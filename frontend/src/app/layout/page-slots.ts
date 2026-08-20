import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * The shell's content slots, and the rule for who fills them.
 *
 * `AppShell` owns three DOM nodes a screen cannot reach by nesting: the side
 * column of the §C1 grid, and the app bar's title and action areas. Screens
 * publish into them by rendering `<SideColumn>` (any page) or a `<PageHeader>`
 * (which hoists band 1 into the bar by itself, §C2/§D2).
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
 *
 * ### Band 1 is in the bar at **every** width
 *
 * This used to be gated at `md`, which meant a phone got the section name in
 * the bar *and* the page's own `<h1>` immediately underneath it — «Задачи»
 * twice, 8px apart. §D2's phone sketch is explicit that the title and the one
 * primary action live in the bar, so the hoist is unconditional and the page
 * below renders only its eyebrow, description and content.
 *
 * The single exception is a screen whose title is its own *display* line
 * (§B2 `display`, 28/34) below `md` — Сегодня's greeting, and only that. It
 * keeps its `<h1>` in the page there and claims the title as `'page'`, which
 * stands the bar's fallback down from `<h1>` to a plain section name so the
 * document still has exactly one level-1 heading.
 */

/** Where the mounted `PageHeader` has put the page's `<h1>`. */
export type TitlePlacement = 'bar' | 'page';

export interface PageSlots {
  /** True only under `AppShell`. Outside it (tests, auth screens) slots no-op. */
  readonly inShell: boolean;
  /** The `<aside>` of the shell grid. `null` for the first render only. */
  readonly side: HTMLElement | null;
  /** App-bar title area. */
  readonly appBarTitle: HTMLElement | null;
  /** App-bar action area. */
  readonly appBarActions: HTMLElement | null;
  /**
   * Viewport is `≥ md`. Band 1 is hoisted at every width, so this is *not* the
   * hoist switch any more — it is only how a `displayTitle` header knows
   * whether its display line is the one on screen.
   */
  readonly desktop: boolean;
  /** A `PageHeader` has portalled the page `<h1>` into the app bar. */
  readonly barTitle: boolean;
  /** A `PageHeader` is rendering the page `<h1>` in the page itself. */
  readonly pageTitle: boolean;
  /** Claim the page title for one placement; returns the release function. */
  registerPageTitle: (where: TitlePlacement) => () => void;
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
  desktop: false,
  barTitle: false,
  pageTitle: false,
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
 * goes away, and the width above which Сегодня's greeting stops being a
 * display line and becomes a bar title (§D1).
 *
 * Kept local rather than added to `shared/hooks`: this is the *shell's* idea of
 * "desktop", and the one other viewport hook in the app (`useIsCompact`) breaks
 * at `sm` for a different reason. Folding them would move one of them for no
 * reason. `matchMedia` missing (jsdom without the stub) reads as phone.
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
   * Counts, not booleans. On a route change React tears the old subtree down
   * before it runs the new one's effects, so a claim goes 1 → 0 → 1; and a
   * screen that renders two headers across a loading branch, or crosses `md`
   * mid-navigation, would otherwise leave a boolean stale.
   */
  const [claims, setClaims] = useState<Record<TitlePlacement, number>>({ bar: 0, page: 0 });

  const desktop = useIsDesktopShell();

  const registerPageTitle = useCallback((where: TitlePlacement) => {
    setClaims((current) => ({ ...current, [where]: current[where] + 1 }));
    return () => {
      setClaims((current) => ({ ...current, [where]: current[where] - 1 }));
    };
  }, []);

  return useMemo(
    () => ({
      inShell: true,
      side,
      appBarTitle,
      appBarActions,
      desktop,
      barTitle: claims.bar > 0,
      pageTitle: claims.page > 0,
      registerPageTitle,
      setSide,
      setAppBarTitle,
      setAppBarActions,
    }),
    [side, appBarTitle, appBarActions, desktop, claims, registerPageTitle],
  );
}
