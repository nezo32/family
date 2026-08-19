import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import * as oidc from 'openid-client';

import { safeEqual } from '../../../core/auth/tokens.js';
import { getConfig } from '../../../core/config.js';
import { AppError } from '../../../core/errors.js';
import { sanitizeRawProfile, type OAuthProfile } from './linking.js';

/**
 * Sign in with Google — OIDC authorization code + PKCE (D3).
 *
 * Three things here are easy to get wrong and are therefore spelled out:
 *
 * 1. **`client_secret` is still required alongside PKCE.** Google's "Web
 *    application" client type is a confidential client; PKCE is defence in depth
 *    on top of client authentication, not a replacement for it. Dropping the
 *    secret because "we use PKCE now" produces `invalid_client` at the token
 *    endpoint, in production, after the consent screen.
 * 2. **Both `https://accounts.google.com` and `accounts.google.com` are valid
 *    `iss` values.** Google documents both forms and has emitted both. A strict
 *    single-issuer check rejects real tokens, so the id_token is verified here
 *    with `jose` against the discovered JWKS, with the issuer allow-list — the
 *    one place this module deviates from letting `openid-client` do the whole
 *    grant. Discovery, PKCE and the authorization URL are still its job.
 * 3. **The identity key is `sub`, never `email`.** Workspace domains recycle
 *    addresses; `sub` is the only stable subject.
 */

const GOOGLE_ISSUER_URL = new URL('https://accounts.google.com');

/** The two `iss` spellings Google is documented to emit. */
export const GOOGLE_ACCEPTED_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export const GOOGLE_SCOPES = 'openid email profile';

/* -------------------------------------------------------------------------- */
/* discovery (cached)                                                          */
/* -------------------------------------------------------------------------- */

let configurationPromise: Promise<oidc.Configuration> | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function googleConfig() {
  const cfg = getConfig().oauth.google;
  if (!cfg.enabled) {
    throw new AppError('SERVICE_UNAVAILABLE', 'Google sign-in is not configured');
  }
  return cfg;
}

/**
 * The discovery document is cached for the process lifetime — it changes about
 * once a decade, and re-fetching it on every `/start` adds a network round trip
 * to the critical path of every login.
 */
export async function getGoogleConfiguration(): Promise<oidc.Configuration> {
  const cfg = googleConfig();
  configurationPromise ??= oidc
    .discovery(GOOGLE_ISSUER_URL, cfg.clientId, {
      client_secret: cfg.clientSecret,
      id_token_signed_response_alg: 'RS256',
    })
    .catch((cause: unknown) => {
      // Do not memoize a failure: a transient DNS blip would otherwise poison
      // Google sign-in until the next deploy.
      configurationPromise = undefined;
      throw new AppError('SERVICE_UNAVAILABLE', 'Google OIDC discovery failed', { cause });
    });
  return configurationPromise;
}

/** Test seam / hot-reload helper. */
export function resetGoogleCaches(): void {
  configurationPromise = undefined;
  jwks = undefined;
}

/* -------------------------------------------------------------------------- */
/* authorization request                                                       */
/* -------------------------------------------------------------------------- */

export interface GoogleAuthSecrets {
  nonce: string;
  codeVerifier: string;
}

/** Generated before the transaction row is written, then stored alongside `state`. */
export function newGoogleAuthSecrets(): GoogleAuthSecrets {
  return { nonce: oidc.randomNonce(), codeVerifier: oidc.randomPKCECodeVerifier() };
}

export async function buildGoogleAuthorizationUrl(input: {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Pre-fills the account chooser when re-authenticating a known user. */
  loginHint?: string | undefined;
}): Promise<string> {
  const cfg = googleConfig();
  const configuration = await getGoogleConfiguration();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(input.codeVerifier);

  const parameters: Record<string, string> = {
    redirect_uri: cfg.redirectUri,
    scope: GOOGLE_SCOPES,
    response_type: 'code',
    state: input.state,
    nonce: input.nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  };
  if (input.loginHint) parameters.login_hint = input.loginHint;

  return oidc.buildAuthorizationUrl(configuration, parameters).href;
}

/* -------------------------------------------------------------------------- */
/* callback                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Maps verified id_token claims onto our profile shape.
 *
 * Pure, and therefore the part that is unit tested: the nonce comparison and the
 * "`sub` is the key" rule are the two failure modes that matter.
 */
export function googleProfileFromClaims(claims: JWTPayload, expectedNonce: string): OAuthProfile {
  const nonce = typeof claims.nonce === 'string' ? claims.nonce : '';
  if (!nonce || !safeEqual(nonce, expectedNonce)) {
    // A replayed id_token from a different authorization request.
    throw new AppError('TOKEN_INVALID', 'Google id_token nonce does not match');
  }

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) throw new AppError('TOKEN_INVALID', 'Google id_token has no subject');

  const email = typeof claims.email === 'string' ? claims.email : null;
  const name = typeof claims.name === 'string' ? claims.name : null;
  const picture = typeof claims.picture === 'string' ? claims.picture : null;

  return {
    provider: 'google',
    // The identity key. Deliberately not the email.
    providerUserId: sub,
    email,
    emailVerified: claims.email_verified === true,
    displayName: name,
    username: null,
    avatarUrl: picture,
    rawProfile: sanitizeRawProfile({
      iss: claims.iss,
      hd: claims.hd,
      given_name: claims.given_name,
      family_name: claims.family_name,
      locale: claims.locale,
    }),
  };
}

function getGoogleJwks(jwksUri: string) {
  jwks ??= createRemoteJWKSet(new URL(jwksUri), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });
  return jwks;
}

/** Verifies a Google id_token: RS256 only, either issuer spelling, our audience. */
export async function verifyGoogleIdToken(
  idToken: string,
  expectedNonce: string,
  jwksUri: string,
): Promise<OAuthProfile> {
  const cfg = googleConfig();
  try {
    const { payload } = await jwtVerify(idToken, getGoogleJwks(jwksUri), {
      // Pinned. Never let the token pick its own algorithm.
      algorithms: ['RS256'],
      audience: cfg.clientId,
      issuer: GOOGLE_ACCEPTED_ISSUERS,
      clockTolerance: 5,
    });
    return googleProfileFromClaims(payload, expectedNonce);
  } catch (cause) {
    if (AppError.isAppError(cause)) throw cause;
    throw new AppError('TOKEN_INVALID', 'Google id_token failed verification', { cause });
  }
}

/**
 * Exchanges the authorization code and returns the verified profile.
 *
 * The POST is written out rather than delegated to `authorizationCodeGrant`
 * purely so the dual-issuer check above is possible; everything else (endpoint,
 * client authentication method, PKCE) comes from the discovery document.
 */
export async function exchangeGoogleCode(input: {
  code: string;
  codeVerifier: string;
  nonce: string;
}): Promise<OAuthProfile> {
  const cfg = googleConfig();
  const configuration = await getGoogleConfiguration();
  const metadata = configuration.serverMetadata();

  const tokenEndpoint = metadata.token_endpoint;
  const jwksUri = metadata.jwks_uri;
  if (!tokenEndpoint || !jwksUri) {
    throw new AppError('SERVICE_UNAVAILABLE', 'Google discovery document is incomplete');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    // Required even with PKCE for a Google "Web application" client.
    client_secret: cfg.clientSecret,
    code_verifier: input.codeVerifier,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new AppError('OAUTH_PROVIDER_ERROR', 'Google token exchange failed', {
      context: { status: response.status, detail: detail.slice(0, 500) },
    });
  }

  const payload = (await response.json()) as { id_token?: unknown };
  if (typeof payload.id_token !== 'string') {
    throw new AppError('OAUTH_PROVIDER_ERROR', 'Google returned no id_token');
  }

  return verifyGoogleIdToken(payload.id_token, input.nonce, jwksUri);
}
