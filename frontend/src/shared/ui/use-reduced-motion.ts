import { useEffect, useState } from 'react';

/**
 * `(prefers-reduced-motion: reduce)`, live.
 *
 * ## Why a hook when `index.css` already resets it globally
 *
 * The global `@media (prefers-reduced-motion: reduce)` block in `index.css`
 * flattens every CSS *transition* and *animation* to 0.01ms. That is the right
 * default and it is not enough on its own, because two of the gestures in
 * §C-gestures are driven by JavaScript timers rather than by CSS:
 *
 *  - `SwipeRow` plays a 180ms height collapse and then commits. With motion
 *    reduced the CSS transition is already instant, so a 180ms `setTimeout`
 *    would simply be 180ms of a row sitting there doing nothing before the
 *    action fires. The commit has to happen on the same frame instead.
 *  - `PullToRefresh` settles its indicator back to zero. Same argument.
 *
 * A media query cannot tell a `setTimeout` to be zero. This can. (§F11.)
 */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Synchronous read, for imperative code that has no business subscribing. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** Live `(prefers-reduced-motion: reduce)`. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = (): void => {
      setReduced(query.matches);
    };
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  return reduced;
}
