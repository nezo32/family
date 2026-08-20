import { useEffect, useState } from 'react';

import { API_BASE_URL, API_PREFIX } from './config';
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
 * Origins whose `/api/...` paths are *ours*, and may therefore be sent the
 * session's bearer token.
 *
 * Two, not one, because the two deployments differ. Same-origin production
 * leaves `VITE_API_URL` empty and the backend writes a relative
 * `/api/users/:id/avatar?v=…`, which resolves against the document. A
 * split-origin deployment points `API_BASE_URL` at another host, and the same
 * relative path still has to work while absolute API URLs start matching too.
 */
function apiOrigins(): readonly string[] {
  const documentOrigin = window.location.origin;
  if (API_BASE_URL === '') return [documentOrigin];
  try {
    return [documentOrigin, new URL(API_BASE_URL, documentOrigin).origin];
  } catch {
    return [documentOrigin];
  }
}

/**
 * Is `url` our own avatar endpoint, as opposed to a provider's CDN?
 *
 * **This is a security boundary, not a formatting question.** `avatarUrl` is
 * whatever `PATCH /api/me` was last given — an absolute `https://` URL of the
 * caller's choosing, up to 2048 characters — so the answer decides whether an
 * access token that authenticates against this API is handed to a host chosen
 * by a family member. Google and Telegram write real ones when an account is
 * linked; nothing stops a member writing `https://example.invalid/api/x`.
 *
 * Resolved through `URL` and compared by **origin**, never by string prefix.
 * `https://lh3.googleusercontent.com/api/a/ACg8…` starts with neither `/api/`
 * nor our base, but the shape of that argument is the shape of every
 * prefix-matching bypass, and the parser is the thing that cannot be talked
 * into a wrong answer. `data:` and `blob:` parse fine and are deliberately
 * excluded: they are not a fetch we need to authenticate.
 */
export function isApiImagePath(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!apiOrigins().includes(parsed.origin)) return false;
  return parsed.pathname.startsWith(`${API_PREFIX}/`);
}

async function fetchImage(url: string, retried = false): Promise<string | null> {
  // The guard lives *here*, wrapped around the only line that reads the token,
  // rather than at the call site. Structure, not convention: `avatarUrl` comes
  // out of the database, and "remember to check before calling" is exactly the
  // rule that gets forgotten the next time somebody adds a caller.
  if (!isApiImagePath(url)) return null;

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
  const [resolved, setResolved] = useState<string | null>(() => {
    if (!url) return null;
    // A provider URL is already renderable; ours is only renderable if the
    // bytes are in the cache from an earlier screen.
    return isApiImagePath(url) ? (cache.get(url) ?? null) : url;
  });

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

/** Everything an `<img>` needs in order to show one person's avatar. */
export interface AvatarSource {
  /** Ready for `<img src>`, or `null` — meaning "show the initials". */
  src: string | null;
  /**
   * The bytes come from a provider's CDN rather than from us.
   *
   * Worth knowing at the call site for one reason: an external `<img>` tells
   * that provider a member opened this app, and `referrer` would tell them
   * which screen. `no-referrer` is the cheap half of the fix; the other half
   * would be to stop loading provider images at all (see the note in
   * `UserAvatar`).
   */
  external: boolean;
}

/**
 * The one entry point for "render this `avatarUrl`".
 *
 * Both faces in this app — `UserAvatar` and `MemberDisc` — go through here, so
 * the same-origin decision is made once. Two components each deciding for
 * themselves whether a URL is ours is how one of them ends up wrong.
 */
export function useAvatarSource(url: string | null | undefined): AvatarSource {
  const src = useAuthedImage(url);
  return { src, external: url ? !isApiImagePath(url) : false };
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
