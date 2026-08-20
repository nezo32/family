import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { cn } from '@/shared/lib/utils';
import { useCoarsePointer } from '@/shared/ui/use-coarse-pointer';
import { usePrefersReducedMotion } from '@/shared/ui/use-reduced-motion';

/**
 * Pull down at the top of the page to refetch (§C-gestures/G6).
 *
 * ## `refetchQueries`, never `location.reload()`
 *
 * This is the whole reason the component exists rather than a two-line
 * listener. In an installed PWA a reload is a **cold start**: it throws away
 * the Query cache, the shopping outbox's in-memory state, every in-flight
 * optimistic write and any half-typed form on the screen — and then shows a
 * splash while it fetches everything again. A refetch of the active queries
 * costs one request per visible screen and keeps all of that. (§F8, research
 * §8.)
 *
 * ## It is an accelerator, never the only way to get fresh data
 *
 * The app already refetches on `visibilitychange → visible`. A family member
 * who never discovers this gesture is never stale because of it; that is what
 * makes it safe for the gesture to be silent, with no coach mark and no
 * "потяните, чтобы обновить" hint (§G1).
 *
 * ## When it must stay out of the way
 *
 * - **Fine pointers.** There is no pull gesture with a mouse, and a scroll
 *   wheel at `scrollY === 0` must not trigger anything.
 * - **`scrollY !== 0`.** Anywhere but the very top the drag is a scroll.
 * - **While a dialog, sheet or drawer is open.** Radix and vaul both lock the
 *   body while a modal is up (`data-scroll-locked`), and a sheet's own drag
 *   handle is a downward drag at the top of a surface — precisely this gesture,
 *   aimed at something else.
 * - **Browser Safari, below iOS's own overscroll.** `overscroll-behavior-y:
 *   none` on `html`/`body` (`index.css`) already removes Safari's rubber band,
 *   so in practice there is nothing to collide with — but §G2 says implementers
 *   must verify that on a device rather than assume it, and that verification
 *   has not happened on real hardware.
 *
 * ## Mounting
 *
 * §G6 hosts this in `AppShell`, around its `<main>`. It is written so that
 * mounting is one wrapper with no props: it reads the document scroller
 * directly, and its indicator is `position: fixed`, so it adds no layout of its
 * own and can sit anywhere in the tree.
 */

/** Travel before the release refetches. */
const THRESHOLD_PX = 64;

/** The indicator band's height at full extension (§G6). */
const BAND_PX = 56;

/** Past the threshold the finger stops being tracked 1:1. */
const RESISTANCE = 0.5;

/** A drag this far sideways is not a pull. */
const AXIS_SLOP_PX = 24;

interface Pull {
  startX: number;
  startY: number;
  active: boolean;
  abandoned: boolean;
  distance: number;
}

/** Is a modal on screen? Radix and vaul both mark the body while one is. */
function modalIsOpen(): boolean {
  if (document.body.hasAttribute('data-scroll-locked')) return true;
  return document.querySelector('[data-slot="responsive-dialog"], [role="dialog"]') !== null;
}

export function PullToRefresh(props: {
  children: React.ReactNode;
  /** Overrides the refetch — for a screen that owns something Query does not. */
  onRefresh?: () => Promise<unknown>;
  /** Turns the gesture off without changing the caller's JSX. */
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const coarse = useCoarsePointer();
  const reducedMotion = usePrefersReducedMotion();

  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pull = useRef<Pull | null>(null);
  const refreshingRef = useRef(false);

  const onRefresh = props.onRefresh;
  const refresh = useCallback(async (): Promise<void> => {
    if (onRefresh) {
      await onRefresh();
      return;
    }
    // `type: 'active'` — only what is mounted. Refetching every cached query
    // would pull screens nobody is looking at over a phone connection.
    await queryClient.refetchQueries({ type: 'active' });
  }, [onRefresh, queryClient]);

  const enabled = coarse && props.disabled !== true;

  useEffect(() => {
    if (!enabled) return;

    const onTouchStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (touch === undefined || event.touches.length !== 1) return;
      if (refreshingRef.current) return;
      if (window.scrollY > 0 || modalIsOpen()) return;
      pull.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        active: false,
        abandoned: false,
        distance: 0,
      };
    };

    const onTouchMove = (event: TouchEvent): void => {
      const state = pull.current;
      const touch = event.touches[0];
      if (state === null || touch === undefined || state.abandoned) return;

      const dy = touch.clientY - state.startY;
      const dx = Math.abs(touch.clientX - state.startX);

      if (!state.active) {
        // Upward, sideways, or the page has scrolled under us: not a pull.
        if (dy < 0 || dx > AXIS_SLOP_PX || window.scrollY > 0) {
          state.abandoned = true;
          return;
        }
        if (dy < 8) return;
        state.active = true;
      }

      if (event.cancelable) event.preventDefault();
      state.distance = dy <= THRESHOLD_PX ? dy : THRESHOLD_PX + (dy - THRESHOLD_PX) * RESISTANCE;
      setDistance(state.distance);
    };

    const finish = (): void => {
      const state = pull.current;
      pull.current = null;
      if (state === null || !state.active) return;

      if (state.distance < THRESHOLD_PX) {
        setDistance(0);
        return;
      }

      refreshingRef.current = true;
      setRefreshing(true);
      setDistance(BAND_PX);
      void refresh()
        .catch(() => undefined)
        .finally(() => {
          refreshingRef.current = false;
          setRefreshing(false);
          setDistance(0);
        });
    };

    // `{ passive: false }` on the move listener only: the pull has to be able
    // to cancel the browser's own handling once it engages, and a passive
    // listener cannot.
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', finish, { passive: true });
    document.addEventListener('touchcancel', finish, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', finish);
      document.removeEventListener('touchcancel', finish);
    };
  }, [enabled, refresh]);

  const progress = Math.min(1, distance / THRESHOLD_PX);
  const visible = distance > 0 || refreshing;

  return (
    <>
      {visible ? (
        <div
          data-slot="pull-to-refresh"
          data-refreshing={refreshing ? '' : undefined}
          aria-hidden
          // Fixed, so the band grows out from under the app bar without adding
          // a pixel of layout to the page it is refreshing. `pt-safe` because
          // in standalone the top of the viewport is under the status bar.
          className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center pt-safe"
          style={{ height: `${String(Math.min(distance, BAND_PX))}px` }}
        >
          <span
            className={cn(
              'flex items-center justify-center self-end rounded-full bg-card p-2 text-primary shadow-[0_2px_8px_-4px_rgb(0_0_0_/_0.3)]',
              refreshing && !reducedMotion && 'animate-spin',
            )}
            style={
              refreshing
                ? undefined
                : // Before release the arc *is* the progress bar: it turns with
                  // the finger, so the gesture reports how far it has to go
                  // without a word of copy.
                  { transform: `rotate(${String(progress * 270)}deg)`, opacity: 0.4 + progress * 0.6 }
            }
          >
            <Loader2 className="size-5" />
          </span>
        </div>
      ) : null}
      {props.children}
    </>
  );
}
