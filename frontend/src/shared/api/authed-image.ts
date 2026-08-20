import { useEffect, useState } from 'react';

import { API_BASE_URL } from './config';
import { refreshAccessToken } from './refresh';
import { getAccessToken, onAccessTokenChange } from './token-store';

/**
 * Loading an image that lives behind the session.
 *
 * Avatars are served by `GET /api/users/:id/avatar`, straight out of a private
 * bucket that has no route to the internet — which is the point: a family photo
 * is exactly as readable as the rest of the family's data, no more. The cost is
 * that `<img src="/api/users/…">` cannot work on its own: this app authenticates
 * with an in-memory bearer token (D3), and an `<img>` sends no `Authorization`
 * header. Left alone it would 401 and render as a broken image on every screen.
 *
 * So the bytes are fetched with the token and handed to the `<img>` as an
 * object URL. Two things keep that from being expensive:
 *
 * - **A module-level cache**, so the roster screen showing the same six people
 *   in four places issues six requests, not twenty-four.
 * - **The browser's own HTTP cache**, which still applies: the request is made
 *   with the default cache mode (not `no-store`, unlike `api/client.ts`), so the
 *   `private, max-age=31536000, immutable` the server sends is honoured and a
 *   revisit costs no network at all. This is why the serving route bothers with
 *   `Cache-Control` and an `ETag` even though nothing renders it directly.
 *
 * Absolute URLs — the ones Google and Telegram write when an account is
 * linked — are passed straight through. They are somebody else's host and need
 * no token.
 */

/** Bounded so a long session cannot accumulate object URLs without limit. */
const MAX_ENTRIES = 48;

/** Insertion-ordered: `Map` iteration order is the eviction order. */
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** URLs that failed, so a broken avatar is not retried on every render. */
const failed = new Set<string>();

function remember(key: string, objectUrl: string): void {
  cache.set(key, objectUrl);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (evicted) URL.revokeObjectURL(evicted);
  }
}

/**
 * A same-origin API path we must authenticate, as opposed to a provider's CDN.
 *
 * Checked by shape rather than by "is it relative", because `VITE_API_URL` can
 * point the API at another origin in a split deployment and those requests
 * still need the token.
 */
export function isApiImagePath(url: string): boolean {
  if (url.startsWith('/api/')) return true;
  return API_BASE_URL !== '' && url.startsWith(`${API_BASE_URL}/api/`);
}

async function fetchImage(url: string, retried = false): Promise<string | null> {
  const token = getAccessToken();
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    credentials: 'same-origin',
    // Deliberately NOT `no-store`: this is the one request in the app whose
    // whole point is to be cached by the browser for a year.
    cache: 'default',
  });

  if (response.status === 401 && !retried) {
    // A cold page load has no access token yet — the very first render of the
    // shell asks for an avatar before `refresh.ts` has exchanged the cookie.
    const refreshed = await refreshAccessToken();
    if (refreshed) return fetchImage(url, true);
  }

  if (!response.ok) return null;
  return URL.createObjectURL(await response.blob());
}

function load(url: string): Promise<string | null> {
  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = fetchImage(url)
    .catch(() => null)
    .then((objectUrl) => {
      inflight.delete(url);
      if (objectUrl) remember(url, objectUrl);
      else failed.add(url);
      return objectUrl;
    });

  inflight.set(url, promise);
  return promise;
}

/**
 * Resolve `url` into something an `<img>` can render, or `null`.
 *
 * `null` covers "no avatar", "still loading" and "it failed" — all three mean
 * the same thing to the caller, which is to show the initials fallback. That
 * collapse is intentional: `UserAvatar` has a good fallback and a spinner where
 * a 32px avatar goes is noise.
 */
export function useAuthedImage(url: string | null | undefined): string | null {
  const needsAuth = Boolean(url) && isApiImagePath(url as string);
  const [resolved, setResolved] = useState<string | null>(() =>
    url && needsAuth ? (cache.get(url) ?? null) : (url ?? null),
  );

  useEffect(() => {
    if (!url) {
      setResolved(null);
      return;
    }
    if (!isApiImagePath(url)) {
      setResolved(url);
      return;
    }

    const cached = cache.get(url);
    if (cached) {
      setResolved(cached);
      return;
    }
    if (failed.has(url)) {
      setResolved(null);
      return;
    }

    let alive = true;
    setResolved(null);
    void load(url).then((objectUrl) => {
      if (alive) setResolved(objectUrl);
    });

    return () => {
      alive = false;
    };
  }, [url]);

  return resolved;
}

/** Drop every cached object URL. */
export function clearAuthedImageCache(): void {
  for (const objectUrl of cache.values()) URL.revokeObjectURL(objectUrl);
  cache.clear();
  inflight.clear();
  failed.clear();
}

/**
 * Sign-out invalidates every one of these: the object URLs point at bytes the
 * next person at this browser must not see, and the failure set would otherwise
 * outlive the reason it exists.
 */
onAccessTokenChange((token) => {
  if (token === null) clearAuthedImageCache();
});
