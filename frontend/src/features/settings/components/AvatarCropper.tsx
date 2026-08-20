import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampTransform,
  displaySize,
  DEFAULT_TRANSFORM,
  MAX_ZOOM,
  MIN_ZOOM,
  zoomAround,
  type CropSource,
  type CropTransform,
} from '../crop-geometry';
import { SETTINGS_RU } from '../locale';

const T = SETTINGS_RU.profile.cropper;

/**
 * The circular crop surface — pan, zoom, and a dimmed mask.
 *
 * The pattern is Telegram's and iOS's, and it is copied deliberately: a phone
 * photo is portrait, and a naive centre-crop to a square puts a person's chin
 * or forehead in the circle. Somebody who cannot frame their own face does not
 * set an avatar at all, so this control is the difference between the feature
 * existing and the feature being used.
 *
 * ## Pointer events, not mouse + touch
 *
 * One code path covers finger, mouse, pen and a second finger for pinch. The
 * separate-handlers version is twice the code and always drifts — the desktop
 * path gets a fix the touch path does not, and nobody notices until somebody
 * tries it on a phone.
 *
 * `touch-action: none` on the surface is mandatory and not cosmetic: without it
 * the browser claims the gesture first and scrolls the settings page while the
 * member is trying to drag their own face into the circle.
 *
 * ## Zoom has three doors
 *
 * Wheel on desktop, pinch on touch, and a real `<input type="range">`. The
 * slider is not a fallback for exotic hardware — pinch is undiscoverable and
 * fiddly, and this app's seed data contains a grandmother. It is a native range
 * input precisely so it arrives focusable, arrow-key operable and labelled
 * without a single line of ARIA plumbing to get wrong.
 */

/** CSS pixels of the crop surface. Fixed, so the geometry has one honest unit. */
const VIEWPORT = 288;

const SLIDER_STEPS = 100;
const zoomToSlider = (zoom: number): number =>
  Math.round(((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * SLIDER_STEPS);
const sliderToZoom = (value: number): number =>
  MIN_ZOOM + (value / SLIDER_STEPS) * (MAX_ZOOM - MIN_ZOOM);

interface ActivePointer {
  readonly x: number;
  readonly y: number;
}

export function AvatarCropper(props: {
  image: HTMLImageElement;
  source: CropSource;
  transform: CropTransform;
  onChange: (transform: CropTransform) => void;
  disabled?: boolean;
}) {
  const { source, transform, onChange, disabled } = props;

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  /** Live pointers by id — one is a drag, two are a pinch. */
  const pointers = useRef(new Map<number, ActivePointer>());
  /** Pinch bookkeeping: the distance and zoom the gesture started from. */
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const size = useMemo(() => displaySize(source, VIEWPORT, transform), [source, transform]);

  /** Viewport-centre-relative coordinates for a raw client point. */
  const toLocal = useCallback((clientX: number, clientY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clientX - rect.left - rect.width / 2,
      y: clientY - rect.top - rect.height / 2,
    };
  }, []);

  const apply = useCallback(
    (next: CropTransform) => {
      onChange(clampTransform(source, VIEWPORT, next));
    },
    [onChange, source],
  );

  /* ----------------------------- pointer input ---------------------------- */

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    // Capture on the surface: a fast drag that leaves the element mid-gesture
    // must keep sending us moves, or the image sticks to the cursor.
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) pinch.current = { distance: distanceBetween(a, b), zoom: transform.zoom };
    }
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;

    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const distance = distanceBetween(a, b);
      if (pinch.current.distance <= 0) return;
      // Zoom about the midpoint between the fingers — the point the gesture is
      // visibly "about".
      const midpoint = toLocal((a.x + b.x) / 2, (a.y + b.y) / 2);
      apply(
        zoomAround(
          source,
          VIEWPORT,
          transform,
          pinch.current.zoom * (distance / pinch.current.distance),
          midpoint,
        ),
      );
      return;
    }

    apply({
      ...transform,
      offsetX: transform.offsetX + (event.clientX - previous.x),
      offsetY: transform.offsetY + (event.clientY - previous.y),
    });
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /**
   * Wheel zoom, bound natively so it can be non-passive.
   *
   * React's `onWheel` is registered passively, and a passive listener may not
   * call `preventDefault()` — so the page scrolls behind the cropper while the
   * image zooms. This has to be an explicit `addEventListener` with
   * `{ passive: false }`.
   */
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || disabled) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // `deltaMode` 1 is lines, not pixels — a mouse wheel in Firefox.
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const next = transform.zoom * Math.exp(-delta / 400);
      apply(zoomAround(source, VIEWPORT, transform, next, toLocal(event.clientX, event.clientY)));
    };

    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      surface.removeEventListener('wheel', onWheel);
    };
  }, [apply, disabled, source, toLocal, transform]);

  /* -------------------------------- render -------------------------------- */

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        ref={surfaceRef}
        data-testid="avatar-crop-surface"
        role="application"
        aria-label={T.surfaceLabel}
        aria-describedby="avatar-crop-hint"
        // `touch-none` is `touch-action: none`, and it is load-bearing: without
        // it the browser claims the gesture first and scrolls the settings page
        // while the member is dragging their face into the circle. A class
        // rather than an inline style so the stylesheet owns it — and so a test
        // can assert it, which an inline `touchAction` cannot be (jsdom's CSS
        // engine drops the property).
        className="relative touch-none overflow-hidden rounded-lg bg-muted select-none"
        style={{
          width: VIEWPORT,
          height: VIEWPORT,
          cursor: disabled ? 'default' : dragging ? 'grabbing' : 'grab',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
      >
        <img
          src={props.image.src}
          alt=""
          // Decorative: the member is looking at their own photograph, and the
          // surface itself carries the label.
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute top-1/2 left-1/2 max-w-none"
          style={{
            width: size.width,
            height: size.height,
            transform: `translate(-50%, -50%) translate(${String(transform.offsetX)}px, ${String(transform.offsetY)}px)`,
          }}
        />

        {/*
          The mask: one element, dimming everything outside the circle. A huge
          spread `box-shadow` on a transparent circle is the reliable way to do
          this — a radial gradient banding differs per browser, and an SVG mask
          needs its own sizing logic. `pointer-events-none` keeps it out of the
          way of the drag underneath it.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-lg"
          style={{
            boxShadow: '0 0 0 9999px color-mix(in oklch, var(--background) 72%, transparent)',
            clipPath: 'inset(0 round 0.5rem)',
            borderRadius: '50%',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-background/80"
        />
      </div>

      <p id="avatar-crop-hint" className="text-center text-xs text-muted-foreground">
        {T.hint}
      </p>

      <div className="flex w-full max-w-72 items-center gap-3">
        <span aria-hidden className="text-xs text-muted-foreground">
          −
        </span>
        {/*
          A native range input: focusable, arrow-key and Home/End operable, and
          announced with its value, all without a line of ARIA. The custom
          slider that would have looked marginally better is the one a
          keyboard user cannot reach.
        */}
        <input
          type="range"
          className="h-11 w-full accent-primary"
          aria-label={T.zoomLabel}
          min={0}
          max={SLIDER_STEPS}
          step={1}
          disabled={disabled ?? false}
          value={zoomToSlider(transform.zoom)}
          onChange={(event) => {
            apply(
              zoomAround(source, VIEWPORT, transform, sliderToZoom(Number(event.target.value))),
            );
          }}
        />
        <span aria-hidden className="text-xs text-muted-foreground">
          +
        </span>
      </div>

      <button
        type="button"
        className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        disabled={disabled ?? false}
        onClick={() => {
          onChange(DEFAULT_TRANSFORM);
        }}
      >
        {T.reset}
      </button>
    </div>
  );
}

function distanceBetween(a: ActivePointer, b: ActivePointer): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export { VIEWPORT as CROP_VIEWPORT };
