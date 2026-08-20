import { createHash, createHmac } from 'node:crypto';

import * as oidc from 'openid-client';

import { safeEqual } from '../../../core/auth/tokens.js';
import { getConfig } from '../../../core/config.js';
import { AppError } from '../../../core/errors.js';
import { logger } from '../../../core/logger.js';
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
 * **`client_secret` is not derivable from the bot token.** It is a separate
 * credential that @BotFather issues (open BotFather *as a mini app* → the bot →
 * **Login Widget**), and it has to be copied by hand into
 * `TELEGRAM_CLIENT_SECRET`. The two hash derivations further down are for the
 * *fallback* flows and are emphatically not it — feeding `SHA256(bot_token)` or
 * the bot token itself to the token endpoint is rejected like any other wrong
 * secret. Telegram's discovery document advertises only `client_secret_basic`
 * and `client_secret_post`; there is no `none`, so an exchange without a secret
 * cannot succeed and `assertTelegramClientAuth` refuses to start the flow.
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

  // `botId` is the token prefix. An empty one means TELEGRAM_BOT_TOKEN is not a
  // bot token at all, and discovery would go out with an empty `client_id` and
  // come back with something far less informative than this.
  if (!cfg.botId) {
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      'TELEGRAM_BOT_TOKEN is malformed: expected `<numeric bot id>:<secret>`',
    );
  }
  configurationPromise ??= oidc
    .discovery(
      TELEGRAM_ISSUER_URL,
      cfg.botId,
      {
        client_secret: cfg.clientSecret,
        // Pinned: the id_token must be RS256, whatever the discovery document
        // advertises and whatever the token's own header claims.
        id_token_signed_response_alg: 'RS256',
      },
      undefined,
      // `openid-client` picks `client_secret_post` whenever `client_secret` is a
      // non-empty string and `None()` otherwise, so the empty-string default of
      // `TELEGRAM_CLIENT_SECRET` silently produces an *unauthenticated* token
      // request. `assertTelegramClientAuth` is what stops that reaching Telegram.
      { [oidc.customFetch]: telegramTokenFetch() },
    )
    .catch((cause: unknown) => {
      configurationPromise = undefined;
      throw new AppError('SERVICE_UNAVAILABLE', 'Telegram OIDC discovery failed', { cause });
    });
  return configurationPromise;
}

export function resetTelegramCaches(): void {
  configurationPromise = undefined;
  domainCheckCache = undefined;
}

/* -------------------------------------------------------------------------- */
/* client authentication (BotFather -> Login Widget -> Client Secret)          */
/* -------------------------------------------------------------------------- */

/**
 * The one-line fix, repeated everywhere a missing client secret surfaces.
 *
 * Deliberately spells out that the secret is *not* the bot token: every other
 * Telegram integration in this file keys off the bot token, so "use the token
 * you already have" is the obvious wrong guess, and Telegram's rejection of it
 * is indistinguishable from any other bad secret.
 */
export const TELEGRAM_CLIENT_SECRET_FIX =
  'open @BotFather as a mini app -> pick the bot -> Login Widget -> copy "Client Secret" into TELEGRAM_CLIENT_SECRET ' +
  '(it is NOT the bot token), and register both the origin and the redirect URI under "Allowed URLs"';

/**
 * Refuses to begin an OIDC login that provably cannot finish.
 *
 * Telegram advertises exactly two token endpoint auth methods,
 * `client_secret_basic` and `client_secret_post` — no `none`. With
 * `TELEGRAM_CLIENT_SECRET` empty, `openid-client` falls back to `None()` and the
 * exchange is rejected **after the user has already approved the login**, which
 * is the worst possible place to learn about a missing environment variable.
 *
 * Same spirit as `assertTelegramLoginDomain`: fail on our side, before the
 * redirect, with the fix in the log line.
 */
export function assertTelegramClientAuth(): void {
  const cfg = telegramConfig();
  if (cfg.clientSecret) return;
  throw new AppError('SERVICE_UNAVAILABLE', 'TELEGRAM_CLIENT_SECRET is not set', {
    context: {
      botId: cfg.botId,
      botUsername: cfg.botUsername,
      // Why this is fatal rather than merely degraded.
      why: 'Telegram offers only client_secret_basic / client_secret_post; an unauthenticated token exchange cannot succeed',
      fix: TELEGRAM_CLIENT_SECRET_FIX,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* token endpoint errors                                                       */
/* -------------------------------------------------------------------------- */

export interface TelegramTokenFailure {
  /** The OAuth `error` code, e.g. `invalid_client`. */
  error: string;
  /** Telegram's `error_description`, when it sent one. */
  description: string | null;
}

/**
 * What each token endpoint rejection actually means for this app.
 *
 * `invalid_client` is the one that matters: it is the *only* symptom of a
 * missing or wrong `TELEGRAM_CLIENT_SECRET`, and nothing about the raw code
 * hints at where the secret comes from.
 */
export const TELEGRAM_TOKEN_ERROR_HINTS: Readonly<Record<string, string>> = {
  invalid_client: `Telegram rejected our client authentication - TELEGRAM_CLIENT_SECRET is missing or wrong. To fix: ${TELEGRAM_CLIENT_SECRET_FIX}.`,
  invalid_grant:
    'The authorization code was already used, has expired, or was issued for a different redirect_uri.',
  invalid_request:
    'Malformed token request - usually a redirect_uri that differs from the one the code was issued for.',
  unauthorized_client: 'This bot may not use the authorization code grant.',
  unsupported_grant_type: 'Telegram supports only grant_type=authorization_code.',
  invalid_scope: `Telegram accepts only openid, profile, phone and telegram:bot_access; we request "${TELEGRAM_SCOPES}".`,
};

export function telegramTokenErrorHint(error: string): string | null {
  return TELEGRAM_TOKEN_ERROR_HINTS[error] ?? null;
}

/** An OAuth error object embedded in a response body, or `null`. */
export function telegramTokenErrorIn(body: unknown): TelegramTokenFailure | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  // A body carrying an access token is a success, whatever else it contains.
  if (typeof record.access_token === 'string') return null;
  if (typeof record.error !== 'string' || record.error.length === 0) return null;
  return {
    error: record.error,
    description:
      typeof record.error_description === 'string' && record.error_description.length > 0
        ? record.error_description
        : null,
  };
}

/**
 * Restores the HTTP status RFC 6749 requires for a rejected token request.
 *
 * **Telegram answers a rejected exchange with `HTTP 200` and an OAuth error
 * body.** `oauth4webapi` only looks for an error object when the status is *not*
 * the expected 200, so it sails straight past `{"error":"invalid_client"}` and
 * dies further down on `"response" body "access_token" property must be a
 * string` — an error that names neither Telegram nor the client secret. Every
 * diagnosis downstream is built on that message, so the status is corrected here
 * once, at the edge, rather than pattern-matched in five places later.
 *
 * Only a 200 whose JSON body has an `error` and no `access_token` is rewritten;
 * a genuine token response is rebuilt byte-for-byte.
 */
export async function normalizeTelegramTokenResponse(response: Response): Promise<Response> {
  if (response.status !== 200) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('json')) return response;

  // Read once and always rebuild: cloning would leave the original body
  // undrained, and `Response` bodies are single-use.
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(text, { status: 200, headers: { 'content-type': contentType } });
  }

  const failure = telegramTokenErrorIn(parsed);
  if (!failure) {
    return new Response(text, { status: 200, headers: { 'content-type': contentType } });
  }

  logger.warn(
    {
      telegramError: failure.error,
      telegramDescription: failure.description,
      hint: telegramTokenErrorHint(failure.error),
    },
    'Telegram token endpoint returned an OAuth error with HTTP 200',
  );
  return new Response(text, { status: 400, headers: { 'content-type': contentType } });
}

/** True for the OIDC token endpoint, which is the only response worth rewriting. */
export function isTelegramTokenEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === TELEGRAM_ISSUER_URL.origin && parsed.pathname === '/token';
}

/**
 * The `customFetch` handed to `openid-client`, so discovery and JWKS responses
 * pass through untouched and only `/token` is normalized.
 */
export function telegramTokenFetch(impl: typeof fetch = fetch): oidc.CustomFetch {
  return async (url, options) => {
    const response = await impl(url, options);
    return isTelegramTokenEndpoint(url) ? normalizeTelegramTokenResponse(response) : response;
  };
}

/** Extracts Telegram's own rejection from whatever `openid-client` threw. */
export function telegramTokenFailureFrom(cause: unknown): TelegramTokenFailure | null {
  if (cause instanceof oidc.ResponseBodyError) {
    return {
      error: cause.error,
      description:
        typeof cause.error_description === 'string' && cause.error_description.length > 0
          ? cause.error_description
          : null,
    };
  }
  // Belt and braces: if the status rewrite above ever stops matching, the raw
  // JSON body still rides along on the library's validation error.
  if (cause instanceof Error && 'body' in cause) {
    return telegramTokenErrorIn((cause as { body: unknown }).body);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* the login domain (BotFather `/setdomain`)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Telegram refuses an authorization request by serving a **bare plain-text line
 * with HTTP 200** - not an OAuth `error` parameter, not JSON, and not a redirect
 * back to `redirect_uri`. «Bot domain invalid» is that page, and because our
 * callback is never reached there is nothing downstream that can turn it into a
 * diagnosis: the user just lands on a white page with three English words.
 *
 * These are the refusals that mean the request never had a chance. Matching them
 * is what lets `/start` fail on our side, in Russian, with the origin we
 * actually sent written into the log line.
 */
export const TELEGRAM_ORIGIN_REFUSALS = [
  'bot domain invalid',
  'bot_id required',
  'bot_id invalid',
  'origin required',
  'origin invalid',
] as const;

/** Telegram's own words when it refused, or `null` when it did not. */
export function telegramRefusalReason(body: string): string | null {
  const head = body.trim().slice(0, 120).toLowerCase();
  return TELEGRAM_ORIGIN_REFUSALS.find((refusal) => head.startsWith(refusal)) ?? null;
}

/**
 * The `origin` Telegram is given - derived from `APP_PUBLIC_URL` and nothing
 * else, so it can never drift from `publicOrigin`, `cookieDomain` or the
 * redirect URI.
 *
 * `URL.origin` is what makes this safe. Telegram compares the value literally
 * against the domain registered with BotFather, and `.origin` drops every way
 * that comparison silently fails: a path, a query, a fragment, a trailing
 * slash, userinfo, a default port, and an upper-case host.
 *
 * What it deliberately does **not** do is rewrite the host. Stripping or adding
 * a `www.` prefix here would quietly disagree with `cookieDomain`, which comes
 * from the same URL - if the registered domain carries a `www.`, the thing to
 * fix is `APP_PUBLIC_URL`.
 */
export function telegramLoginOrigin(publicOrigin: string = getConfig().publicOrigin): string {
  let url: URL;
  try {
    url = new URL(publicOrigin);
  } catch (cause) {
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      `APP_PUBLIC_URL is not a valid URL: ${publicOrigin}`,
      {
        cause,
      },
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      `Telegram sign-in needs an http(s) APP_PUBLIC_URL, got "${url.protocol}"`,
    );
  }
  return url.origin;
}

export interface TelegramLoginDomainCheck {
  /** False only when Telegram itself refused. An unreachable probe is `true`. */
  ok: boolean;
  origin: string;
  botId: string;
  /** Telegram's own words when it refused, `null` otherwise. */
  reason: string | null;
  /** The probe failed (DNS, timeout, TLS) and therefore proved nothing. */
  indeterminate: boolean;
}

const TELEGRAM_PROBE_TIMEOUT_MS = 4_000;
/** A registered domain effectively never changes; a broken one is being fixed. */
const TELEGRAM_DOMAIN_OK_TTL_MS = 10 * 60_000;
const TELEGRAM_DOMAIN_BAD_TTL_MS = 60_000;

/**
 * Asks Telegram whether this bot accepts this origin, without involving a user.
 *
 * `embed=1` makes the authorization endpoint answer with the widget page rather
 * than a redirect, so a refusal comes back as exactly the plain-text line the
 * user would have seen. A probe that cannot reach Telegram returns
 * `indeterminate` with `ok: true` on purpose - refusing to start a login
 * because *our* health check could not resolve DNS is a worse outage than the
 * one it prevents.
 */
export async function probeTelegramLoginDomain(input: {
  botId: string;
  origin: string;
  fetchImpl?: typeof fetch;
}): Promise<TelegramLoginDomainCheck> {
  const url = new URL('/auth', TELEGRAM_ISSUER_URL);
  url.searchParams.set('bot_id', input.botId);
  url.searchParams.set('origin', input.origin);
  url.searchParams.set('embed', '1');

  const base = { origin: input.origin, botId: input.botId };
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(TELEGRAM_PROBE_TIMEOUT_MS),
    });
    const reason = telegramRefusalReason(await response.text());
    return { ...base, ok: reason === null, reason, indeterminate: false };
  } catch {
    return { ...base, ok: true, reason: null, indeterminate: true };
  }
}

let domainCheckCache: { key: string; at: number; result: TelegramLoginDomainCheck } | undefined;

/**
 * Throws `SERVICE_UNAVAILABLE` when the bot has no BotFather domain matching the
 * origin we are about to send.
 *
 * The whole point is *where* it throws: on our side, before the redirect, with
 * `origin`, `botId` and the fix in one log line - instead of on Telegram's
 * «Bot domain invalid» page, where nothing of ours ever runs again.
 */
export async function assertTelegramLoginDomain(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<TelegramLoginDomainCheck> {
  const cfg = telegramConfig();
  const origin = telegramLoginOrigin();
  // Keyed on both, so rotating the bot or moving the origin re-probes at once.
  const key = `${cfg.botId} ${origin}`;
  const now = Date.now();

  const cached = domainCheckCache;
  const ttl = cached?.result.ok ? TELEGRAM_DOMAIN_OK_TTL_MS : TELEGRAM_DOMAIN_BAD_TTL_MS;
  let result: TelegramLoginDomainCheck;
  if (cached && cached.key === key && now - cached.at < ttl) {
    result = cached.result;
  } else {
    result = await probeTelegramLoginDomain({
      botId: cfg.botId,
      origin,
      fetchImpl: options.fetchImpl,
    });
    domainCheckCache = { key, at: now, result };
    if (result.indeterminate) {
      logger.warn(
        { origin, botId: cfg.botId },
        'could not verify the Telegram login domain; starting the flow anyway',
      );
    }
  }

  if (!result.ok) {
    const host = new URL(origin).host;
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      'Telegram login domain is not registered for this bot',
      {
        context: {
          // Everything the next person needs, in one log line.
          origin,
          botId: cfg.botId,
          botUsername: cfg.botUsername,
          telegramSaid: result.reason,
          fix: `@BotFather -> /setdomain -> @${cfg.botUsername || '<bot>'} -> ${host}`,
        },
      },
    );
  }
  return result;
}

export interface TelegramAuthSecrets {
  nonce: string;
  codeVerifier: string;
}

export function newTelegramAuthSecrets(): TelegramAuthSecrets {
  return { nonce: oidc.randomNonce(), codeVerifier: oidc.randomPKCECodeVerifier() };
}

/**
 * The authorization request parameters, as a pure function of its inputs.
 *
 * Split out from `buildTelegramAuthorizationUrl` so the shape can be asserted
 * without discovery, without a network call and without a bot token - notably
 * that `origin` and `redirect_uri` are both built from `APP_PUBLIC_URL` and
 * agree with each other exactly.
 */
export function telegramAuthorizationParams(input: {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  origin: string;
}): Record<string, string> {
  return {
    redirect_uri: input.redirectUri,
    scope: TELEGRAM_SCOPES,
    response_type: 'code',
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    /**
     * Telegram-specific and not part of OIDC.
     *
     * `oauth.telegram.org` refuses the request with "Origin required" unless
     * this is present, and it must match a domain registered against the bot
     * with BotFather's `/setdomain` - otherwise the answer is «Bot domain
     * invalid». Standard OIDC has no such parameter, so `openid-client` does
     * not send it and the flow fails on Telegram's page rather than anywhere in
     * our code. `telegramLoginOrigin` is the only source of the value.
     */
    origin: input.origin,
  };
}

export async function buildTelegramAuthorizationUrl(input: {
  state: string;
  nonce: string;
  codeVerifier: string;
}): Promise<string> {
  const cfg = telegramConfig();
  const origin = telegramLoginOrigin();

  // Cheapest preflight first, and the only one that needs no network: a missing
  // client secret cannot possibly produce a successful exchange, so there is no
  // reason to send the user to Telegram and let them approve a login that dies
  // on the way back.
  assertTelegramClientAuth();

  const configuration = await getTelegramConfiguration();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(input.codeVerifier);

  // Preflight, cached. Without it the only symptom of an unregistered BotFather
  // domain is Telegram's bare «Bot domain invalid» page - which our callback
  // never sees, so it can be neither logged nor translated.
  await assertTelegramLoginDomain();

  return oidc.buildAuthorizationUrl(
    configuration,
    telegramAuthorizationParams({
      state: input.state,
      nonce: input.nonce,
      codeChallenge,
      redirectUri: cfg.redirectUri,
      origin,
    }),
  ).href;
}

/**
 * Normalizes a Telegram user id to the string form `user_identities` stores.
 *
 * The `id` claim arrives as a JSON *number* (`987654321`), while the widget and
 * Mini App payloads carry the same value as a *string*. Collapsing both to a
 * string here is what lets the three flows produce one identical key. Telegram
 * guarantees user ids fit in 52 bits, so the `JSON.parse` inside the JWT decoder
 * is lossless and `String(value)` is exact; `Number.isSafeInteger` rejects
 * anything that would not be.
 */
function telegramClaimUserId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return '';
}

/**
 * Maps verified OIDC claims onto our profile shape. Email is always NULL.
 *
 * **The identity key is the `id` claim, not `sub`** — they are different values.
 * Telegram's scope table (https://core.telegram.org/bots/telegram-login) is
 * explicit:
 *
 *   openid  → `sub, iss, iat, exp`                  "the user's unique identifier"
 *   profile → `id, name, preferred_username, picture`
 *             "user's basic info: user ID, name, username, and profile photo URL"
 *
 * The numeric Telegram user id sits behind the **`profile`** scope while `sub`
 * sits behind `openid`. A provider does not put two names on one value and then
 * charge a separate scope for the second — the scope boundary *is* the proof
 * they differ. Telegram's worked example says the same thing numerically:
 * `"sub": "1234123412341234123"` is ~1.2e18, past the 2^52 ceiling the Bot API
 * guarantees for user ids, so that `sub` could not be a user id even in
 * principle, while the example's `"id": 987654321` is an ordinary one.
 *
 * `id` is exactly what `verifyTelegramWidget` and `verifyTelegramInitData` key
 * on below, and what the bot needs to DM anybody. Keying OIDC off `sub` instead
 * gives one human **two** `user_identities` rows; because registration is
 * admin-gated, their second sign-in would then arrive as a stranger awaiting
 * approval. The `telegram identity key parity` tests in `oauth.test.ts` pin the
 * three paths together so this cannot regress.
 *
 * `sub` is still recorded in `raw_profile` — it is the OIDC subject and worth
 * having when debugging a token, it is simply not the join key.
 */
export function telegramProfileFromClaims(claims: Record<string, unknown>): OAuthProfile {
  const providerUserId = telegramClaimUserId(claims.id);
  if (!providerUserId) {
    /*
     * Deliberately fatal rather than falling back to `sub`. A missing `id` means
     * the `profile` scope was not granted (we always request it — see
     * TELEGRAM_SCOPES), and substituting `sub` would mint a second,
     * permanently unreconcilable identity for someone who may already have
     * signed in through the widget. A loud, fixable failure beats silent
     * duplicate-account corruption.
     */
    throw new AppError(
      'TOKEN_INVALID',
      'Telegram id_token has no `id` claim — the `profile` scope is required',
    );
  }

  const username = typeof claims.preferred_username === 'string' ? claims.preferred_username : null;

  return {
    provider: 'telegram',
    providerUserId,
    // Telegram never returns an email. Not "sometimes" — never.
    email: null,
    emailVerified: false,
    displayName: typeof claims.name === 'string' ? claims.name : null,
    username,
    avatarUrl: typeof claims.picture === 'string' ? claims.picture : null,
    rawProfile: sanitizeRawProfile({
      iss: claims.iss,
      sub: claims.sub,
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
  assertTelegramClientAuth();
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

    const failure = telegramTokenFailureFrom(cause);
    if (failure) {
      // `invalid_client` is a server misconfiguration, not a bad request from
      // this user: 503 is what makes the login page render «Вход через Telegram
      // не настроен на сервере…» instead of the generic «попробуйте через
      // минуту», which would be a lie — retrying never fixes a missing secret.
      const misconfigured = failure.error === 'invalid_client';
      throw new AppError(
        misconfigured ? 'SERVICE_UNAVAILABLE' : 'OAUTH_PROVIDER_ERROR',
        `Telegram token exchange failed: ${failure.error}`,
        {
          cause,
          context: {
            botId: cfg.botId,
            botUsername: cfg.botUsername,
            redirectUri: cfg.redirectUri,
            telegramError: failure.error,
            telegramDescription: failure.description,
            ...(misconfigured ? { fix: TELEGRAM_CLIENT_SECRET_FIX } : {}),
            hint: telegramTokenErrorHint(failure.error),
          },
        },
      );
    }
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
