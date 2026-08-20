import { randomBytes } from 'node:crypto';

import { IMAGE_EXTENSIONS, type AllowedImageType } from './image.js';

/**
 * The mapping between a stored object and the URL we hand the client.
 *
 * `users.avatarUrl` keeps holding a URL, exactly as before — it just holds
 * **our own** API path now instead of a provider's CDN link:
 *
 *     /api/users/<userId>/avatar?v=<random>.<ext>
 *
 * which corresponds to the object `avatars/<userId>/<random>.<ext>`.
 *
 * Encoding the object's name in the query string rather than in a second
 * database column buys two things:
 *
 * - **A cache buster for free.** The URL changes on every replacement, so the
 *   year-long `Cache-Control` on the serving route is safe: a new avatar is a
 *   new URL and no stale copy can survive in a browser cache.
 * - **The previous object stays addressable.** Replacing an avatar needs to
 *   delete the one before it, and the only record of which object that was is
 *   the URL we are about to overwrite.
 *
 * The `v` parameter is **not** trusted on the way back in. The serving route
 * reads the user's stored `avatarUrl` and derives the key from that, so `v` is
 * a cache key and nothing else; a client that edits it changes nothing.
 */

const AVATAR_PREFIX = 'avatars';

/** 16 bytes of entropy. The key must not be guessable from the user id alone. */
const RANDOM_BYTES = 16;

/**
 * Matches what {@link buildAvatarObjectName} produces and nothing else.
 * Anchored, no dots outside the extension, no slashes: this is the guard that
 * keeps a hand-edited URL from turning into a path traversal on the bucket.
 */
const OBJECT_NAME_PATTERN = new RegExp(
  `^[0-9a-f]{${String(RANDOM_BYTES * 2)}}\\.(?:${Object.values(IMAGE_EXTENSIONS).join('|')})$`,
);

/** `<random>.<ext>` — the part of the key that varies per upload. */
export function buildAvatarObjectName(contentType: AllowedImageType): string {
  return `${randomBytes(RANDOM_BYTES).toString('hex')}.${IMAGE_EXTENSIONS[contentType]}`;
}

/** The bucket key. The user id is a UUID from our own database, never client input. */
export function avatarObjectKey(userId: string, objectName: string): string {
  return `${AVATAR_PREFIX}/${userId}/${objectName}`;
}

/** What goes into `users.avatarUrl`. */
export function avatarUrlFor(userId: string, objectName: string): string {
  return `/api/users/${userId}/avatar?v=${objectName}`;
}

export interface ParsedAvatarUrl {
  readonly userId: string;
  readonly objectName: string;
  readonly key: string;
}

/**
 * Recover the object a stored `avatarUrl` points at.
 *
 * Returns `null` for anything that is not one of ours — most importantly the
 * absolute `https://lh3.googleusercontent.com/...` URLs the Google and Telegram
 * link flows still write. Those are somebody else's objects: we must never try
 * to delete them, and we must never try to stream them out of our bucket.
 */
export function parseAvatarUrl(url: string | null | undefined): ParsedAvatarUrl | null {
  if (!url) return null;
  // A relative path needs a base to parse against; the base is discarded.
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://internal.invalid');
  } catch {
    return null;
  }
  // An absolute URL to somebody else's host is not ours even if the path matches.
  if (parsed.host !== 'internal.invalid') return null;

  const match = /^\/api\/users\/([0-9a-fA-F-]{36})\/avatar$/.exec(parsed.pathname);
  if (!match?.[1]) return null;

  const objectName = parsed.searchParams.get('v');
  if (!objectName || !OBJECT_NAME_PATTERN.test(objectName)) return null;

  const userId = match[1];
  return { userId, objectName, key: avatarObjectKey(userId, objectName) };
}
