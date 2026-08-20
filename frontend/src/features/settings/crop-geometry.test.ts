import { describe, expect, it } from 'vitest';

import {
  AVATAR_OUTPUT_SIZE,
  baseScale,
  clampTransform,
  DEFAULT_TRANSFORM,
  displaySize,
  MAX_ZOOM,
  MIN_ZOOM,
  maxOffset,
  safeSourceRect,
  sourceRectFor,
  zoomAround,
  type CropSource,
} from './crop-geometry';

/**
 * The cropper's arithmetic.
 *
 * These are the assertions that decide whether the exported picture matches the
 * preview, and they are stated in source pixels rather than in "it looked
 * right" — a rendering test cannot tell a correct crop from one that is 30px
 * high, and 30px is the difference between a face and a forehead.
 *
 * The portrait case gets the most attention on purpose: it is what a phone
 * camera produces, it is where a naive centre-crop fails, and it is the whole
 * reason this control exists.
 */

const VIEWPORT = 288;

/** A 3024×4032 iPhone photo — the common case, and much taller than wide. */
const PORTRAIT: CropSource = { width: 3024, height: 4032 };
const LANDSCAPE: CropSource = { width: 4032, height: 3024 };
const SQUARE: CropSource = { width: 1000, height: 1000 };

describe('baseScale: zoom 1 covers the circle', () => {
  it('maps the shorter side onto the viewport', () => {
    expect(baseScale(PORTRAIT, VIEWPORT)).toBeCloseTo(VIEWPORT / 3024, 10);
    expect(baseScale(LANDSCAPE, VIEWPORT)).toBeCloseTo(VIEWPORT / 3024, 10);
    expect(baseScale(SQUARE, VIEWPORT)).toBeCloseTo(VIEWPORT / 1000, 10);
  });

  it('leaves no gap at zoom 1 for any aspect ratio', () => {
    for (const source of [PORTRAIT, LANDSCAPE, SQUARE]) {
      const size = displaySize(source, VIEWPORT, DEFAULT_TRANSFORM);
      expect(size.width).toBeGreaterThanOrEqual(VIEWPORT - 1e-9);
      expect(size.height).toBeGreaterThanOrEqual(VIEWPORT - 1e-9);
    }
  });
});

describe('clampTransform: the mask can never show a gap', () => {
  it('gives a portrait photo vertical room and no horizontal room at zoom 1', () => {
    // This asymmetry IS the feature: the member can slide a tall photo up to
    // put their face in the circle, and cannot slide it sideways into nothing.
    const limit = maxOffset(PORTRAIT, VIEWPORT, DEFAULT_TRANSFORM);
    expect(limit.x).toBe(0);
    // 4032/3024 * 288 = 384 tall on screen; (384 - 288) / 2 = 48.
    expect(limit.y).toBeCloseTo(48, 6);

    expect(clampTransform(PORTRAIT, VIEWPORT, { zoom: 1, offsetX: 500, offsetY: 500 })).toEqual({
      zoom: 1,
      offsetX: 0,
      offsetY: 48,
    });
    expect(clampTransform(PORTRAIT, VIEWPORT, { zoom: 1, offsetX: -500, offsetY: -500 })).toEqual({
      zoom: 1,
      offsetX: 0,
      offsetY: -48,
    });
  });

  it('mirrors that for a landscape photo', () => {
    const limit = maxOffset(LANDSCAPE, VIEWPORT, DEFAULT_TRANSFORM);
    expect(limit.x).toBeCloseTo(48, 6);
    expect(limit.y).toBe(0);
  });

  it('pins a square photo at zoom 1 — there is nowhere to pan', () => {
    expect(clampTransform(SQUARE, VIEWPORT, { zoom: 1, offsetX: 99, offsetY: -99 })).toEqual({
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('opens room on both axes once zoomed in', () => {
    const limit = maxOffset(SQUARE, VIEWPORT, { zoom: 2, offsetX: 0, offsetY: 0 });
    expect(limit.x).toBeCloseTo(144, 6);
    expect(limit.y).toBeCloseTo(144, 6);
  });

  it('holds the zoom inside its range', () => {
    expect(clampTransform(SQUARE, VIEWPORT, { zoom: 99, offsetX: 0, offsetY: 0 }).zoom).toBe(
      MAX_ZOOM,
    );
    expect(clampTransform(SQUARE, VIEWPORT, { zoom: 0.01, offsetX: 0, offsetY: 0 }).zoom).toBe(
      MIN_ZOOM,
    );
  });

  it('pulls the offset back in when zooming out', () => {
    // Panned to the limit at 3×, then zoomed back to 1×: the offset that was
    // legal is now off the edge, and must be corrected rather than left to
    // open a gap.
    const zoomedIn = clampTransform(SQUARE, VIEWPORT, { zoom: 3, offsetX: 288, offsetY: 288 });
    expect(zoomedIn.offsetX).toBeCloseTo(288, 6);

    const zoomedOut = clampTransform(SQUARE, VIEWPORT, { ...zoomedIn, zoom: 1 });
    expect(zoomedOut).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });
  });
});

describe('sourceRectFor: pan and zoom pick a rectangle of the source image', () => {
  it('centres a square crop on a portrait photo by default', () => {
    const rect = sourceRectFor(PORTRAIT, VIEWPORT, DEFAULT_TRANSFORM);
    // The circle covers the full width and the middle 3024px of the height.
    expect(rect.size).toBeCloseTo(3024, 6);
    expect(rect.sx).toBeCloseTo(0, 6);
    expect(rect.sy).toBeCloseTo((4032 - 3024) / 2, 6);
  });

  it('translates a drag into source pixels at the right ratio', () => {
    // Drag the image DOWN by 48 viewport px at zoom 1. baseScale = 288/3024,
    // so 48 viewport px is 48 * 3024/288 = 504 source px, and dragging the
    // image down means reading a region 504px HIGHER in the source.
    const rect = sourceRectFor(PORTRAIT, VIEWPORT, { zoom: 1, offsetX: 0, offsetY: 48 });
    expect(rect.sy).toBeCloseTo((4032 - 3024) / 2 - 504, 6);
    // 48 is exactly the clamp limit, so this is the very top of the photo.
    expect(rect.sy).toBeCloseTo(0, 6);
    expect(rect.size).toBeCloseTo(3024, 6);
  });

  it('reaches the very bottom of a portrait photo at the other limit', () => {
    const rect = sourceRectFor(PORTRAIT, VIEWPORT, { zoom: 1, offsetX: 0, offsetY: -48 });
    expect(rect.sy).toBeCloseTo(4032 - 3024, 6);
    expect(rect.sy + rect.size).toBeCloseTo(4032, 6);
  });

  it('halves the region when the zoom doubles', () => {
    const one = sourceRectFor(PORTRAIT, VIEWPORT, { zoom: 1, offsetX: 0, offsetY: 0 });
    const two = sourceRectFor(PORTRAIT, VIEWPORT, { zoom: 2, offsetX: 0, offsetY: 0 });
    expect(two.size).toBeCloseTo(one.size / 2, 6);
    // Still centred on the same point.
    expect(two.sx + two.size / 2).toBeCloseTo(one.sx + one.size / 2, 6);
    expect(two.sy + two.size / 2).toBeCloseTo(one.sy + one.size / 2, 6);
  });

  it('combines pan and zoom into one rectangle', () => {
    // zoom 2 on the portrait: scale = 2*288/3024, region = 288/scale = 1512px.
    // offsetX = -72 => centre moves right by 72/scale = 378 source px.
    const rect = sourceRectFor(PORTRAIT, VIEWPORT, { zoom: 2, offsetX: -72, offsetY: 96 });
    const scale = (2 * VIEWPORT) / 3024;
    expect(rect.size).toBeCloseTo(VIEWPORT / scale, 6);
    expect(rect.sx).toBeCloseTo(3024 / 2 + 72 / scale - rect.size / 2, 6);
    expect(rect.sy).toBeCloseTo(4032 / 2 - 96 / scale - rect.size / 2, 6);
  });

  it('never reads outside the image, at any legal transform', () => {
    for (const source of [PORTRAIT, LANDSCAPE, SQUARE]) {
      for (const zoom of [1, 1.37, 2, 3.5, MAX_ZOOM]) {
        for (const [x, y] of [
          [0, 0],
          [1e4, 1e4],
          [-1e4, -1e4],
          [1e4, -1e4],
        ] as const) {
          const transform = clampTransform(source, VIEWPORT, { zoom, offsetX: x, offsetY: y });
          const rect = safeSourceRect(source, VIEWPORT, transform);
          expect(rect.sx).toBeGreaterThanOrEqual(0);
          expect(rect.sy).toBeGreaterThanOrEqual(0);
          expect(rect.sx + rect.size).toBeLessThanOrEqual(source.width + 1e-6);
          expect(rect.sy + rect.size).toBeLessThanOrEqual(source.height + 1e-6);
        }
      }
    }
  });
});

describe('zoomAround: the point under the finger stays put', () => {
  it('holds the focal point still', () => {
    const source = SQUARE;
    const focal = { x: 60, y: -40 };
    const before = { zoom: 1, offsetX: 0, offsetY: 0 };

    // The source pixel currently under `focal`…
    const scaleBefore = baseScale(source, VIEWPORT) * before.zoom;
    const pointBefore = {
      x: source.width / 2 + (focal.x - before.offsetX) / scaleBefore,
      y: source.height / 2 + (focal.y - before.offsetY) / scaleBefore,
    };

    const after = zoomAround(source, VIEWPORT, before, 2, focal);
    const scaleAfter = baseScale(source, VIEWPORT) * after.zoom;
    const pointAfter = {
      x: source.width / 2 + (focal.x - after.offsetX) / scaleAfter,
      y: source.height / 2 + (focal.y - after.offsetY) / scaleAfter,
    };

    // …is the same source pixel afterwards.
    expect(pointAfter.x).toBeCloseTo(pointBefore.x, 6);
    expect(pointAfter.y).toBeCloseTo(pointBefore.y, 6);
  });

  it('behaves as a plain centre zoom with no focal point', () => {
    expect(zoomAround(SQUARE, VIEWPORT, DEFAULT_TRANSFORM, 2)).toEqual({
      zoom: 2,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('clamps the result, so a focal zoom-out cannot leave a gap', () => {
    const zoomedIn = clampTransform(SQUARE, VIEWPORT, { zoom: 4, offsetX: 400, offsetY: 400 });
    const back = zoomAround(SQUARE, VIEWPORT, zoomedIn, 1, { x: 140, y: 140 });
    expect(back).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });
  });
});

describe('the exported size', () => {
  it('is 512, which is what the upload path uses', () => {
    expect(AVATAR_OUTPUT_SIZE).toBe(512);
  });
});
