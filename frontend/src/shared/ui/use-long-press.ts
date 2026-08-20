import { useCallback, useEffect, useRef, type TouchEvent as ReactTouchEvent } from 'react';

/**
 * Long-press → the row's action sheet (§C-gestures/G5).
 *
 * 450ms, cancelled by more than 10px of movement or by any scroll, and — the
 * part that is easy to get wrong — it must not *also* fire the row's tap. On a
 * row whose whole surface is a `<Link>` to a detail screen, a long-press that
 * opens a sheet and navigates underneath it is worse than no gesture at all.
 *
 * ## Why touch events and not pointer events
 *
 * Pointer events would also fire for a mouse, and a 450ms mouse-down is not a
 * gesture, it is a slow click. Touch events gate this to a finger by
 * construction, which is the same `(pointer: coarse)` rule the rest of
 * §C-gestures applies — just enforced by the event stream instead of by a media
 * query.
 *
 * ## Suppressing the tap
 *
 * iOS fires `touchend` → `click` for a long press exactly as it does for a
 * short one. The binding therefore returns an `onClickCapture` that swallows
 * **one** click for a short window after the sheet opened. Capture phase, so it
 * runs before the `<Link>`'s own handler, and `preventDefault()` as well as
 * `stopPropagation()`, because an anchor navigates on the default action rather
 * than on a listener.
 *
 * `contextmenu` is cancelled too: Android's long-press raises one, and Safari
 * raises the selection callout. The row also wants the `.no-callout` utility —
 * this hook cannot add a class to an element it does not own.
 *
 * ## Nothing is reachable *only* by long-press
 *
 * §G1 is a hard rule and this hook cannot enforce it. Every caller must make
 * the same actions reachable from a visible control — a `⋯` on the row, or the
 * detail screen the row already opens.
 */
export const LONG_PRESS_MS = 450;

/** A finger that has travelled this far is scrolling, not pressing. */
export const LONG_PRESS_SLOP_PX = 10;

/** How long a click is swallowed after the press fired. */
const CLICK_SUPPRESS_MS = 700;

export interface LongPressBinding {
  onTouchStart: (event: ReactTouchEvent) => void;
  onTouchMove: (event: ReactTouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
  onContextMenu: (event: { preventDefault: () => void }) => void;
  onClickCapture: (event: {
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => void;
}

export interface UseLongPressResult {
  /** Spread onto the element that should respond to a long press. */
  handlers: LongPressBinding;
  /**
   * Abandon a press in flight. `SwipeRow` calls this the moment the horizontal
   * axis lock engages: one finger cannot be doing both gestures, and the swipe
   * is the one the user has already committed to by moving.
   */
  cancel: () => void;
}

export function useLongPress(options: {
  onLongPress: () => void;
  /** `false` disables the gesture without changing the caller's JSX. */
  enabled?: boolean;
  delay?: number;
}): UseLongPressResult {
  const { onLongPress } = options;
  const enabled = options.enabled ?? true;
  const delay = options.delay ?? LONG_PRESS_MS;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const suppressUntil = useRef(0);
  // Read inside the timeout so a caller passing an inline arrow does not need
  // to memoise it to keep the timer honest.
  const latest = useRef(onLongPress);
  latest.current = onLongPress;

  const clear = useCallback((): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  // A press that survives to the timeout while the page is scrolling under it
  // is a scroll, not a press. `scroll` is listened for on the window because
  // the document is the scroll container (§F7).
  useEffect(() => clear, [clear]);

  const onTouchStart = useCallback(
    (event: ReactTouchEvent): void => {
      if (!enabled) return;
      // Two fingers is a pinch, and the second finger must not restart a press
      // the first one already cancelled.
      if (event.touches.length !== 1) {
        clear();
        return;
      }
      const touch = event.touches[0];
      if (touch === undefined) return;
      origin.current = { x: touch.clientX, y: touch.clientY };

      const onScroll = (): void => {
        clear();
        window.removeEventListener('scroll', onScroll);
      };
      window.addEventListener('scroll', onScroll, { passive: true, once: true });

      timer.current = setTimeout(() => {
        timer.current = null;
        origin.current = null;
        window.removeEventListener('scroll', onScroll);
        suppressUntil.current = Date.now() + CLICK_SUPPRESS_MS;
        latest.current();
      }, delay);
    },
    [clear, delay, enabled],
  );

  const onTouchMove = useCallback(
    (event: ReactTouchEvent): void => {
      const start = origin.current;
      if (start === null) return;
      const touch = event.touches[0];
      if (touch === undefined) return;
      const moved =
        Math.abs(touch.clientX - start.x) > LONG_PRESS_SLOP_PX ||
        Math.abs(touch.clientY - start.y) > LONG_PRESS_SLOP_PX;
      if (moved) clear();
    },
    [clear],
  );

  const onClickCapture = useCallback(
    (event: { preventDefault: () => void; stopPropagation: () => void }): void => {
      if (Date.now() >= suppressUntil.current) return;
      suppressUntil.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  const onContextMenu = useCallback(
    (event: { preventDefault: () => void }): void => {
      if (!enabled) return;
      event.preventDefault();
    },
    [enabled],
  );

  return {
    cancel: clear,
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd: clear,
      onTouchCancel: clear,
      onContextMenu,
      onClickCapture,
    },
  };
}
