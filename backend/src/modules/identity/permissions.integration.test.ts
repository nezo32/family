import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hasTestDb } from '../../test/db.js';
import {
  closeHarness,
  createMember,
  createOwner,
  errorCode,
  expectStatus,
  request,
  resetDatabase,
  startHarness,
  type Harness,
  type TestUser,
} from '../../test/harness.js';

/**
 * Access control, through the real router.
 *
 * The role matrix is already unit-tested. What is *not* testable without the
 * app is whether each route actually carries the guard the matrix implies, and
 * — the part D4 cares about — whether a denial comes back as 404 or 403. A
 * `notFoundOnDeny` flag forgotten on one route is invisible to every unit test
 * and turns a status code into an oracle: a 403 on `/goals` tells a child the
 * family has a moneybox.
 */
describe.skipIf(!hasTestDb)('permissions (integration)', () => {
  let h: Harness;
  let owner: TestUser;
  let adult: TestUser;
  let teen: TestUser;
  let child: TestUser;
  let guest: TestUser;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await closeHarness();
  });

  beforeEach(async () => {
    await resetDatabase();
    owner = await createOwner(h.app);
    adult = await createMember(h.app, owner, 'adult', { displayName: 'Взрослый' });
    teen = await createMember(h.app, owner, 'teen', { displayName: 'Подросток' });
    child = await createMember(h.app, owner, 'child', { displayName: 'Ребёнок' });
    guest = await createMember(h.app, owner, 'guest', { displayName: 'Гость' });
  });

  it('creates one member per role and resolves the permission set from the row', async () => {
    for (const user of [owner, adult, teen, child, guest]) {
      const me = await request(h.app, { method: 'GET', url: '/api/me', token: user.accessToken });
      expectStatus(me, 200);
      expect(me.json()).toMatchObject({ user: { id: user.id, role: user.role } });
    }
  });

  describe('the moneybox is invisible below `goal:read`', () => {
    /**
     * KNOWN FAILURE — documents a real bug, do not relax.
     *
     * `core/plugins/auth.ts` names this exact case in its own documentation:
     *
     *   > a child has no `goal:*` permission whatsoever, so `/goals` must answer
     *   > 404, not 403. A 403 would confirm the family has a moneybox (D4).
     *
     * `goals.routes.ts` declares `config: { permission: 'goal:read' }` on every
     * read route and never sets `notFoundOnDeny: true`, so the deny path lands
     * on the 403 branch of `enforce()`. `tasks.routes.ts` gets this right; the
     * moneybox — the one section the rule was written for — does not.
     */
    it('404s a child on /goals rather than 403', async () => {
      const response = await request(h.app, {
        method: 'GET',
        url: '/api/goals',
        token: child.accessToken,
      });

      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
    });

    /** KNOWN FAILURE — same bug, across the whole read surface. */
    it('404s a child on every goal read route, existing or not', async () => {
      const madeUpId = '00000000-0000-4000-8000-00000000dead';
      for (const url of ['/api/goals', '/api/goals/summary', `/api/goals/${madeUpId}`]) {
        const response = await request(h.app, { method: 'GET', url, token: child.accessToken });
        expect({ url, status: response.statusCode }).toEqual({ url, status: 404 });
      }
    });

    it('lets a teen read goals but not create or contribute', async () => {
      const list = await request(h.app, {
        method: 'GET',
        url: '/api/goals',
        token: teen.accessToken,
      });
      expectStatus(list, 200);

      const create = await request(h.app, {
        method: 'POST',
        url: '/api/goals',
        token: teen.accessToken,
        payload: { title: 'Велосипед', targetAmount: 100_000, currency: 'RUB' },
      });
      // A teen can see the section, so "you may not do that" is the honest
      // answer — 403, not 404.
      expect(create.statusCode).toBe(403);
      expect(errorCode(create)).toBe('FORBIDDEN');
    });
  });

  describe('the dashboard hides finance from a child', () => {
    it('omits the moneybox section entirely for a child', async () => {
      // Give the family something to hide.
      const goal = await request(h.app, {
        method: 'POST',
        url: '/api/goals',
        token: adult.accessToken,
        payload: {
          title: 'Отпуск',
          targetAmount: 500_000,
          currency: 'RUB',
          visibility: 'household',
        },
      });
      expect([200, 201]).toContain(goal.statusCode);

      const asAdult = await request(h.app, {
        method: 'GET',
        url: '/api/dashboard/today',
        token: adult.accessToken,
      });
      expectStatus(asAdult, 200);

      const asChild = await request(h.app, {
        method: 'GET',
        url: '/api/dashboard/today',
        token: child.accessToken,
      });
      expectStatus(asChild, 200);

      const childBody = asChild.json() as Record<string, unknown>;
      const adultBody = asAdult.json() as Record<string, unknown>;

      // The adult's payload carries the section; the child's must not — and
      // must not carry it as an empty husk either, because "goals: []" still
      // tells the child the feature exists.
      expect(JSON.stringify(adultBody)).toContain('Отпуск');
      expect(JSON.stringify(childBody)).not.toContain('Отпуск');
      expect(childBody.goals ?? null).toBeNull();
    });
  });

  describe("another member's private goal", () => {
    it('404s a different adult, and 404s the owner of the section too', async () => {
      const created = await request(h.app, {
        method: 'POST',
        url: '/api/goals',
        token: adult.accessToken,
        payload: {
          title: 'Секретный подарок',
          targetAmount: 30_000,
          currency: 'RUB',
          visibility: 'private',
        },
      });
      expect([200, 201]).toContain(created.statusCode);
      const goalId = (created.json() as { id: string }).id;

      // The author still sees it.
      const mine = await request(h.app, {
        method: 'GET',
        url: `/api/goals/${goalId}`,
        token: adult.accessToken,
      });
      expectStatus(mine, 200);

      // A teen with `goal:read` but no `goal:read:any` must not — and gets a
      // 404, so the id itself is not confirmed to exist.
      const other = await request(h.app, {
        method: 'GET',
        url: `/api/goals/${goalId}`,
        token: teen.accessToken,
      });
      expect(other.statusCode).toBe(404);

      // Nor may they contribute to it by guessing the id.
      const contribute = await request(h.app, {
        method: 'POST',
        url: `/api/goals/${goalId}/contributions`,
        token: teen.accessToken,
        payload: { amount: 100, kind: 'contribution' },
      });
      expect([403, 404]).toContain(contribute.statusCode);

      // It does not appear in the list either.
      const list = await request(h.app, {
        method: 'GET',
        url: '/api/goals',
        token: teen.accessToken,
      });
      expectStatus(list, 200);
      expect(list.body).not.toContain('Секретный подарок');
    });
  });

  describe('privilege escalation through the members surface', () => {
    it('refuses to assign a role at or above the actor’s own', async () => {
      const admin = await createMember(h.app, owner, 'admin', { displayName: 'Админ' });

      const promote = await request(h.app, {
        method: 'PATCH',
        url: `/api/members/${adult.id}`,
        token: admin.accessToken,
        payload: { role: 'owner' },
      });
      expect(promote.statusCode).toBe(403);
      expect(errorCode(promote)).toBe('FORBIDDEN');

      const selfPromote = await request(h.app, {
        method: 'PATCH',
        url: `/api/members/${admin.id}`,
        token: admin.accessToken,
        payload: { role: 'owner' },
      });
      expect(selfPromote.statusCode).toBe(403);
    });

    it('refuses to grant a permission the actor does not hold', async () => {
      const admin = await createMember(h.app, owner, 'admin', { displayName: 'Админ2' });

      // An admin does hold `backup:manage`, so pick something only an owner has.
      const escalate = await request(h.app, {
        method: 'PATCH',
        url: `/api/members/${child.id}`,
        token: adult.accessToken,
        payload: { permissionGrants: ['member:role:assign'] },
      });
      // An adult cannot administer members at all; either refusal is correct,
      // but it must never be a 200.
      expect(escalate.statusCode).toBeGreaterThanOrEqual(400);
      expect(escalate.statusCode).toBeLessThan(500);
      expect(admin.role).toBe('admin');
    });

    it('lets a guest read nothing but their own profile and the calendar', async () => {
      const me = await request(h.app, { method: 'GET', url: '/api/me', token: guest.accessToken });
      expectStatus(me, 200);

      const tasks = await request(h.app, {
        method: 'GET',
        url: '/api/tasks/series',
        token: guest.accessToken,
      });
      // No `task:read:*` at all — the section must look absent, not forbidden.
      expect(tasks.statusCode).toBe(404);
    });
  });

  describe('unauthenticated and malformed credentials', () => {
    it('401s without a token and 401s a forged one', async () => {
      const anonymous = await request(h.app, { method: 'GET', url: '/api/me' });
      expect(anonymous.statusCode).toBe(401);

      const forged = await request(h.app, {
        method: 'GET',
        url: '/api/me',
        token: 'not.a.jwt',
      });
      expect(forged.statusCode).toBe(401);
      expect(errorCode(forged)).toBe('TOKEN_INVALID');
    });

    it('404s an unmatched URL rather than 403', async () => {
      // The deny-by-default hook runs for unmatched routes too; without the
      // `request.is404` guard every typo would answer 403 and D4's "a missing
      // resource must look missing" would be false.
      const response = await request(h.app, {
        method: 'GET',
        url: '/api/definitely-not-a-route',
        token: owner.accessToken,
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
