import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';

import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { useCoarsePointer } from '@/shared/ui/use-coarse-pointer';
import { usePrefersReducedMotion } from '@/shared/ui/use-reduced-motion';
import { useLongPress, type UseLongPressResult } from '@/shared/ui/use-long-press';

/**
 * A row you can swipe **left** to fire one reversible action (§C-gestures/G4).
 *
 * ```
 *  ○  Молоко 2 л                      →  ○  Молоко 2 л   ┃  ✓        ┃
 *                                                        ┃ Куплено   ┃
 * ```
 *
 * ## The five rules this component exists to keep
 *
 * 1. **Left only.** A rightward drag is handed straight back to the system: on
 *    iOS a left-to-right drag is the back gesture, and an app that eats it
 *    breaks the only navigation control a standalone PWA has. There is no
 *    right-swipe action anywhere in this app, and adding one here would put it
 *    on every row at once. `TaskCard` used to carry exactly that and it was
 *    removed for this reason — do not bring it back.
 * 2. **A 32px dead zone at the left edge of the *viewport*.** Not the left edge
 *    of the row: the system reads the back gesture off the screen, so a row
 *    indented by a section's padding must still refuse a touch that started at
 *    `clientX < 32`. Even a leftward drag beginning there is left alone, because
 *    that is where a finger mid-back-gesture lives.
 * 3. **Reversible actions only.** The `action` this component takes is «куплено»
 *    / «сделано» / «прочитано» and never «удалить». Delete stays on the visible
 *    🗑 and in the long-press sheet, behind a confirmation, because a
 *    destructive action one careless thumb away is how a family loses its
 *    shopping list. This is a rule the component cannot enforce — it is on
 *    every caller.
 * 4. **A 6-second undo toast**, one at a time. The toast carries a fixed id, so
 *    a second swipe replaces the first toast and the first action stands
 *    (§G4).
 * 5. **It must not fight the scroll.** The moving layer is `touch-action:
 *    pan-y`, so the browser keeps vertical panning and only horizontal movement
 *    reaches us; the gesture then engages *only* after 12px of horizontal
 *    travel with |Δx| ≥ 2·|Δy|, and calls `preventDefault()` from then on.
 *    Anything less strict turns a list into a surface that stutters when you
 *    try to scroll it.
 *
 * ## Why native listeners instead of React's `onTouchMove`
 *
 * React attaches `touchstart`/`touchmove` at the root as **passive**
 * listeners, so `preventDefault()` inside an `onTouchMove` prop does nothing
 * but log a console warning. Once the axis lock engages this row genuinely has
 * to cancel the browser's default handling, so the move listener is registered
 * by hand with `{ passive: false }`.
 *
 * ## Why the drag writes to the DOM directly
 *
 * The transform is written to `panelRef.current.style` inside the move handler
 * rather than through React state. A `setState` per `touchmove` on a
 * thirty-row shopping list is a re-render per frame of the whole list, on the
 * device least able to afford it. React state is used only for the two resting
 * states (open / closed), which change at most twice per gesture.
 */

/** One action button, 88px wide (§G4 "rest stop"). */
const REST_STOP_PX = 88;

/** Horizontal travel before the row moves at all. */
const ENGAGE_PX = 12;

/** `|Δx| ≥ AXIS_RATIO × |Δy|` or it is a scroll. */
const AXIS_RATIO = 2;

/** Released past this fraction of the row's width and the action fires. */
const COMMIT_FRACTION = 0.45;

/** Past 50 % of the row width the finger stops being tracked 1:1. */
const RUBBER_BAND_FROM = 0.5;
const RUBBER_BAND_FACTOR = 0.35;

/**
 * The iOS system back gesture starts within ~20–30px of the left edge (§G3).
 * 32 buys a margin without eating a meaningful part of a 320px screen.
 */
export const SWIPE_DEAD_ZONE_PX = 32;

/** §G4: 180ms height + opacity, so the list does not teleport. */
const COLLAPSE_MS = 180;

/** «Отменить» must live for six seconds (§G4). */
const UNDO_TOAST_MS = 6000;

/**
 * One toast at a time, app-wide. A second swipe replaces the first toast and
 * the first action stands — which is the behaviour §G4 asks for, expressed as
 * a stable sonner id rather than as a queue we would have to maintain.
 */
const UNDO_TOAST_ID = 'swipe-row-undo';

export type SwipeTone = 'success' | 'primary' | 'secondary';

const toneClass: Record<SwipeTone, string> = {
  success: 'bg-success text-success-foreground',
  primary: 'bg-primary text-primary-foreground',
  secondary: 'bg-secondary text-secondary-foreground',
};

export interface SwipeAction {
  /** One word on the button and in the toast: «Куплено», «Сделано». */
  label: string;
  /** Colour is never the only signal (§B4) — the icon and the word carry it. */
  icon: ReactNode;
  tone: SwipeTone;
  /** Fired on commit. Must go through the same path the visible control uses. */
  onCommit: () => void;
  /**
   * Reverses `onCommit`. Its absence is a claim that the action genuinely
   * cannot be undone, and it costs the toast its «Отменить» — so it is a
   * decision, not a default.
   */
  onUndo?: () => void;
  /** Defaults to «Отменить». */
  undoLabel?: string;
  /** Accessible name of the revealed button. Defaults to `label`. */
  ariaLabel?: string;
}

export interface SwipeRowProps {
  /**
   * `null` disables the gesture entirely — a read-only row, a row already in
   * the state the action would put it in, a fine pointer.
   */
  action: SwipeAction | null;
  children: ReactNode;
  /** `li` when the row lives in a list. */
  as?: 'div' | 'li';
  /** Classes for the clipping wrapper. */
  className?: string;
  /**
   * Classes for the layer that moves. It does not have to be opaque — the
   * action button is `visibility: hidden` until a gesture engages — but a row
   * whose own surface is translucent will show the *section* behind it while it
   * slides, which is usually what you want.
   */
  contentClassName?: string;
  /**
   * `true` when a commit takes the row out of this section — a bought item, a
   * finished chore. The row's height animates to 0 over 180ms and *then*
   * `onCommit` fires, so the list closes the gap instead of teleporting.
   *
   * The order is deliberate and it is the one departure from the letter of §G4,
   * which asks for the in-place state change first and the collapse second.
   * With optimistic mutations the state change is what *removes* the row from
   * this section, so "commit then collapse" is "commit then watch an unmounted
   * element animate" — i.e. no animation at all. Collapsing first is the only
   * ordering in which the 180ms is ever seen.
   */
  collapse?: boolean;
  /** Opens the row's action sheet (§G5). The same sheet a visible control opens. */
  onLongPress?: () => void;
}

interface Gesture {
  startX: number;
  startY: number;
  /** The gesture belongs to the system (dead zone) or to the scroller. */
  abandoned: boolean;
  engaged: boolean;
  /** Current leftward displacement, in px, always ≥ 0. */
  offset: number;
  width: number;
  /** `navigator.vibrate` fires once per gesture, at the threshold (§G4). */
  buzzed: boolean;
}

export function SwipeRow({
  action,
  children,
  as = 'div',
  className,
  contentClassName,
  collapse = false,
  onLongPress,
}: SwipeRowProps) {
  // `as` is only ever a runtime tag name. Narrowing it to `'div'` for the type
  // checker keeps `ref` and `className` concrete instead of a union of every
  // intrinsic element's props, which no amount of generics makes readable.
  const Tag = as as 'div';
  const coarse = useCoarsePointer();
  const reducedMotion = usePrefersReducedMotion();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const [open, setOpen] = useState(false);

  // Read from inside native listeners, which are registered once and must not
  // close over a stale render.
  const actionRef = useRef(action);
  actionRef.current = action;
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  const collapseRef = useRef(collapse);
  collapseRef.current = collapse;

  const longPress: UseLongPressResult = useLongPress({
    onLongPress: onLongPress ?? (() => undefined),
    enabled: onLongPress !== undefined,
  });
  const cancelLongPress = longPress.cancel;

  const enabled = coarse && action !== null;

  const translate = useCallback((offset: number, animate: boolean): void => {
    const panel = panelRef.current;
    if (panel === null) return;
    panel.style.transition = animate ? 'transform 180ms cubic-bezier(0.2, 0, 0, 1)' : 'none';
    panel.style.transform = offset === 0 ? '' : `translate3d(${String(-offset)}px, 0, 0)`;
  }, []);

  /**
   * Show or hide the action button.
   *
   * The button is `visibility: hidden` at rest rather than merely covered by
   * the row, because "merely covered" would make the row's own background
   * load-bearing: a translucent surface — the `--accent/40` wash on an unread
   * notification, a `calm` section — would let the button glow through a row
   * nobody has touched. Toggling visibility instead means a caller never has to
   * think about opacity, and it costs one direct style write per gesture rather
   * than a re-render per frame.
   */
  const reveal = useCallback((visible: boolean): void => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    const button = buttonRef.current;
    if (button === null) return;
    if (visible) {
      button.style.visibility = 'visible';
      return;
    }
    // Hidden only once the row has finished sliding back over it, or the last
    // 180ms of the snap plays against a hole in the list.
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      if (buttonRef.current !== null) buttonRef.current.style.visibility = '';
    }, 200);
  }, []);

  useEffect(
    () => () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );

  /** Snap shut, forget the gesture. Used on unmount, on disable, on undo. */
  const close = useCallback(
    (animate = true): void => {
      gesture.current = null;
      setOpen(false);
      translate(0, animate);
      reveal(false);
    },
    [translate, reveal],
  );

  const raiseToast = useCallback((committed: SwipeAction): void => {
    const undo = committed.onUndo;
    toast(committed.label, {
      id: UNDO_TOAST_ID,
      duration: UNDO_TOAST_MS,
      ...(undo
        ? {
            action: {
              label: committed.undoLabel ?? COMMON.undo,
              onClick: () => {
                undo();
              },
            },
          }
        : {}),
    });
  }, []);

  const commit = useCallback((): void => {
    const committed = actionRef.current;
    if (committed === null) return;
    close(true);

    const fire = (): void => {
      committed.onCommit();
      raiseToast(committed);
    };

    const root = rootRef.current;
    if (!collapseRef.current || reducedRef.current || root === null) {
      fire();
      return;
    }

    // Height must be a number before it can be animated to zero; `auto` does
    // not interpolate.
    const height = root.getBoundingClientRect().height;
    root.style.overflow = 'hidden';
    root.style.height = `${String(height)}px`;
    root.style.opacity = '1';
    // Two frames: one to land the explicit height, one to start from it.
    requestAnimationFrame(() => {
      const node = rootRef.current;
      if (node === null) return;
      node.style.transition = `height ${String(COLLAPSE_MS)}ms ease-out, opacity ${String(COLLAPSE_MS)}ms ease-out`;
      node.style.height = '0px';
      node.style.opacity = '0';
    });

    setTimeout(() => {
      fire();
      // The row has almost always unmounted by now — the optimistic write moved
      // it to another section. If it has not (a rejected mutation, a list that
      // keeps it), give it its height back rather than leave an invisible row.
      setTimeout(() => {
        const node = rootRef.current;
        if (node === null) return;
        node.style.transition = '';
        node.style.height = '';
        node.style.opacity = '';
        node.style.overflow = '';
      }, 250);
    }, COLLAPSE_MS);
  }, [close, raiseToast]);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null || !enabled) return;

    const onTouchStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (touch === undefined || event.touches.length !== 1) {
        gesture.current = null;
        return;
      }
      gesture.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        // §G3 dead zone: measured against the viewport, not the row.
        abandoned: touch.clientX < SWIPE_DEAD_ZONE_PX,
        engaged: false,
        offset: 0,
        width: panel.getBoundingClientRect().width || 1,
        buzzed: false,
      };
    };

    const onTouchMove = (event: TouchEvent): void => {
      const state = gesture.current;
      const touch = event.touches[0];
      if (state === null || touch === undefined) return;
      if (state.abandoned) return;

      const dx = state.startX - touch.clientX; // positive = leftward
      const dy = Math.abs(touch.clientY - state.startY);

      if (!state.engaged) {
        // Rightward first: the system back gesture's direction. Hand it over
        // and never take this gesture back.
        if (dx < -ENGAGE_PX) {
          state.abandoned = true;
          return;
        }
        // Vertical first: a scroll. Same — abandoned for good, so a diagonal
        // flick cannot turn into a swipe halfway down the screen.
        if (dy > ENGAGE_PX && dy > dx) {
          state.abandoned = true;
          return;
        }
        if (dx < ENGAGE_PX || dx < AXIS_RATIO * dy) return;
        state.engaged = true;
        reveal(true);
        // One finger, one gesture.
        cancelLongPress();
      }

      // From here the row owns the gesture, so the browser must not also scroll
      // it. Only reachable with `{ passive: false }` — see the note above.
      if (event.cancelable) event.preventDefault();

      const knee = state.width * RUBBER_BAND_FROM;
      const raw = Math.max(0, dx);
      state.offset = raw <= knee ? raw : knee + (raw - knee) * RUBBER_BAND_FACTOR;

      if (!state.buzzed && state.offset >= state.width * COMMIT_FRACTION) {
        state.buzzed = true;
        // Android only — iOS Safari has no `navigator.vibrate`. A pure
        // enhancement: the real feedback is the visual snap (§G4).
        navigator.vibrate?.(10);
      }

      translate(state.offset, false);
    };

    const onTouchEnd = (): void => {
      const state = gesture.current;
      gesture.current = null;
      if (state === null || !state.engaged) return;

      if (state.offset >= state.width * COMMIT_FRACTION) {
        commit();
        return;
      }
      if (state.offset >= REST_STOP_PX) {
        setOpen(true);
        translate(REST_STOP_PX, true);
        return;
      }
      close(true);
    };

    const onTouchCancel = (): void => {
      close(true);
    };

    panel.addEventListener('touchstart', onTouchStart, { passive: true });
    panel.addEventListener('touchmove', onTouchMove, { passive: false });
    panel.addEventListener('touchend', onTouchEnd, { passive: true });
    panel.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      panel.removeEventListener('touchstart', onTouchStart);
      panel.removeEventListener('touchmove', onTouchMove);
      panel.removeEventListener('touchend', onTouchEnd);
      panel.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [enabled, translate, commit, cancelLongPress, close, reveal]);

  // A row that loses its action mid-flight (permission change, state change)
  // must not stay parked at 88px with nothing behind it.
  useEffect(() => {
    if (!enabled && open) close(false);
  }, [enabled, open, close]);

  const longPressHandlers = onLongPress !== undefined && coarse ? longPress.handlers : null;

  return (
    <Tag
      ref={rootRef}
      data-slot="swipe-row"
      data-swipe-open={open ? '' : undefined}
      className={cn('relative isolate overflow-hidden', className)}
    >
      {enabled && action !== null ? (
        <button
          ref={buttonRef}
          type="button"
          // Behind the row, revealed by it moving. Not a "visible twin" — the
          // row's own tick is that (§G1) — so it stays out of the tab order and
          // out of the accessibility tree until it is actually on screen.
          aria-label={action.ariaLabel ?? action.label}
          aria-hidden={!open}
          tabIndex={open ? 0 : -1}
          onClick={() => {
            commit();
          }}
          className={cn(
            'invisible absolute inset-y-0 right-0 z-0 flex w-[88px] flex-col items-center justify-center gap-1',
            'text-[13px] leading-[18px] font-semibold no-callout',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            toneClass[action.tone],
          )}
        >
          <span aria-hidden className="[&_svg]:size-5">
            {action.icon}
          </span>
          {action.label}
        </button>
      ) : null}

      <div
        ref={panelRef}
        data-slot="swipe-row-panel"
        // `touch-pan-y` is what lets the list scroll normally: the browser keeps
        // vertical panning and hands us the horizontal component, which is the
        // only axis this row wants.
        className={cn(
          'relative z-10',
          enabled && 'touch-pan-y will-change-transform',
          onLongPress !== undefined && 'no-callout',
          contentClassName,
        )}
        {...(longPressHandlers ?? {})}
        onClickCapture={(event: ReactMouseEvent) => {
          // A tap on a row that is standing open is "put it back", not "open
          // the detail screen". Without this the revealed button is impossible
          // to dismiss without swiping again.
          if (open) {
            event.preventDefault();
            event.stopPropagation();
            close(true);
            return;
          }
          longPressHandlers?.onClickCapture(event);
        }}
      >
        {children}
      </div>
    </Tag>
  );
}
