/**
 * The maths behind the circular avatar cropper.
 *
 * Kept apart from React and from `<canvas>` on purpose: this is the part that
 * has to be *right*, and it is the part a rendering test cannot check. "Did the
 * circle look full?" is a screenshot; "does dragging 40px up at zoom 2 read the
 * rectangle 20px lower in the source image?" is arithmetic, and it is what
 * decides whether the exported picture matches the preview.
 *
 * ## The model
 *
 * The crop surface is a square of `viewport` CSS pixels with the circular mask
 * inscribed in it. The image sits behind it, scaled and translated:
 *
 * - `zoom` is a multiplier over the **cover** baseline — the scale at which the
 *   image's shorter side exactly fills the viewport. `zoom = 1` therefore always
 *   means "fills the circle with nothing to spare", whatever the aspect ratio,
 *   which is why it is the sensible default framing for a portrait phone photo
 *   and for a square one alike.
 * - `offsetX` / `offsetY` translate the image's centre away from the viewport's
 *   centre, in viewport pixels. Positive `offsetY` moves the image **down**,
 *   i.e. reveals more of its top.
 *
 * {@link clampTransform} is what guarantees the mask is never left with a gap:
 * the offset can never exceed the overhang the current zoom produces, and at
 * `zoom = 1` a portrait image has exactly zero horizontal room and real vertical
 * room. That asymmetry is the whole feature — the reason a phone photo can be
 * framed on the face rather than on the chin.
 */

/** The exported avatar. 512 is enough for a retina 128px display and no more. */
export const AVATAR_OUTPUT_SIZE = 512;

export const MIN_ZOOM = 1;
/**
 * Past 4× a 512px export is reading fewer than 128 source pixels and the result
 * is visibly soft. The slider stops where the picture stops being worth it.
 */
export const MAX_ZOOM = 4;

export interface CropSource {
  /** `naturalWidth` of the decoded image. */
  readonly width: number;
  /** `naturalHeight` of the decoded image. */
  readonly height: number;
}

export interface CropTransform {
  readonly zoom: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** A point in viewport coordinates, measured from the viewport's centre. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export const DEFAULT_TRANSFORM: CropTransform = { zoom: 1, offsetX: 0, offsetY: 0 };

/**
 * `+ 0` normalises negative zero away. `Math.max(-0, -500)` is `-0`, which
 * compares equal to `0` but renders as `"-0px"` in the transform string and
 * makes every equality assertion about a pinned image read strangely.
 */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value)) + 0;

/**
 * Scale at which the image exactly covers the viewport — the shorter side maps
 * to the full square, the longer one overhangs.
 */
export function baseScale(source: CropSource, viewport: number): number {
  const shorter = Math.min(source.width, source.height);
  if (shorter <= 0) return 1;
  return viewport / shorter;
}

/** On-screen size of the image at this transform, in viewport pixels. */
export function displaySize(
  source: CropSource,
  viewport: number,
  transform: CropTransform,
): { width: number; height: number } {
  const scale = baseScale(source, viewport) * transform.zoom;
  return { width: source.width * scale, height: source.height * scale };
}

/**
 * How far the image may be dragged before a gap would open at the mask.
 *
 * Exactly half the overhang on each axis. `Math.max(0, …)` guards the pixel of
 * floating-point overhang a square image at `zoom = 1` can produce; without it
 * the value goes very slightly negative and `clamp(min > max)` snaps the image
 * to a corner.
 */
export function maxOffset(
  source: CropSource,
  viewport: number,
  transform: CropTransform,
): Point {
  const size = displaySize(source, viewport, transform);
  return {
    x: Math.max(0, (size.width - viewport) / 2),
    y: Math.max(0, (size.height - viewport) / 2),
  };
}

/**
 * Force a transform back inside the legal range.
 *
 * Every interaction goes through this, so there is no code path — drag, wheel,
 * pinch, slider, keyboard — that can leave the circle showing background.
 */
export function clampTransform(
  source: CropSource,
  viewport: number,
  transform: CropTransform,
): CropTransform {
  const zoom = clamp(transform.zoom, MIN_ZOOM, MAX_ZOOM);
  const limit = maxOffset(source, viewport, { ...transform, zoom });
  return {
    zoom,
    offsetX: clamp(transform.offsetX, -limit.x, limit.x),
    offsetY: clamp(transform.offsetY, -limit.y, limit.y),
  };
}

/**
 * Change the zoom while holding one point of the image still under `focal`.
 *
 * This is what makes a pinch feel like a pinch and a wheel feel like a map:
 * zooming around the centre instead sends whatever you were looking at sliding
 * off toward the edge. `focal` is relative to the viewport's centre; pass
 * `{x: 0, y: 0}` for the slider, which has no focal point of its own.
 */
export function zoomAround(
  source: CropSource,
  viewport: number,
  transform: CropTransform,
  nextZoom: number,
  focal: Point = { x: 0, y: 0 },
): CropTransform {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const ratio = zoom / transform.zoom;
  return clampTransform(source, viewport, {
    zoom,
    offsetX: focal.x + (transform.offsetX - focal.x) * ratio,
    offsetY: focal.y + (transform.offsetY - focal.y) * ratio,
  });
}

export interface SourceRect {
  /** Left edge in the **source image's** pixels. */
  readonly sx: number;
  readonly sy: number;
  /** Side of the square region. Always square — the export is square. */
  readonly size: number;
}

/**
 * The region of the source image the viewport is currently showing.
 *
 * This is the single value the export depends on: `drawImage(img, sx, sy, size,
 * size, 0, 0, 512, 512)`. Preview and export therefore cannot disagree — they
 * are the same numbers, applied once to a DOM transform and once to a canvas.
 *
 * The square is the *bounding box of the circle*, not the circle: we store a
 * square image and let CSS mask it, exactly as every other avatar in the app is
 * already rendered. Storing a transparent-cornered circle would look wrong the
 * moment anything renders it on a non-matching background.
 */
export function sourceRectFor(
  source: CropSource,
  viewport: number,
  transform: CropTransform,
): SourceRect {
  const scale = baseScale(source, viewport) * transform.zoom;
  // How much of the source one viewport-square covers.
  const size = viewport / scale;
  return {
    sx: source.width / 2 - transform.offsetX / scale - size / 2,
    sy: source.height / 2 - transform.offsetY / scale - size / 2,
    size,
  };
}

/**
 * `sourceRectFor` with the result nudged inside the image bounds.
 *
 * `clampTransform` already keeps it there, but rounding at high zoom on an odd
 * pixel size can push the rectangle a fraction of a pixel past the edge, and
 * `drawImage` answers that with a transparent sliver along one side. Cheap
 * insurance for a defect that only appears on some images.
 */
export function safeSourceRect(
  source: CropSource,
  viewport: number,
  transform: CropTransform,
): SourceRect {
  const rect = sourceRectFor(source, viewport, transform);
  const size = Math.min(rect.size, source.width, source.height);
  return {
    size,
    sx: clamp(rect.sx, 0, Math.max(0, source.width - size)),
    sy: clamp(rect.sy, 0, Math.max(0, source.height - size)),
  };
}
