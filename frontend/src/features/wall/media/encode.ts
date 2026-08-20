import { isAllowedMediaType, limitsFor } from './limits';

/**
 * Downscale and re-encode a photo before it is uploaded.
 *
 * ## Why the client does this and the server does not
 *
 * The backend has **no image library** — no `sharp`, no native build, no C
 * decoder parsing a stranger's file — and keeping it that way is a deliberate
 * property, not an omission (D15 §1). Its entire image handling is a
 * magic-byte check and a byte count. So the only place a 4000 × 3000, 6 MB
 * phone photo can become a 300 KB WebP is here, on the six devices that already
 * have a hardware decoder and are already holding the file.
 *
 * The widest place a photo is ever drawn in this app is the 720px feed column
 * at 2× (§C2), so **2048 on the long edge is already generous** and the same
 * number `features/settings/avatar-image.ts` settled on.
 *
 * ## This is also what makes the server's HEIC sentence true
 *
 * `backend/.../media.ts` refuses HEIC with:
 *
 * > «…либо отправьте фото ещё раз — приложение пересохранит его в JPEG.»
 *
 * That promise is only kept if something re-encodes. iOS Safari decodes HEIC
 * natively (`MIMETypeRegistry.cpp`, `HAVE(HEIC)`), so a HEIC picked from Файлы
 * decodes into an `<img>` here and goes up as WebP, and the server never sees
 * it. On Android or desktop Chrome the decode fails and the honest answer is
 * «Не получилось открыть это фото» — because nobody outside Apple can display
 * that file anyway.
 *
 * ## Decoded through `<img>`, never `createImageBitmap`
 *
 * `avatar-image.ts` already documents why and it transfers verbatim:
 * `createImageBitmap` ignores EXIF orientation in several engines, and the
 * gallery path *does* carry orientation. An `<img>` applies it. (The camera
 * path loses EXIF entirely — `WKFileUploadPanel.mm` carries an open
 * `// FIXME: Should EXIF data be maintained?` — which is harmless, because a
 * camera capture comes out upright.)
 *
 * ## When it does nothing at all
 *
 * An accepted type, inside the byte cap, no larger than 2048 on the long edge
 * is **passed through untouched**. Re-encoding it would cost quality and CPU to
 * make a file that is not smaller. The pass-through also keeps the original
 * `File` object, which is the one iOS reads for its background-upload assertion
 * (see `upload.ts`) — a `Blob` works too, but "changed nothing, sent the
 * original" is the cheaper thing to be sure about.
 */

const MAX_EDGE = 2048;

/**
 * The ladder, in order. WebP first because it is 25–35 % smaller than JPEG at
 * the same perceived quality and every browser in this house renders it; JPEG
 * is the floor for a canvas that refuses WebP (older Safari), and
 * `canvas.toBlob` falls back to PNG on its own if even that is unsupported,
 * which the type check below catches.
 */
const LADDER: readonly { type: string; quality: number }[] = [
  { type: 'image/webp', quality: 0.82 },
  { type: 'image/webp', quality: 0.7 },
  { type: 'image/jpeg', quality: 0.82 },
  { type: 'image/jpeg', quality: 0.7 },
];

export class PhotoDecodeError extends Error {
  constructor() {
    super('The browser could not decode this image');
    this.name = 'PhotoDecodeError';
  }
}

/**
 * `file` in, something uploadable out — or `PhotoDecodeError` when the browser
 * cannot open it at all.
 *
 * Never throws for "it is still too big": that is the caller's refusal to make,
 * with the caller's sentence, against the contract's cap.
 */
export async function preparePhoto(file: File): Promise<Blob> {
  const cap = limitsFor('image').maxBytes;

  const image = await decode(file);
  try {
    const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
    const acceptable = isAllowedMediaType(file.type);

    if (acceptable && file.size <= cap && longEdge <= MAX_EDGE) return file;

    const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new PhotoDecodeError();
    context.drawImage(image.element, 0, 0, width, height);

    let best: Blob | null = null;
    for (const step of LADDER) {
      const blob = await toBlob(canvas, step.type, step.quality);
      // `toBlob` silently falls back to PNG for a type it does not support, and
      // a PNG of a photograph is larger than the JPEG we started with.
      if (!blob || blob.type !== step.type) continue;
      best = blob;
      if (blob.size <= cap) return blob;
    }

    // Every rung produced something too heavy, or the canvas produced nothing
    // usable. Hand back whatever we have and let the caller's cap check say so
    // in Russian; handing back the original would be worse, since it is the
    // larger of the two.
    if (best) return best;
    if (acceptable) return file;
    throw new PhotoDecodeError();
  } finally {
    // Whatever happened, the decoder's object URL must not outlive it.
    release(image);
  }
}

interface DecodedImage {
  naturalWidth: number;
  naturalHeight: number;
  objectUrl: string;
  element: HTMLImageElement;
}

function decode(file: File): Promise<DecodedImage> {
  return new Promise<DecodedImage>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const element = new Image();
    element.onload = () => {
      resolve({
        naturalWidth: element.naturalWidth,
        naturalHeight: element.naturalHeight,
        objectUrl,
        element,
      });
    };
    element.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new PhotoDecodeError());
    };
    element.src = objectUrl;
  });
}

function release(image: DecodedImage): void {
  URL.revokeObjectURL(image.objectUrl);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

/**
 * Read a clip's length without uploading it (§D7.14.6).
 *
 * The difference between checking here and checking on the server is the
 * difference between "we said no instantly" and "we spent three minutes of your
 * tethered connection and then said no".
 *
 * Resolves `null` when the browser will not report one. That is not a refusal:
 * the server parses `moov/mvhd` and is the authority, and rejecting a file
 * locally because *this* browser could not read its header would refuse files
 * the server would have taken. A duration we cannot read is one we cannot
 * enforce, and the byte cap still binds.
 */
export function probeDuration(file: File, kind: 'video' | 'audio'): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const element = document.createElement(kind);
    element.preload = 'metadata';

    const finish = (value: number | null): void => {
      element.removeAttribute('src');
      URL.revokeObjectURL(objectUrl);
      resolve(value);
    };

    element.onloadedmetadata = () => {
      const seconds = element.duration;
      finish(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null);
    };
    element.onerror = () => {
      finish(null);
    };
    element.src = objectUrl;
  });
}
