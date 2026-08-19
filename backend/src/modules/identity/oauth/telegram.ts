import { createHash, createHmac } from 'node:crypto';

import * as oidc from 'openid-client';

import { safeEqual } from '../../../core/auth/tokens.js';
import { getConfig } from '../../../core/config.js';
import { AppError } from '../../../core/errors.js';
import { sanitizeRawProfile, type OAuthProfile } from './linking.js';

/**
 * Telegram sign-in.
 *
 * Primary flow: **OIDC at `https://oauth.telegram.org`** (D3). `client_id` is the
 * numeric bot id — the part of the bot token before the colon — which
 * `config.oauth.telegram.botId` has already parsed out. The
 * `telegram:bot_access` scope is what lets the bot DM admins about pending
 * signups; without it the notification channel for approvals does not exist.
 *
 * Two hash-based fallbacks are implemented in full because they are still the
 * only way in from the archived Login Widget and from a Mini App, and because
 * **their key derivations are mirror images of each other** and are trivially
 * swapped by accident:
 *
 *   Login Widget : secret = SHA256(bot_token)                  ← a plain digest
 *   Mini App     : secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *
 * Telegram's own documentation writes the Mini App one as
 * `HMAC_SHA256(<bot_token>, "WebAppData")` — **message first, key second** —
 * which reads like the opposite of every crypto API's argument order and is the
 * single most common Mini App bug. Both derivations have unit tests, including a
 * deliberately-swapped-operands negative case.
 *
 * Telegram gives **no email, ever**: `providerEmail` stays NULL and a Telegram
 * identity can never participate in email-based linking.
 */

const TELEGRAM_ISSUER_URL = new URL('https://oauth.telegram.org');

export const TELEGRAM_SCOPES = 'openid profile telegram:bot_access';

/** Replay window for `auth_date`, not a session lifetime. */
export const TELEGRAM_MAX_AUTH_AGE_SECONDS = 86_400;

/** Tolerance for an `auth_date` slightly in the future (client clock skew). */
const TELEGRAM_FUTURE_SKEW_SECONDS = 60;

function telegramConfig() {
  const cfg = getConfig().oauth.telegram;
  if (!cfg.enabled) {
    throw new AppError('SERVICE_UNAVAILABLE', 'Telegram sign-in is not configured');
  }
  return cfg;
}

/* -------------------------------------------------------------------------- */
/* OIDC (primary)                                                              */
/* -------------------------------------------------------------------------- */

let configurationPromise: Promise<oidc.Configuration> | undefined;

export async function getTelegramConfiguration(): Promise<oidc.Configuration> {
  const cfg = telegramConfig();
  configurationPromise ??= oidc
    .discovery(TELEGRAM_ISSUER_URL, cfg.botId, {
      client_secret: cfg.clientSecret,
      // Pinned: the id_token must be RS256, whatever the discovery document
      // advertises and whatever the token's own header claims.
      id_token_signed_response_alg: 'RS256',
    })
    .catch((cause: unknown) => {
      configurationPromise = undefined;
      throw new AppError('SERVICE_UNAVAILABLE', 'Telegram OIDC discovery failed', { cause });
    });
  return configurationPromise;
}

export function resetTelegramCaches(): void {
  configurationPromise = undefined;
}

export interface TelegramAuthSecrets {
  nonce: string;
  codeVerifier: string;
}

export function newTelegramAuthSecrets(): TelegramAuthSecrets {
  return { nonce: oidc.randomNonce(), codeVerifier: oidc.randomPKCECodeVerifier() };
}

export async function buildTelegramAuthorizationUrl(input: {
  state: string;
  nonce: string;
  codeVerifier: string;
}): Promise<string> {
  const cfg = telegramConfig();
  const configuration = await getTelegramConfiguration();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(input.codeVerifier);

  return oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: cfg.redirectUri,
    scope: TELEGRAM_SCOPES,
    response_type: 'code',
    state: input.state,
    nonce: input.nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    /**
     * Telegram-specific and not part of OIDC.
     *
     * `oauth.telegram.org` refuses the request with "Origin required" unless
     * this is present, and it must match a domain registered against the bot
     * with BotFather's `/setdomain`. Standard OIDC has no such parameter, so
     * `openid-client` does not send it and the flow fails on Telegram's page
     * rather than anywhere in our code.
     */
    origin: getConfig().publicOrigin,
  }).href;
}

/** Maps verified OIDC claims onto our profile shape. Email is always NULL. */
export function telegramProfileFromClaims(claims: Record<string, unknown>): OAuthProfile {
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) throw new AppError('TOKEN_INVALID', 'Telegram id_token has no subject');

  const username =
    typeof claims.preferred_username === 'string' ? claims.preferred_username : null;

  return {
    provider: 'telegram',
    providerUserId: sub,
    // Telegram never returns an email. Not "sometimes" — never.
    email: null,
    emailVerified: false,
    displayName: typeof claims.name === 'string' ? claims.name : null,
    username,
    avatarUrl: typeof claims.picture === 'string' ? claims.picture : null,
    rawProfile: sanitizeRawProfile({
      iss: claims.iss,
      given_name: claims.given_name,
      family_name: claims.family_name,
      flow: 'oidc',
    }),
  };
}

export async function exchangeTelegramCode(input: {
  code: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}): Promise<OAuthProfile> {
  const cfg = telegramConfig();
  const configuration = await getTelegramConfiguration();

  const currentUrl = new URL(cfg.redirectUri);
  currentUrl.searchParams.set('code', input.code);
  currentUrl.searchParams.set('state', input.state);

  try {
    const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
      expectedNonce: input.nonce,
      expectedState: input.state,
      pkceCodeVerifier: input.codeVerifier,
    });
    const claims = tokens.claims();
    if (!claims) throw new AppError('OAUTH_PROVIDER_ERROR', 'Telegram returned no id_token');
    return telegramProfileFromClaims(claims);
  } catch (cause) {
    if (AppError.isAppError(cause)) throw cause;
    throw new AppError('OAUTH_PROVIDER_ERROR', 'Telegram token exchange failed', { cause });
  }
}

/* -------------------------------------------------------------------------- */
/* shared hash machinery                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The data-check-string: every field **except the excluded ones**, sorted
 * alphabetically by key, rendered as `key=value` and joined with `\n`.
 *
 * Sorting is by key, not by the rendered line — for keys where one is a prefix
 * of another the two orders can differ, and a mismatch here is indistinguishable
 * from a forged signature at the call site.
 */
export function buildDataCheckString(
  fields: Iterable<readonly [string, string]>,
  exclude: readonly string[] = [],
): string {
  const skip = new Set(exclude);
  const entries = [...fields].filter(([key]) => !skip.has(key));
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([key, value]) => `${key}=${value}`).join('\n');
}

/**
 * Login Widget (legacy): the secret key is a **plain SHA-256 digest** of the bot
 * token — not an HMAC.
 */
export function telegramWidgetSecretKey(botToken: string): Buffer {
  return createHash('sha256').update(botToken).digest();
}

/**
 * Mini App `initData`: the secret key is `HMAC_SHA256` with the **key
 * `"WebAppData"`** over the **message `botToken`**.
 *
 * Telegram documents this as `HMAC_SHA256(<bot_token>, "WebAppData")`, listing
 * the message first. Reading that as `createHmac('sha256', botToken)` — which is
 * what the argument order suggests — produces a valid-looking but wrong key and
 * rejects every genuine Mini App user. There is a test pinning this.
 */
export function telegramMiniAppSecretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

export function computeTelegramHash(secretKey: Buffer, dataCheckString: string): string {
  return createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
}

/**
 * `auth_date` freshness. A valid signature is forever valid, so without this a
 * captured widget payload is a permanent credential.
 */
export function assertTelegramAuthDateFresh(
  authDate: number,
  now: Date = new Date(),
  maxAgeSeconds: number = TELEGRAM_MAX_AUTH_AGE_SECONDS,
): void {
  if (!Number.isFinite(authDate)) {
    throw new AppError('TOKEN_INVALID', 'Telegram auth_date is missing or malformed');
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (authDate > nowSeconds + TELEGRAM_FUTURE_SKEW_SECONDS) {
    throw new AppError('TOKEN_INVALID', 'Telegram auth_date is in the future');
  }
  if (nowSeconds - authDate > maxAgeSeconds) {
    throw new AppError('TOKEN_INVALID', 'Telegram auth_date is too old');
  }
}

/* -------------------------------------------------------------------------- */
/* Login Widget fallback                                                       */
/* -------------------------------------------------------------------------- */

export interface TelegramUserFields {
  id: string;
  first_name?: string | undefined;
  last_name?: string | undefined;
  username?: string | undefined;
  photo_url?: string | undefined;
  language_code?: string | undefined;
}

function toFieldEntries(payload: Record<string, unknown>): [string, string][] {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      entries.push([key, value]);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      entries.push([key, String(value)]);
    }
    // Anything else (an object, an array) cannot appear in a genuine widget
    // payload. Dropping it makes the hash mismatch — a safe failure — rather
    // than folding "[object Object]" into the data-check-string.
  }
  return entries;
}

function displayNameOf(first?: string, last?: string, username?: string | null): string | null {
  const name = [first?.trim(), last?.trim()].filter(Boolean).join(' ').trim();
  if (name.length > 0) return name;
  return username && username.length > 0 ? username : null;
}

function telegramProfile(
  user: TelegramUserFields,
  flow: 'widget' | 'miniapp',
  extra: Record<string, unknown> = {},
): OAuthProfile {
  return {
    provider: 'telegram',
    providerUserId: user.id,
    email: null,
    emailVerified: false,
    displayName: displayNameOf(user.first_name, user.last_name, user.username ?? null),
    username: user.username ?? null,
    avatarUrl: user.photo_url ?? null,
    rawProfile: sanitizeRawProfile({ flow, language_code: user.language_code, ...extra }),
  };
}

/**
 * Verifies an archived Login Widget payload.
 *
 * @param payload the fields exactly as Telegram sent them, `hash` included.
 */
export function verifyTelegramWidget(input: {
  payload: Record<string, unknown>;
  botToken: string;
  now?: Date;
  maxAgeSeconds?: number;
}): OAuthProfile {
  const entries = toFieldEntries(input.payload);
  const provided = entries.find(([key]) => key === 'hash')?.[1];
  if (!provided) throw new AppError('TOKEN_INVALID', 'Telegram payload has no hash');

  const dataCheckString = buildDataCheckString(entries, ['hash']);
  const expected = computeTelegramHash(telegramWidgetSecretKey(input.botToken), dataCheckString);
  if (!safeEqual(expected, provided.toLowerCase())) {
    throw new AppError('TOKEN_INVALID', 'Telegram widget signature is invalid');
  }

  const authDate = Number(entries.find(([key]) => key === 'auth_date')?.[1]);
  assertTelegramAuthDateFresh(authDate, input.now, input.maxAgeSeconds);

  const field = (key: string): string | undefined => entries.find(([k]) => k === key)?.[1];
  const id = field('id');
  if (!id) throw new AppError('TOKEN_INVALID', 'Telegram payload has no user id');

  return telegramProfile(
    {
      id,
      first_name: field('first_name'),
      last_name: field('last_name'),
      username: field('username'),
      photo_url: field('photo_url'),
    },
    'widget',
    { auth_date: authDate },
  );
}

/* -------------------------------------------------------------------------- */
/* Mini App initData fallback                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Verifies a Mini App `initData` string.
 *
 * `initData` is passed through from the client **verbatim**: the HMAC is
 * computed over the decoded pairs in the order Telegram defines, so any
 * re-encoding or key reordering on the client breaks verification.
 *
 * `signature` (Telegram's newer Ed25519 third-party validation field) is
 * excluded from the data-check-string alongside `hash`.
 */
export function verifyTelegramInitData(input: {
  initData: string;
  botToken: string;
  now?: Date;
  maxAgeSeconds?: number;
}): OAuthProfile {
  const params = new URLSearchParams(input.initData);
  const provided = params.get('hash');
  if (!provided) throw new AppError('TOKEN_INVALID', 'initData has no hash');

  const entries: [string, string][] = [...params.entries()];
  const dataCheckString = buildDataCheckString(entries, ['hash', 'signature']);
  const expected = computeTelegramHash(telegramMiniAppSecretKey(input.botToken), dataCheckString);
  if (!safeEqual(expected, provided.toLowerCase())) {
    throw new AppError('TOKEN_INVALID', 'initData signature is invalid');
  }

  assertTelegramAuthDateFresh(Number(params.get('auth_date')), input.now, input.maxAgeSeconds);

  const rawUser = params.get('user');
  if (!rawUser) throw new AppError('TOKEN_INVALID', 'initData has no user');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUser);
  } catch (cause) {
    throw new AppError('TOKEN_INVALID', 'initData user is not valid JSON', { cause });
  }

  const user = parsed as Partial<Record<keyof TelegramUserFields, unknown>>;
  const id = typeof user.id === 'number' || typeof user.id === 'string' ? String(user.id) : '';
  if (!id) throw new AppError('TOKEN_INVALID', 'initData user has no id');

  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;

  return telegramProfile(
    {
      id,
      first_name: str(user.first_name),
      last_name: str(user.last_name),
      username: str(user.username),
      photo_url: str(user.photo_url),
      language_code: str(user.language_code),
    },
    'miniapp',
    { auth_date: Number(params.get('auth_date')), chat_type: params.get('chat_type') ?? undefined },
  );
}
