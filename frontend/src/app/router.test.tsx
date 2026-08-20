import { describe, expect, it } from 'vitest';
import { matchRoutes } from 'react-router-dom';

import { APP_ROUTES } from '@family/shared';

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
