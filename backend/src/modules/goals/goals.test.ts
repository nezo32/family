import { getTableColumns } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { effectivePermissions, type Permission, type Role } from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import { AppError } from '../../core/errors.js';
import { decideAccess } from '../../core/plugins/auth.js';
import type { Db } from '../../core/db.js';
import { authFor } from '../../test/access.js';
import { users } from '../identity/users.schema.js';
import { goalTransactions, savingsGoals } from './goals.schema.js';
import goalsRoutes, { GOAL_ROUTE_ACCESS } from './goals.routes.js';
import * as repo from './goals.repository.js';
import * as service from './goals.service.js';

/**
 * Moneybox tests.
 *
 * The rules worth testing here are the money rules, and money rules do not need
 * a database: signs, the below-zero refusal, the integer-only arithmetic and the
 * fire-once crossing detection are all pure functions. They run everywhere.
 *
 * The database-shaped half — that `SUM(delta)` really is the balance, that a
 * replayed POST really is idempotent — is gated on `TEST_DATABASE_URL` so
 * `pnpm test` stays runnable without Docker (see `src/test/setup.ts`).
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const ADULT_ID = '11111111-1111-4111-8111-111111111111';
const TEEN_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ADULT_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const SOME_GOAL_ID = '66666666-6666-4666-8666-666666666666';
const SOME_MILESTONE_ID = '77777777-7777-4777-8777-777777777777';

function actorFor(role: Role, userId: string): service.GoalActor {
  const permissions = new Set<Permission>(effectivePermissions(role));
  return { userId, can: (permission) => permissions.has(permission) };
}

/** The service refuses before it ever reaches the database in these tests. */
const NO_DB = undefined as unknown as Db;

function expectAppError(error: unknown, code: string): void {
  expect(AppError.isAppError(error)).toBe(true);
  expect((error as AppError).code).toBe(code);
}

/* ========================================================================== */
/* Money: integer minor units, no float anywhere                              */
/* ========================================================================== */

describe('integer minor units', () => {
  it('has no float drift where roubles would have it', () => {
    // The canonical trap, in roubles.
    expect(0.1 + 0.2 - 0.3).not.toBe(0);
    expect(0.1 + 0.2).not.toBe(0.3);

    // The same three amounts in копейки: 10 + 20 - 30.
    const ledger = [10, 20, -30];
    expect(service.sumLedger(ledger)).toBe(0);
    expect(Object.is(service.sumLedger(ledger), 0)).toBe(true);
    expect(service.sumLedger([10, 20])).toBe(30);
  });

  it('stays exact over a long ledger and is order-independent', () => {
    // 1 копейка a hundred thousand times is exactly 1000,00 ₽.
    const many = Array.from({ length: 100_000 }, () => 1);
    expect(service.sumLedger(many)).toBe(100_000);

    const mixed = [123_45, -1, 99_999, 7, -50_000, 1, -1];
    const reversed = [...mixed].reverse();
    expect(service.sumLedger(mixed)).toBe(service.sumLedger(reversed));
    expect(Number.isInteger(service.sumLedger(mixed))).toBe(true);
  });

  it('rejects a non-integer amount at the boundary', () => {
    expect(() => service.assertIntegerMinorUnits(10.5, 'amount')).toThrow(AppError);
    expect(() => service.assertIntegerMinorUnits(Number.NaN, 'amount')).toThrow(AppError);
    expect(() => service.assertIntegerMinorUnits(2 ** 60, 'amount')).toThrow(AppError);
    expect(service.assertIntegerMinorUnits(-42, 'delta')).toBe(-42);
  });

  it('parses money from the driver without ever producing a float', () => {
    expect(repo.toMinorUnits('100000')).toBe(100_000);
    expect(repo.toMinorUnits('-4550')).toBe(-4550);
    expect(repo.toMinorUnits(null)).toBe(0);
    expect(repo.toMinorUnits(12_345n)).toBe(12_345);
    // `numeric` leaking in as a decimal string is a bug, not something to round.
    expect(() => repo.toMinorUnits('100.5')).toThrow(AppError);
    expect(() => repo.toMinorUnits(100.5)).toThrow(AppError);
  });

  it('computes progressPercent with integer arithmetic only', () => {
    const target = 100_000;
    expect(service.progressPercent(0, target)).toBe(0);
    expect(service.progressPercent(50_000, target)).toBe(50);
    // 33.333… rounds down, 33.5 rounds up — exactly, without a float.
    expect(service.progressPercent(33_333, target)).toBe(33);
    expect(service.progressPercent(33_500, target)).toBe(34);
    // Not capped at 100: an over-funded goal reads 112 % (household.md §2.5).
    expect(service.progressPercent(112_000, target)).toBe(112);
    // Floored at 0: a correction cannot make progress negative.
    expect(service.progressPercent(-5_000, target)).toBe(0);
    expect(service.progressPercent(1, 0)).toBe(0);

    for (const current of [0, 1, 999, 33_333, 50_000, 99_999, 250_000]) {
      expect(Number.isInteger(service.progressPercent(current, target))).toBe(true);
    }
  });

  it('computes remainingAmount as an integer floored at zero', () => {
    expect(service.remainingAmount(30_000, 100_000)).toBe(70_000);
    expect(service.remainingAmount(120_000, 100_000)).toBe(0);
  });
});

/* ========================================================================== */
/* The balance is the ledger — never a stored value                           */
/* ========================================================================== */

describe('balance is derived from the ledger', () => {
  it('savings_goals carries no cached balance column (D6)', () => {
    const columns = Object.keys(getTableColumns(savingsGoals));

    for (const cached of [
      'currentAmount',
      'current_amount',
      'balance',
      'savedAmount',
      'saved_amount',
      'currentBalance',
      'progressPercent',
    ]) {
      expect(columns).not.toContain(cached);
    }
    // The only stored amount is the target the ledger is measured against.
    expect(columns).toContain('targetAmount');
  });

  it('goal_transactions is append-only in shape', () => {
    const columns = Object.keys(getTableColumns(goalTransactions));
    expect(columns).toContain('delta');
    // No `updated_at`, no `deleted_at`: a row is never edited or retracted.
    expect(columns).not.toContain('updatedAt');
    expect(columns).not.toContain('deletedAt');
  });

  it('exposes no update or delete path for a ledger row', () => {
    const exported = Object.keys(repo);
    expect(exported).toContain('insertTransaction');
    expect(exported.filter((name) => /^(update|delete|softDelete)Transaction/.test(name))).toEqual(
      [],
    );
  });

  it('nets a contribution against a later withdrawal', () => {
    const ledger = [service.contributionDelta(150_000), service.withdrawalDelta(45_000)];
    // The withdrawal was submitted positive and came back negative.
    expect(ledger).toEqual([150_000, -45_000]);
    expect(service.sumLedger(ledger)).toBe(105_000);
    expect(service.progressPercent(service.sumLedger(ledger), 210_000)).toBe(50);
  });
});

/* ========================================================================== */
/* Signs and the below-zero refusal                                           */
/* ========================================================================== */

describe('signs are the service’s decision', () => {
  it('takes a positive amount for both directions', () => {
    expect(service.contributionDelta(500)).toBe(500);
    expect(service.withdrawalDelta(500)).toBe(-500);
  });

  it('refuses a non-positive amount on either endpoint', () => {
    for (const amount of [0, -1, -100_000]) {
      expect(() => service.contributionDelta(amount)).toThrow(AppError);
      expect(() => service.withdrawalDelta(amount)).toThrow(AppError);
    }
  });
});

describe('a withdrawal may not go below zero', () => {
  it('refuses with CONFLICT when the balance would go negative', () => {
    const balance = 40_000;
    const delta = service.withdrawalDelta(50_000);
    try {
      service.assertBalanceNotNegative(balance + delta, { isCorrection: false });
      expect.unreachable('withdrawal below zero should have been refused');
    } catch (error) {
      expectAppError(error, 'CONFLICT');
      expect((error as AppError).statusCode).toBe(409);
    }
  });

  it('allows a withdrawal down to exactly zero', () => {
    expect(() =>
      service.assertBalanceNotNegative(40_000 + service.withdrawalDelta(40_000), {
        isCorrection: false,
      }),
    ).not.toThrow();
  });

  it('allows an explicit correction to go negative', () => {
    // A correction exists to undo a wrong row, so it has to be able to go
    // anywhere — which is why it needs `goal:update`, not `goal:contribute`.
    expect(() => service.assertBalanceNotNegative(-4_000, { isCorrection: true })).not.toThrow();
  });
});

/* ========================================================================== */
/* Milestone crossing fires exactly once                                      */
/* ========================================================================== */

describe('milestone crossing', () => {
  const milestones: service.MilestoneState[] = [
    { id: 'm-half', title: 'Половина', targetAmount: 50_000, reachedAt: null },
    { id: 'm-most', title: 'Почти', targetAmount: 90_000, reachedAt: null },
  ];

  it('reports only the checkpoints the new balance passed', () => {
    const result = service.detectCrossings({
      currentAmount: 60_000,
      targetAmount: 100_000,
      goalReachedAt: null,
      milestones,
    });
    expect(result.milestones.map((m) => m.id)).toEqual(['m-half']);
    expect(result.goalReached).toBe(false);
  });

  it('fires exactly once when the transaction endpoint is retried', () => {
    const first = service.detectCrossings({
      currentAmount: 60_000,
      targetAmount: 100_000,
      goalReachedAt: null,
      milestones,
    });
    expect(first.milestones).toHaveLength(1);

    // What the service does next: stamp `reached_at` on the crossed rows. The
    // stamp — not a remembered "previous balance" — is the fire-once guard.
    const stampedAt = new Date('2026-08-19T10:00:00.000Z');
    const afterStamp = milestones.map((m) =>
      first.milestones.some((x) => x.id === m.id) ? { ...m, reachedAt: stampedAt } : m,
    );

    // The client retries the identical request; the ledger reads the same.
    const replay = service.detectCrossings({
      currentAmount: 60_000,
      targetAmount: 100_000,
      goalReachedAt: null,
      milestones: afterStamp,
    });
    expect(replay.milestones).toEqual([]);
  });

  it('announces the goal itself once, then never again', () => {
    const reaching = service.detectCrossings({
      currentAmount: 100_000,
      targetAmount: 100_000,
      goalReachedAt: null,
      milestones: [],
    });
    expect(reaching.goalReached).toBe(true);

    const already = service.detectCrossings({
      currentAmount: 150_000,
      targetAmount: 100_000,
      goalReachedAt: new Date('2026-08-19T10:00:00.000Z'),
      milestones: [],
    });
    expect(already.goalReached).toBe(false);
  });

  it('keeps reachedAt sticky when money is withdrawn again', () => {
    // Withdrawing below the target must not un-reach the goal, or a
    // withdraw/contribute cycle would notify the family on every loop.
    const afterWithdrawal = service.detectCrossings({
      currentAmount: 10_000,
      targetAmount: 100_000,
      goalReachedAt: new Date('2026-08-19T10:00:00.000Z'),
      milestones: milestones.map((m) => ({
        ...m,
        reachedAt: new Date('2026-08-19T10:00:00.000Z'),
      })),
    });
    expect(afterWithdrawal.goalReached).toBe(false);
    expect(afterWithdrawal.milestones).toEqual([]);
  });

  it('derives a stable dedupe key per event', () => {
    expect(service.intentDedupeKey('goal_milestone_reached', SOME_MILESTONE_ID)).toBe(
      `goal_milestone_reached:${SOME_MILESTONE_ID}`,
    );
    expect(service.intentDedupeKey('goal_reached', SOME_GOAL_ID)).toBe(
      `goal_reached:${SOME_GOAL_ID}`,
    );
    // Same event twice ⇒ same key ⇒ same BullMQ jobId ⇒ told once.
    expect(service.intentDedupeKey('goal_reached', SOME_GOAL_ID)).toBe(
      service.intentDedupeKey('goal_reached', SOME_GOAL_ID),
    );
  });
});

/* ========================================================================== */
/* Permissions (D4)                                                           */
/* ========================================================================== */

const GOAL_PERMISSIONS: Permission[] = [
  'goal:read',
  'goal:create',
  'goal:update',
  'goal:delete',
  'goal:contribute',
];

describe('permission matrix', () => {
  it('gives a child zero goal permissions', () => {
    const held = effectivePermissions('child').filter((p) => p.startsWith('goal:'));
    expect(held).toEqual([]);
    for (const permission of GOAL_PERMISSIONS) {
      expect(effectivePermissions('child')).not.toContain(permission);
    }
  });

  it('gives a teen goal:read and nothing else', () => {
    expect(effectivePermissions('teen').filter((p) => p.startsWith('goal:'))).toEqual([
      'goal:read',
    ]);
  });

  it('gives an adult the full moneybox', () => {
    const adult = effectivePermissions('adult');
    for (const permission of GOAL_PERMISSIONS) expect(adult).toContain(permission);
  });

  it('locks a child out of every declared goal route', () => {
    const child = effectivePermissions('child');
    for (const [route, access] of Object.entries(GOAL_ROUTE_ACCESS)) {
      expect(child, `child must not satisfy ${route}`).not.toContain(access.permission);
    }
  });

  it('lets a teen satisfy only the read routes', () => {
    const teen = effectivePermissions('teen');
    for (const [route, access] of Object.entries(GOAL_ROUTE_ACCESS)) {
      const isRead = route.startsWith('GET ');
      expect(teen.includes(access.permission), `teen vs ${route}`).toBe(isRead);
    }
  });

  it('marks every read route — and only the reads — `notFoundOnDeny`', () => {
    // The D4 split, asserted on the table itself: a caller with no `goal:read`
    // must not be told the moneybox exists, while a teen who *can* see it and
    // may not spend from it gets an honest 403.
    for (const [route, access] of Object.entries(GOAL_ROUTE_ACCESS)) {
      const expected = route.startsWith('GET ') ? true : undefined;
      expect(
        'notFoundOnDeny' in access ? access.notFoundOnDeny : undefined,
        `${route} carries the wrong deny status`,
      ).toBe(expected);
    }
  });
});

describe('private goal visibility', () => {
  const privateGoal = { ownerId: OTHER_ADULT_ID, visibility: 'private' };
  const familyGoal = { ownerId: null, visibility: 'household' };

  it('hides a private goal from another adult', () => {
    expect(service.canReadGoal(actorFor('adult', ADULT_ID), privateGoal)).toBe(false);
    expect(service.canReadGoal(actorFor('adult', ADULT_ID), familyGoal)).toBe(true);
  });

  it('shows a private goal to its owner', () => {
    expect(service.canReadGoal(actorFor('adult', OTHER_ADULT_ID), privateGoal)).toBe(true);
  });

  it('shows a private goal to the `:any`-equivalent authority', () => {
    // household.md §5: owner/admin see everything. Expressed as a permission,
    // never as `role === 'admin'` (D4).
    expect(service.canReadGoal(actorFor('admin', ADMIN_ID), privateGoal)).toBe(true);
    expect(service.canReadAnyGoal(actorFor('admin', ADMIN_ID))).toBe(true);
    expect(service.canReadAnyGoal(actorFor('adult', ADULT_ID))).toBe(false);
  });

  it('hides everything from a child, whoever owns it', () => {
    const child = actorFor('child', CHILD_ID);
    expect(service.canReadGoal(child, familyGoal)).toBe(false);
    expect(service.canReadGoal(child, { ownerId: CHILD_ID, visibility: 'private' })).toBe(false);
  });

  it('narrows the SQL filter for everyone but the `:any` holder', () => {
    expect(repo.goalVisibilityFilter({ userId: ADULT_ID, canReadAny: false })).toBeDefined();
    expect(repo.goalVisibilityFilter({ userId: ADMIN_ID, canReadAny: true })).toBeUndefined();
  });
});

describe('service-level authorization (no database is ever reached)', () => {
  it('answers 404, not 403, when the caller may not read goals at all', async () => {
    // A child must not learn that the moneybox exists (D4, household.md §5).
    await expect(
      service.listGoals(NO_DB, actorFor('child', CHILD_ID), {
        scope: 'all',
        includeArchived: false,
        sort: 'sortOrder',
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });

    await expect(
      service.getGoal(NO_DB, actorFor('child', CHILD_ID), SOME_GOAL_ID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(service.getSummary(NO_DB, actorFor('child', CHILD_ID))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('answers 403 when the caller may read but may not act', async () => {
    // A teen sees the progress ring and cannot touch the money.
    const teen = actorFor('teen', TEEN_ID);

    await expect(
      service.contribute(NO_DB, teen, SOME_GOAL_ID, { amount: 10_000, kind: 'contribution' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    await expect(
      service.withdraw(NO_DB, teen, SOME_GOAL_ID, { amount: 10_000 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      service.correct(NO_DB, teen, SOME_GOAL_ID, { delta: -10_000, note: 'ошибка' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      service.createGoal(NO_DB, teen, {
        title: 'Велосипед',
        targetAmount: 100_000,
        currency: 'RUB',
        visibility: 'household',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(service.deleteGoal(NO_DB, teen, SOME_GOAL_ID)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    await expect(
      service.createMilestone(NO_DB, teen, SOME_GOAL_ID, {
        title: 'Половина',
        targetAmount: 50_000,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to create a private goal the author could not read back', async () => {
    // Otherwise a successful POST would be followed by a 404 on the very goal
    // it just created — the read filter already excludes the author.
    await expect(
      service.createGoal(NO_DB, actorFor('adult', ADULT_ID), {
        title: 'Подарок',
        targetAmount: 50_000,
        currency: 'RUB',
        visibility: 'private',
        ownerId: OTHER_ADULT_ID,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a child on every write too — as 404, never 403', async () => {
    const child = actorFor('child', CHILD_ID);
    await expect(
      service.contribute(NO_DB, child, SOME_GOAL_ID, { amount: 100, kind: 'contribution' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.reorderGoals(NO_DB, child, [SOME_GOAL_ID])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('notification audience', () => {
  it('derives the reader roles from the catalog, never from a hardcoded list', () => {
    expect(service.GOAL_READER_ROLES).toContain('adult');
    expect(service.GOAL_READER_ROLES).toContain('teen');
    expect(service.GOAL_READER_ROLES).not.toContain('child');
    expect(service.GOAL_READER_ROLES).not.toContain('guest');
  });

  it('keeps a private goal’s milestones private', () => {
    // Telling the family that «Подарок» just hit 50 % would leak the surprise.
    expect(service.audienceFor({ ownerId: OTHER_ADULT_ID, visibility: 'private' })).toEqual({
      users: [OTHER_ADULT_ID],
    });
  });

  it('announces a shared goal to everyone who may read goals', () => {
    expect(service.audienceFor({ ownerId: null, visibility: 'household' })).toEqual({
      roles: service.GOAL_READER_ROLES,
    });
  });
});

/* ========================================================================== */
/* Routes: declared access (no database needed — the guard runs first)        */
/* ========================================================================== */

interface CollectedRoute {
  method: string;
  url: string;
  permission: Permission | undefined;
  notFoundOnDeny: boolean;
  isPublic: boolean;
}

/**
 * A miniature host for the goals plugin.
 *
 * It hosts the routes without Redis-backed rate limiting or a JWT, but the
 * access decision itself is the **real** one: the `onRequest` hook calls
 * `decideAccess()` from `core/plugins/auth`, and the caller comes from the real
 * `buildAuthContext`. A hand-rolled copy of the rule here would have happily
 * kept asserting 403 on `/goals` forever — which is precisely the bug this
 * module shipped.
 */
async function buildGoalsHarness(
  role: Role | null,
  userId = ADULT_ID,
): Promise<{ app: FastifyInstance; routes: CollectedRoute[] }> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('auth', null);
  app.decorateRequest('scope', null);

  const routes: CollectedRoute[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      routes.push({
        method,
        url: route.url,
        permission: route.config?.permission,
        notFoundOnDeny: route.config?.notFoundOnDeny === true,
        isPublic: route.config?.public === true,
      });
    }
  });

  const caller: AuthContext | null = role ? authFor(role, { userId }) : null;

  app.addHook('onRequest', async (request) => {
    const access = request.routeOptions.config;
    if (access.public) return;
    if (!caller) throw new AppError('UNAUTHENTICATED', 'Authentication required');
    const decision = decideAccess(access, caller);
    if (!decision.allowed) throw decision.error;
    request.auth = caller;
  });

  await app.register(goalsRoutes);
  await app.ready();
  return { app, routes };
}

function concreteUrl(url: string): string {
  return url.replace(':id', SOME_GOAL_ID).replace(':mid', SOME_MILESTONE_ID);
}

describe('route access declarations', () => {
  let harness: Awaited<ReturnType<typeof buildGoalsHarness>>;

  beforeAll(async () => {
    harness = await buildGoalsHarness('adult');
  });

  afterAll(async () => {
    await harness.app.close();
  });

  it('declares a permission on every route and makes none public', () => {
    expect(harness.routes.length).toBeGreaterThan(0);
    for (const route of harness.routes) {
      expect(route.isPublic, `${route.method} ${route.url} must not be public`).toBe(false);
      expect(
        route.permission,
        `${route.method} ${route.url} declares no permission — boot would fail`,
      ).toBeDefined();
    }
  });

  it('registers exactly the documented route table', () => {
    const registered = Object.fromEntries(
      harness.routes.map((route) => [
        `${route.method} ${route.url}`,
        route.notFoundOnDeny
          ? { permission: route.permission, notFoundOnDeny: true }
          : { permission: route.permission },
      ]),
    );
    expect(registered).toEqual(GOAL_ROUTE_ACCESS);
  });
});

describe('HTTP: a child is denied every goal route', () => {
  let harness: Awaited<ReturnType<typeof buildGoalsHarness>>;

  beforeAll(async () => {
    harness = await buildGoalsHarness('child', CHILD_ID);
  });

  afterAll(async () => {
    await harness.app.close();
  });

  it('rejects the child before any handler runs — 404 on the reads', async () => {
    expect(harness.routes.length).toBe(Object.keys(GOAL_ROUTE_ACCESS).length);

    for (const route of harness.routes) {
      const response = await harness.app.inject({
        method: route.method as 'GET',
        url: concreteUrl(route.url),
        payload: route.method === 'GET' || route.method === 'DELETE' ? undefined : {},
      });
      // The route guard denies at `onRequest`, so no database is touched and no
      // goal id is ever confirmed or denied.
      //
      // A child holds no `goal:*` permission at all, so every **read** must
      // answer 404: a 403 on `/goals` would tell them the family keeps a
      // moneybox, which is the exact leak D4 was written about. The writes stay
      // 403 — a caller who cannot read the section cannot reach them by
      // guessing a URL either, and 403 is what the module promises everybody
      // who can see a goal but may not spend from it.
      const expected = route.method === 'GET' ? 404 : 403;
      expect(response.statusCode, `${route.method} ${route.url} must reject a child`).toBe(
        expected,
      );
    }
  });

  it('never answers a child 403 on a read, whatever the id', async () => {
    const reads = harness.routes.filter((route) => route.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);

    for (const route of reads) {
      const response = await harness.app.inject({ method: 'GET', url: concreteUrl(route.url) });
      expect(response.statusCode, `${route.url}`).toBe(404);
      // A 404 whose body reads "Missing permission: goal:read" leaks exactly
      // what the status code was chosen to hide. (This harness carries no error
      // handler, so the body is Fastify's default; the shaped payload is
      // asserted in `permissions.integration.test.ts`.)
      expect(response.body).not.toContain('goal:read');
    }
  });
});

describe('HTTP: a teen may read but not contribute', () => {
  let harness: Awaited<ReturnType<typeof buildGoalsHarness>>;

  beforeAll(async () => {
    harness = await buildGoalsHarness('teen', TEEN_ID);
  });

  afterAll(async () => {
    await harness.app.close();
  });

  it('rejects every money-moving route', async () => {
    const writeRoutes = harness.routes.filter((route) => route.method !== 'GET');
    expect(writeRoutes.length).toBeGreaterThan(0);

    for (const route of writeRoutes) {
      const response = await harness.app.inject({
        method: route.method as 'POST',
        url: concreteUrl(route.url),
        payload: route.method === 'DELETE' ? undefined : {},
      });
      expect(response.statusCode, `${route.method} ${route.url} must reject a teen`).toBe(403);
    }
  });

  it('lets the read routes past the guard', () => {
    // Asserted against what is actually registered, not against a copy of the
    // table: a loosened guard on a read route would show up here.
    const teen = effectivePermissions('teen');
    const readRoutes = harness.routes.filter((route) => route.method === 'GET');
    expect(readRoutes.length).toBeGreaterThan(0);
    for (const route of readRoutes) {
      expect(route.permission).toBe('goal:read');
      expect(teen).toContain(route.permission);
    }
  });

  it('is denied unauthenticated', async () => {
    const anonymous = await buildGoalsHarness(null);
    const response = await anonymous.app.inject({ method: 'GET', url: '/goals' });
    expect(response.statusCode).toBe(401);
    await anonymous.app.close();
  });
});

/* ========================================================================== */
/* Postgres-backed: the ledger really is the balance                          */
/* ========================================================================== */

describe.skipIf(!TEST_DATABASE_URL)('goals ledger against Postgres', () => {
  let db: Db;
  let close: () => Promise<void>;
  const adult = actorFor('adult', ADULT_ID);
  const otherAdult = actorFor('adult', OTHER_ADULT_ID);

  beforeAll(async () => {
    const { createDbClient } = await import('../../core/db.js');
    const created = createDbClient(TEST_DATABASE_URL);
    db = created.db;
    close = async () => {
      await created.sql.end({ timeout: 5 });
    };

    for (const [id, role, name] of [
      [ADULT_ID, 'adult', 'Мама'],
      [OTHER_ADULT_ID, 'adult', 'Папа'],
    ] as const) {
      await db
        .insert(users)
        .values({ id, role, status: 'active', displayName: name })
        .onConflictDoNothing();
    }
  });

  afterAll(async () => {
    await close();
  });

  async function freshGoal(target = 100_000): Promise<string> {
    const goal = await service.createGoal(db, adult, {
      title: `Тест ${Date.now()}-${Math.random()}`,
      targetAmount: target,
      currency: 'RUB',
      visibility: 'household',
      milestones: [{ title: 'Половина', targetAmount: Math.floor(target / 2) }],
    });
    return goal.id;
  }

  it('derives currentAmount as SUM(delta) and nets a withdrawal', async () => {
    const goalId = await freshGoal();

    await service.contribute(db, adult, goalId, { amount: 150_00, kind: 'contribution' });
    await service.contribute(db, adult, goalId, { amount: 350_00, kind: 'contribution' });
    const afterWithdrawal = await service.withdraw(db, adult, goalId, { amount: 100_00 });

    expect(afterWithdrawal.goal.currentAmount).toBe(400_00);
    // Same number, computed the other way: straight off the ledger.
    expect(await repo.goalBalance(db, goalId)).toBe(400_00);

    const ledger = await service.listTransactions(db, adult, goalId, { limit: 50 });
    expect(service.sumLedger(ledger.items.map((t) => t.delta))).toBe(400_00);
  });

  it('refuses a withdrawal that would go below zero', async () => {
    const goalId = await freshGoal();
    await service.contribute(db, adult, goalId, { amount: 100_00, kind: 'contribution' });

    await expect(service.withdraw(db, adult, goalId, { amount: 100_01 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await repo.goalBalance(db, goalId)).toBe(100_00);
  });

  it('lets a correction go where a withdrawal may not', async () => {
    const goalId = await freshGoal();
    await service.contribute(db, adult, goalId, { amount: 100_00, kind: 'contribution' });
    const corrected = await service.correct(db, adult, goalId, {
      delta: -150_00,
      note: 'дубль внесения',
    });
    expect(corrected.goal.currentAmount).toBe(-50_00);
    expect(corrected.goal.progressPercent).toBe(0);
  });

  it('credits a replayed clientId exactly once', async () => {
    const goalId = await freshGoal();
    const clientId = crypto.randomUUID();

    const first = await service.contribute(db, adult, goalId, {
      amount: 60_000,
      kind: 'contribution',
      clientId,
    });
    const retry = await service.contribute(db, adult, goalId, {
      amount: 60_000,
      kind: 'contribution',
      clientId,
    });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.transaction.id).toBe(first.transaction.id);
    expect(await repo.goalBalance(db, goalId)).toBe(60_000);
  });

  it('stamps a milestone once even when the request is retried', async () => {
    const goalId = await freshGoal();
    const clientId = crypto.randomUUID();

    await service.contribute(db, adult, goalId, { amount: 60_000, kind: 'contribution', clientId });
    await service.contribute(db, adult, goalId, { amount: 60_000, kind: 'contribution', clientId });

    const stamped = (await repo.listMilestones(db, [goalId])).filter((m) => m.reachedAt !== null);
    expect(stamped).toHaveLength(1);

    // And a second stamping attempt updates nothing, so nothing is announced.
    const first = stamped[0];
    if (!first) throw new Error('expected a stamped milestone');
    expect(await repo.markMilestonesReached(db, [first.id], new Date())).toEqual([]);
  });

  it('reaches the goal once and stays reached after a withdrawal', async () => {
    const goalId = await freshGoal();
    const reached = await service.contribute(db, adult, goalId, {
      amount: 100_000,
      kind: 'contribution',
    });
    expect(reached.goal.status).toBe('reached');
    expect(reached.goal.reachedAt).not.toBeNull();

    const after = await service.withdraw(db, adult, goalId, { amount: 50_000 });
    expect(after.goal.status).toBe('reached');
    expect(after.goal.currentAmount).toBe(50_000);
  });

  it('404s a private goal for anybody but its owner', async () => {
    const privateGoal = await service.createGoal(db, adult, {
      title: 'Подарок',
      targetAmount: 50_000,
      currency: 'RUB',
      visibility: 'private',
    });

    await expect(service.getGoal(db, otherAdult, privateGoal.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    await expect(service.getGoal(db, adult, privateGoal.id)).resolves.toMatchObject({
      id: privateGoal.id,
    });
  });

  it('archives rather than deletes a goal that has history', async () => {
    const withHistory = await freshGoal();
    await service.contribute(db, adult, withHistory, { amount: 1_000, kind: 'contribution' });
    expect(await service.deleteGoal(db, adult, withHistory)).toEqual({ archived: true });
    // The ledger survives.
    expect(await repo.goalBalance(db, withHistory)).toBe(1_000);

    const untouched = await freshGoal();
    expect(await service.deleteGoal(db, adult, untouched)).toEqual({ archived: false });
    await expect(service.getGoal(db, adult, untouched)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('keeps milestone rows attached to their goal', async () => {
    const goalId = await freshGoal();
    const milestone = await service.createMilestone(db, adult, goalId, {
      title: 'Почти',
      targetAmount: 90_000,
    });
    expect(milestone.goalId).toBe(goalId);
    expect(await repo.findMilestone(db, goalId, milestone.id)).not.toBeNull();

    await service.deleteMilestone(db, adult, goalId, milestone.id);
    expect(await repo.findMilestone(db, goalId, milestone.id)).toBeNull();
  });
});
