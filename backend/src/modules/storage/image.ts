import { AppError } from '../../core/errors.js';

/**
 * Image type detection from the bytes, not from what the client said.
 *
 * This is the security boundary of the whole avatar feature. `Content-Type` on
 * a multipart part is attacker-controlled free text, and so is the filename —
 * an HTML document uploaded as `avatar.png` with `Content-Type: image/png` is
 * stored XSS the moment we serve it back from our own origin under a
 * `text/html`-sniffable response.
 *
 * So the rule here is: the declared type is a *hint we may reject on*, never a
 * *value we store*. What ends up in the object's `Content-Type` — and therefore
 * on the response when we serve it — is derived exclusively from the magic
 * bytes below. `X-Content-Type-Options: nosniff` on the way out closes the
 * remaining gap where a browser would otherwise second-guess us.
 */

/** The three formats a browser canvas can produce and every browser can render. */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/**
 * Extension per detected type. Used to build the object key; never taken from
 * the client's filename, which may be `../../etc/passwd` or `x.php`.
 */
export const IMAGE_EXTENSIONS: Record<AllowedImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Longest prefix any check below needs: WebP's `WEBP` tag sits at offset 8. */
const SNIFF_BYTES = 12;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** SOI + the first marker byte. Enough to exclude anything that is not JPEG. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const RIFF_MAGIC = Buffer.from('RIFF', 'ascii');
const WEBP_MAGIC = Buffer.from('WEBP', 'ascii');

/**
 * The real type of `bytes`, or `null` when it is not one of the three.
 *
 * Deliberately does not fall back to "probably fine": an unrecognised header is
 * a rejection, not a guess. Anything that reaches storage has matched a literal
 * byte sequence here.
 */
export function sniffImageType(bytes: Uint8Array): AllowedImageType | null {
  if (bytes.length < SNIFF_BYTES) return null;
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, SNIFF_BYTES));

  if (head.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png';
  if (head.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'image/jpeg';
  // WebP is a RIFF container: `RIFF` .... `WEBP`. Checking only `RIFF` would
  // also accept WAV and AVI, which are RIFF too.
  if (head.subarray(0, 4).equals(RIFF_MAGIC) && head.subarray(8, 12).equals(WEBP_MAGIC)) {
    return 'image/webp';
  }

  return null;
}

export function isAllowedImageType(value: string | undefined): value is AllowedImageType {
  // Widened rather than cast down: `includes` on the literal tuple would reject
  // an arbitrary `string` at compile time, which is exactly the input we have.
  return value !== undefined && (ALLOWED_IMAGE_TYPES as readonly string[]).includes(value);
}

export interface ValidatedImage {
  readonly bytes: Uint8Array;
  readonly contentType: AllowedImageType;
  readonly extension: string;
}

/**
 * Validate an uploaded image end to end: size, then bytes.
 *
 * `declaredType` is checked first purely so the common honest mistake (a member
 * picking a HEIC straight off an iPhone) gets `UNSUPPORTED_MEDIA_TYPE` rather
 * than the more confusing "your PNG is not a PNG". The declared type is then
 * discarded — `contentType` in the result always comes from {@link sniffImageType}.
 */
export function validateImageUpload(
  bytes: Uint8Array,
  options: { declaredType?: string | undefined; maxBytes: number },
): ValidatedImage {
  if (bytes.length === 0) {
    throw new AppError('BAD_REQUEST', 'Uploaded file is empty');
  }
  if (bytes.length > options.maxBytes) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `Image is larger than the ${String(options.maxBytes)} byte limit`,
    );
  }

  const declared = options.declaredType?.split(';')[0]?.trim().toLowerCase();
  if (declared !== undefined && declared !== '' && !isAllowedImageType(declared)) {
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      `Content-Type ${declared} is not one of ${ALLOWED_IMAGE_TYPES.join(', ')}`,
    );
  }

  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    // Intentionally the same code as a bad declared type: from the member's
    // side both mean "this file is not a picture we can use", and the
    // distinction ("you lied about it") is only interesting in the log.
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      'File contents are not a JPEG, PNG or WebP image',
      { context: { declaredType: declared ?? null } },
    );
  }

  return { bytes, contentType: sniffed, extension: IMAGE_EXTENSIONS[sniffed] };
}
