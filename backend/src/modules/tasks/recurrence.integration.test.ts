import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
 * second pass a no-op, that a completion lands exactly once however often it is
 * replayed, and that a `this_and_future` split leaves the completed history
 * alone.
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
    return response.json<{ id: string }>().id;
  }

  async function occurrencesOf(seriesId: string) {
    return h.db
      .select()
      .from(taskOccurrences)
      .where(eq(taskOccurrences.seriesId, seriesId))
      .orderBy(asc(taskOccurrences.occurrenceKey));
  }

  /**
   * How many chores this person has actually done — the only fairness input
   * there is (D5). It used to be a `SUM(points_ledger.delta)`; it is a row
   * count now, and an occurrence can only be `done` once, which is why the
   * replay tests below no longer need a unique index to lean on.
   */
  async function doneCountFor(userId: string): Promise<number> {
    const rows = await h.db
      .select({ id: taskOccurrences.id })
      .from(taskOccurrences)
      .where(eq(taskOccurrences.completedById, userId));
    return rows.length;
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
  /* 2. completion lands exactly once                                       */
  /* ====================================================================== */

  /** KNOWN FAILURE — blocked by the `nowExpr` bug documented below. */
  it('counts the chore once when the same occurrence is completed twice', async () => {
    const seriesId = await createSeries(adult, { defaultAssigneeId: teen.id });
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
    // emphatically not a second completion.
    const two = await complete();
    expect(two.statusCode).toBeLessThan(400);

    const [row] = await h.db.select().from(taskOccurrences).where(eq(taskOccurrences.id, first.id));
    expect(row?.status).toBe('done');
    expect(row?.completedById).toBe(teen.id);

    // One row done, so the rotation counts one chore. There is no second place
    // for a replay to land any more.
    expect(await doneCountFor(teen.id)).toBe(1);
  });

  it('counts the chore once when two clients complete the same occurrence at once', async () => {
    const seriesId = await createSeries(adult, { defaultAssigneeId: teen.id });
    const [first] = await occurrencesOf(seriesId);
    if (!first) throw new Error('nothing materialized');

    // The conditional `WHERE status = 'scheduled'` UPDATE is the whole defence
    // now. Only a real database can be asked whether it holds under a race.
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

    expect(await doneCountFor(teen.id)).toBe(1);
  });

  /* ====================================================================== */
  /* 3. edit this-and-future preserves completed history                    */
  /* ====================================================================== */

  it('splits the series on this_and_future and leaves completed history intact', async () => {
    const seriesId = await createSeries(adult, { title: 'Мыть посуду' });
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
      },
    });
    expectStatus(split, 200);
    const successorId = split.json<{ id: string }>().id;
    expect(successorId).not.toBe(seriesId);

    // The successor points back at the closed original, so history stays
    // walkable rather than orphaned.
    const [successor] = await h.db.select().from(taskSeries).where(eq(taskSeries.id, successorId));
    expect(successor?.supersedesSeriesId).toBe(seriesId);
    expect(successor?.title).toBe('Мыть посуду и убрать со стола');

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

    // The completed history still counts for the person who did it — the split
    // rewrote the rule, not the record of what happened.
    expect(await doneCountFor(adult.id)).toBe(2);
  });

  /* ====================================================================== */
  /* 4. an edit keeps the occurrences it did not change                     */
  /* ====================================================================== */

  /**
   * The occurrence id is a URL (`/tasks/:occurrenceId`), a comment thread, a
   * pending swap and a notification dedupe key. Regenerating a row that the
   * edit did not actually move throws all four away — the visible symptom was
   * «Дело сохранено» followed immediately by «Задача не найдена», because the
   * detail page refetched the id it was standing on.
   */
  describe('edit-all identity', () => {
    it('keeps every occurrence id when the form resends an unchanged deadline', async () => {
      const seriesId = await createSeries(adult, { defaultAssigneeId: teen.id });
      const before = await occurrencesOf(seriesId);
      expect(before).toHaveLength(5);

      // What the edit sheet actually sends: the whole field set, changed or
      // not. Only `title` differs from what was loaded.
      const response = await request(h.app, {
        method: 'PATCH',
        url: `/api/tasks/series/${seriesId}`,
        token: adult.accessToken,
        payload: {
          scope: 'all',
          title: 'Мыть посуду и вытирать',
          notes: null,
          visibility: 'household',
          dueOffsetMinutes: 60,
          graceMinutes: 30,
          rotationId: null,
          defaultAssigneeId: teen.id,
          category: null,
          autoCancelAfterDays: null,
          reminderOffsets: [],
        },
      });
      expectStatus(response, 200);

      const after = await occurrencesOf(seriesId);
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
      expect(after.map((r) => r.assigneeId)).toEqual(before.map((r) => r.assigneeId));
    });

    it('still serves the occurrence the user was looking at after the save', async () => {
      const seriesId = await createSeries(adult);
      const [first] = await occurrencesOf(seriesId);
      if (!first) throw new Error('nothing materialized');

      const save = await request(h.app, {
        method: 'PATCH',
        url: `/api/tasks/series/${seriesId}`,
        token: adult.accessToken,
        payload: { scope: 'all', title: 'Мыть посуду быстро', dueOffsetMinutes: 60 },
      });
      expectStatus(save, 200);

      // The refetch the detail page fires on invalidation.
      const refetch = await request(h.app, {
        method: 'GET',
        url: `/api/tasks/occurrences/${first.id}`,
        token: adult.accessToken,
      });
      expectStatus(refetch, 200);
      expect(refetch.json<{ title: string }>().title).toBe('Мыть посуду быстро');
    });

    it('moves the deadline in place rather than regenerating the rows', async () => {
      const seriesId = await createSeries(adult);
      const before = await occurrencesOf(seriesId);

      const response = await request(h.app, {
        method: 'PATCH',
        url: `/api/tasks/series/${seriesId}`,
        token: adult.accessToken,
        // 09:00 + 60min was the deadline; make it 09:00 + 180min.
        payload: { scope: 'all', dueOffsetMinutes: 180 },
      });
      expectStatus(response, 200);

      const after = await occurrencesOf(seriesId);
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
      // Wall-clock arithmetic on the local start, as at materialization (D2).
      for (const row of after) {
        expect(row.dueAt.getTime() - row.startsAt.getTime()).toBe(180 * 60_000);
      }
    });

    it('does not cancel a pending swap when the chore is merely renamed', async () => {
      const seriesId = await createSeries(adult, { defaultAssigneeId: teen.id });
      const [first] = await occurrencesOf(seriesId);
      if (!first) throw new Error('nothing materialized');

      // «Подмени меня» — an offer the other person has already been told about.
      const offer = await request(h.app, {
        method: 'POST',
        url: '/api/chores/swaps',
        token: teen.accessToken,
        payload: { occurrenceId: first.id, toUserId: adult.id },
      });
      expect([200, 201]).toContain(offer.statusCode);

      await request(h.app, {
        method: 'PATCH',
        url: `/api/tasks/series/${seriesId}`,
        token: adult.accessToken,
        payload: { scope: 'all', title: 'Мыть посуду до блеска', dueOffsetMinutes: 60 },
      });

      // `chore_swaps.occurrence_id` is ON DELETE CASCADE, so regenerating the
      // occurrence deletes the offer outright — silently, and after the person
      // it was addressed to has already been notified.
      const inbox = await request(h.app, {
        method: 'GET',
        url: '/api/chores/swaps?direction=incoming',
        token: adult.accessToken,
      });
      expectStatus(inbox, 200);
      const pending = inbox
        .json<{ items: Array<{ occurrenceId: string; status: string }> }>()
        .items.filter((item) => item.status === 'pending');
      expect(pending.map((item) => item.occurrenceId)).toEqual([first.id]);
    });

    it('reassigns the occurrences already on the board when «кто» changes', async () => {
      const seriesId = await createSeries(adult, { defaultAssigneeId: teen.id });
      const before = await occurrencesOf(seriesId);
      expect(before.every((r) => r.assigneeId === teen.id)).toBe(true);

      const response = await request(h.app, {
        method: 'PATCH',
        url: `/api/tasks/series/${seriesId}`,
        token: adult.accessToken,
        payload: { scope: 'all', defaultAssigneeId: adult.id },
      });
      expectStatus(response, 200);

      // Frozen means "never recomputed on read" (D5), not "unreachable by an
      // edit": a change of who does it that only takes effect in ninety days
      // has not taken effect.
      const after = await occurrencesOf(seriesId);
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
      expect(after.every((r) => r.assigneeId === adult.id)).toBe(true);
    });

    it('keeps the hand-picked assignee of an exception when «кто» changes', async () => {
      const seriesId = await createSeries(adult, { defaultAssigneeId: teen.id });
      const [first] = await occurrencesOf(seriesId);
      if (!first) throw new Error('nothing materialized');

      // A hand-made decision: «сегодня сделаю я».
      const byHand = await request(h.app, {
        method: 'POST',
        url: `/api/tasks/occurrences/${first.id}/assign`,
        token: owner.accessToken,
        payload: { assigneeId: owner.id },
      });
      expectStatus(byHand, 200);

      await request(h.app, {
        method: 'PATCH',
        url: `/api/tasks/series/${seriesId}`,
        token: adult.accessToken,
        payload: { scope: 'all', defaultAssigneeId: adult.id },
      });

      const after = await occurrencesOf(seriesId);
      // The rule reassigns the rows the rule owns. It does not take a chore
      // back off somebody who volunteered for it.
      expect(after.find((r) => r.id === first.id)?.assigneeId).toBe(owner.id);
      expect(after.filter((r) => r.id !== first.id).every((r) => r.assigneeId === adult.id)).toBe(
        true,
      );
    });

    it('keeps the dates a new rule still produces and drops only the rest', async () => {
      const seriesId = await createSeries(adult);
      const before = await occurrencesOf(seriesId);
      const keptKey = '2026-09-03T09:00:00';
      const kept = before.find((r) => r.occurrenceKey === keptKey);
      if (!kept) throw new Error('expected 2026-09-03 in the daily series');

      // Daily → every other day from the same anchor: the 1st, 3rd and 5th
      // survive as dates, the 2nd and 4th genuinely stop existing.
      const response = await request(h.app, {
        method: 'PATCH',
        url: `/api/tasks/series/${seriesId}`,
        token: adult.accessToken,
        payload: {
          scope: 'all',
          recurrence: {
            mode: 'preset',
            preset: { kind: 'daily', interval: 2 },
            ends: { type: 'after', count: 3 },
            dtstartLocal: '2026-09-01T09:00:00',
            timezone: 'Europe/Moscow',
            rdatesLocal: [],
            exdatesLocal: [],
          },
        },
      });
      expectStatus(response, 200);

      const after = await occurrencesOf(seriesId);
      expect(after.map((r) => r.occurrenceKey)).toEqual([
        '2026-09-01T09:00:00',
        '2026-09-03T09:00:00',
        '2026-09-05T09:00:00',
      ]);
      // The surviving date is the *same row*, not a new one wearing its date.
      expect(after.find((r) => r.occurrenceKey === keptKey)?.id).toBe(kept.id);
    });
  });

  /**
   * The split is the one edit that legitimately retires the row the user is
   * standing on: `this_and_future` closes the old series and opens a successor,
   * so the anchor's id *is* gone by design. What must not be gone is the
   * anchor's **date** — the successor owns it now, and the response names the
   * successor, which is what lets the detail page follow instead of 404.
   */
  it('hands the anchor date to the successor the split response names', async () => {
    const seriesId = await createSeries(adult);
    const rows = await occurrencesOf(seriesId);
    const anchor = rows[2];
    if (!anchor) throw new Error('expected five occurrences');

    const split = await request(h.app, {
      method: 'PATCH',
      url: `/api/tasks/series/${seriesId}`,
      token: adult.accessToken,
      payload: {
        scope: 'this_and_future',
        occurrenceId: anchor.id,
        title: 'Мыть посуду и убрать со стола',
      },
    });
    expectStatus(split, 200);
    const successorId = split.json<{ id: string }>().id;

    const sameDate = await request(h.app, {
      method: 'GET',
      url: `/api/tasks/occurrences?seriesId=${successorId}&from=${anchor.localDate}&to=${anchor.localDate}`,
      token: adult.accessToken,
    });
    expectStatus(sameDate, 200);
    const items = sameDate.json<{ items: Array<{ id: string; title: string }> }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).not.toBe(anchor.id);
    expect(items[0]?.title).toBe('Мыть посуду и убрать со стола');
  });

  /* ====================================================================== */
  /* 5. chore rotation fairness — deterministic and frozen                  */
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
      return response.json<{ id: string }>().id;
    }

    it('assigns deterministically and freezes the assignment across a second pass', async () => {
      const rotationId = await createRotation('round_robin', [adult, teen]);

      const seriesId = await createSeries(adult, {
        title: 'Дежурство по кухне',
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
      expect(response.json<{ items: unknown[] }>().items).toHaveLength(5);
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
      expect(response.json<{ items: unknown[] }>().items).toHaveLength(5);
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
      expect(response.json<{ isOverdue: boolean }>().isOverdue).toBe(true);
    });
  });

  /**
   * `loadRotationRoster` is raw SQL, and it is on the critical path of
   * *creating* a rotated series — so a defect in it is a write failure, not
   * just a read one. The preview endpoint is the only thing that runs it
   * outside materialization, which makes it the cheapest way to exercise it.
   */
  describe('rotation reads', () => {
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
      const rotationId = create.json<{ id: string }>().id;

      const response = await request(h.app, {
        method: 'GET',
        url: `/api/chores/rotations/${rotationId}/preview`,
        token: owner.accessToken,
      });
      expectStatus(response, 200);
    });
  });
});
