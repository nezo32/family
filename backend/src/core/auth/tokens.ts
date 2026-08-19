import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import { getConfig } from '../config.js';
import { AppError } from '../errors.js';

/**
 * Access tokens and refresh tokens.
 *
 * - Access token: short-lived HS256 JWT, held **in memory only** by the client.
 * - Refresh token: opaque random bytes, stored **hashed** server-side, delivered
 *   in a `__Host-` HttpOnly cookie.
 *
 * See D3. The refresh token is deliberately not a JWT: it must be revocable
 * server-side, and rotation with reuse detection needs a database row anyway.
 */

const ISSUER = 'family-app';
const AUDIENCE = 'family-app-client';

/** Claims carried by the access token. `status` is embedded so a suspension takes effect within one token lifetime. */
export const accessTokenClaimsSchema = z.object({
  sub: z.string().uuid(),
  role: z.string(),
  status: z.string(),
  /** Refresh-token family id, so an access token can be traced to its session. */
  sid: z.string().uuid(),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

let accessSecret: Uint8Array | undefined;
function getAccessSecret(): Uint8Array {
  accessSecret ??= new TextEncoder().encode(getConfig().JWT_ACCESS_SECRET);
  return accessSecret;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  const config = getConfig();
  return new SignJWT({ role: claims.role, status: claims.status, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getAccessSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, getAccessSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      // Pinned: never let the token choose its own algorithm.
      algorithms: ['HS256'],
      clockTolerance: 5,
    });
    return accessTokenClaimsSchema.parse(payload);
  } catch (err) {
    const code =
      err instanceof Error && err.name === 'JWTExpired' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    throw new AppError(code, 'Access token is not valid', { cause: err });
  }
}

/* ------------------------------ refresh tokens ------------------------------ */

/** 32 bytes of entropy, base64url. Returned to the client exactly once. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What we persist. The raw token never touches the database. */
export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

/** Constant-time comparison for anything secret-shaped. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* --------------------------------- cookies --------------------------------- */

/**
 * `__Host-` is browser-enforced: it requires `Secure`, requires `Path=/`, and
 * forbids `Domain=`, which makes the cookie un-settable by a compromised
 * sibling subdomain. Over plain HTTP (local dev) the prefix is illegal, so we
 * fall back to an unprefixed name there.
 */
export function refreshCookieName(): string {
  return getConfig().useSecureCookies ? '__Host-rt' : 'rt';
}

export function refreshCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  const config = getConfig();
  return {
    httpOnly: true,
    secure: config.useSecureCookies,
    // Lax, not Strict: Strict withholds the cookie on the top-level GET that
    // returns from an OAuth provider, so the user lands logged out and loops.
    sameSite: 'lax',
    path: '/',
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  };
}
