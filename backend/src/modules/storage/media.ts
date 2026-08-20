import {
  ALLOWED_MEDIA_TYPES,
  MEDIA_LIMITS,
  MEDIA_MAX_DIMENSION,
  MEDIA_MAX_PIXELS,
  type AllowedMediaType,
  type MediaKind,
} from '@family/shared';

import { AppError } from '../../core/errors.js';

/**
 * What the bytes actually are — the security boundary of the whole media
 * feature, and a direct extension of `image.ts`.
 *
 * The rule is unchanged and it is the only rule that matters here: **the
 * declared `Content-Type` and the filename are hints we may reject on, never
 * values we store.** What ends up on the object — and therefore on every
 * response that streams it back from our own origin — is derived exclusively
 * from the magic bytes below. An HTML file called `видео.mp4` gets a 415, and a
 * `.jpg` that is really a QuickTime file is stored and served as QuickTime.
 *
 * ## What is new here, versus avatars
 *
 * Three things, and each one is a place where copying `image.ts` would have
 * been wrong:
 *
 * 1. **A container is not a type.** `ftyp` at offset 4 says "ISO base media
 *    file", which is MP4 *and* QuickTime *and* HEIC *and* M4A. The brand list
 *    tells them apart, and whether a file is video or audio is decided by the
 *    tracks inside it, not by the brand — see `media.probe.ts`.
 * 2. **HEIC has to be recognised in order to be refused well.** It is `ftyp`
 *    like MP4 is; without the brand table an iPhone photo would be stored as
 *    `video/mp4` and would never play. It gets its own message telling the
 *    member what to do, because "unsupported" is not actionable advice.
 * 3. **Rejection is a vocabulary, not a boolean.** Six people share this wall;
 *    "не подходит" teaches nobody anything. Each refusal below names the format
 *    and the way out.
 */

/** Extension per accepted type. Built here, never taken from the client's filename. */
export const MEDIA_EXTENSIONS: Record<AllowedMediaType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
};

export function isAllowedMediaType(value: string | undefined): value is AllowedMediaType {
  // Widened deliberately: `includes` on the literal tuple refuses an arbitrary
  // `string` at compile time, and an arbitrary string is exactly the input.
  return value !== undefined && (ALLOWED_MEDIA_TYPES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Sniffing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Longest prefix any check below needs.
 *
 * `ftyp` brands run from offset 8 and a compatible-brands list can be long; 64
 * bytes covers every real file and costs nothing.
 */
export const SNIFF_BYTES = 64;

/** Why a file was refused. Each one maps to a sentence a family member can act on. */
export type MediaRejection =
  'heic' | 'svg' | 'webm' | 'ogg' | 'wav' | 'avi' | 'pdf' | 'archive' | 'unknown';

export type SniffedContainer =
  | { readonly container: 'jpeg' | 'png' | 'webp' | 'gif' | 'mp3' }
  /** MP4 / QuickTime / M4A: which one it is takes the brands *and* the tracks. */
  | { readonly container: 'isobmff'; readonly brands: readonly string[] };

export type MediaSniff =
  | { readonly ok: true; readonly sniffed: SniffedContainer }
  | { readonly ok: false; readonly reason: MediaRejection };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const RIFF_MAGIC = Buffer.from('RIFF', 'ascii');
const MATROSKA_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/**
 * ISO-BMFF brands we accept as MP4-family video or audio.
 *
 * `qt  ` is QuickTime — what an iPhone writes. It is on this list because the
 * alternative is telling the family's main camera that its own output is not a
 * video; see the contract's note on why we do not transcode.
 */
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'iso8',
  'mp41',
  'mp42',
  'avc1',
  'mmp4',
  'dash',
  'M4V ',
  'M4A ',
  'M4B ',
  'M4P ',
  'qt  ',
  '3gp4',
  '3gp5',
  '3g2a',
]);

/**
 * HEIC/HEIF/AVIF brands. Recognised **only** so they can be refused with a
 * sentence that helps: they are `ftyp` files like MP4 is, and a brand table
 * that ignored them would store an iPhone photo as a video that never plays.
 */
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'avif',
  'avis',
]);

function brandsOf(head: Buffer): string[] {
  const brands: string[] = [];
  // major_brand at 8, minor_version at 12, compatible_brands from 16 on.
  if (head.length >= 12) brands.push(head.toString('latin1', 8, 12));
  for (let offset = 16; offset + 4 <= head.length; offset += 4) {
    const brand = head.toString('latin1', offset, offset + 4);
    // The compatible-brands list runs to the end of the `ftyp` box; stop at the
    // first thing that is not four printable characters rather than trusting
    // the declared box size, which is attacker-controlled like everything else.
    if (!/^[\x20-\x7e]{4}$/.test(brand)) break;
    brands.push(brand);
  }
  return brands;
}

/** True when the head starts with an XML/SVG document, in any of its disguises. */
function looksLikeSvg(head: Buffer): boolean {
  const text = head.toString('latin1', 0, Math.min(head.length, SNIFF_BYTES)).trimStart();
  return text.startsWith('<?xml') || text.startsWith('<svg') || text.startsWith('<!DOCTYPE svg');
}

/**
 * The real container of `bytes`, or a named refusal.
 *
 * Deliberately never falls back to "probably fine": an unrecognised header is a
 * rejection. Everything that reaches the bucket has matched a literal byte
 * sequence here.
 */
export function sniffMedia(bytes: Uint8Array): MediaSniff {
  if (bytes.length < 12) return { ok: false, reason: 'unknown' };
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, SNIFF_BYTES));

  if (head.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { ok: true, sniffed: { container: 'png' } };
  }
  if (head.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return { ok: true, sniffed: { container: 'jpeg' } };
  }
  if (head.subarray(0, 3).toString('latin1') === 'GIF') {
    const version = head.toString('latin1', 0, 6);
    if (version === 'GIF87a' || version === 'GIF89a') {
      return { ok: true, sniffed: { container: 'gif' } };
    }
    return { ok: false, reason: 'unknown' };
  }

  if (head.subarray(0, 4).equals(RIFF_MAGIC)) {
    // RIFF is a family, not a format: WebP, WAV and AVI all start this way, so
    // checking only `RIFF` (as a shortcut once did elsewhere) accepts two
    // things we do not want.
    const form = head.toString('latin1', 8, 12);
    if (form === 'WEBP') return { ok: true, sniffed: { container: 'webp' } };
    if (form === 'WAVE') return { ok: false, reason: 'wav' };
    if (form === 'AVI ') return { ok: false, reason: 'avi' };
    return { ok: false, reason: 'unknown' };
  }

  if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brands = brandsOf(head);
    if (brands.some((brand) => HEIF_BRANDS.has(brand))) return { ok: false, reason: 'heic' };
    if (brands.some((brand) => MP4_BRANDS.has(brand))) {
      return { ok: true, sniffed: { container: 'isobmff', brands } };
    }
    return { ok: false, reason: 'unknown' };
  }

  if (head.subarray(0, 4).equals(MATROSKA_MAGIC)) return { ok: false, reason: 'webm' };
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return { ok: false, reason: 'ogg' };
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return { ok: false, reason: 'pdf' };
  if (head.subarray(0, 2).toString('latin1') === 'PK') return { ok: false, reason: 'archive' };
  if (looksLikeSvg(head)) return { ok: false, reason: 'svg' };

  // MP3: an ID3v2 tag, or a bare frame sync (11 set bits) with a valid version
  // and layer. The second form is why the sync check is not just `0xff 0xfb`.
  if (head.subarray(0, 3).toString('latin1') === 'ID3') {
    return { ok: true, sniffed: { container: 'mp3' } };
  }
  const b0 = head[0];
  const b1 = head[1];
  if (b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0) {
    const version = (b1 >> 3) & 0b11;
    const layer = (b1 >> 1) & 0b11;
    // version 0b01 and layer 0b00 are both "reserved" — i.e. not an MP3.
    if (version !== 0b01 && layer !== 0b00) return { ok: true, sniffed: { container: 'mp3' } };
  }

  return { ok: false, reason: 'unknown' };
}

/* -------------------------------------------------------------------------- */
/* Refusals the member can act on                                              */
/* -------------------------------------------------------------------------- */

/**
 * Russian, in `details`, not in `message`.
 *
 * `AppError.message` is developer-facing by convention and the client renders
 * its own copy keyed off `error.code` — but `code` alone cannot say *which*
 * format was wrong or what to do instead, and there are eight of them. So the
 * actionable sentence rides in `details.file`, exactly as `assertEntityType`
 * puts its Russian in `details.entityType`.
 */
const REJECTION_RU: Record<MediaRejection, string> = {
  heic:
    'iPhone сохранил фото в формате HEIC — его не покажет ни один браузер, кроме Safari. ' +
    'Откройте «Настройки → Камера → Форматы» и выберите «Наиболее совместимые», ' +
    'либо отправьте фото ещё раз — приложение пересохранит его в JPEG.',
  svg: 'SVG — это документ, который умеет выполнять код, поэтому мы его не принимаем.',
  webm: 'Формат WebM не проигрывается на iPhone. Сохраните видео в MP4.',
  ogg: 'Формат Ogg/Opus не проигрывается на iPhone. Сохраните запись в MP3 или M4A.',
  wav: 'WAV — несжатый звук, он занимает в десять раз больше нужного. Сохраните в MP3 или M4A.',
  avi: 'Формат AVI слишком старый для браузера. Сохраните видео в MP4.',
  pdf: 'Это PDF, а не фото, видео или запись.',
  archive: 'Это архив, а не фото, видео или запись.',
  unknown: 'Не удалось распознать файл: это не фото, не видео и не аудиозапись.',
};

const ACCEPTED_RU = 'Принимаем: JPEG, PNG, WebP, GIF, MP4, MOV, M4A, MP3.';

export function unsupportedMedia(reason: MediaRejection, context?: Record<string, unknown>): never {
  throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Rejected upload: ${reason}`, {
    details: { file: [REJECTION_RU[reason], ACCEPTED_RU] },
    ...(context ? { context } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

const KIND_RU: Record<MediaKind, string> = {
  image: 'Фото',
  video: 'Видео',
  audio: 'Аудиозапись',
};

/** «10 МБ» — megabytes, one decimal only when it needs one. */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  const rounded = Math.round(mb * 10) / 10;
  return `${String(Number.isInteger(rounded) ? rounded : rounded.toFixed(1))} МБ`;
}

/** «3 минуты» / «45 секунд» — whichever the number actually is. */
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
 * The 413 that says what the limit is.
 *
 * A bare "Payload too large" after a ninety-second upload over a phone
 * connection is the definition of a mystery error. This one names the kind, the
 * cap and what the file actually weighed, in Russian, in `details`.
 */
export function tooLarge(kind: MediaKind, byteSize: number): never {
  const limit = MEDIA_LIMITS[kind].maxBytes;
  throw new AppError(
    'PAYLOAD_TOO_LARGE',
    `${kind} of ${String(byteSize)} bytes exceeds the ${String(limit)} byte limit`,
    {
      details: {
        file: [
          `${KIND_RU[kind]} весит ${formatMegabytes(byteSize)}, а больше ${formatMegabytes(limit)} мы не принимаем.`,
        ],
      },
    },
  );
}

/** The duration cap, phrased the same way. */
export function tooLong(kind: MediaKind, durationMs: number): never {
  const limit = MEDIA_LIMITS[kind].maxDurationMs;
  throw new AppError(
    'PAYLOAD_TOO_LARGE',
    `${kind} of ${String(durationMs)}ms exceeds the ${String(limit ?? 0)}ms limit`,
    {
      details: {
        file: [
          `${KIND_RU[kind]} длится ${formatDurationRu(durationMs)}, ` +
            `а больше ${formatDurationRu(limit ?? 0)} мы не принимаем.`,
        ],
      },
    },
  );
}

export interface ProbedMedia {
  readonly contentType: AllowedMediaType;
  readonly kind: MediaKind;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
}

/**
 * The limit gate, applied to an already-probed file.
 *
 * Pure and separate from the probing so the numbers can be tested without a
 * single real video: every branch here is a sentence somebody reads on a phone.
 */
export function assertWithinLimits(probed: ProbedMedia, byteSize: number): void {
  const limits = MEDIA_LIMITS[probed.kind];
  if (byteSize > limits.maxBytes) tooLarge(probed.kind, byteSize);

  if (limits.maxDurationMs !== null) {
    if (probed.durationMs === null) {
      // Consistent with the sniffing rule one layer up: an unreadable header is
      // a rejection, not a guess. A duration we cannot read is a duration we
      // cannot enforce, and "probably short enough" is how a 40-minute file
      // ends up in a nightly backup forever.
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Could not read the media duration', {
        details: {
          file: [
            'Не удалось прочитать длительность файла — возможно, он повреждён или записан необычно. ' +
              'Попробуйте пересохранить его.',
          ],
        },
      });
    }
    if (probed.durationMs > limits.maxDurationMs) tooLong(probed.kind, probed.durationMs);
  }

  if (probed.kind !== 'audio') {
    const { width, height } = probed;
    if (width === null || height === null) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Could not read the media dimensions', {
        details: {
          file: ['Не удалось прочитать размер кадра — возможно, файл повреждён.'],
        },
      });
    }
    // Not decoded here, but decoded on six phones the moment it is drawn.
    if (
      width > MEDIA_MAX_DIMENSION ||
      height > MEDIA_MAX_DIMENSION ||
      width * height > MEDIA_MAX_PIXELS
    ) {
      throw new AppError('PAYLOAD_TOO_LARGE', `Image is ${String(width)}x${String(height)}`, {
        details: {
          file: [
            `Слишком большое изображение: ${String(width)}×${String(height)}. ` +
              'Уменьшите его перед отправкой.',
          ],
        },
      });
    }
  }
}
