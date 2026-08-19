import { Suspense, useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigation } from 'react-router-dom';
import { LoadingScreen } from '@/shared/components/LoadingScreen';
import { setFamilyTimeZone } from '@/shared/lib/format';
import { useMe } from '@/shared/auth/use-me';
import { InstallPrompt } from '@/features/auth/components/InstallPrompt';
import { useShoppingSync } from '@/features/shopping/hooks';
import { BottomTabBar } from './BottomTabBar';
import { DesktopSidebar } from './DesktopSidebar';
import { TopAppBar } from './TopAppBar';

/**
 * The authenticated application chrome.
 *
 * Layout:  [sidebar (≥md)] [ app bar / scrolling main / tab bar (<md) ]
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
    // The family zone is the authority; `user.timezone` is the member's own
    // override and is nullable ("inherit the family's").
    setFamilyTimeZone(me?.user.timezone ?? me?.family.timezone);
  }, [me?.user.timezone, me?.family.timezone]);

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
    <div className="flex min-h-dvh bg-background">
      <DesktopSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopAppBar />

        <main
          id="main"
          className="flex-1 px-4 pt-4 pb-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom,0px)+1rem)] md:px-6 md:pb-8"
          aria-busy={navigation.state === 'loading'}
        >
          <div className="mx-auto w-full max-w-3xl xl:max-w-5xl">
            {/*
              Self-suppressing: nothing renders when already installed, when the
              user has not engaged yet, or for two weeks after a dismissal. It
              lives in the shell because push on iOS is unreachable until the
              app is on the Home Screen, so the prompt has to be able to appear
              wherever the user happens to be.
            */}
            <InstallPrompt className="mb-4" />
            <Suspense fallback={<LoadingScreen />}>
              <Outlet />
            </Suspense>
          </div>
        </main>

        <BottomTabBar />
      </div>
    </div>
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
