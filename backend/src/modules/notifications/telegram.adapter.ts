import { getConfig } from '../../core/config.js';
import { logger } from '../../core/logger.js';

/**
 * Telegram bot transport.
 *
 * Telegram is the *second* channel, and it earns its place twice over:
 *
 * - It reaches a family member whose phone has no working push subscription —
 *   which, on iOS, is a permanent risk (see `docs/research/ios-pwa-push.md`).
 * - **It gives a genuinely better receipt than Web Push.** `sendMessage` returns
 *   a real `message_id` only once the message exists in the chat, so a success
 *   here is `deliveredAt`, not merely `sentAt` (D11). Web Push can only ever
 *   tell us "accepted for delivery".
 *
 * A `403` with "bot was blocked by the user" sets `canDm = false` instead of
 * retrying forever: an unreachable chat that keeps consuming the retry budget is
 * how a queue silently fills up with work that can never succeed.
 *
 * The bot token is a credential. It appears only in the URL we build here, never
 * in a log line, and the failure logs below carry the chat id and the API error
 * code — never the token and never the message text.
 */

const API_BASE = 'https://api.telegram.org';

export interface TelegramMessage {
  chatId: number;
  title: string;
  body: string;
  /** Absolute URL rendered as an inline «Открыть» link. */
  link: string | null;
}

export type TelegramAction =
  /** Delivered. Stamp `deliveredAt` — Telegram confirms real arrival. */
  | 'delivered'
  /** The user blocked the bot or deleted the chat. Set `canDm = false`. */
  | 'block'
  /** Transient — retry with backoff. */
  | 'retry'
  /** Our bug (malformed markdown, bad chat id). Fail the delivery, log loudly. */
  | 'abort';

export type TelegramResult =
  | { ok: true; action: 'delivered'; messageId: number }
  | {
      ok: false;
      action: Exclude<TelegramAction, 'delivered'>;
      reason: string;
      statusCode: number | null;
      retryAfterSeconds?: number;
    };

/** Injection seam: tests stub `fetch` and never touch the network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id?: number };
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/* -------------------------------------------------------------------------- */
/* MarkdownV2 escaping                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Characters Telegram's MarkdownV2 parser reserves. Every one of them must be
 * backslash-escaped in ordinary text or the API rejects the whole message with
 * `400 Bad Request: can't parse entities` — and a notification that 400s is a
 * notification the family never sees.
 *
 * Note `.` and `-` and `!`: Russian copy is full of them
 * («Задача просрочена — сделай!»), which is why naive implementations of this
 * function fail in production on the very first real message.
 */
const MARKDOWN_V2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(value: string): string {
  return value.replace(MARKDOWN_V2_RESERVED, (char) => `\\${char}`);
}

/**
 * Inside a `(...)` link destination, MarkdownV2 only reserves `)` and `\`.
 * Escaping the rest would corrupt query strings and percent-encoding.
 */
export function escapeMarkdownV2Url(url: string): string {
  return url.replace(/[)\\]/g, (char) => `\\${char}`);
}

/** Telegram's hard limit is 4096 characters for `sendMessage`. */
const MAX_MESSAGE_CHARS = 3800;

/**
 * Renders `{ title, body, link }` into MarkdownV2.
 *
 * Bold title on its own line, plain body, then an inline link. Exported so the
 * escaping can be asserted directly rather than through a stubbed transport.
 */
export function formatTelegramMessage(message: TelegramMessage): string {
  const parts = [`*${escapeMarkdownV2(message.title)}*`];
  if (message.body.trim().length > 0) parts.push(escapeMarkdownV2(message.body));
  if (message.link) {
    parts.push(`[Открыть](${escapeMarkdownV2Url(message.link)})`);
  }
  const text = parts.join('\n');
  return text.length <= MAX_MESSAGE_CHARS ? text : `${text.slice(0, MAX_MESSAGE_CHARS)}…`;
}

/* -------------------------------------------------------------------------- */
/* Failure classification                                                      */
/* -------------------------------------------------------------------------- */

const BLOCKED_MARKERS = [
  'bot was blocked by the user',
  'user is deactivated',
  'chat not found',
  "bot can't initiate conversation",
  'peer_id_invalid',
  'the group chat was deleted',
];

/**
 * Maps a Bot API failure onto an action. Pure, so the test suite can pin it.
 *
 * The `403 blocked` case is the one that matters: without it every subsequent
 * notification to that user burns five retries and five backoff delays for a
 * chat that will never accept another message.
 */
export function classifyTelegramFailure(
  statusCode: number | null,
  description: string | undefined,
  retryAfterSeconds?: number,
): { action: Exclude<TelegramAction, 'delivered'>; reason: string; retryAfterSeconds?: number } {
  const text = (description ?? '').toLowerCase();

  if (statusCode === 403 || BLOCKED_MARKERS.some((marker) => text.includes(marker))) {
    return { action: 'block', reason: 'blocked' };
  }

  if (statusCode === 429) {
    return {
      action: 'retry',
      reason: 'rate_limited',
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }

  if (statusCode === null || statusCode >= 500) {
    return { action: 'retry', reason: 'transient' };
  }

  if (statusCode === 400) {
    return {
      action: 'abort',
      reason: text.includes('parse entities') ? 'bad_markup' : 'bad_request',
    };
  }

  if (statusCode === 401 || statusCode === 404) {
    // A wrong or revoked bot token. Never a reason to unlink the user.
    return { action: 'abort', reason: 'bot_misconfigured' };
  }

  return { action: 'abort', reason: 'unknown' };
}

/* -------------------------------------------------------------------------- */
/* Sending                                                                     */
/* -------------------------------------------------------------------------- */

export function isTelegramConfigured(): boolean {
  return getConfig().oauth.telegram.botToken.length > 0;
}

export async function sendTelegramMessage(
  message: TelegramMessage,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<TelegramResult> {
  const token = getConfig().oauth.telegram.botToken;
  if (!token) {
    logger.error('telegram bot token is not configured — TELEGRAM_BOT_TOKEN is empty');
    return { ok: false, action: 'abort', reason: 'bot_misconfigured', statusCode: null };
  }

  const text = formatTelegramMessage(message);

  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: message.chatId,
        text,
        parse_mode: 'MarkdownV2',
        // The family app owns the link preview; Telegram's would be noise.
        link_preview_options: { is_disabled: true },
        disable_notification: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    logger.warn({ chatId: message.chatId, err: error }, 'telegram sendMessage network failure');
    return { ok: false, action: 'retry', reason: 'transient', statusCode: null };
  }

  let payload: TelegramApiResponse;
  try {
    payload = (await response.json()) as TelegramApiResponse;
  } catch {
    payload = { ok: response.ok };
  }

  if (response.ok && payload.ok) {
    const messageId = payload.result?.message_id;
    if (typeof messageId === 'number') {
      // A real message_id: the message exists in the chat. This is a genuine
      // arrival receipt, which is more than Web Push can ever give us (D11).
      return { ok: true, action: 'delivered', messageId };
    }
    // `ok: true` without a message_id should not happen; treat it as delivered
    // but without a handle, rather than inventing a failure.
    return { ok: true, action: 'delivered', messageId: 0 };
  }

  const classification = classifyTelegramFailure(
    response.status,
    payload.description,
    payload.parameters?.retry_after,
  );

  const logContext = {
    chatId: message.chatId,
    statusCode: response.status,
    errorCode: payload.error_code,
    description: payload.description?.slice(0, 200),
    reason: classification.reason,
  };

  if (classification.action === 'block') {
    logger.info(logContext, 'telegram DM blocked by the user — disabling can_dm');
  } else if (classification.reason === 'bad_markup') {
    logger.error(logContext, 'telegram rejected our MarkdownV2 — escaping bug');
  } else if (classification.action === 'abort') {
    logger.error(logContext, 'telegram sendMessage failed permanently');
  } else {
    logger.warn(logContext, 'telegram sendMessage failed');
  }

  return {
    ok: false,
    action: classification.action,
    reason: classification.reason,
    statusCode: response.status,
    ...(classification.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: classification.retryAfterSeconds }
      : {}),
  };
}
