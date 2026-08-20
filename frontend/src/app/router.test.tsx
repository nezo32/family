import { describe, expect, it } from 'vitest';
import { matchRoutes } from 'react-router-dom';

import { APP_ROUTES, APP_ROUTES_WITH_DETAIL, isKnownAppPath } from '@family/shared';

import { routes } from './router';

/**
 * Every advertised route must actually resolve.
 *
 * `APP_ROUTES` is shared with the backend, which composes push-notification
 * deep links from it, and `isKnownAppPath()` vouches for anything in it. That
 * guard is worth nothing if the list can name a path the router does not serve:
 * the backend test passes, the push ships, and tapping it lands the user on the
 * 404 screen with no idea what they did wrong.
 *
 * That had happened — `/notifications` was listed while the notification centre
 * is a panel opened from the app bar, not a route.
 *
 * ## The child paths matter just as much
 *
 * `isKnownAppPath()` vouches for detail paths too, and for a long time it
 * vouched for a child of *any* known route. `/tasks/<id>` is real;
 * `/admin/members/<id>` is not — the approval queue is one list with no `:id`
 * child — and the join-request notification pointed straight at it. The owner's
 * tap landed on the 404 screen, so the only button left on the card was the
 * delivery receipt, which she pressed and reasonably read as an approval. The
 * applicant waited three hours for a decision that had not been made.
 *
 * `APP_ROUTES_WITH_DETAIL` now names the routes that really have a detail page,
 * and the block at the bottom checks that list against this router **in both
 * directions**. Declaring the flag is only half a guard; the half that matters
 * is that the router, not the declaration, gets to be right.
 */

describe('APP_ROUTES and the router agree', () => {
  for (const [name, path] of Object.entries(APP_ROUTES)) {
    it(`${name} (${path}) resolves to a real route`, () => {
      const matched = matchRoutes(routes, path);

      expect(matched, `${path} matched nothing at all`).not.toBeNull();
      // The catch-all matches everything, so "matched something" proves
      // nothing; what matters is which route actually renders — the last one.
      expect(
        matched?.at(-1)?.route.path,
        `${path} fell through to the catch-all — it renders the 404 screen`,
      ).not.toBe('*');
    });
  }

  it('an unlisted path still falls through to the catch-all', () => {
    // Proves the assertion above can fail, rather than passing vacuously.
    const matched = matchRoutes(routes, '/definitely-not-a-route');
    expect(matched?.at(-1)?.route.path).toBe('*');
  });
});

/** Does the router serve `<route>/<something>` with a real page? */
function childResolves(route: string): boolean {
  const matched = matchRoutes(routes, `${route}/00000000-0000-4000-8000-000000000001`);
  const leaf = matched?.at(-1)?.route.path;
  return leaf !== undefined && leaf !== '*';
}

describe('APP_ROUTES_WITH_DETAIL and the router agree', () => {
  for (const route of APP_ROUTES_WITH_DETAIL) {
    it(`${route} really serves a detail page under a child segment`, () => {
      expect(
        childResolves(route),
        `${route} is flagged as having a detail page, but ${route}/<id> renders the 404 screen`,
      ).toBe(true);
    });
  }

  const withoutDetail = Object.values(APP_ROUTES).filter(
    (route) => !APP_ROUTES_WITH_DETAIL.includes(route),
  );

  for (const route of withoutDetail) {
    it(`${route} is correctly not flagged — it has no detail page`, () => {
      /*
       * The direction that actually caught the bug. A route gaining a `:id`
       * child without being added to `APP_ROUTES_WITH_DETAIL` only means deep
       * links to it are refused — annoying, safe. A route *losing* one, or
       * never having had one while the flag says otherwise, means the backend
       * happily ships a push that lands on the 404 screen.
       *
       * `/` is the exception: everything is a child of the today route, so it
       * can never be flagged and this assertion cannot hold for it.
       */
      if (route === APP_ROUTES.today) return;
      expect(
        childResolves(route),
        `${route}/<id> resolves to a real page — add ${route} to APP_ROUTES_WITH_DETAIL ` +
          'so deep links to it are allowed',
      ).toBe(false);
    });
  }

  it('refuses a deep link the router cannot serve', () => {
    // The exact path the join-request notification used to carry.
    expect(isKnownAppPath('/admin/members/40d7da5d-76a5-4bb9-9d42-a7d4b6436346')).toBe(false);
    expect(isKnownAppPath(APP_ROUTES.adminMembers)).toBe(true);

    // And the shape it is allowed to keep serving.
    expect(isKnownAppPath('/tasks/40d7da5d-76a5-4bb9-9d42-a7d4b6436346')).toBe(true);
    // One segment deep only — `/tasks/<id>/edit` is not a route either.
    expect(isKnownAppPath('/tasks/40d7da5d-76a5-4bb9-9d42-a7d4b6436346/edit')).toBe(false);
  });
});
