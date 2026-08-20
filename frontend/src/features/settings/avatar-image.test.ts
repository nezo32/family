import { describe, expect, it, vi } from 'vitest';

import {
  drawCrop,
  encodeAvatar,
  filenameFor,
  renderAvatarBlob,
  TARGET_MAX_BYTES,
  type Canvas2DLike,
  type CanvasLike,
} from './avatar-image';
import {
  AVATAR_OUTPUT_SIZE,
  clampTransform,
  DEFAULT_TRANSFORM,
  safeSourceRect,
  type CropSource,
} from './crop-geometry';

/**
 * The export step: crop, downscale, encode.
 *
 * jsdom has no `<canvas>`, so the module takes the canvas as a structural
 * interface and these tests hand it a fake. That is not a workaround — it is
 * what makes the two things worth asserting assertable:
 *
 * 1. **Which source rectangle is drawn.** The single number that decides
 *    whether the file matches the preview.
 * 2. **How the encoder reacts to what the browser gives back.** A Safari that
 *    silently answers a WebP request with a PNG, and a photo that will not fit
 *    the budget at the first quality. Both are real, both are invisible in a
 *    manual test, and both cost the member a failed upload.
 */

const VIEWPORT = 288;
const PORTRAIT: CropSource = { width: 3024, height: 4032 };

/* -------------------------------------------------------------------------- */
/* fakes                                                                       */
/* -------------------------------------------------------------------------- */

interface FakeCanvas extends CanvasLike {
  readonly draws: unknown[][];
}

function fakeCanvas(
  toBlob: (type: string, quality: number) => Blob | null = (type) =>
    new Blob([new Uint8Array(1024)], { type }),
): FakeCanvas {
  const draws: unknown[][] = [];
  const context: Canvas2DLike = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    clearRect: () => undefined,
    drawImage: (...args: unknown[]) => {
      draws.push(args);
    },
  } as unknown as Canvas2DLike;

  return {
    width: 0,
    height: 0,
    draws,
    getContext: () => context,
    toBlob: (callback, type, quality) => {
      callback(toBlob(type ?? 'image/png', quality ?? 1));
    },
  };
}

/** Stand-in for the decoded photo; `drawImage` never inspects it here. */
const IMAGE = {} as CanvasImageSource;

interface DrawCall {
  readonly image: unknown;
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  readonly dx: number;
  readonly dy: number;
  readonly dw: number;
  readonly dh: number;
}

/**
 * The nine `drawImage` arguments, named.
 *
 * `noUncheckedIndexedAccess` makes positional destructuring of a `unknown[]`
 * an exercise in `!` assertions; one throwing accessor keeps the assertions
 * below readable and still fails loudly if the call never happened.
 */
function drawCall(canvas: FakeCanvas, index = 0): DrawCall {
  const args = canvas.draws[index];
  if (!args) throw new Error(`no drawImage call at index ${String(index)}`);
  const [image, sx, sy, sw, sh, dx, dy, dw, dh] = args as [unknown, ...number[]];
  return {
    image,
    sx: sx ?? Number.NaN,
    sy: sy ?? Number.NaN,
    sw: sw ?? Number.NaN,
    sh: sh ?? Number.NaN,
    dx: dx ?? Number.NaN,
    dy: dy ?? Number.NaN,
    dw: dw ?? Number.NaN,
    dh: dh ?? Number.NaN,
  };
}

/* -------------------------------------------------------------------------- */
/* drawCrop                                                                    */
/* -------------------------------------------------------------------------- */

describe('drawCrop', () => {
  it('always produces a 512×512 canvas', () => {
    const canvas = drawCrop(fakeCanvas(), IMAGE, PORTRAIT, VIEWPORT, DEFAULT_TRANSFORM);
    expect(canvas.width).toBe(AVATAR_OUTPUT_SIZE);
    expect(canvas.height).toBe(AVATAR_OUTPUT_SIZE);
  });

  it('draws exactly the rectangle the geometry chose, for a tall portrait photo', () => {
    // The common case: a 3:4 phone photo, panned to the top of its range so the
    // face rather than the chest ends up in the circle.
    const transform = clampTransform(PORTRAIT, VIEWPORT, {
      zoom: 1.5,
      offsetX: 0,
      offsetY: 120,
    });
    const canvas = fakeCanvas();
    drawCrop(canvas, IMAGE, PORTRAIT, VIEWPORT, transform);

    const expected = safeSourceRect(PORTRAIT, VIEWPORT, transform);
    const call = drawCall(canvas);

    expect(call.image).toBe(IMAGE);
    expect(call.sx).toBeCloseTo(expected.sx, 6);
    expect(call.sy).toBeCloseTo(expected.sy, 6);
    // Square in, square out — no aspect distortion.
    expect(call.sw).toBeCloseTo(expected.size, 6);
    expect(call.sh).toBeCloseTo(expected.size, 6);
    expect([call.dx, call.dy, call.dw, call.dh]).toEqual([
      0,
      0,
      AVATAR_OUTPUT_SIZE,
      AVATAR_OUTPUT_SIZE,
    ]);
  });

  it('reads a region entirely inside a portrait source', () => {
    const transform = clampTransform(PORTRAIT, VIEWPORT, { zoom: 1, offsetX: 0, offsetY: 999 });
    const canvas = fakeCanvas();
    drawCrop(canvas, IMAGE, PORTRAIT, VIEWPORT, transform);

    const call = drawCall(canvas);
    expect(call.sx).toBeGreaterThanOrEqual(0);
    expect(call.sy).toBeGreaterThanOrEqual(0);
    expect(call.sx + call.sw).toBeLessThanOrEqual(PORTRAIT.width + 1e-6);
    expect(call.sy + call.sh).toBeLessThanOrEqual(PORTRAIT.height + 1e-6);
    // Panned to the top limit: the crop starts at the very first row.
    expect(call.sy).toBeCloseTo(0, 6);
  });

  it('turns smoothing on — downscaling 3024px to 512 without it aliases badly', () => {
    const canvas = fakeCanvas();
    const context = canvas.getContext('2d');
    drawCrop(canvas, IMAGE, PORTRAIT, VIEWPORT, DEFAULT_TRANSFORM);
    expect(context?.imageSmoothingEnabled).toBe(true);
    expect(context?.imageSmoothingQuality).toBe('high');
  });
});

/* -------------------------------------------------------------------------- */
/* encodeAvatar                                                                */
/* -------------------------------------------------------------------------- */

describe('encodeAvatar', () => {
  it('produces WebP at the first quality when it already fits', async () => {
    const toBlob = vi.fn((type: string) => new Blob([new Uint8Array(30 * 1024)], { type }));
    const result = await encodeAvatar(fakeCanvas(toBlob));

    expect(result.type).toBe('image/webp');
    expect(result.quality).toBe(0.85);
    expect(result.blob.size).toBeLessThanOrEqual(TARGET_MAX_BYTES);
    expect(toBlob).toHaveBeenCalledTimes(1);
  });

  it('falls back to JPEG when the browser silently substitutes PNG', async () => {
    // Exactly what an older Safari does: it does not reject `image/webp`, it
    // ignores it and hands back a PNG several times the size. Trusting the
    // request instead of the answer is how a 40 KB avatar becomes 400 KB.
    const toBlob = (type: string) =>
      type === 'image/webp'
        ? new Blob([new Uint8Array(900 * 1024)], { type: 'image/png' })
        : new Blob([new Uint8Array(60 * 1024)], { type: 'image/jpeg' });

    const result = await encodeAvatar(fakeCanvas(toBlob));
    expect(result.type).toBe('image/jpeg');
    expect(result.blob.size).toBeLessThanOrEqual(TARGET_MAX_BYTES);
  });

  it('falls back to JPEG when toBlob answers with nothing at all', async () => {
    const toBlob = (type: string) =>
      type === 'image/webp' ? null : new Blob([new Uint8Array(50 * 1024)], { type });

    const result = await encodeAvatar(fakeCanvas(toBlob));
    expect(result.type).toBe('image/jpeg');
  });

  it('walks the quality ladder down until the result fits the budget', async () => {
    // A photograph of a bookshelf: high entropy, and genuinely large at q=0.85.
    const sizes: Record<number, number> = {
      0.85: 900 * 1024,
      0.72: 600 * 1024,
      0.6: 380 * 1024,
      0.45: 200 * 1024,
    };
    const qualities: number[] = [];
    const toBlob = (type: string, quality: number) => {
      qualities.push(quality);
      return new Blob([new Uint8Array(sizes[quality] ?? 1024)], { type });
    };

    const result = await encodeAvatar(fakeCanvas(toBlob));
    expect(qualities).toEqual([0.85, 0.72, 0.6]);
    expect(result.quality).toBe(0.6);
    expect(result.blob.size).toBeLessThanOrEqual(TARGET_MAX_BYTES);
  });

  it('returns the smallest attempt rather than failing when nothing fits', async () => {
    // The server's ceiling is five times ours, so handing back an oversized
    // blob still normally succeeds — and a real error from the server beats a
    // silent client-side refusal to upload anything.
    const toBlob = (type: string) => new Blob([new Uint8Array(TARGET_MAX_BYTES * 2)], { type });
    const result = await encodeAvatar(fakeCanvas(toBlob));
    expect(result.blob.size).toBeGreaterThan(TARGET_MAX_BYTES);
    expect(result.quality).toBe(0.45);
  });

  it('respects an explicit budget', async () => {
    const toBlob = (type: string, quality: number) =>
      new Blob([new Uint8Array(quality > 0.5 ? 5000 : 100)], { type });
    const result = await encodeAvatar(fakeCanvas(toBlob), { maxBytes: 1000 });
    expect(result.blob.size).toBeLessThanOrEqual(1000);
  });
});

/* -------------------------------------------------------------------------- */
/* the whole pipeline                                                          */
/* -------------------------------------------------------------------------- */

describe('renderAvatarBlob', () => {
  it('crops a portrait photo and returns a 512px WebP inside the budget', async () => {
    const canvas = fakeCanvas((type) => new Blob([new Uint8Array(42 * 1024)], { type }));
    const transform = clampTransform(PORTRAIT, VIEWPORT, { zoom: 2, offsetX: 0, offsetY: 200 });

    const result = await renderAvatarBlob(IMAGE, PORTRAIT, VIEWPORT, transform, {
      createCanvas: () => canvas,
    });

    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(512);
    expect(result.type).toBe('image/webp');
    expect(result.blob.size).toBeLessThanOrEqual(TARGET_MAX_BYTES);
    // And comfortably inside the server's own 2 MB cap.
    expect(result.blob.size).toBeLessThan(2 * 1024 * 1024);

    const expected = safeSourceRect(PORTRAIT, VIEWPORT, transform);
    const call = drawCall(canvas);
    expect(call.sx).toBeCloseTo(expected.sx, 6);
    expect(call.sy).toBeCloseTo(expected.sy, 6);
    expect(call.sw).toBeCloseTo(expected.size, 6);
  });
});

describe('filenameFor', () => {
  it('names the part after the type we actually produced', () => {
    expect(filenameFor('image/webp')).toBe('avatar.webp');
    expect(filenameFor('image/jpeg')).toBe('avatar.jpg');
    expect(filenameFor('image/png')).toBe('avatar.png');
  });
});
