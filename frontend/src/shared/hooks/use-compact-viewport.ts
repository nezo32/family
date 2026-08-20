import { useEffect, useState } from 'react';

/**
 * Compact (phone) viewport, for the handful of decisions CSS cannot make on
 * its own —
 * chiefly "popover or bottom sheet", which is a choice of *component*, not of
 * layout, and therefore cannot be a media query in a class list.
 *
 * The breakpoint matches Tailwind's `sm` (640px), the same line the date/time
 * fields stack on, so a trigger and its picker never disagree about which
 * device they are on. Deliberately **not** `features/calendar`'s `useIsPhone`:
 * that one breaks at `md` (768px) because a 7×5 month grid needs more room than
 * a field does, and folding the two would move one of them for no reason.
 */
const COMPACT_QUERY = '(max-width: 639px)';

export function isCompactViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') return window.matchMedia(COMPACT_QUERY).matches;
  return window.innerWidth > 0 && window.innerWidth < 640;
}

export function useIsCompact(): boolean {
  const [isPhone, setIsPhone] = useState(isCompactViewport);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COMPACT_QUERY);
    const update = (): void => {
      setIsPhone(query.matches);
    };
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  return isPhone;
}
