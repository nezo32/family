import { useEffect, useRef, useState } from 'react';

import { apiUrl } from '@/shared/api/config';
import { refreshAccessToken } from '@/shared/api/refresh';
import { getAccessToken, onAccessTokenChange } from '@/shared/api/token-store';

/**
 * Turning `/api/media/<id>` into something an `<img>`, a `<video>` or an
 * `<audio>` can actually load.
 *
 * ## The problem, stated plainly, because it is a real gap and not a detail
 *
 * `GET /api/media/:id` is guarded by the ordinary auth plugin, which reads the
 * **`Authorization: Bearer` header and nothing else** — there is no cookie
 * fallback (`extractBearer` in `backend/src/core/plugins/auth.ts`). This app's
 * access token lives in JS memory by design (D3). A media element sends no
 * headers it was not given, and it cannot be given any. So
 * `<video src="/api/media/…">` 401s, silently, and renders as an element that
 * never starts.
 *
 * The consequence is worth naming because the backend paid for the thing it
 * defeats: `media.routes.ts` implements **`Range` end to end** — a real `206`
 * with `Content-Range`, so a scrubber drag costs one request for the part you
 * dragged to. Nothing in this PWA can currently ask for a range, because every
 * byte arrives through the fetch below. The 206 path is correct, tested and
 * unreachable from this client.
 *
 * ## What is done instead, and what it costs
 *
 * The bytes are fetched once with the token and handed over as an object URL —
 * the same trick `shared/api/authed-image.ts` plays for avatars, which is why
 * this reads like it. The costs, so nobody discovers them later:
 *
 * - **No range requests and no partial playback.** A video plays when it has
 *   finished downloading, not while it downloads.
 * - **The whole object is resident** while its element is mounted. The contract
 *   caps video at 100 MiB.
 * - **`preload="none"` stops being the mechanism and becomes the intent.**
 *   Nothing is fetched until somebody taps, which is what §D7.14.5 actually
 *   wanted; the attribute stays on the element for every other browser in the
 *   house.
 *
 * ## The fix, which is one rule in the service worker
 *
 * `src/sw.ts` already intercepts every same-origin `GET`. A rule that matched
 * `/api/media/` and re-issued the request with the token — forwarding `Range`
 * and the `206` untouched — would make `<video src>` work natively, restore
 * seeking, and delete most of this file. It needs the token inside the worker
 * (a `postMessage` on every `setAccessToken`, which `sw-bridge.ts` already has
 * the shape for). It is **out of this change's scope** and is the single
 * highest-value follow-up in the media feature.
 *
 * ## Why not `authed-image.ts` itself
 *
 * Two reasons, and the first is a live bug rather than a preference. That cache
 * is bounded at 48 entries and **revokes on eviction with no idea whether the
 * URL is still on screen** — fine for six avatars, wrong for a feed where one
 * page is fifteen cards and up to sixty photos, which would revoke the object
 * URL of a photo the reader is looking at and blank it. This cache is
 * **reference-counted**: an object URL is released when the last element using
 * it unmounts, never because a newer one arrived. Second, it is `<img>`-shaped
 * (it returns a string and swallows failure into "show the initials"), and a
 * video that failed to load needs to say so.
 */

interface Entry {
  objectUrl: string;
  /** Live consumers. The object URL is revoked when this reaches zero. */
  refs: number;
  byteSize: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry | null>>();

/**
 * Bytes kept alive by consumers that have all unmounted.
 *
 * Nothing is revoked eagerly on unmount: scrolling a photo out of the feed and
 * back in is the common case, and re-downloading it every time would make the
 * feed cost more the longer you read it. Instead a released entry lingers until
 * the total parked size crosses this line, then the least-recently-released
 * ones go. 64 MiB is roughly two phone screens' worth of photos and never one
 * video.
 */
const PARKED_BUDGET = 64 * 1024 * 1024;

/** Released entries, oldest first. `Map` iteration order is the eviction order. */
const parked = new Map<string, Entry>();

function park(key: string, entry: Entry): void {
  parked.delete(key);
  parked.set(key, entry);
  let total = 0;
  for (const item of parked.values()) total += item.byteSize;
  for (const [oldest, item] of parked) {
    if (total <= PARKED_BUDGET) break;
    total -= item.byteSize;
    parked.delete(oldest);
    entries.delete(oldest);
    URL.revokeObjectURL(item.objectUrl);
  }
}

async function fetchObject(url: string, retried = false): Promise<Entry | null> {
  const token = getAccessToken();
  const response = await fetch(apiUrl(url), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    credentials: 'same-origin',
    // Deliberately not `no-store`. The server sends
    // `private, max-age=31536000, immutable` and a media id is one set of bytes
    // forever, so a revisit inside a session should cost no network at all.
    cache: 'default',
  });

  if (response.status === 401 && !retried) {
    // A cold PWA start renders the feed before `refresh.ts` has exchanged the
    // cookie for an access token.
    const refreshed = await refreshAccessToken();
    if (refreshed) return fetchObject(url, true);
  }
  if (!response.ok) return null;

  const blob = await response.blob();
  return { objectUrl: URL.createObjectURL(blob), refs: 0, byteSize: blob.size };
}

function acquire(url: string): Promise<Entry | null> {
  const parkedEntry = parked.get(url);
  if (parkedEntry) {
    parked.delete(url);
    parkedEntry.refs += 1;
    return Promise.resolve(parkedEntry);
  }

  const live = entries.get(url);
  if (live) {
    live.refs += 1;
    return Promise.resolve(live);
  }

  const existing = inflight.get(url);
  if (existing) {
    return existing.then((entry) => {
      if (entry) entry.refs += 1;
      return entry;
    });
  }

  const promise = fetchObject(url)
    .catch(() => null)
    .then((entry) => {
      inflight.delete(url);
      if (entry) {
        entries.set(url, entry);
        entry.refs += 1;
      }
      return entry;
    });

  inflight.set(url, promise);
  return promise;
}

function release(url: string): void {
  const entry = entries.get(url);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    entry.refs = 0;
    park(url, entry);
  }
}

export type MediaSourceState =
  | { status: 'idle'; src: null }
  | { status: 'loading'; src: null }
  | { status: 'ready'; src: string }
  | { status: 'failed'; src: null };

/**
 * Resolve one attachment's bytes, or don't.
 *
 * `active: false` is the whole of `preload="none"` on this transport: a video
 * card passes `false` until the reader taps play, so fifteen cards of video
 * cost fifteen *nothing*. A photo passes `true` — a feed of photos that has to
 * be tapped to appear is not a feed of photos.
 */
export function useMediaSource(url: string, active: boolean): MediaSourceState {
  const [state, setState] = useState<MediaSourceState>({ status: 'idle', src: null });

  useEffect(() => {
    if (!active) {
      setState({ status: 'idle', src: null });
      return;
    }

    let alive = true;
    setState({ status: 'loading', src: null });
    void acquire(url).then((entry) => {
      if (!alive) {
        if (entry) release(url);
        return;
      }
      setState(entry ? { status: 'ready', src: entry.objectUrl } : { status: 'failed', src: null });
    });

    return () => {
      alive = false;
      release(url);
    };
  }, [url, active]);

  return state;
}

/**
 * The same, for a thumbnail that must not blink.
 *
 * A composer tile restored after a cold start resolves its picture from
 * `/api/media/<id>`; once the bytes are in, the tile should keep showing them
 * even across a re-render that briefly reports `loading`. Holding the last
 * good src in a ref is what stops the strip flickering while the member types.
 */
export function useThumbnail(url: string): string | null {
  const state = useMediaSource(url, url.length > 0);
  const last = useRef<string | null>(null);
  if (state.status === 'ready') last.current = state.src;
  return last.current;
}

/** Drop everything. Exported for the sign-out hook below and for tests. */
export function clearMediaCache(): void {
  for (const entry of entries.values()) URL.revokeObjectURL(entry.objectUrl);
  entries.clear();
  parked.clear();
  inflight.clear();
}

/**
 * Sign-out invalidates every one of these: the object URLs point at family
 * photographs, and the next person at this browser must not see them.
 */
onAccessTokenChange((token) => {
  if (token === null) clearMediaCache();
});
