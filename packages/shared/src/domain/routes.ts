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
 * Which instance of a repeating thing a detail link is about, as a floating
 * local date (D2) — `/calendar/<seriesId>?date=2026-08-21`.
 *
 * `/calendar/:eventId` is keyed by a **series**, so the path alone cannot say
 * "the ужин on Wednesday" — and it must stay that way. Occurrence rows are
 * regenerated whenever a series is edited, so a link keyed by one goes stale
 * the first time somebody changes the time, and a notification link is read
 * long after it is written. A date is data rather than a pointer: it survives
 * regeneration, and when it matches nothing the page simply stops highlighting
 * a row instead of failing to load.
 *
 * It lives here because both sides compose it — the backend renderer builds the
 * query string (`modules/notifications/render.ts`) and the PWA reads it
 * (`EventDetailPage`) — and that is the same drift this file exists to stop.
 */
export const EVENT_DATE_PARAM = 'date';

/**
 * The routes that serve a **detail page** under a single child segment.
 *
 * This list is the difference between `/tasks/<id>` and `/admin/members/<id>`,
 * and it has to be declared rather than inferred. `isKnownAppPath` used to
 * accept *any* child of *any* known route, on the reasoning that deep links are
 * built as `<list>/<id>` — true for the four routes below, and false for every
 * other entry in the table.
 *
 * It cost a family a signup. The join-request notification pointed at
 * `/admin/members/<uuid>`; the approval queue is a single list with no `:id`
 * child, so the router fell through to the catch-all and the owner's tap landed
 * on the 404 screen. The guard whose entire job is to prevent exactly that
 * waved it through, because `/admin/members` is a known route. The same hole
 * was hiding a second one: `/wall/<postId>`, for a screen that has no detail
 * page either.
 *
 * So: add a route here only when the router really serves a child under it.
 * `frontend/src/app/router.test.tsx` checks this list against the router in
 * both directions — a flagged route must have a child route, and an unflagged
 * one must not — so the router stays the source of truth and drift is a test
 * failure rather than a 404 in somebody's hand.
 */
export const APP_ROUTES_WITH_DETAIL: readonly AppRoute[] = [
  APP_ROUTES.tasks,
  APP_ROUTES.calendar,
  APP_ROUTES.goals,
  APP_ROUTES.shopping,
];

/**
 * True when `path` is a canonical route, or a detail page beneath one of the
 * routes that actually has detail pages (`/tasks/<id>`, `/goals/<id>`).
 *
 * Two things it deliberately refuses:
 *
 *  - a child of a route not in `APP_ROUTES_WITH_DETAIL` — see the note there;
 *  - a *grandchild* of anything (`/tasks/<id>/edit`). Detail routes are one
 *    `:param` segment deep, so a second segment is as unroutable as an unknown
 *    prefix and must not inherit its parent's blessing.
 *
 * A query string or fragment is stripped first: `/shopping/<id>?focus=milk` is
 * the same route as `/shopping/<id>`.
 */
export function isKnownAppPath(path: string): boolean {
  const [pathname] = path.split(/[?#]/);
  if (!pathname || !pathname.startsWith('/')) return false;

  // Exact match covers every entry, `today` (`/`) included — which is why this
  // no longer needs a special case for a route that is a prefix of everything.
  if (APP_ROUTE_PATHS.includes(pathname)) return true;

  return APP_ROUTES_WITH_DETAIL.some((route) => {
    if (!pathname.startsWith(`${route}/`)) return false;
    const child = pathname.slice(route.length + 1);
    return child.length > 0 && !child.includes('/');
  });
}
