import type { FastifyPluginAsync } from 'fastify';
import { describe, expect, it } from 'vitest';

import { CHANGE_DOMAINS } from '@family/shared';

import { ROUTE_DOMAINS, domainsForRoute } from '../../core/plugins/revisions.js';
import { collectRouteAccess } from '../../test/access.js';
import { registerModules } from '../index.js';
import { visibleRevisions } from './changes.routes.js';
import { authFor } from '../../test/access.js';

/**
 * The change feed's classification rules, without a database or Redis.
 *
 * Two halves: a handful of examples that pin the ordering of `ROUTE_DOMAINS`,
 * and the coverage guard — which is the valuable one.
 */

/** Exactly how `buildApp()` mounts the modules, so the URLs carry `/api`. */
const mountedModules: FastifyPluginAsync = async (app) => {
  await app.register(registerModules, { prefix: '/api' });
};

describe('ROUTE_DOMAINS', () => {
  it('matches a parameterised route by its pattern, not by its concrete URL', () => {
    expect(domainsForRoute('/api/shopping/items/:id/toggle')).toEqual(['shopping']);
  });

  it('puts kudos on the wall, ahead of the general chores entry', () => {
    // Order is the whole mechanism here: `/api/chores` → tasks sits below, and
    // a first-match-wins table is the only reason kudos do not become a task.
    expect(domainsForRoute('/api/chores/kudos')).toEqual(['wall']);
    expect(domainsForRoute('/api/chores/rotations')).toEqual(['tasks']);
  });

  it('keeps a comment on a task on the wall', () => {
    // The discussion routes are mounted generically on five segments. A comment
    // changes the thread, not the task — and the thread is keyed under
    // `['wall','comments',…]` on the client. These rows only work because they
    // sit above the general `/api/tasks` entry.
    expect(domainsForRoute('/api/tasks/:id/comments')).toEqual(['wall']);
    expect(domainsForRoute('/api/goals/:id/reactions')).toEqual(['wall']);
    expect(domainsForRoute('/api/posts/:id/comments')).toEqual(['wall']);
    // …while the task's own writes still move `tasks`.
    expect(domainsForRoute('/api/tasks/occurrences/:id/complete')).toEqual(['tasks']);
    expect(domainsForRoute('/api/goals/:id/contributions')).toEqual(['goals']);
  });

  it('classifies the D11 delivery acknowledgements as changing nothing', () => {
    // Written by the service worker for the device that just got a push. If
    // these bumped `notifications`, one push would make every open client in
    // the family refetch its inbox.
    expect(domainsForRoute('/api/notifications/deliveries/:id/delivered')).toEqual([]);
    // …while the inbox itself still moves.
    expect(domainsForRoute('/api/notifications/read')).toEqual(['notifications']);
  });

  it('classifies auth and the digest preview as changing nothing', () => {
    expect(domainsForRoute('/api/auth/refresh')).toEqual([]);
    expect(domainsForRoute('/api/dashboard/digest/preview')).toEqual([]);
  });

  it('answers null — not an empty set — for a route nobody classified', () => {
    // The difference is the point: `[]` is a decision, `null` is an omission.
    expect(domainsForRoute('/api/telemetry')).toBeNull();
    expect(domainsForRoute(undefined)).toBeNull();
  });

  it('never matches a prefix mid-segment', () => {
    // `/api/mercury` must not be caught by the `/api/me` entry.
    expect(domainsForRoute('/api/mercury')).toBeNull();
    expect(domainsForRoute('/api/me/avatar')).toEqual(['members']);
  });

  it('names only domains that exist in the shared contract', () => {
    const known = new Set<string>(CHANGE_DOMAINS);
    for (const [prefix, domains] of ROUTE_DOMAINS) {
      for (const domain of domains) expect(known.has(domain), `${prefix} → ${domain}`).toBe(true);
    }
  });
});

/**
 * The coverage guard.
 *
 * A future write route that maps to no domain silently stops syncing, and
 * nobody notices for a month. This is the same shape as the boot assertion in
 * `core/plugins/auth.ts` that every route must declare an access rule: the
 * registry is enumerated, and an unclassified write fails the run by name.
 */
describe('every write route is classified', () => {
  it('leaves no non-GET route under /api unmapped', async () => {
    const routes = await collectRouteAccess(mountedModules);
    const writes = routes.filter((r) => r.method !== 'GET' && r.method !== 'OPTIONS');
    expect(writes.length).toBeGreaterThan(40);

    const unmapped = writes
      .filter((route) => domainsForRoute(route.url) === null)
      .map((route) => route.key);

    expect(
      unmapped,
      'add these to ROUTE_DOMAINS in core/plugins/revisions.ts — an entry with an ' +
        'empty domain list is a valid answer, a missing entry is not',
    ).toEqual([]);
  });

  it('confirms the route patterns carry the /api prefix the table is written with', async () => {
    // Open question 3 in `sync.md` §9, settled here rather than guessed: if
    // Fastify ever stopped propagating the registration prefix into the route
    // pattern, every lookup above would silently return null and the guard
    // would be the thing that says so.
    const routes = await collectRouteAccess(mountedModules);
    expect(routes.every((route) => route.url.startsWith('/api/'))).toBe(true);
  });
});

describe('visibleRevisions', () => {
  const all = {
    tasks: 4,
    events: 5,
    goals: 6,
    shopping: 7,
    wall: 8,
    members: 9,
    notifications: 10,
  } as const;

  it('gives an owner everything', () => {
    expect(visibleRevisions(all, authFor('owner'))).toEqual(all);
  });

  it('omits — never zeroes — a domain the caller cannot read', () => {
    // A child holds no `goal:*` permission at all (D4). Zeroing instead of
    // omitting would be a number that differs from whatever they last saw,
    // which is a refetch of a query they may not run.
    const child = visibleRevisions(all, authFor('child'));
    expect(child).not.toHaveProperty('goals');
    expect(child.wall).toBe(8);
    expect(child.notifications).toBe(10);
    // `task:read:own` is enough to be told that tasks moved.
    expect(child.tasks).toBe(4);
  });

  it('follows an explicit revocation rather than the role', () => {
    const admin = visibleRevisions(all, authFor('admin', { denies: ['shopping:read'] }));
    expect(admin).not.toHaveProperty('shopping');
    expect(admin.goals).toBe(6);
  });

  it('gives a suspended caller nothing but their own inbox and the wall', () => {
    // `buildAuthContext` empties the permission set for anyone not `active`.
    const suspended = visibleRevisions(all, authFor('owner', { status: 'suspended' }));
    expect(Object.keys(suspended).sort()).toEqual(['notifications', 'wall']);
  });
});
