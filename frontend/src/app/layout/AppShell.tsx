import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigation } from 'react-router-dom';
import { LoadingScreen } from '@/shared/components/LoadingScreen';
import { setFamilyTimeZone } from '@/shared/lib/format';
import { useMe } from '@/shared/auth/use-me';
import { cn } from '@/shared/lib/utils';
import { InstallPrompt } from '@/features/auth/components/InstallPrompt';
import { PushOnboarding } from '@/features/settings/push/PushOnboarding';
import { useShoppingSync } from '@/features/shopping/hooks';
import { NotificationsPanel, useUnreadCount } from '@/features/notifications';
import { BottomTabBar } from './BottomTabBar';
import { DesktopSidebar } from './DesktopSidebar';
import { TopAppBar } from './TopAppBar';
import { PageSlotsContext, usePageSlotsHost } from './page-slots';
import { SHELL_CONTAINER, SHELL_GRID, SHELL_GUTTER, SHELL_SIDE } from './measures';

/**
 * The authenticated application chrome.
 *
 * Layout:  [sidebar (≥md)] [ app bar / scrolling main / tab bar (<md) ]
 *
 * `<main>` is the §C1 grid — a main column that is never wider than 720px and,
 * from 1088px up, a side column beside it. The arithmetic, and the two places
 * it departs from the written spec, are in `measures.ts`; the mechanism a
 * screen uses to fill the side column is in `page-slots.ts`.
 *
 * Scroll handling deserves a note. The page — not an inner div — is the scroll
 * container, because iOS only collapses the URL bar and only runs the native
 * "tap the status bar to scroll to top" gesture for the document scroller. The
 * shell therefore reserves space for the fixed tab bar with padding instead of
 * clipping content inside an `overflow-auto` box.
 *
 * Scroll restoration is handled here rather than with React Router's
 * `<ScrollRestoration>`: we want *new* navigations to land at the top, and
 * back/forward to restore where the user was, and the router's component
 * cannot distinguish the two without a data router.
 */
export function AppShell() {
  const location = useLocation();
  const navigation = useNavigation();
  const { data: me } = useMe();
  const positions = useRef(new Map<string, number>());
  const previousKey = useRef<string | null>(null);

  /**
   * The bell lives in `TopAppBar`, but its state lives here: the panel is a
   * sibling of the app bar rather than a child of it, so closing it does not
   * depend on the header staying mounted, and the badge query is shared by the
   * shell instead of re-fetched per header render.
   */
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const unread = useUnreadCount();
  /**
   * The app bar's title/action areas and the grid's side column, published to
   * every screen below. See `page-slots.ts` for why this is a portal target
   * rather than a prop.
   */
  const slots = usePageSlotsHost();
  const openNotifications = useCallback(() => {
    setNotificationsOpen(true);
  }, []);

  /**
   * The offline outbox drains from here, not from the shopping screen. iOS has
   * no Background Sync, so the only moments our code runs are `online` and the
   * app coming to the foreground — and the family member who added milk on the
   * bus will very often reopen the app on Сегодня, not on Покупки. Started here
   * the queue flushes on any tab; started in the feature it would sit unsent
   * until somebody happened to open the shopping list.
   */
  useShoppingSync();

  // Times and dates are rendered in the family timezone, not the device one (D2).
  useEffect(() => {
    // The family zone is the authority for *rendering* (D2): a parent in
    // Bangkok must read the time the family at home will sit down to dinner.
    // `user.timezone` is the member's own override, nullable in the contract
    // ("inherit the family's"), and is only the fallback here.
    setFamilyTimeZone(me?.family.timezone ?? me?.user.timezone);
  }, [me?.family.timezone, me?.user.timezone]);

  useEffect(() => {
    // Remember where we were leaving from.
    const leavingKey = previousKey.current;
    if (leavingKey !== null) positions.current.set(leavingKey, window.scrollY);
    previousKey.current = location.key;

    const restored = positions.current.get(location.key);
    // POP (back/forward) reuses a key we have seen; PUSH gets a fresh one.
    window.scrollTo({ top: restored ?? 0, behavior: 'instant' });
  }, [location.key]);

  return (
    /*
      `px-safe` on the shell, not on `main`: in landscape the notch takes a
      59px bite out of one side, and this is the one element with no horizontal
      padding of its own to collide with. The fixed tab bar is a descendant but
      positions against the viewport, so it carries its own `px-safe`.
    */
    <PageSlotsContext.Provider value={slots}>
      <div className="flex min-h-dvh bg-background px-safe">
        <DesktopSidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopAppBar unreadCount={unread.data ?? 0} onOpenNotifications={openNotifications} />

          {/*
            The bottom reserve, measured on an iPhone 15 in standalone: the bar
            renders 91px tall (56px of `--spacing-tabbar` + a 1px top border +
            34px of home-indicator inset) and this reserves 106px, so the last
            row of content clears it by 15px. `env(safe-area-inset-bottom)`
            appears here exactly once and nowhere below — a screen that adds its
            own `pb-safe` to something that is *not* sitting on the home
            indicator pays the 34px twice, which is what used to leave the
            shopping composer floating in the middle of an empty screen.
          */}
          <main
            id="main"
            className={cn(
              'flex-1 pt-4 pb-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom,0px)+1rem)] md:pb-8',
              SHELL_GUTTER,
            )}
            aria-busy={navigation.state === 'loading'}
          >
            <div className={cn(SHELL_CONTAINER, SHELL_GRID)}>
              <div className="min-w-0">
                {/*
                  Self-suppressing: nothing renders when already installed, when
                  the user has not engaged yet, or for two weeks after a
                  dismissal. It lives in the shell because push on iOS is
                  unreachable until the app is on the Home Screen, so the prompt
                  has to be able to appear wherever the user happens to be.
                */}
                <InstallPrompt className="mb-4" />
                {/*
                  And once the app *is* installed (or on a platform that never
                  needed to be), the same slot offers notifications — the feature
                  is otherwise invisible, because nothing else in the app ever
                  mentions it. Self-suppressing in the same way, and it stands
                  down entirely while the install card is up: see
                  `push/onboarding.ts` for the funnel, whose one hard rule is
                  that the OS permission prompt can be shown once, ever.
                */}
                <PushOnboarding className="mb-4" />
                <Suspense fallback={<LoadingScreen />}>
                  <Outlet />
                </Suspense>
              </div>

              {/*
                The side column (§C4). Always in the DOM because it is the
                portal target; `empty:hidden` keeps it from costing a grid gap
                on the screens that publish nothing into it.
              */}
              <aside ref={slots.setSide} aria-label="Дополнительно" className={SHELL_SIDE} />
            </div>
          </main>

          <BottomTabBar />
        </div>

        <NotificationsPanel open={notificationsOpen} onOpenChange={setNotificationsOpen} />
      </div>
    </PageSlotsContext.Provider>
  );
}

/**
 * Chrome-less shell for the auth screens (`/login`, `/auth/*`).
 * No navigation: an unauthenticated or non-active user has nowhere to navigate.
 */
export function AuthShell() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 py-10 pt-safe pb-safe">
      <div className="w-full max-w-sm">
        <Suspense fallback={<LoadingScreen />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}
