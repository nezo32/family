import { randomBytes } from 'node:crypto';

import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTPayload } from 'jose';

import { appleUserPayloadSchema } from '@family/shared';

import { safeEqual } from '../../../core/auth/tokens.js';
import { getConfig } from '../../../core/config.js';
import { AppError } from '../../../core/errors.js';
import { sanitizeRawProfile, type OAuthProfile } from './linking.js';

/**
 * Sign in with Apple.
 *
 * Apple differs from every other provider in four ways, each of which has cost
 * somebody a production outage:
 *
 * 1. **The client secret is a JWT you mint yourself**, signed ES256 with the
 *    `.p8` key, and Apple caps its `exp` at 15 777 000 s (~6 months). It
 *    therefore *cannot* live in an env var without a semi-annual outage on a
 *    date nobody has in their calendar. It is generated at runtime here, with a
 *    30-minute lifetime, and cached.
 * 2. **The callback is a cross-site `form_post`**, which is why `state` lives in
 *    a database table and not a cookie (see `transactions.ts`).
 * 3. **The user's name arrives exactly once**, unsigned, in the `user` form
 *    field of the very first authorization, and never again. Persist it in the
 *    same transaction that creates the identity or it is unrecoverable.
 * 4. **`email_verified` and `is_private_email` come back as strings or as
 *    booleans**, inconsistently, depending on the endpoint and the account. Both
 *    are coerced.
 */

export const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_AUTHORIZE_URL = `${APPLE_ISSUER}/auth/authorize`;
const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`;
const APPLE_JWKS_URL = `${APPLE_ISSUER}/auth/keys`;

/** Apple rejects a client secret whose lifetime exceeds this (~6 months). */
export const APPLE_MAX_CLIENT_SECRET_LIFETIME_SECONDS = 15_777_000;

/**
 * Thirty minutes. Far below Apple's cap, so a clock skew or a long-running
 * request can never produce a secret Apple considers over-long, and short enough
 * that a leaked secret is worthless almost immediately.
 */
export const APPLE_CLIENT_SECRET_LIFETIME_SECONDS = 30 * 60;

/** Re-mint this long before expiry so an in-flight exchange never uses a stale one. */
const CLIENT_SECRET_REFRESH_MARGIN_MS = 60_000;

export const APPLE_SCOPES = 'name email';

/**
 * Apple does not support PKCE, so the nonce is the only replay defence on the
 * id_token. 32 bytes, echoed back verbatim by Apple's web flow.
 */
export function newAppleAuthNonce(): string {
  return randomBytes(32).toString('base64url');
}

/* -------------------------------------------------------------------------- */
/* client secret                                                               */
/* -------------------------------------------------------------------------- */

export interface AppleClientSecretParams {
  /** Contents of `AuthKey_XXXXXXXXXX.p8` (PKCS#8 PEM). */
  privateKeyPem: string;
  /** Apple Developer Team ID — the `iss` claim. */
  teamId: string;
  /** The Services ID — the `sub` claim, and our `client_id`. */
  clientId: string;
  /** The `.p8` key id — the `kid` **header**, not a claim. */
  keyId: string;
  lifetimeSeconds?: number;
  /** Injected in tests. */
  now?: Date;
}

/**
 * Mints the ES256 client-secret JWT. Pure with respect to configuration, so the
 * header and claims can be asserted in a unit test with a throwaway key.
 */
export async function signAppleClientSecret(params: AppleClientSecretParams): Promise<{
  token: string;
  expiresAt: number;
}> {
  const lifetime = params.lifetimeSeconds ?? APPLE_CLIENT_SECRET_LIFETIME_SECONDS;
  if (lifetime <= 0 || lifetime > APPLE_MAX_CLIENT_SECRET_LIFETIME_SECONDS) {
    throw new AppError(
      'INTERNAL_ERROR',
      `Apple client secret lifetime must be between 1 and ${APPLE_MAX_CLIENT_SECRET_LIFETIME_SECONDS} seconds`,
    );
  }

  const key = await importPKCS8(params.privateKeyPem, 'ES256').catch((cause: unknown) => {
    throw new AppError('INTERNAL_ERROR', 'APPLE_PRIVATE_KEY_BASE64 is not a valid PKCS#8 key', {
      cause,
    });
  });

  const issuedAt = Math.floor((params.now?.getTime() ?? Date.now()) / 1000);
  const expiresAt = issuedAt + lifetime;

  const token = await new SignJWT({})
    // `kid` identifies the .p8; without it Apple cannot select the public key.
    .setProtectedHeader({ alg: 'ES256', kid: params.keyId })
    .setIssuer(params.teamId)
    .setSubject(params.clientId)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);

  return { token, expiresAt };
}

let cachedClientSecret: { token: string; expiresAtMs: number } | undefined;

function appleConfig() {
  const cfg = getConfig().oauth.apple;
  if (!cfg.enabled) {
    throw new AppError('SERVICE_UNAVAILABLE', 'Sign in with Apple is not configured');
  }
  return cfg;
}

/** The cached, runtime-generated client secret. Re-minted a minute before it lapses. */
export async function getAppleClientSecret(now: Date = new Date()): Promise<string> {
  if (cachedClientSecret && cachedClientSecret.expiresAtMs - CLIENT_SECRET_REFRESH_MARGIN_MS > now.getTime()) {
    return cachedClientSecret.token;
  }

  const cfg = appleConfig();
  const { token, expiresAt } = await signAppleClientSecret({
    privateKeyPem: cfg.privateKeyPem,
    teamId: cfg.teamId,
    clientId: cfg.clientId,
    keyId: cfg.keyId,
    now,
  });

  cachedClientSecret = { token, expiresAtMs: expiresAt * 1000 };
  return token;
}

export function resetAppleCaches(): void {
  cachedClientSecret = undefined;
  jwks = undefined;
}

/* -------------------------------------------------------------------------- */
/* authorization request                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Apple does not support PKCE, so `code_verifier` stays NULL in the transaction
 * row and `state` + `nonce` carry the whole anti-forgery burden.
 */
export function buildAppleAuthorizationUrl(input: { state: string; nonce: string }): string {
  const cfg = appleConfig();
  const url = new URL(APPLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', APPLE_SCOPES);
  // Requesting any scope forces form_post — and form_post is what makes the
  // callback cross-site, which is what makes the DB-backed state store mandatory.
  url.searchParams.set('response_mode', 'form_post');
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  return url.href;
}

/* -------------------------------------------------------------------------- */
/* the unsigned `user` field                                                   */
/* -------------------------------------------------------------------------- */

export interface AppleUserField {
  displayName: string | null;
  /** Display data only — the authoritative email is the one in the id_token. */
  email: string | null;
}

/**
 * Parses Apple's `user` POST field.
 *
 * Present **only on the very first authorization** for a given Services ID, and
 * **unsigned** — anybody who can reach the callback can put anything in it. It
 * is therefore treated as display data and never as an identity claim: the
 * subject comes from the verified id_token's `sub`, and the authoritative email
 * from the verified id_token's `email`.
 *
 * Malformed JSON is not an error worth failing the login over; the name is
 * simply lost, which is the same outcome as a second authorization.
 */
export function parseAppleUserField(raw: string | null | undefined): AppleUserField {
  if (!raw) return { displayName: null, email: null };

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { displayName: null, email: null };
  }

  const parsed = appleUserPayloadSchema.safeParse(decoded);
  if (!parsed.success) return { displayName: null, email: null };

  const first = parsed.data.name?.firstName?.trim() ?? '';
  const last = parsed.data.name?.lastName?.trim() ?? '';
  const displayName = [first, last].filter(Boolean).join(' ').trim();

  return {
    displayName: displayName.length > 0 ? displayName : null,
    email: parsed.data.email?.trim() || null,
  };
}

/* -------------------------------------------------------------------------- */
/* id_token                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Apple returns `email_verified` and `is_private_email` as `true`/`false`
 * booleans **or** as the strings `"true"`/`"false"`, inconsistently. A naive
 * truthiness check turns `"false"` into `true`, which would silently mark relay
 * addresses as ordinary verified mailboxes.
 */
export function coerceAppleBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

export function appleProfileFromClaims(
  claims: JWTPayload,
  expectedNonce: string,
  userField: AppleUserField = { displayName: null, email: null },
): OAuthProfile {
  const nonce = typeof claims.nonce === 'string' ? claims.nonce : '';
  if (!nonce || !safeEqual(nonce, expectedNonce)) {
    throw new AppError('TOKEN_INVALID', 'Apple id_token nonce does not match');
  }

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) throw new AppError('TOKEN_INVALID', 'Apple id_token has no subject');

  // The id_token is signed; the `user` field is not. The token wins on email.
  const email = typeof claims.email === 'string' ? claims.email : null;
  const isPrivateEmail = coerceAppleBoolean(claims.is_private_email);

  return {
    provider: 'apple',
    providerUserId: sub,
    email,
    emailVerified: coerceAppleBoolean(claims.email_verified),
    isPrivateEmail,
    // The one and only chance to capture the human's name.
    displayName: userField.displayName,
    username: null,
    avatarUrl: null,
    rawProfile: sanitizeRawProfile({
      iss: claims.iss,
      real_user_status: claims.real_user_status,
      auth_time: claims.auth_time,
      is_private_email: isPrivateEmail,
    }),
  };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getAppleJwks() {
  jwks ??= createRemoteJWKSet(new URL(APPLE_JWKS_URL), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });
  return jwks;
}

export async function verifyAppleIdToken(
  idToken: string,
  expectedNonce: string,
  userField?: AppleUserField,
): Promise<OAuthProfile> {
  const cfg = appleConfig();
  try {
    const { payload } = await jwtVerify(idToken, getAppleJwks(), {
      // Apple signs id_tokens with RS256. Pinned so a rogue JWKS entry with a
      // different alg cannot be used to change the verification rules.
      algorithms: ['RS256'],
      issuer: APPLE_ISSUER,
      audience: cfg.clientId,
      clockTolerance: 5,
    });
    return appleProfileFromClaims(payload, expectedNonce, userField);
  } catch (cause) {
    if (AppError.isAppError(cause)) throw cause;
    throw new AppError('TOKEN_INVALID', 'Apple id_token failed verification', { cause });
  }
}

/* -------------------------------------------------------------------------- */
/* code exchange                                                               */
/* -------------------------------------------------------------------------- */

export async function exchangeAppleCode(input: {
  code: string;
  nonce: string;
  userField?: AppleUserField;
}): Promise<OAuthProfile> {
  const cfg = appleConfig();
  const clientSecret = await getAppleClientSecret();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new AppError('OAUTH_PROVIDER_ERROR', 'Apple token exchange failed', {
      context: { status: response.status, detail: detail.slice(0, 500) },
    });
  }

  const payload = (await response.json()) as { id_token?: unknown };
  if (typeof payload.id_token !== 'string') {
    throw new AppError('OAUTH_PROVIDER_ERROR', 'Apple returned no id_token');
  }

  return verifyAppleIdToken(payload.id_token, input.nonce, input.userField);
}
