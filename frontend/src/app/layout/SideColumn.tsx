import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePageSlots } from './page-slots';

/**
 * Puts its children in the shell's side column (§C4).
 *
 * ```tsx
 * <SideColumn>
 *   <WeeklyLoad … />
 * </SideColumn>
 * ```
 *
 * The children stay in the calling screen's React tree — hooks, queries and
 * context all still resolve against the page — while the DOM lands in
 * `AppShell`'s `<aside>`. Below the two-column breakpoint that `<aside>` is
 * simply the next row of a one-column grid, so the content appears at the
 * bottom of the page in the order it was written. There is no second copy and
 * no media query: §C4's "collapses, does not disappear" is the grid doing it.
 *
 * Outside `AppShell` — a component test, a screen rendered on its own — the
 * children render in place, so nothing silently vanishes from a test tree.
 */
export function SideColumn(props: { children: ReactNode }): ReactNode {
  const slots = usePageSlots();

  if (!slots.inShell) return props.children;
  // First render only: the ref callback has not run yet. One frame, no flash —
  // rendering in place instead would mount the children twice.
  if (slots.side === null) return null;

  return createPortal(props.children, slots.side);
}
