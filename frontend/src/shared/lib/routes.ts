/**
 * The single source of truth for URL paths.
 *
 * Anything that navigates — the router, the shell navigation, the API layer's
 * involuntary redirects — must use these constants rather than a string
 * literal, so renaming a route is one edit.
 *
 * See `docs/architecture/frontend.md` for the full route contract.
 */
export const ROUTES = {
  today: '/',
  tasks: '/tasks',
  calendar: '/calendar',
  goals: '/goals',
  shopping: '/shopping',
  wall: '/wall',
  family: '/family',

  settings: '/settings',
  settingsProfile: '/settings/profile',
  settingsNotifications: '/settings/notifications',
  settingsAccounts: '/settings/accounts',

  login: '/login',
  register: '/register',
  authPending: '/auth/pending',
  authRejected: '/auth/rejected',
  authSuspended: '/auth/suspended',

  adminMembers: '/admin/members',
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

/** Query param carrying "where the user wanted to go" through the login flow. */
export const NEXT_PARAM = 'next';

export function loginUrl(next?: string): string {
  if (!next || next === ROUTES.login) return ROUTES.login;
  return `${ROUTES.login}?${NEXT_PARAM}=${encodeURIComponent(next)}`;
}

/* -------------------------------------------------------------------------- */
/* Detail-route builders                                                       */
/*                                                                             */
/* Detail views live *under* their section rather than at a new top-level       */
/* segment, so the bottom tab bar keeps a single active item and back always    */
/* returns to the list.                                                        */
/* -------------------------------------------------------------------------- */

export const taskDetail = (taskId: string): string => `${ROUTES.tasks}/${taskId}`;
export const eventDetail = (eventId: string): string => `${ROUTES.calendar}/${eventId}`;
export const goalDetail = (goalId: string): string => `${ROUTES.goals}/${goalId}`;
export const shoppingList = (listId: string): string => `${ROUTES.shopping}/${listId}`;
