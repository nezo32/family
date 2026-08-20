import {
  ALLOWED_MEDIA_TYPES,
  MAX_ATTACHMENTS,
  MEDIA_LIMITS,
  type AllowedMediaType,
  type MediaAttachment,
  type MediaKind,
} from '@family/shared';

/**
 * What the composer is allowed to accept, and how it says no.
 *
 * ## Every number here comes from the contract
 *
 * `ALLOWED_MEDIA_TYPES` and `MEDIA_LIMITS` live in
 * `packages/shared/src/contracts/wall.ts` and the server imports the same
 * constants, so the sentence the composer says before an upload and the
 * sentence the server would have said after it cannot disagree. **Nothing in
 * this file may hard-code a megabyte figure or a format list** — that is the
 * exact bug the contract was moved for: a client refusing at 8 MB while the
 * server accepts 10 is a feature the family can see but not use, and a client
 * accepting at 100 MB while the server refuses at 40 is ninety seconds of a
 * tethered connection spent on a 413.
 *
 * `docs/design/DESIGN.md` §D7.14.6 quotes a *different* set of numbers (8 MB
 * photo, 40 MB / 60 s video, 180 s audio) and a `GET /api/media/limits` route
 * that would publish them. Neither shipped: the caps were raised in the
 * contract and the route was replaced by the constants. The design document is
 * the older of the two and the contract is what the server enforces, so the
 * contract wins. Flagged in the report rather than silently reconciled.
 *
 * ## Two caps that are *not* the contract's
 *
 * `MAX_ATTACHMENTS` is the transport's bound — ten is a phone picker's
 * selection. The wall's bound is smaller and it is a **layout** fact
 * (§D7.14.2): four is what the 2×2 grid holds without a «+2» tile, and a «+2»
 * tile is a digit on a card (§D7.7b). One per comment is the line between a
 * reply and a post (§D7.8b). Both are asserted against the transport bound
 * below, so raising one and forgetting the other fails at import time rather
 * than at the first 400.
 */

/** §D7.14.2 — the grid's bound, chosen so a «+N» counter is never needed. */
export const MAX_PER_POST = 4;

/** §D7.8b — one attachment is the line between a reply and a post. */
export const MAX_PER_COMMENT = 1;

if (MAX_PER_POST > MAX_ATTACHMENTS || MAX_PER_COMMENT > MAX_ATTACHMENTS) {
  throw new Error('The wall cannot offer more attachments than the contract accepts');
}

/**
 * `accept` for the one file input (§D7.14.3).
 *
 * ```
 * image/*,video/*,audio/mp4,audio/mpeg
 * ```
 *
 * **No `capture` attribute, ever.** `capture` is genuinely supported on iOS and
 * short-circuits `WKFileUploadPanel` straight to the system camera — which is
 * exactly why it must not be set here. Setting it *removes* «Фотогалерея» and
 * «Выбрать файл» from the menu. One control; the OS already draws all three
 * doors inside it.
 *
 * **The two wildcards** are what raise «Фотогалерея» and «Снять фото или
 * видео». The narrower explicit list would hide a HEIC in Файлы, which is
 * tempting, but it also puts six MIME→UTI mappings on the critical path of a
 * picker nobody on this project can test on a real device. A HEIC is re-encoded
 * by `encode.ts` on Safari (which decodes it natively) and refused with a
 * sentence anywhere else; that path is verified. A picker that silently offers
 * nothing is not.
 *
 * ## The audio types are deliberate, and they correct §D7.14.3
 *
 * The design says «`accept="audio/*"` is never used anywhere» and concludes
 * from that: *"There is no file-picker path to an audio file on an iPhone."*
 * The premise is right and still right — WebKit bug **242110** is open, and the
 * mapping is unchanged in `WKFileUploadPanel.mm` on `main` today:
 *
 * ```objc
 * else if ([mimeType caseInsensitiveCompare:@"audio/*"] == NSOrderedSame)
 *     // UIImagePickerController doesn't allow audio-only recording, so show the video
 *     // recorder for "audio/*".
 *     [mediaTypes addObject:UTTypeMovie.identifier];
 * ```
 *
 * But read the condition: it is an **exact string compare against the wildcard**.
 * `audio/mp4` and `audio/mpeg` do not take that branch — they fall through to
 * the ordinary MIME→UTI conversion and end up as document-picker types, so
 * Файлы is filtered to `.m4a` and `.mp3` instead of being filtered to movies.
 * So the correct rule is narrower than the one the design wrote down: **never
 * the `audio/*` wildcard**, rather than never audio at all.
 *
 * This is worth the two extra tokens because the in-app recorder — the design's
 * only other route to a voice note — is **blocked** (see `record.ts`). Listing
 * these costs nothing if the UTI mapping disappoints on a device: the worst
 * case is that Файлы shows no audio files, which is exactly where the design
 * assumed we already were. It creates no button that does nothing.
 *
 * **Unverified on a real device.** Read off WebKit source, not off an iPhone.
 */
export const MEDIA_ACCEPT = 'image/*,video/*,audio/mp4,audio/mpeg';

const ALLOWED = new Set<string>(ALLOWED_MEDIA_TYPES);

export function isAllowedMediaType(value: string): value is AllowedMediaType {
  return ALLOWED.has(value);
}

/**
 * Kind from a MIME type, or `null` when we cannot tell.
 *
 * `null` is a real answer and is **not** a refusal: a browser that hands back
 * an empty `File.type` (it happens, especially from Файлы) still deserves its
 * upload, because the server sniffs the magic bytes and is the only party that
 * actually knows. Refusing locally on a blank type would reject files the
 * server would have accepted, which is the worse of the two errors.
 */
export function kindOfType(contentType: string): MediaKind | null {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return null;
}

export function limitsFor(kind: MediaKind): { maxBytes: number; maxDurationMs: number | null } {
  return MEDIA_LIMITS[kind];
}

/** «10 МБ» — the server's own formatting, so the two sentences match verbatim. */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  const rounded = Math.round(mb * 10) / 10;
  return `${String(Number.isInteger(rounded) ? rounded : rounded.toFixed(1))} МБ`;
}

/** «3 минуты» / «45 сек.» — likewise copied from `backend/.../media.ts`. */
export function formatDurationRu(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)} сек.`;
  const minutes = Math.round(totalSeconds / 60);
  const tail = minutes % 100;
  const last = minutes % 10;
  const word =
    tail >= 11 && tail <= 14
      ? 'минут'
      : last === 1
        ? 'минута'
        : last >= 2 && last <= 4
          ? 'минуты'
          : 'минут';
  return `${String(minutes)} ${word}`;
}

/**
 * «0:42» — the duration pill, and the one number allowed onto a media element
 * (§D7.14.4).
 *
 * It passes D7.2's test cleanly and the review will ask, so the argument is
 * here: a clip's length is not sayable any other way, it is not attached to a
 * person, nothing sorts by it, and it is precisely the fact that decides
 * whether you tap now or later.
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${seconds < 10 ? '0' : ''}${String(seconds)}`;
}

/**
 * The same length in words, for an accessible name — «42 секунды», «1 минута
 * 12 секунд» (§D7.14.8).
 *
 * A screen reader reading «0:42» says "ноль двоеточие сорок два", which is not
 * a duration in any language.
 */
export function spellDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${String(minutes)} ${plural(minutes, 'минута', 'минуты', 'минут')}`);
  if (seconds > 0 || minutes === 0) {
    parts.push(`${String(seconds)} ${plural(seconds, 'секунда', 'секунды', 'секунд')}`);
  }
  return parts.join(' ');
}

function plural(n: number, one: string, few: string, many: string): string {
  const tail = n % 100;
  if (tail >= 11 && tail <= 14) return many;
  const last = n % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/**
 * The aspect ratio a card reserves for one attachment (§D7.14.2).
 *
 * Clamped at the **tall** end only, to 4:5. A portrait phone photo is the
 * common case and squaring it loses heads; 4:5 is the mildest clamp that bounds
 * the height, and at a 358px card it is 448px, which leaves the top of the next
 * card visible on a 390×844 phone. A panorama is short and harms nothing, so
 * the wide end is unclamped.
 *
 * `null` when the server sent no dimensions — audio, or a container we could
 * not read. The caller then draws no box at all rather than guessing one, which
 * is the whole point of reserving from server data.
 */
export function reservedRatio(attachment: MediaAttachment): number | null {
  const { width, height } = attachment;
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return Math.max(width / height, 4 / 5);
}
