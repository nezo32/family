import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * The shell's two content slots, and the rule for who fills them.
 *
 * `AppShell` owns three DOM nodes a screen cannot reach by nesting: the side
 * column of the §C1 grid, and — on `≥ md` — the app bar's title and action
 * areas. Screens publish into them by rendering `<SideColumn>` (any page) or a
 * `<PageHeader>` (which hoists band 1 into the bar by itself, §C4).
 *
 * ### Why portals and not props
 *
 * Routes are lazy and the shell has no idea what is behind them, so a prop
 * would have to travel through the router. A portal keeps the content inside
 * the *screen's* React tree — its queries, its state, its `useCan()` — while
 * putting the DOM where the layout needs it. One instance, two places.
 *
 * ### Why the side column is one node, not two
 *
 * §C4 says the side column "collapses, it does not disappear": below the
 * two-column breakpoint its contents move to the bottom of the main column in
 * the same order. That is a grid reflow, not a second render — the `<aside>` is
 * simply the second grid item, and below the breakpoint the grid is one column
 * wide, so it lands under the main content. Nothing re-mounts, nothing is
 * duplicated, and there is no media query in the path.
 */
export interface PageSlots {
  /** True only under `AppShell`. Outside it (tests, auth screens) slots no-op. */
  readonly inShell: boolean;
  /** The `<aside>` of the shell grid. `null` for the first render only. */
  readonly side: HTMLElement | null;
  /** App-bar title area (`≥ md`). */
  readonly appBarTitle: HTMLElement | null;
  /** App-bar action area (`≥ md`). */
  readonly appBarActions: HTMLElement | null;
  /**
   * Viewport is `≥ md`, so band 1 (title + the one primary action, §C2) belongs
   * in the app bar rather than in the page. This is the one decision here that
   * CSS cannot make: moving a node between two DOM subtrees is a render, not a
   * class.
   */
  readonly hoist: boolean;
  /** A `PageHeader` currently owns the app-bar title. */
  readonly hasPageTitle: boolean;
  /** Claim the app-bar title; returns the release function. */
  registerPageTitle: () => () => void;
  setSide: (element: HTMLElement | null) => void;
  setAppBarTitle: (element: HTMLElement | null) => void;
  setAppBarActions: (element: HTMLElement | null) => void;
}

function noop(): void {
  /* no shell above us */
}

const OUTSIDE_SHELL: PageSlots = {
  inShell: false,
  side: null,
  appBarTitle: null,
  appBarActions: null,
  hoist: false,
  hasPageTitle: false,
  registerPageTitle: () => noop,
  setSide: noop,
  setAppBarTitle: noop,
  setAppBarActions: noop,
};

export const PageSlotsContext = createContext<PageSlots>(OUTSIDE_SHELL);

export function usePageSlots(): PageSlots {
  return useContext(PageSlotsContext);
}

/**
 * `md` — the breakpoint at which the sidebar appears and the bottom tab bar
 * goes away, which is also the point where the app bar has room to carry the
 * page title and its action (§C4).
 *
 * Kept local rather than added to `shared/hooks`: this is the *shell's* idea of
 * "desktop", and the one other viewport hook in the app (`useIsCompact`) breaks
 * at `sm` for a different reason. Folding them would move one of them for no
 * reason. `matchMedia` missing (jsdom without the stub) reads as phone, which
 * is the layout that needs no hoisting.
 */
const DESKTOP_QUERY = '(min-width: 768px)';

function readDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DESKTOP_QUERY).matches;
}

function useIsDesktopShell(): boolean {
  const [desktop, setDesktop] = useState(readDesktop);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const update = (): void => {
      setDesktop(query.matches);
    };
    // Re-read on mount: the first render may have happened before `matchMedia`
    // was patched in (tests).
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  return desktop;
}

/** Host side of the context. `AppShell` calls this once and provides the result. */
export function usePageSlotsHost(): PageSlots {
  const [side, setSide] = useState<HTMLElement | null>(null);
  const [appBarTitle, setAppBarTitle] = useState<HTMLElement | null>(null);
  const [appBarActions, setAppBarActions] = useState<HTMLElement | null>(null);
  /**
   * A count, not a boolean. On a route change React tears the old subtree down
   * before it runs the new one's effects, so the claim goes 1 → 0 → 1; a
   * boolean would work too, but a count cannot be left stale by a screen that
   * renders two headers across a loading branch.
   */
  const [titleClaims, setTitleClaims] = useState(0);

  const hoist = useIsDesktopShell();

  const registerPageTitle = useCallback(() => {
    setTitleClaims((n) => n + 1);
    return () => {
      setTitleClaims((n) => n - 1);
    };
  }, []);

  return useMemo(
    () => ({
      inShell: true,
      side,
      appBarTitle,
      appBarActions,
      hoist,
      hasPageTitle: titleClaims > 0,
      registerPageTitle,
      setSide,
      setAppBarTitle,
      setAppBarActions,
    }),
    [side, appBarTitle, appBarActions, hoist, titleClaims, registerPageTitle],
  );
}
