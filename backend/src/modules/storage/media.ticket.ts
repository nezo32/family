import { createHmac, timingSafeEqual } from 'node:crypto';

import { MEDIA_TICKET_TTL_SECONDS } from '@family/shared';

import { getConfig } from '../../core/config.js';

/**
 * Playback tickets — the credential a `<video>` element can actually carry.
 *
 * ## Why this exists at all
 *
 * `GET /api/media/:id` is bearer-authenticated and a media element sends no
 * `Authorization` header. There is no attribute for it and no hook to add one,
 * so the PWA had to download the whole file and hand the element an object URL
 * — which loses seeking and partial playback on exactly the files where they
 * matter. The backend's `Range` support was never the problem; the credential
 * was. A ticket in `?t=` puts the bytes back in reach of the browser's own
 * media stack, which is the only thing that knows how to seek.
 *
 * ## Why a capability token and not the alternatives
 *
 * - **A service worker attaching the bearer** keeps the credential exactly as
 *   it is, which is the strongest thing that can be said for it. Against it: it
 *   puts the byte stream through a JS interception layer on iOS, where ranged
 *   media through a service worker is the classic silent failure — the
 *   `<video>` simply never starts, with no error anywhere, which is the precise
 *   failure mode D15 §1 warns about. It also needs the access token borrowed
 *   from a window client on every cold start of the worker (D3 keeps the JWT
 *   out of every storage a worker can read), and a seek is many requests.
 * - **A cookie scoped to `/api/media`** would be a second ambient credential
 *   covering *all* media for as long as it lives, attached by the browser to
 *   every request that path sees, with no way to scope it to one object. A
 *   ticket is one object, one member, fifteen minutes.
 *
 * ## The design
 *
 * ```
 * m1.<mediaId compact>.<userId compact>.<expiry epoch seconds, base36>.<HMAC-SHA256, base64url>
 * ```
 *
 * - **Unguessable.** A full 256-bit HMAC over the payload.
 * - **Not the session key.** Derived from `COOKIE_SECRET` through its own info
 *   string, exactly as the ICS feed token is, so a ticket can never be replayed
 *   as a session credential and a leaked one grants *this file* and nothing
 *   else. Never `JWT_ACCESS_SECRET`.
 * - **A credential, not a bypass.** The payload names the member; the stream
 *   route loads that member's row and re-runs the whole authorisation chain —
 *   status, `media:read`, and the attachment's own target — on **every**
 *   request. Suspend them, revoke the permission or delete the post and the
 *   next range request is a 404. That is what keeps the token's short life from
 *   being the only thing standing between a leak and the bytes.
 * - **Short.** {@link MEDIA_TICKET_TTL_SECONDS} is fifteen minutes: longer than
 *   the longest file the limits allow (ten minutes of audio), so a straight
 *   playthrough never expires mid-stream, and short enough that a URL sitting in
 *   somebody's history is worthless by the time it is read.
 *
 * The ICS token was once logged in full, which is why `core/logger.ts` strips
 * the query string from every request line. Tickets ride in `?t=` and are
 * covered by that already — **do not undo it.**
 */
export const MEDIA_TICKET_VERSION = 'm1';

const MEDIA_TICKET_INFO = 'family:media-ticket:v1';

/** Domain-separated key. Never `JWT_ACCESS_SECRET`, never the raw secret. */
function ticketKey(): Buffer {
  return createHmac('sha256', getConfig().COOKIE_SECRET).update(MEDIA_TICKET_INFO).digest();
}

function signPayload(payload: string): string {
  return createHmac('sha256', ticketKey()).update(payload, 'utf8').digest('base64url');
}

const COMPACT_UUID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function compactUuid(id: string): string | null {
  const compact = id.toLowerCase().replace(/-/g, '');
  return COMPACT_UUID.test(compact) ? compact : null;
}

function expandUuid(compact: string): string | null {
  if (!COMPACT_UUID.test(compact)) return null;
  const id = [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
  return UUID.test(id) ? id : null;
}

/** Length-guarded `timingSafeEqual`, so a wrong ticket leaks no prefix length. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface MintedTicket {
  readonly token: string;
  readonly url: string;
  readonly expiresAt: Date;
}

/** The path a `<video src>` is pointed at. Relative: same origin, always. */
export function mediaStreamUrl(mediaId: string, token: string): string {
  return `/api/media/${mediaId}/stream?t=${encodeURIComponent(token)}`;
}

/**
 * Mint a ticket for one attachment and one member.
 *
 * Not deterministic, unlike the feed token: the expiry is part of the payload,
 * so asking twice gives two live tickets. That is the right trade here — a
 * ticket is disposable and a member holds at most a handful at a time, whereas a
 * calendar link is something a person pastes into an app once and keeps.
 */
export function mintMediaTicket(
  mediaId: string,
  userId: string,
  now: Date = new Date(),
): MintedTicket | null {
  const media = compactUuid(mediaId);
  const user = compactUuid(userId);
  if (media === null || user === null) return null;

  const expiresAt = new Date(now.getTime() + MEDIA_TICKET_TTL_SECONDS * 1000);
  const expirySeconds = Math.floor(expiresAt.getTime() / 1000);
  const payload = `${MEDIA_TICKET_VERSION}.${media}.${user}.${expirySeconds.toString(36)}`;
  const token = `${payload}.${signPayload(payload)}`;
  return { token, url: mediaStreamUrl(mediaId, token), expiresAt };
}

export interface ParsedMediaTicket {
  readonly mediaId: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

/**
 * Verify the signature and the expiry, and return the claims — or `null`.
 *
 * `null` means "this string buys you nothing", for every reason: not ours,
 * tampered with, or timed out. The caller turns that into a 404, because a 401
 * on a `<video>`'s range request would confirm the object exists to somebody
 * holding a URL they should not have (D4).
 *
 * Everything *else* about the request — is the member still active, do they
 * still hold `media:read`, is the post still there — is checked by the caller
 * against the database, deliberately not here, so this function stays pure and
 * so that no authorisation decision is ever frozen into a signed string.
 */
export function parseMediaTicket(token: string, now: Date = new Date()): ParsedMediaTicket | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [version, media, user, expiryRaw, signature] = parts;
  if (version !== MEDIA_TICKET_VERSION) return null;
  if (media === undefined || user === undefined) return null;
  if (expiryRaw === undefined || signature === undefined) return null;

  const mediaId = expandUuid(media);
  const userId = expandUuid(user);
  if (mediaId === null || userId === null) return null;

  if (!/^[0-9a-z]{1,12}$/.test(expiryRaw)) return null;
  const expirySeconds = Number.parseInt(expiryRaw, 36);
  if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) return null;

  // Signature before expiry: a forged string must not be able to tell the
  // difference between "expired" and "never valid".
  const expected = signPayload(`${version}.${media}.${user}.${expiryRaw}`);
  if (!constantTimeEquals(expected, signature)) return null;

  const expiresAt = new Date(expirySeconds * 1000);
  if (expiresAt.getTime() <= now.getTime()) return null;

  return { mediaId, userId, expiresAt };
}
