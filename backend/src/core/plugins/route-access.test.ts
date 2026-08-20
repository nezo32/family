import { describe, expect, it } from 'vitest';

import { ROLES, type Role } from '@family/shared';

import { authFor, collectRouteAccess, statusFor, type CollectedRoute } from '../../test/access.js';
import choresRoutes from '../../modules/chores/chores.routes.js';
import goalsRoutes from '../../modules/goals/goals.routes.js';
import { registerModules } from '../../modules/index.js';
import { decideAccess, denyError } from './auth.js';

/**
 * D4 at the router, across every module at once.
 *
 * The per-module tests assert that a module declares the guards its own
 * documentation claims. This file asserts the property those declarations exist
 * to produce, and it does it over the **whole** registered surface — because the
 * failure mode is never "the module we were thinking about", it is the one
 * nobody remembered to check. `notFoundOnDeny` shipped with exactly one module
 * using it and eight not; the invariant below is what makes that visible.
 *
 * No database, no Redis, no tokens: `collectRouteAccess` reads what the modules
 * registered and `statusFor` runs the real `decideAccess()` over a real
 * `AuthContext`.
 */

let cached: CollectedRoute[] | undefined;

/** Every route the app registers, exactly as `buildApp()` would mount them. */
async function allRoutes(): Promise<CollectedRoute[]> {
  cached ??= await collectRouteAccess(registerModules);
  return cached;
}

const routeAt = (routes: readonly CollectedRoute[], key: string): CollectedRoute => {
  const route = routes.find((r) => r.key === key);
  if (!route) throw new Error(`route not registered: ${key} (is the module table stale?)`);
  return route;
};

describe('D4: a denial must not confirm what it denies', () => {
  /**
   * The invariant, stated once for the whole app.
   *
   * A `GET` is the caller asking "what is here?". If the honest answer is "you
   * may not know", the status has to be 404 — a 403 answers the question it
   * refused to answer. 403 is reserved for the other case: the caller can see
   * the thing and may not act on it, which only a write can be.
   */
  it('never answers 403 to any role on any read route', async () => {
    const routes = await allRoutes();
    const reads = routes.filter((route) => route.method === 'GET');
    expect(reads.length).toBeGreaterThan(20);

    const leaks: string[] = [];
    for (const role of ROLES) {
      const caller = authFor(role);
      for (const route of reads) {
        if (statusFor(route.access, caller) === 403) leaks.push(`${role}: ${route.key}`);
      }
    }

    expect(leaks, 'these reads confirm their own existence with a 403').toEqual([]);
  });

  it('answers a child 404 — not 403 — on every goal read', async () => {
    const child = authFor('child');
    // The moneybox's *own* routes, not "every URL starting with /goals": the
    // wall also mounts `/goals/:id/comments`, which is `authenticated: true` by
    // design and narrowed inside `comments.service.ts` instead.
    const goalReads = (await collectRouteAccess(goalsRoutes)).filter((r) => r.method === 'GET');
    expect(goalReads.length).toBeGreaterThan(0);

    for (const route of goalReads) {
      // The case `core/plugins/auth` names in its own documentation: a child
      // holds no `goal:*` permission whatsoever, and a 403 would confirm the
      // family has a moneybox.
      expect(statusFor(route.access, child), route.key).toBe(404);
    }
  });

  it('still answers a teen 403 on the goal writes', async () => {
    const teen = authFor('teen');
    const writes = (await collectRouteAccess(goalsRoutes)).filter((r) => r.method !== 'GET');
    expect(writes.length).toBeGreaterThan(0);

    for (const route of writes) {
      // A teen holds `goal:read`. They are looking straight at the goal, so
      // "you may not do that to it" is the honest answer — hiding it here would
      // be a worse product for no privacy gained.
      expect(statusFor(route.access, teen), route.key).toBe(403);
    }
  });

  it('hides the whole section from a guest, module by module', async () => {
    const routes = await allRoutes();
    const guest = authFor('guest');

    for (const key of [
      'GET /goals',
      'GET /tasks/series',
      'GET /shopping/lists',
      'GET /chores/rotations',
      'GET /chores/swaps',
    ]) {
      expect(statusFor(routeAt(routes, key).access, guest), key).toBe(404);
    }
  });

  /**
   * The status must follow the *effective* permission set, not the role name.
   * An explicit revocation is the only way an owner or admin ever loses a
   * permission, so it is the case a role-shaped check silently gets wrong.
   */
  it('honours an explicit revocation, not the role', async () => {
    const routes = await allRoutes();
    const goals = routeAt(routes, 'GET /goals');

    expect(statusFor(goals.access, authFor('admin'))).toBe(200);
    expect(statusFor(goals.access, authFor('admin', { denies: ['goal:read'] }))).toBe(404);
    // …and a per-user grant opens it for a role the matrix does not give it to.
    expect(statusFor(goals.access, authFor('child', { grants: ['goal:read'] }))).toBe(200);
  });

  it('gives a suspended member nothing at all', async () => {
    const routes = await allRoutes();
    // `buildAuthContext` empties the permission set for anybody who is not
    // `active`, so a token that outlived a suspension buys nothing.
    const suspended = authFor('owner', { status: 'suspended' });
    for (const route of routes) {
      if (route.method !== 'GET') continue;
      if (route.access.public || route.access.authenticated) continue;
      expect(statusFor(route.access, suspended), route.key).not.toBe(200);
    }
  });
});

describe('chore swaps are guarded by the chore-swap permissions', () => {
  /**
   * The role matrix gives `child` both `chore:swap:request` and
   * `chore:swap:accept`. The routes used to demand `task:update:own` /
   * `task:assign:any`, which a child does not hold — so the two permissions
   * written for children were unreachable by a child.
   */
  it('lets a child request, answer and cancel a swap', async () => {
    const routes = await collectRouteAccess(choresRoutes);
    const child = authFor('child');

    for (const key of [
      'POST /chores/swaps',
      'POST /chores/swaps/:id/respond',
      'POST /chores/swaps/:id/cancel',
    ]) {
      expect(statusFor(routeAt(routes, key).access, child), key).toBe(200);
    }
  });

  it('names the swap permissions, not the task ones', async () => {
    const routes = await collectRouteAccess(choresRoutes);
    expect(routeAt(routes, 'POST /chores/swaps').access.permission).toBe('chore:swap:request');
    expect(routeAt(routes, 'POST /chores/swaps/:id/respond').access.anyPermission).toContain(
      'chore:swap:accept',
    );
  });

  it('refuses a guest, who holds neither', async () => {
    const routes = await collectRouteAccess(choresRoutes);
    const guest = authFor('guest');
    expect(statusFor(routeAt(routes, 'POST /chores/swaps').access, guest)).toBe(403);
  });
});

describe('denyError', () => {
  it('answers 404 where the route asked for it and 403 everywhere else', () => {
    expect(denyError({ permission: 'goal:read' }, 'goal:read', {}).statusCode).toBe(403);
    expect(
      denyError({ permission: 'goal:read', notFoundOnDeny: true }, 'goal:read', {}).statusCode,
    ).toBe(404);
  });

  it('keeps the required permission out of the 404 body', () => {
    // It goes to `context`, which the error handler logs and never serialises.
    const error = denyError({ permission: 'goal:read', notFoundOnDeny: true }, 'goal:read', {
      required: 'goal:read',
    });
    expect(error.message).not.toContain('goal:read');
    expect(error.context).toMatchObject({ required: 'goal:read' });
  });
});

describe('decideAccess', () => {
  it('resolves the scope for a scoped route so the handler need not re-derive it', () => {
    const own = decideAccess({ scoped: 'task:read' }, authFor('child'));
    expect(own).toEqual({ allowed: true, scope: 'own' });

    const any = decideAccess({ scoped: 'task:read' }, authFor('adult'));
    expect(any).toEqual({ allowed: true, scope: 'any' });
  });

  it('accepts a caller holding any one of an `anyPermission` list', () => {
    const access = { anyPermission: ['chore:swap:accept', 'chore:swap:request'] } as const;
    const roles: Role[] = ['child', 'teen', 'adult'];
    for (const role of roles) {
      expect(decideAccess({ ...access }, authFor(role)).allowed, role).toBe(true);
    }
    expect(decideAccess({ ...access }, authFor('guest')).allowed).toBe(false);
  });
});
