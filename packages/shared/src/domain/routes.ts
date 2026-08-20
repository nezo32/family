/**
 * The application's canonical navigable paths.
 *
 * This exists because the backend composes deep links for notifications while
 * the routes themselves are declared in the PWA, and the two drifted: the
 * "somebody wants to join the family" notification pointed at
 * `/settings/members` and chore-swap notifications at `/chores/swaps`, neither
 * of which is a route. Tapping either landed the user on a 404 — from a
 * notification, which is the one context where the user has no idea what they
 * did wrong and no obvious way back.
 *
 * Nothing catches that at compile time when each side keeps its own list, so
 * both sides read from this one and a test asserts every link the renderer
 * produces resolves to a real path.
 */
export const APP_ROUTES = {
  today: '/',
  tasks: '/tasks',
  calendar: '/calendar',
  goals: '/goals',
  shopping: '/shopping',
  wall: '/wall',
  family: '/family',
  // No `/notifications`: the notification centre is a panel opened from the app
  // bar, not a route. Listing it here would make `isKnownAppPath` vouch for a
  // path that renders the 404 screen — defeating the one guard that exists to
  // stop a push landing there.
  settings: '/settings',
  settingsProfile: '/settings/profile',
  settingsNotifications: '/settings/notifications',
  settingsAccounts: '/settings/accounts',
  adminMembers: '/admin/members',
  login: '/login',
  register: '/register',
  authPending: '/auth/pending',
  authRejected: '/auth/rejected',
  authSuspended: '/auth/suspended',
} as const;

export type AppRoute = (typeof APP_ROUTES)[keyof typeof APP_ROUTES];

/** Every canonical path, for membership checks. */
export const APP_ROUTE_PATHS: readonly string[] = Object.values(APP_ROUTES);

/**
 * True when `path` is a canonical route or a detail page beneath one
 * (`/tasks/<id>`, `/goals/<id>`), which is how deep links are built.
 *
 * Deliberately rejects a bare prefix match against `/`: every path starts with
 * a slash, so treating `today` as a prefix would make this assert nothing.
 */
export function isKnownAppPath(path: string): boolean {
  const [pathname] = path.split(/[?#]/);
  if (!pathname || !pathname.startsWith('/')) return false;
  if (pathname === APP_ROUTES.today) return true;

  return APP_ROUTE_PATHS.some(
    (route) => route !== APP_ROUTES.today && (pathname === route || pathname.startsWith(`${route}/`)),
  );
}
