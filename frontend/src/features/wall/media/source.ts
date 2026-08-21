import { useEffect, useRef, useState } from 'react';

import { apiUrl } from '@/shared/api/config';
import { refreshAccessToken } from '@/shared/api/refresh';
import { getAccessToken, onAccessTokenChange } from '@/shared/api/token-store';

/**
 * Turning `/api/media/<id>` into something an `<img>` can actually load.
 *
 * ## The problem, stated plainly, because it is a real gap and not a detail
 *
 * `GET /api/media/:id` is guarded by the ordinary auth plugin, which reads the
 * **`Authorization: Bearer` header and nothing else** — there is no cookie
 * fallback (`extractBearer` in `backend/src/core/plugins/auth.ts`). This app's
 * access token lives in JS memory by design (D3). A media element sends no
 * headers it was not given, and it cannot be given any. So
 * `<img src="/api/media/…">` 401s, silently, and renders as a broken image.
 *
 * The bytes are therefore fetched once with the token and handed over as an
 * object URL — the same trick `shared/api/authed-image.ts` plays for avatars,
 * which is why this reads like it.
 *
 * ## This is the **photo** transport, and only the photo transport
 *
 * Video and audio used to come through here too, and that was the whole of what
 * was wrong with playback: the backend's `Range` support is complete and
 * correct — a real `206` with `Content-Range` — and every byte arriving through
 * the `fetch()` below made it unreachable. A three-minute clip downloaded in
 * full before the first frame and a scrubber drag re-read bytes the browser
 * already had.
 *
 * That is fixed, and not here: `media/ticket.ts` mints a short-lived capability
 * for one object and one member, and the URL goes straight into `<video src>`
 * so the browser's own media stack issues the range requests. **Do not route
 * video or audio back through this file.**
 *
 * A photograph stays, and it should:
 *
 * - it is **not ranged** — an `<img>` asks for the whole object once;
 * - the response is `private, max-age=31536000, immutable`, and a URL carrying
 *   a fifteen-minute credential would give every photo a cache key that changes
 *   on every mint, which is precisely what that header exists to prevent;
 * - a feed page is fifteen cards and up to sixty photographs, and sixty
 *   mint round trips to draw a feed would be a worse trade than the one this
 *   cache already makes.
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
 * in the wrong way — it swallows failure into "show the initials", and a photo
 * that failed to load needs to say so.
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
 * `active` is what lets a caller hold off: a composer tile that is not on
 * screen yet passes `false`. Every photo in the feed passes `true`, because a
 * feed of photos that has to be tapped to appear is not a feed of photos.
 *
 * Video and audio do not come through here at all any more — see the header.
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
