import webpush from 'web-push';
import type { PushSubscription, RequestOptions } from 'web-push';

import { NOTIFICATION_LIMITS, type NotificationPriority } from '@family/shared';

import { getConfig } from '../../core/config.js';
import { logger } from '../../core/logger.js';

/**
 * Web Push transport.
 *
 * Two things in this file are load-bearing and neither is obvious:
 *
 * 1. **The hybrid Declarative Web Push payload.** Safari 18.5+/iOS 18.4+ renders
 *    `{ web_push: 8030, notification: {…} }` natively, without ever waking our
 *    service worker — which is what finally fixed the long-standing iOS bug
 *    where `clients.openWindow()` from `notificationclick` opened the root URL
 *    or nothing at all, and it exempts the message from silent-push penalties.
 *    Every other browser ignores the `web_push` key and falls through to the SW
 *    `push` handler, which reads the very same `notification` object. One
 *    payload, both worlds. `mutable: true` means the SW still gets its chance to
 *    customise, but if the handler throws or times out the platform shows the
 *    notification anyway — strictly better than classic push.
 *
 * 2. **The status table.** Getting this wrong is how a bad deploy wipes every
 *    subscription in the family. `400/401/403` mean *our VAPID configuration is
 *    broken*, not that the user's device is gone; pruning on them would delete
 *    every row in `push_subscriptions` the first time someone fat-fingers
 *    `VAPID_SUBJECT`. Only `404`/`410` prune.
 *
 * The `endpoint` is a **capability URL** — anyone holding it can push to that
 * device. It is never logged above `debug`, never returned to a client, and the
 * pino redaction list in `core/logger.ts` covers it as a second line of defence.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface PushTarget {
  /** `push_subscriptions.id` — the safe identifier to log. */
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  /** `notification_deliveries.id`. The service worker acks this back (D11). */
  deliveryId: string;
  /** `notification_intents.id`. Used as the coalescing `topic`. */
  intentId: string;
  type: string;
  title: string;
  body: string;
  /** App-relative route, e.g. `/tasks/42`. Absolutised before sending. */
  navigate: string | null;
  /** Value for `app_badge` — the unread count after this notification lands. */
  badge?: number;
  priority: NotificationPriority;
  /** `high`/`critical` intents ask the user to press «Подтвердить». */
  needsAcknowledgement?: boolean;
}

/**
 * What the caller must do next. Deliberately an explicit verb rather than a
 * boolean pair — the whole point is that "failed" is not one thing.
 */
export type PushAction =
  /** Delete/expire the subscription row. The device is gone forever. */
  | 'prune'
  /** Transient. Retry with backoff; do not touch the subscription. */
  | 'retry'
  /** Transient, but honour `Retry-After` first. Never prune. */
  | 'backoff'
  /** Our bug (payload or VAPID). Log loudly, fail the delivery, never prune. */
  | 'abort';

export interface PushClassification {
  action: PushAction;
  /** Machine-readable, surfaced by `POST /test` so a user can be told the truth. */
  reason:
    | 'gone'
    | 'rate_limited'
    | 'payload_too_large'
    | 'vapid_misconfigured'
    | 'transient'
    | 'client_error';
  /** True only for `404`/`410`. Nothing else may ever delete a subscription. */
  prune: boolean;
  /** Should the delivery consume one of its retry attempts? */
  retryable: boolean;
  /** Counts toward the ~10-consecutive-failure expiry. */
  countsAsFailure: boolean;
  retryAfterSeconds?: number;
}

export type PushResult =
  | { ok: true; statusCode: number; bytes: number; degraded: boolean }
  | ({ ok: false; statusCode: number | null; bytes: number } & PushClassification);

/** Injection seam so tests never touch the network. */
export interface PushDeps {
  sendNotification: (
    subscription: PushSubscription,
    payload: string,
    options: RequestOptions,
  ) => Promise<{ statusCode: number }>;
}

/**
 * After this many consecutive transport failures the subscription is expired
 * anyway. Ten is deliberately generous: a phone in a tunnel for a week must not
 * lose its subscription, but an endpoint that has failed ten times running is
 * not coming back.
 */
export const PUSH_FAILURE_EXPIRY_THRESHOLD = 10;

/* -------------------------------------------------------------------------- */
/* Status classification — the table from docs/research/ios-pwa-push.md §5      */
/* -------------------------------------------------------------------------- */

/**
 * Maps an HTTP status (or `null` for a network error) to a decision.
 *
 * Pure and exported so the test suite can assert every row of the table. This is
 * the test that protects the family's subscriptions from a bad deploy.
 */
export function classifyPushFailure(
  statusCode: number | null,
  retryAfterSeconds?: number,
): PushClassification {
  // Network error, DNS failure, socket timeout — no status at all.
  if (statusCode === null) {
    return {
      action: 'retry',
      reason: 'transient',
      prune: false,
      retryable: true,
      countsAsFailure: true,
    };
  }

  switch (statusCode) {
    // The subscription is dead forever. This is the ONLY prune.
    case 404:
    case 410:
      return {
        action: 'prune',
        reason: 'gone',
        prune: true,
        retryable: false,
        countsAsFailure: false,
      };

    // Too many messages to this endpoint. Back off, honour Retry-After.
    case 429:
      return {
        action: 'backoff',
        reason: 'rate_limited',
        prune: false,
        retryable: true,
        countsAsFailure: false,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      };

    // Our payload exceeded the push service's limit. Retrying sends the same
    // bytes, so it is pointless — but the device is perfectly healthy.
    case 413:
      return {
        action: 'abort',
        reason: 'payload_too_large',
        prune: false,
        retryable: false,
        countsAsFailure: false,
      };

    // VAPID/JWT misconfiguration: a malformed subject, an expired JWT, a key
    // that does not match the one the subscription was created with. Pruning
    // here would wipe every subscription in the family on a bad deploy.
    case 400:
    case 401:
    case 403:
      return {
        action: 'abort',
        reason: 'vapid_misconfigured',
        prune: false,
        retryable: false,
        countsAsFailure: false,
      };

    default:
      if (statusCode >= 500) {
        return {
          action: 'retry',
          reason: 'transient',
          prune: false,
          retryable: true,
          countsAsFailure: true,
        };
      }
      // Any other 4xx: unexpected, but not evidence the device is gone.
      return {
        action: 'abort',
        reason: 'client_error',
        prune: false,
        retryable: false,
        countsAsFailure: false,
      };
  }
}

function parseRetryAfter(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(3600, Math.round((date - Date.now()) / 1000)));
}

/* -------------------------------------------------------------------------- */
/* Payload construction & the size budget                                      */
/* -------------------------------------------------------------------------- */

/**
 * RFC 8291 guarantees only 4096 octets, and after headers, padding and the AEAD
 * tag that is roughly 3993 bytes of plaintext. `NOTIFICATION_LIMITS`
 * budgets 3072, which leaves comfortable headroom for the browsers that pad
 * more aggressively than others.
 */
const BUDGET = NOTIFICATION_LIMITS.pushPayloadBudgetBytes;

/** Never ship a title below this many characters — an empty banner is useless. */
const MIN_TITLE = 24;

export interface DeclarativePushPayload {
  /** The Declarative Web Push magic number. Ignored by non-Safari browsers. */
  web_push: 8030;
  notification: {
    title: string;
    body: string;
    /** REQUIRED by the declarative path. Absolute URL. */
    navigate: string;
    app_badge?: number;
    /** Let the SW customise; the platform shows the fallback if it throws. */
    mutable: true;
    dir: 'ltr';
    silent: false;
    /**
     * Ids only, never entity data — the app fetches the rest when the user taps.
     * `deliveryId` is what the SW posts back as the D11 arrival ack.
     */
    data: {
      deliveryId: string;
      intentId: string;
      type: string;
      needsAck?: boolean;
    };
  };
}

function absoluteUrl(navigate: string | null): string {
  const origin = getConfig().publicOrigin;
  if (!navigate) return `${origin}/notifications`;
  if (navigate.startsWith('http://') || navigate.startsWith('https://')) return navigate;
  return `${origin}${navigate.startsWith('/') ? '' : '/'}${navigate}`;
}

function buildPayload(message: PushMessage, title: string, body: string): DeclarativePushPayload {
  return {
    web_push: 8030,
    notification: {
      title,
      body,
      navigate: absoluteUrl(message.navigate),
      ...(message.badge !== undefined ? { app_badge: message.badge } : {}),
      mutable: true,
      dir: 'ltr',
      silent: false,
      data: {
        deliveryId: message.deliveryId,
        intentId: message.intentId,
        type: message.type,
        ...(message.needsAcknowledgement ? { needsAck: true } : {}),
      },
    },
  };
}

export interface SerializedPush {
  json: string;
  bytes: number;
  /** True when we had to trim to fit — worth a log line, never an error. */
  degraded: boolean;
}

/**
 * Serialises the payload, **degrading rather than throwing**.
 *
 * A `413` is a self-inflicted outage: the notification is lost and the retry
 * sends exactly the same oversized bytes. So we trim, in this order:
 *
 * 1. shorten the body (the deep link matters more than the second sentence);
 * 2. drop the body entirely and drop `app_badge`;
 * 3. as a last resort, shorten the title — but never below `MIN_TITLE`, because
 *    on iOS the title is the only way to tell what kind of notification this is.
 *
 * `title` and `navigate` always survive: without them Safari refuses the
 * declarative path and the message silently does nothing.
 */
export function serializePushPayload(message: PushMessage, budget = BUDGET): SerializedPush {
  const encode = (payload: DeclarativePushPayload) => {
    const json = JSON.stringify(payload);
    return { json, bytes: Buffer.byteLength(json, 'utf8') };
  };

  let attempt = encode(buildPayload(message, message.title, message.body));
  if (attempt.bytes <= budget) return { ...attempt, degraded: false };

  // 1. Trim the body to whatever room is left, in UTF-8 bytes, not characters —
  //    Cyrillic is two bytes per character and a character count would lie by 2x.
  const overheadWithoutBody = encode(buildPayload(message, message.title, '')).bytes;
  const roomForBody = budget - overheadWithoutBody;
  if (roomForBody > 24) {
    const trimmedBody = trimToBytes(message.body, roomForBody - 4);
    attempt = encode(buildPayload(message, message.title, `${trimmedBody}…`));
    if (attempt.bytes <= budget) return { ...attempt, degraded: true };
  }

  // 2. No body, no badge.
  const stripped: PushMessage = { ...message, body: '' };
  delete stripped.badge;
  attempt = encode(buildPayload(stripped, message.title, ''));
  if (attempt.bytes <= budget) return { ...attempt, degraded: true };

  // 3. Shorten the title. If even a minimal title does not fit, the deep link
  //    itself must be pathological — ship it anyway rather than throw; the push
  //    service's own 413 is a better failure than a crashed dispatcher.
  const titleOverhead = encode(buildPayload(stripped, '', '')).bytes;
  const roomForTitle = Math.max(MIN_TITLE, budget - titleOverhead);
  attempt = encode(buildPayload(stripped, trimToBytes(message.title, roomForTitle), ''));
  return { ...attempt, degraded: true };
}

/** Cuts a string so its UTF-8 encoding fits in `maxBytes`, never mid-codepoint. */
export function trimToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = '';
  let used = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out.trimEnd();
}

/* -------------------------------------------------------------------------- */
/* Sending                                                                     */
/* -------------------------------------------------------------------------- */

/** `topic` must be ≤32 URL-safe base64 characters; the push service coalesces on it. */
function topicFor(intentId: string): string {
  return intentId.replace(/-/g, '').slice(0, 32);
}

/**
 * `urgency` tells the push service whether it may hold the message until the
 * device wakes. Anything the user is expected to act on is `high`; chatter is
 * `low` so a sleeping phone is not woken for a kudos.
 */
function urgencyFor(priority: NotificationPriority): 'very-low' | 'low' | 'normal' | 'high' {
  switch (priority) {
    case 'critical':
    case 'high':
      return 'high';
    case 'normal':
      return 'normal';
    case 'low':
      return 'low';
  }
}

const defaultDeps: PushDeps = {
  sendNotification: (subscription, payload, options) =>
    webpush.sendNotification(subscription, payload, options),
};

/** Host only — safe to log. The path is the secret half of a capability URL. */
function pushServiceHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid-endpoint';
  }
}

export function isPushConfigured(): boolean {
  const { push } = getConfig();
  return push.enabled && push.publicKey.length > 0 && push.privateKey.length > 0;
}

export async function sendPush(
  target: PushTarget,
  message: PushMessage,
  deps: PushDeps = defaultDeps,
): Promise<PushResult> {
  const config = getConfig();

  if (!isPushConfigured()) {
    // Treat a missing keypair exactly like a misconfiguration, because that is
    // what it is — and above all, do not prune anything.
    logger.error({ subscriptionId: target.id }, 'web push is not configured (VAPID keys missing)');
    return {
      ok: false,
      statusCode: null,
      bytes: 0,
      ...classifyPushFailure(401),
    };
  }

  const { json, bytes, degraded } = serializePushPayload(message);
  if (degraded) {
    logger.warn(
      { subscriptionId: target.id, deliveryId: message.deliveryId, bytes },
      'push payload exceeded the budget and was trimmed',
    );
  }

  const subscription: PushSubscription = {
    endpoint: target.endpoint,
    keys: { p256dh: target.p256dh, auth: target.auth },
  };

  const options: RequestOptions = {
    vapidDetails: {
      subject: config.push.subject,
      publicKey: config.push.publicKey,
      privateKey: config.push.privateKey,
    },
    TTL: message.priority === 'critical' ? 3600 : 24 * 3600,
    urgency: urgencyFor(message.priority),
    topic: topicFor(message.intentId),
    timeout: 10_000,
    contentEncoding: 'aes128gcm',
  };

  // Endpoint at debug only — it is a capability URL.
  logger.debug({ subscriptionId: target.id, endpoint: target.endpoint, bytes }, 'sending web push');

  try {
    const result = await deps.sendNotification(subscription, json, options);
    return { ok: true, statusCode: result.statusCode, bytes, degraded };
  } catch (error) {
    if (error instanceof webpush.WebPushError) {
      const classification = classifyPushFailure(
        error.statusCode,
        parseRetryAfter(error.headers),
      );
      logPushFailure(target, message, error.statusCode, classification, error.body);
      return { ok: false, statusCode: error.statusCode, bytes, ...classification };
    }

    const classification = classifyPushFailure(null);
    logPushFailure(target, message, null, classification, String(error));
    return { ok: false, statusCode: null, bytes, ...classification };
  }
}

function logPushFailure(
  target: PushTarget,
  message: PushMessage,
  statusCode: number | null,
  classification: PushClassification,
  body: string,
): void {
  const base = {
    subscriptionId: target.id,
    deliveryId: message.deliveryId,
    pushService: pushServiceHost(target.endpoint),
    statusCode,
    reason: classification.reason,
    // The body of a push-service error is short and never contains user data.
    responseBody: body.slice(0, 200),
  };

  switch (classification.reason) {
    case 'vapid_misconfigured':
      // Loud on purpose: this is a deployment problem affecting EVERY device in
      // the family, and it must never be mistaken for a dead subscription.
      logger.error(
        base,
        'web push rejected our VAPID credentials — check VAPID_SUBJECT/VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY. NOT pruning any subscription.',
      );
      break;
    case 'payload_too_large':
      logger.error(base, 'web push payload was too large — this is our bug, not the device');
      break;
    case 'gone':
      logger.info(base, 'push subscription is gone; pruning');
      break;
    default:
      logger.warn(base, 'web push failed');
  }
}
