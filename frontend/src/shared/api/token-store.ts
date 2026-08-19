/**
 * Access-token store.
 *
 * D3: the access token is an HS256 JWT with a 10-minute lifetime and it lives
 * **in JS memory only**. Never `localStorage`, never `sessionStorage`, never a
 * cookie we can read:
 *
 *  - `localStorage` is readable by any XSS payload and, on iOS, is subject to
 *    the 7-day script-writable storage eviction cap — an installed PWA would
 *    silently log the family out after a week away.
 *  - Durable login is the refresh token's job, and that lives in a
 *    `__Host-rt; HttpOnly; Secure; SameSite=Lax` cookie the JS never touches.
 *
 * Consequence: a page reload starts with no access token. That is fine and by
 * design — the first request 401s, `refresh.ts` exchanges the cookie for a new
 * access token, and the request is retried.
 */

let accessToken: string | null = null;

type Listener = (token: string | null) => void;
const listeners = new Set<Listener>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  if (accessToken === token) return;
  accessToken = token;
  for (const listener of listeners) listener(accessToken);
}

export function clearAccessToken(): void {
  setAccessToken(null);
}

/** Subscribe to token changes (used to reset query caches on sign-out). */
export function onAccessTokenChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True once a token has been obtained in this tab. Not an authorisation check —
 * only a hint that lets the shell skip the "unauthenticated" flash.
 */
export function hasAccessToken(): boolean {
  return accessToken !== null;
}
