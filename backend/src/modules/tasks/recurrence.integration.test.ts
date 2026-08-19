import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pointsLedger } from '../chores/chores.schema.js';
import { hasTestDb } from '../../test/db.js';
import {
  closeHarness,
  createMember,
  createOwner,
  expectStatus,
  request,
  resetDatabase,
  startHarness,
  type Harness,
  type TestUser,
} from '../../test/harness.js';
import { taskOccurrences, taskSeries } from './tasks.schema.js';

/**
 * Recurrence and chore rotation, end to end.
 *
 * `engine.test.ts` proves the RRULE expansion, and `materializer.test.ts`
 * proves the plan/insert protocol against a fake port. Neither can prove the
 * thing that actually breaks in production: that the plan reaches Postgres
 * intact, that the `(series_id, occurrence_key)` unique index really makes a
 * second pass a no-op, that a completion books points exactly once through the
 * partial unique index, and that a `this_and_future` split leaves the completed
 * history alone.
 *
 * Where an HTTP read is currently broken (see the `broken reads` block at the
 * bottom) the assertions are made against the table instead, so a single bug
 * does not blind the whole file.
 */
describe.skipIf(!hasTestDb)('recurrence & rotation (integration)', () => {
  let h: Harness;
  let owner: TestUser;
  let adult: TestUser;
  let teen: TestUser;

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
  });

  /* -------------------------------- helpers ----------------------------- */

  async function createSeries(
    actor: TestUser,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await request(h.app, {
      method: 'POST',
      url: '/api/tasks/series',
      token: actor.accessToken,
      payload: {
        title: 'Мыть посуду',
        points: 10,
        graceMinutes: 30,
        dueOffsetMinutes: 60,
        recurrence: {
          mode: 'preset',
          preset: { kind: 'daily', interval: 1 },
          ends: { type: 'after', count: 5 },
          dtstartLocal: '2026-09-01T09:00:00',
          timezone: 'Europe/Moscow',
          rdatesLocal: [],
          exdatesLocal: [],
        },
        ...overrides,
      },
    });
    expect([200, 201]).toContain(response.statusCode);
    return (response.json() as { id: string }).id;
  }

  async function occurrencesOf(seriesId: string) {
    return h.db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.seriesId, seriesId))
      .orderBy(asc(taskOccurrences.occurrenceKey));
  }

  async function ledgerFor(userId: string) {
    return h.db.select().from(pointsLedger).where(eq(pointsLedger.userId, userId));
  }

  /* ====================================================================== */
  /* 1. occurrences materialize, and a second pass is a no-op               */
  /* ====================================================================== */

  it('materializes the occurrences eagerly, in the series transaction', async () => {
    const seriesId = await createSeries(adult);
    const rows = await occurrencesOf(seriesId);

    // COUNT=5 daily from 2026-09-01.
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.occurrenceKey)).toEqual([
      '2026-09-01T09:00:00',
      '2026-09-02T09:00:00',
      '2026-09-03T09:00:00',
      '2026-09-04T09:00:00',
      '2026-09-05T09:00:00',
    ]);
    expect(rows.every((r) => r.status === 'scheduled')).toBe(true);

    // `due_at` is wall-clock arithmetic on the local start, not
    // `instant + n * 60000`. 09:00 + 60min = 10:00 Moscow = 07:00Z.
    for (const row of rows) {
      expect(row.dueAt.getTime() - row.startsAt.getTime()).toBe(60 * 60_000);
      expect(row.startsLocal).toBe(row.occurrenceKey);
    }

    // The watermark commits with the rows it vouches for.
    const [series] = await h.db.select().from(taskSeries).where(eq(taskSeries.id, seriesId));
    expect(series?.materializedThrough).not.toBeNull();
  });

  it('is idempotent: a second materializer pass inserts nothing and moves nothing', async () => {
    const seriesId = await createSeries(adult);
    const before = await occurrencesOf(seriesId);
    const beforeIds = before.map((r) => r.id);

    const { TasksService } = await import('./tasks.service.js');
    const service = new TasksService(h.db);
    const [series] = await h.db.select().from(taskSeries).where(eq(taskSeries.id, seriesId));
    if (!series) throw new Error('series vanished');

    // The nightly horizon extension, run again over the same window. The
    // `(series_id, occurrence_key)` unique index is what makes this safe; a
    // planner that recomputed keys from `now` instead of from the anchor would
    // duplicate every row here.
    const result = await service.materialize(h.db, series, new Date('2026-08-19T12:00:00Z'));
    expect(result.inserted).toBe(0);

    const after = await occurrencesOf(seriesId);
    expect(after.map((r) => r.id)).toEqual(beforeIds);
    expect(after.map((r) => r.occurrenceKey)).toEqual(before.map((r) => r.occurrenceKey));
  });

  /* ====================================================================== */
  /* 2. completion books points exactly once                                */
  /* ====================================================================== */

  /**
   * The ledger half of completion, exercised directly against Postgres.
   *
   * `POST /tasks/occurrences/:id/complete` cannot currently be driven at all
   * (see `occurrence reads` below), so these go through `PointsService` on the
   * real database instead. What they prove is the part a fake repository never
   * can: that the partial unique index
   * `(occurrence_id, user_id) WHERE reason = 'chore_completed'` exists and holds.
   */
  describe('points ledger', () => {
    async function bookTwice(points: number, dueAt: Date, completedAt: Date) {
      const seriesId = await createSeries(adult, { points, defaultAssigneeId: teen.id });
      const [occurrence] = await occurrencesOf(seriesId);
      if (!occurrence) throw new Error('nothing materialized');

      const { PointsService } = await import('../chores/points.service.js');
      const service = new PointsService(h.db);
      const booking = {
        occurrenceId: occurrence.id,
        completedById: teen.id,
        assigneeId: teen.id,
        points,
        dueAt,
        graceMinutes: 30,
        completedAt,
      };
      const first = await service.bookCompletion(h.db, booking);
      const second = await service.bookCompletion(h.db, booking);
      return { first, second, occurrence };
    }

    it('writes the ledger rows exactly once, however many times it is replayed', async () => {
      const dueAt = new Date('2026-09-01T07:00:00Z');
      const { first, second } = await bookTwice(10, dueAt, new Date(dueAt.getTime() - 60_000));

      const chore = (await ledgerFor(teen.id)).filter((e) => e.reason === 'chore_completed');
      expect(chore).toHaveLength(1);
      expect(chore[0]?.delta).toBe(10);

      expect(first.entries.length).toBeGreaterThan(0);
      expect(second.entries).toHaveLength(0);
    });

    /**
     * KNOWN FAILURE — documents a real bug, do not relax.
     *
     * `points.service.ts:165-244` sums `total` from `basePoints + onTimeBonus +
     * coverBonus + swapBonus` with no regard for whether the insert actually
     * landed. `coverBonus` and `swapBonus` are reset to 0 when
     * `insertLedgerEntry` returns nothing (lines 209 and 241); `basePoints` and
     * `onTimeBonus` are not. A booking whose rows were all swallowed by the
     * partial unique index therefore reports a full award it did not make.
     *
     * `chores.service.ts:729` returns that number as `pointsAwarded`, so a
     * completion that loses the race tells the child «+13 очков» while the
     * ledger moved by zero.
     */
    it('reports an award of zero when the ledger rows were already there', async () => {
      const dueAt = new Date('2026-09-01T07:00:00Z');
      const { second } = await bookTwice(10, dueAt, new Date(dueAt.getTime() - 60_000));

      expect(second.entries).toHaveLength(0);
      expect(second.total).toBe(0);
    });

    it('books at most one row per (occurrence, user, reason) under concurrency', async () => {
      const seriesId = await createSeries(adult, { points: 8, defaultAssigneeId: teen.id });
      const [occurrence] = await occurrencesOf(seriesId);
      if (!occurrence) throw new Error('nothing materialized');

      const { PointsService } = await import('../chores/points.service.js');
      const service = new PointsService(h.db);
      const booking = {
        occurrenceId: occurrence.id,
        completedById: teen.id,
        assigneeId: teen.id,
        points: 8,
        dueAt: occurrence.dueAt,
        graceMinutes: 30,
        completedAt: new Date(occurrence.dueAt.getTime() - 60_000),
      };

      await Promise.all(Array.from({ length: 4 }, () => service.bookCompletion(h.db, booking)));

      const ledger = await ledgerFor(teen.id);
      const byReason = new Map<string, number>();
      for (const row of ledger) byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + 1);
      for (const [, count] of byReason) expect(count).toBe(1);
      expect(byReason.get('chore_completed')).toBe(1);
    });

    it('withholds the on-time bonus for a completion past the grace window', async () => {
      const dueAt = new Date('2026-09-01T07:00:00Z');
      // 30 minutes of grace, completed two hours late.
      await bookTwice(10, dueAt, new Date(dueAt.getTime() + 2 * 60 * 60_000));

      const ledger = await ledgerFor(teen.id);
      expect(ledger.filter((e) => e.reason === 'chore_completed')).toHaveLength(1);
      expect(ledger.filter((e) => e.reason === 'on_time_bonus')).toHaveLength(0);
    });
  });

  /** KNOWN FAILURE — blocked by the `nowExpr` bug documented below. */
  it('books points once when the same occurrence is completed twice', async () => {
    const seriesId = await createSeries(adult, { points: 10, defaultAssigneeId: teen.id });
    const [first] = await occurrencesOf(seriesId);
    if (!first) throw new Error('nothing materialized');

    const complete = () =>
      request(h.app, {
        method: 'POST',
        url: `/api/tasks/occurrences/${first.id}/complete`,
        token: teen.accessToken,
        payload: {},
      });

    const one = await complete();
    expectStatus(one, 200);

    // The client's intent is already satisfied; a replay is not an error and
    // emphatically not a second award.
    const two = await complete();
    expect(two.statusCode).toBeLessThan(400);

    const [row] = await h.db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.id, first.id));
    expect(row?.status).toBe('done');
    expect(row?.completedById).toBe(teen.id);

    const ledger = await ledgerFor(teen.id);
    const chore = ledger.filter((e) => e.reason === 'chore_completed');
    expect(chore).toHaveLength(1);
    expect(chore[0]?.delta).toBe(10);
  });

  it('books points once when two clients complete the same occurrence at the same instant', async () => {
    const seriesId = await createSeries(adult, { points: 7, defaultAssigneeId: teen.id });
    const [first] = await occurrencesOf(seriesId);
    if (!first) throw new Error('nothing materialized');

    // The partial unique index on `(occurrence_id, user_id) WHERE reason =
    // 'chore_completed'` is the last line of defence. Only a real database can
    // be asked whether it holds.
    await Promise.all(
      Array.from({ length: 3 }, () =>
        request(h.app, {
          method: 'POST',
          url: `/api/tasks/occurrences/${first.id}/complete`,
          token: teen.accessToken,
          payload: {},
        }),
      ),
    );

    const chore = (await ledgerFor(teen.id)).filter((e) => e.reason === 'chore_completed');
    expect(chore).toHaveLength(1);
  });

  /* ====================================================================== */
  /* 3. edit this-and-future preserves completed history                    */
  /* ====================================================================== */

  it('splits the series on this_and_future and leaves completed history intact', async () => {
    const seriesId = await createSeries(adult, { title: 'Мыть посуду', points: 10 });
    const rows = await occurrencesOf(seriesId);
    expect(rows).toHaveLength(5);

    const [day1, day2, day3] = rows;
    if (!day1 || !day2 || !day3) throw new Error('expected five occurrences');

    // History: the first two are already done.
    for (const occurrence of [day1, day2]) {
      const response = await request(h.app, {
        method: 'POST',
        url: `/api/tasks/occurrences/${occurrence.id}/complete`,
        token: adult.accessToken,
        payload: {},
      });
      expectStatus(response, 200);
    }

    // "From Wednesday on, it is called something else and is worth more."
    const split = await request(h.app, {
      method: 'PATCH',
      url: `/api/tasks/series/${seriesId}`,
      token: adult.accessToken,
      payload: {
        scope: 'this_and_future',
        occurrenceId: day3.id,
        title: 'Мыть посуду и убрать со стола',
        points: 20,
      },
    });
    expectStatus(split, 200);
    const successorId = (split.json() as { id: string }).id;
    expect(successorId).not.toBe(seriesId);

    // The successor points back at the closed original, so history stays
    // walkable rather than orphaned.
    const [successor] = await h.db
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.id, successorId));
    expect(successor?.supersedesSeriesId).toBe(seriesId);
    expect(successor?.title).toBe('Мыть посуду и убрать со стола');
    expect(successor?.points).toBe(20);

    // The completed rows are untouched: same ids, same status, same series.
    const oldRows = await occurrencesOf(seriesId);
    const survivingDone = oldRows.filter((r) => r.status === 'done');
    expect(survivingDone.map((r) => r.id).sort()).toEqual([day1.id, day2.id].sort());
    expect(survivingDone.every((r) => r.completedById === adult.id)).toBe(true);

    // The old series is closed at the split point — nothing scheduled survives
    // from day 3 onwards on the old rule.
    expect(oldRows.filter((r) => r.occurrenceKey >= day3.occurrenceKey)).toHaveLength(0);

    // And the successor covers the rest of the window.
    const newRows = await occurrencesOf(successorId);
    expect(newRows.length).toBeGreaterThan(0);
    expect(newRows[0]?.occurrenceKey).toBe(day3.occurrenceKey);
    expect(newRows.every((r) => r.status === 'scheduled')).toBe(true);

    // The points already booked for the completed history are not rewritten by
    // the new series' point value.
    const ledger = (await ledgerFor(adult.id)).filter((e) => e.reason === 'chore_completed');
    expect(ledger).toHaveLength(2);
    expect(ledger.every((e) => e.delta === 10)).toBe(true);
  });

  /* ====================================================================== */
  /* 4. chore rotation fairness — deterministic and frozen                  */
  /* ====================================================================== */

  describe('chore rotation', () => {
    async function createRotation(
      strategy: 'round_robin' | 'weighted_balance',
      members: TestUser[],
    ): Promise<string> {
      const response = await request(h.app, {
        method: 'POST',
        url: '/api/chores/rotations',
        token: owner.accessToken,
        payload: {
          name: `Дежурство ${strategy}`,
          strategy,
          members: members.map((m, index) => ({
            userId: m.id,
            weight: '1.00',
            position: index,
          })),
        },
      });
      expect([200, 201]).toContain(response.statusCode);
      return (response.json() as { id: string }).id;
    }

    it('assigns deterministically and freezes the assignment across a second pass', async () => {
      const rotationId = await createRotation('round_robin', [adult, teen]);

      const seriesId = await createSeries(adult, {
        title: 'Дежурство по кухне',
        points: 5,
        rotationId,
      });

      const first = await occurrencesOf(seriesId);
      expect(first).toHaveLength(5);

      // Every occurrence has an owner, picked at materialization time and
      // recorded — never recomputed on read (D5).
      expect(first.every((r) => r.assigneeId !== null)).toBe(true);
      expect(first.every((r) => r.assignedVia === 'rotation')).toBe(true);

      // Round robin over two members alternates, and does not hand three in a
      // row to the same person.
      const assignees = first.map((r) => r.assigneeId);
      const distinct = new Set(assignees);
      expect(distinct.size).toBe(2);
      for (let i = 0; i + 1 < assignees.length; i += 1) {
        expect(assignees[i]).not.toBe(assignees[i + 1]);
      }

      // A second materializer pass must not reshuffle anybody. This is the
      // whole point of freezing the assignment: a chore that changes owner
      // overnight is a chore nobody trusts.
      const { TasksService } = await import('./tasks.service.js');
      const service = new TasksService(h.db);
      const [series] = await h.db.select().from(taskSeries).where(eq(taskSeries.id, seriesId));
      if (!series) throw new Error('series vanished');
      await service.materialize(h.db, series, new Date('2026-08-19T12:00:00Z'));

      const second = await occurrencesOf(seriesId);
      expect(second.map((r) => ({ key: r.occurrenceKey, who: r.assigneeId }))).toEqual(
        first.map((r) => ({ key: r.occurrenceKey, who: r.assigneeId })),
      );
    });

    it('evens the load out by weight rather than by turn', async () => {
      const rotationId = await createRotation('weighted_balance', [adult, teen]);
      const seriesId = await createSeries(adult, {
        title: 'Вынести мусор',
        points: 10,
        rotationId,
        recurrence: {
          mode: 'preset',
          preset: { kind: 'daily', interval: 1 },
          ends: { type: 'after', count: 6 },
          dtstartLocal: '2026-09-01T20:00:00',
          timezone: 'Europe/Moscow',
          rdatesLocal: [],
          exdatesLocal: [],
        },
      });

      const rows = await occurrencesOf(seriesId);
      expect(rows).toHaveLength(6);

      const perUser = new Map<string, number>();
      for (const row of rows) {
        if (!row.assigneeId) continue;
        perUser.set(row.assigneeId, (perUser.get(row.assigneeId) ?? 0) + 1);
      }
      // Equal weights, six occurrences: three each. A run that folded its own
      // picks back into `committed` produces this; one that did not would hand
      // all six to whoever started with the lowest debt.
      expect([...perUser.values()].sort()).toEqual([3, 3]);
    });

    it('leaves a rotation with nobody eligible claimable rather than guessing', async () => {
      const rotationId = await createRotation('round_robin', []);
      const seriesId = await createSeries(adult, {
        title: 'Ничей',
        points: 1,
        rotationId,
      });

      const rows = await occurrencesOf(seriesId);
      expect(rows.length).toBeGreaterThan(0);
      // Not silently handed to the default assignee: an unassigned chore is
      // claimable, which is honest, and a wrongly-assigned one is not.
      expect(rows.every((r) => r.assigneeId === null)).toBe(true);
      expect(rows.every((r) => r.assignedVia === null)).toBe(true);
    });
  });

  /* ====================================================================== */
  /* broken reads — KNOWN FAILURES, do not relax                            */
  /* ====================================================================== */

  /**
   * `tasks.repository.ts:136`
   *
   *   const nowExpr = (now) => now === undefined ? sql`now()` : sql`${now}::timestamptz`
   *
   * interpolates a JavaScript `Date` into a raw drizzle `sql` template.
   * `drizzle-orm/postgres-js/driver.js` replaces postgres.js's serializers for
   * the timestamp OIDs with an identity function, so the `Date` reaches the
   * wire encoder unconverted and the query throws `ERR_INVALID_ARG_TYPE`.
   *
   * `nowExpr` sits inside the projection (`isOverdue`), not just in a filter, so
   * it fires on **every** occurrence read. Every caller passes `this.now()`, so
   * the `sql\`now()\`` branch is dead in production. Net effect: the entire task
   * read surface is a 500.
   */
  describe('occurrence reads', () => {
    it('serves GET /tasks/occurrences', async () => {
      const seriesId = await createSeries(adult);
      const response = await request(h.app, {
        method: 'GET',
        url: `/api/tasks/occurrences?seriesId=${seriesId}&limit=50`,
        token: adult.accessToken,
      });
      expectStatus(response, 200);
      expect((response.json() as { items: unknown[] }).items).toHaveLength(5);
    });

    it('serves GET /tasks/today', async () => {
      await createSeries(adult);
      const response = await request(h.app, {
        method: 'GET',
        url: '/api/tasks/today',
        token: adult.accessToken,
      });
      expectStatus(response, 200);
    });

    it('serves GET /tasks/calendar', async () => {
      await createSeries(adult);
      const response = await request(h.app, {
        method: 'GET',
        url: '/api/tasks/calendar?from=2026-09-01&to=2026-09-30',
        token: adult.accessToken,
      });
      expectStatus(response, 200);
      expect((response.json() as { items: unknown[] }).items).toHaveLength(5);
    });

    it('derives isOverdue from the clock and the grace window', async () => {
      // Anchored in the past so the first occurrence is unambiguously overdue.
      const seriesId = await createSeries(adult, {
        graceMinutes: 30,
        recurrence: {
          mode: 'once',
          dtstartLocal: '2020-01-01T09:00:00',
          timezone: 'Europe/Moscow',
          rdatesLocal: [],
          exdatesLocal: [],
        },
      });
      const [row] = await occurrencesOf(seriesId);
      if (!row) throw new Error('nothing materialized');

      const response = await request(h.app, {
        method: 'GET',
        url: `/api/tasks/occurrences/${row.id}`,
        token: adult.accessToken,
      });
      expectStatus(response, 200);
      expect((response.json() as { isOverdue: boolean }).isOverdue).toBe(true);
    });
  });

  /**
   * `chores.repository.ts:430/439` (`loadRotationRoster`) and `:559-587`
   * (`loadFairnessRows`) have the same defect. The roster query is on the
   * critical path of *creating* a rotated series, so the failure is a write
   * failure, not just a read one.
   */
  describe('rotation and fairness reads', () => {
    it('serves GET /chores/fairness', async () => {
      const response = await request(h.app, {
        method: 'GET',
        url: '/api/chores/fairness',
        token: owner.accessToken,
      });
      expectStatus(response, 200);
    });

    it('serves GET /chores/rotations/:id/preview', async () => {
      const create = await request(h.app, {
        method: 'POST',
        url: '/api/chores/rotations',
        token: owner.accessToken,
        payload: {
          name: 'Предпросмотр',
          strategy: 'round_robin',
          members: [{ userId: adult.id, weight: '1.00', position: 0 }],
        },
      });
      expect([200, 201]).toContain(create.statusCode);
      const rotationId = (create.json() as { id: string }).id;

      const response = await request(h.app, {
        method: 'GET',
        url: `/api/chores/rotations/${rotationId}/preview`,
        token: owner.accessToken,
      });
      expectStatus(response, 200);
    });
  });
});
