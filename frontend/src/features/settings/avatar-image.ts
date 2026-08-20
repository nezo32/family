import {
  AVATAR_OUTPUT_SIZE,
  safeSourceRect,
  type CropSource,
  type CropTransform,
} from './crop-geometry';

/**
 * Turning the user's picture into the ~40 KB square the server stores.
 *
 * All of it happens in the browser, and that is a deliberate architectural
 * choice rather than an optimisation:
 *
 * - A photo straight off a phone is 4000×3000 and 6 MB. Uploading that over
 *   mobile data to produce a 512px avatar is somewhere between rude and
 *   unusable, and it is the difference between "setting a photo" taking one
 *   second and taking forty.
 * - Because the client sends an already-square, already-small, already-WebP
 *   image, **the server needs no image library at all** — no `sharp`, no native
 *   build step, no CVE surface from a decoder written in C parsing files a
 *   stranger uploaded. The backend's entire image handling is a magic-byte
 *   check and a byte-count.
 *
 * The server still validates independently. Nothing here is a security control —
 * a client can send whatever it likes — it is a bandwidth and dependency
 * decision, and the backend assumes none of it.
 */

/** Encode target. WebP at this quality is visually lossless at 512px. */
const QUALITY_LADDER = [0.85, 0.72, 0.6, 0.45] as const;

/**
 * What we aim to upload. Well under the server's 2 MB ceiling — that limit is
 * an abuse stop, this is the size a decent 512px avatar actually is.
 */
export const TARGET_MAX_BYTES = 400 * 1024;

/** Refuse absurd input before decoding it. A 60 MB "photo" is not a photo. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/** What a file picker may offer. The real gate is the decode below. */
export const ACCEPTED_INPUT = 'image/*';

/* -------------------------------------------------------------------------- */
/* structural types                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The slice of `<canvas>` this module uses.
 *
 * Structural rather than `HTMLCanvasElement` so the geometry and the encode
 * ladder are testable under jsdom, which ships no canvas implementation. A real
 * canvas satisfies these; so does a ten-line fake.
 */
export interface Canvas2DLike {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): Canvas2DLike | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export interface EncodedAvatar {
  readonly blob: Blob;
  /** The type actually produced — `image/webp`, or `image/jpeg` on a fallback. */
  readonly type: string;
  readonly quality: number;
}

/* -------------------------------------------------------------------------- */
/* decoding                                                                    */
/* -------------------------------------------------------------------------- */

export class ImageDecodeError extends Error {
  constructor() {
    super('The selected file could not be decoded as an image');
    this.name = 'ImageDecodeError';
  }
}

export class ImageTooLargeError extends Error {
  constructor() {
    super('The selected file is too large to process');
    this.name = 'ImageTooLargeError';
  }
}

/**
 * Decode a picked file into something drawable.
 *
 * Uses an `<img>` and an object URL rather than `createImageBitmap`, because
 * Safari applies EXIF orientation to `<img>` and — until recently — did not to
 * `createImageBitmap`. Every photo taken in portrait carries an orientation
 * flag, so the version that ignores it shows a third of the family sideways.
 *
 * The object URL is revoked by the caller through {@link releaseImage}: the
 * element stays alive for as long as the cropper is open.
 */
export async function decodeImageFile(file: File | Blob): Promise<HTMLImageElement> {
  if (file.size > MAX_SOURCE_BYTES) throw new ImageTooLargeError();

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => {
        resolve(element);
      };
      element.onerror = () => {
        reject(new ImageDecodeError());
      };
      element.src = url;
    });

    // A file the browser "loaded" but sized 0×0 is not an image we can crop —
    // and it is what an SVG with no intrinsic size, or a corrupt JPEG, gives us.
    if (image.naturalWidth < 1 || image.naturalHeight < 1) throw new ImageDecodeError();

    // `decode()` moves the actual work off the first paint. Not fatal if the
    // browser lacks it or rejects — `onload` already fired.
    await image.decode?.().catch(() => undefined);

    return image;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Release the object URL behind a decoded image. Always call it. */
export function releaseImage(image: HTMLImageElement | null | undefined): void {
  if (image?.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
}

export function sourceOf(image: HTMLImageElement): CropSource {
  return { width: image.naturalWidth, height: image.naturalHeight };
}

/* -------------------------------------------------------------------------- */
/* cropping                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Draw the cropped square at the output resolution.
 *
 * One `drawImage` with an explicit source rectangle: the crop and the downscale
 * happen in the same operation, so there is no intermediate full-size canvas to
 * hold 48 MB of pixel data on a phone.
 */
export function drawCrop(
  canvas: CanvasLike,
  image: CanvasImageSource,
  source: CropSource,
  viewport: number,
  transform: CropTransform,
  outputSize: number = AVATAR_OUTPUT_SIZE,
): CanvasLike {
  canvas.width = outputSize;
  canvas.height = outputSize;

  const context = canvas.getContext('2d');
  if (!context) throw new ImageDecodeError();

  // Downscaling a 4000px photo to 512 with smoothing off produces visible
  // aliasing on hair and glasses — the two things in a portrait that matter.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, outputSize, outputSize);

  const rect = safeSourceRect(source, viewport, transform);
  context.drawImage(image, rect.sx, rect.sy, rect.size, rect.size, 0, 0, outputSize, outputSize);

  return canvas;
}

/* -------------------------------------------------------------------------- */
/* encoding                                                                    */
/* -------------------------------------------------------------------------- */

function toBlobAsync(canvas: CanvasLike, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        resolve(blob);
      },
      type,
      quality,
    );
  });
}

/**
 * Encode the canvas, preferring WebP and falling back to JPEG.
 *
 * The fallback detection is the important bit and it is not a browser-sniff:
 * `toBlob` with an unsupported type does not fail, it **silently returns
 * PNG** — which for a 512px photo is roughly ten times the size of the WebP we
 * asked for. So the produced `blob.type` is inspected, and anything that is not
 * what we requested is treated as "this browser cannot do WebP" and re-encoded
 * as JPEG, which every browser can.
 *
 * The quality ladder then walks down until the result fits {@link TARGET_MAX_BYTES}.
 * In practice the first rung wins; the rest exist for the photograph of a
 * bookshelf, which is genuinely hard to compress and would otherwise sail past
 * the server's limit and fail the upload after the member had already framed it.
 */
export async function encodeAvatar(
  canvas: CanvasLike,
  options: { maxBytes?: number } = {},
): Promise<EncodedAvatar> {
  const maxBytes = options.maxBytes ?? TARGET_MAX_BYTES;

  let type = 'image/webp';
  let best: EncodedAvatar | null = null;

  for (const quality of QUALITY_LADDER) {
    const blob = await toBlobAsync(canvas, type, quality);

    if (!blob) {
      if (type === 'image/webp') {
        // `toBlob` handed back nothing at all. Try the format that cannot fail.
        type = 'image/jpeg';
        continue;
      }
      break;
    }

    if (type === 'image/webp' && blob.type !== 'image/webp') {
      // Silently substituted — almost always PNG. Restart the ladder on JPEG.
      type = 'image/jpeg';
      const jpeg = await toBlobAsync(canvas, type, quality);
      if (!jpeg) break;
      best = { blob: jpeg, type: jpeg.type || type, quality };
      if (jpeg.size <= maxBytes) return best;
      continue;
    }

    best = { blob, type: blob.type || type, quality };
    if (blob.size <= maxBytes) return best;
  }

  if (!best) throw new ImageDecodeError();
  // Every rung was still too big. Hand back the smallest one and let the server
  // have the final say — its limit is five times this one, so it will normally
  // pass anyway, and a real error beats a silent refusal to upload.
  return best;
}

/**
 * The whole client-side pipeline: decoded image + framing in, upload blob out.
 *
 * `createCanvas` is injectable purely so this is testable without a real
 * `<canvas>`; production always passes the default.
 */
export async function renderAvatarBlob(
  image: CanvasImageSource,
  source: CropSource,
  viewport: number,
  transform: CropTransform,
  options: {
    outputSize?: number;
    maxBytes?: number;
    createCanvas?: () => CanvasLike;
  } = {},
): Promise<EncodedAvatar> {
  const createCanvas = options.createCanvas ?? (() => document.createElement('canvas'));
  const canvas = drawCrop(
    createCanvas(),
    image,
    source,
    viewport,
    transform,
    options.outputSize ?? AVATAR_OUTPUT_SIZE,
  );
  return encodeAvatar(canvas, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes });
}

/** `image/webp` -> `avatar.webp`. The server ignores it; the picker shows it. */
export function filenameFor(type: string): string {
  const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/png' ? 'png' : 'webp';
  return `avatar.${extension}`;
}
