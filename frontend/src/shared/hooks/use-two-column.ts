import { useEffect, useState } from 'react';

/**
 * "Is the shell showing two columns right now?"
 *
 * The breakpoint is the shell's own — 1088px, the width at which §C1's minimums
 * first fit next to a 240px sidebar (`app/layout/measures.ts` explains the
 * arithmetic and why it is not `lg`). This hook exists only for the decisions
 * CSS cannot make: whether a *stateful* component is mounted once in the main
 * column or once in the side column.
 *
 * Prefer a class — `hidden min-[1088px]:block` — whenever the block is static.
 * Rendering it twice and hiding one copy costs nothing there, keeps the layout
 * declarative and cannot desynchronise. Reach for this hook only when the two
 * copies would each own state, a query subscription or a dialog: Стена's polls
 * panel carries a composer and a filter, and two of those is two places for the
 * same half-typed question to live.
 *
 * The value is live, so dragging a desktop window across the breakpoint (or
 * toggling devtools' device emulation) re-renders rather than stranding the
 * layout in whichever state it started in. It reads `false` when `matchMedia`
 * is missing — one column, which is the layout that needs no special handling
 * and the one every component must already support.
 */
const TWO_COLUMN_QUERY = '(min-width: 1088px)';

export function isTwoColumnViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(TWO_COLUMN_QUERY).matches;
}

export function useTwoColumn(): boolean {
  const [wide, setWide] = useState(isTwoColumnViewport);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(TWO_COLUMN_QUERY);
    const update = (): void => {
      setWide(query.matches);
    };
    // Re-read on mount: the first render may have happened before `matchMedia`
    // was patched in (tests), or on a server.
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  return wide;
}
