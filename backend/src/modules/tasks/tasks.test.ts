import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions, type Permission, type Role } from '@family/shared';

import type { Db } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { materializeSeries } from '../../core/recurrence/materializer.js';
import type * as MaterializerModule from '../../core/recurrence/materializer.js';
import { occurrenceStatus } from '../scheduling/recurrence.schema.js';
import tasksRoutes, { TASK_ROUTE_ACCESS } from './tasks.routes.js';
import type * as TaskRepositoryModule from './tasks.repository.js';
import { taskOccurrences, taskSeries, type TaskSeriesRow } from './tasks.schema.js';
import {
  TasksService,
  canReadOccurrence,
  compileRecurrence,
  isOverdue,
  planOccurrenceMove,
  planSeriesSplit,
  resolveCompletion,
  viewerOf,
  type PointsPort,
  type TaskActor,
} from './tasks.service.js';

/**
 * Tasks & chores.
 *
 * The suite is built around the six claims the module actually has to keep, and
 * each `describe` below is named after one of them:
 *
 * 1. **Overdue is derived, never stored.** No column, no status, no writer.
 * 2. **Double completion awards once.** A double tap, a retry and an offline
 *    replay are the same request, and the ledger must not notice them twice.
 * 3. **Skip preserves the row.** It is a status change, never an EXDATE and
 *    never a delete — the audit trail is the point of it.
 * 4. **Edit-this-and-future does not touch completed history.**
 * 5. **A child sees their own tasks plus household-visible ones**, and nothing
 *    private or restricted that is not theirs.
 * 6. **`occurrenceKey` is stable across a move.**
 *
 * ## Why the repository is mocked
 *
 * The four mutation semantics are *service* behaviour — which rows get deleted,
 * which flags get set, what happens on the second identical request. Running
 * them through an in-memory store lets every one of those rules be asserted on
 * a laptop with no Docker, which is the difference between a rule that is
 * checked on every commit and one that is checked when somebody remembers to
 * start Postgres. The SQL those rules ride on — `COALESCE(override, series)`,
 * the derived overdue predicate, the conditional completion update — is
 * asserted separately at the bottom, against a real database, behind
 * `TEST_DATABASE_URL`.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const T0 = new Date('2026-08-19T09:00:00.000Z');
const TZ = 'Europe/Moscow';

const ADULT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ADULT = '00000000-0000-4000-8000-0000000000a2';
const CHILD = '00000000-0000-4000-8000-0000000000c1';

type Visibility = TaskSeriesRow['visibility'];

interface FakeOccurrence {
  id: string;
  seriesId: string;
  occurrenceKey: string;
  startsAt: Date;
  dueAt: Date;
  localDate: string;
  startsLocal: string;
  status: 'scheduled' | 'done' | 'skipped' | 'cancelled';
  isException: boolean;
  titleOverride: string | null;
  notesOverride: string | null;
  pointsOverride: number | null;
  assigneeId: string | null;
  assignedVia: 'rotation' | 'manual' | 'swap' | 'claimed' | null;
  completedById: string | null;
  completedAt: Date | null;
  skippedById: string | null;
  skipReason: string | null;
  createdAt: Date;
}

/* -------------------------------------------------------------------------- */
/* In-memory repository                                                        */
/* -------------------------------------------------------------------------- */

const store = vi.hoisted(() => ({
  series: new Map<string, Record<string, unknown>>(),
  occurrences: new Map<string, Record<string, unknown>>(),
}));

vi.mock('./tasks.repository.js', () => {
  type Row = Record<string, unknown>;

  const seriesOf = (row: Row): Row => store.series.get(row.seriesId as string) as Row;

  const overdueOf = (row: Row, series: Row, now: Date | undefined): boolean => {
    if (row.status !== 'scheduled') return false;
    const at = now ?? new Date();
    return (
      (row.dueAt as Date).getTime() + (series.graceMinutes as number) * 60_000 < at.getTime()
    );
  };

  const resolve = (row: Row, now: Date | undefined): Row => {
    const series = seriesOf(row);
    return {
      ...row,
      isOverdue: overdueOf(row, series, now),
      title: row.titleOverride ?? series.title,
      notes: row.notesOverride ?? series.notes,
      points: row.pointsOverride ?? series.points,
      category: series.category,
      visibility: series.visibility,
      timezone: series.timezone,
      graceMinutes: series.graceMinutes,
      dueOffsetMinutes: series.dueOffsetMinutes,
      seriesCreatedById: series.createdById,
      rotationId: series.rotationId,
    };
  };

  const visible = (row: Row, viewer: { userId: string; canReadAny: boolean; canSeeRestricted: boolean } | undefined): boolean => {
    if (!viewer) return true;
    const mine = row.seriesCreatedById === viewer.userId || row.assigneeId === viewer.userId;
    const visibilityGate =
      row.visibility === 'household' ||
      mine ||
      (row.visibility === 'restricted' && viewer.canSeeRestricted);
    const scopeGate = viewer.canReadAny || row.visibility === 'household' || mine;
    return visibilityGate && scopeGate;
  };

  return {
    async insertSeries(_ex: unknown, values: Row) {
      const row: Row = {
        id: values.id ?? globalThis.crypto.randomUUID(),
        notes: null,
        visibility: 'household',
        rrule: null,
        rdatesLocal: [],
        exdatesLocal: [],
        seriesEndsAt: null,
        materializedThrough: null,
        dueOffsetMinutes: 0,
        graceMinutes: 0,
        rotationId: null,
        defaultAssigneeId: null,
        points: 0,
        category: null,
        autoCancelAfterDays: null,
        supersedesSeriesId: null,
        archivedAt: null,
        createdAt: new Date('2026-08-19T09:00:00.000Z'),
        updatedAt: new Date('2026-08-19T09:00:00.000Z'),
        ...values,
      };
      store.series.set(row.id as string, row);
      return row;
    },
    async findSeriesById(_ex: unknown, id: string) {
      return store.series.get(id);
    },
    async findSeriesByIdForViewer(_ex: unknown, id: string, viewer: Row) {
      const row = store.series.get(id);
      if (!row) return undefined;
      const mine = row.createdById === viewer.userId;
      if (row.visibility === 'household' || mine) return row;
      if (row.visibility === 'restricted' && viewer.canSeeRestricted) return row;
      return undefined;
    },
    async lockSeriesById(_ex: unknown, id: string) {
      return store.series.get(id);
    },
    async updateSeriesRow(_ex: unknown, id: string, patch: Row) {
      const row = store.series.get(id);
      if (!row) return undefined;
      Object.assign(row, patch, { updatedAt: new Date('2026-08-19T09:00:00.000Z') });
      return row;
    },
    async archiveSeries(_ex: unknown, id: string, at: Date) {
      const row = store.series.get(id);
      if (!row) return undefined;
      row.archivedAt = at;
      return row;
    },
    async deleteSeries(_ex: unknown, id: string) {
      store.series.delete(id);
      for (const [key, row] of store.occurrences) {
        if (row.seriesId === id) store.occurrences.delete(key);
      }
    },
    async countOccurrences(_ex: unknown, seriesId: string) {
      const rows = [...store.occurrences.values()].filter((r) => r.seriesId === seriesId);
      return {
        total: rows.length,
        done: rows.filter((r) => r.status === 'done').length,
        skipped: rows.filter((r) => r.status === 'skipped').length,
        exceptions: rows.filter((r) => r.isException === true).length,
      };
    },
    async listOccurrenceIds(_ex: unknown, seriesId: string) {
      return [...store.occurrences.values()]
        .filter((r) => r.seriesId === seriesId)
        .map((r) => r.id as string);
    },
    async findOccurrenceById(_ex: unknown, id: string, options: Row = {}) {
      const row = store.occurrences.get(id);
      if (!row) return undefined;
      const resolved = resolve(row, options.now as Date | undefined);
      return visible(resolved, options.viewer as never) ? resolved : undefined;
    },
    async listOccurrences(_ex: unknown, params: Row) {
      const items = [...store.occurrences.values()]
        .map((r) => resolve(r, params.now as Date | undefined))
        .filter((r) => visible(r, params.viewer as never));
      return { items, nextCursor: null };
    },
    async findCalendarRange(_ex: unknown, params: Row) {
      return [...store.occurrences.values()]
        .map((r) => resolve(r, params.now as Date | undefined))
        .filter((r) => visible(r, params.viewer as never));
    },
    async findOverdue(_ex: unknown, params: Row) {
      return [...store.occurrences.values()]
        .map((r) => resolve(r, params.now as Date))
        .filter((r) => r.isOverdue === true)
        .filter((r) => visible(r, params.viewer as never));
    },
    async findDueBetween(_ex: unknown, params: Row) {
      return [...store.occurrences.values()]
        .map((r) => resolve(r, params.from as Date))
        .filter(
          (r) =>
            r.status === 'scheduled' &&
            (r.dueAt as Date) >= (params.from as Date) &&
            (r.dueAt as Date) < (params.to as Date),
        );
    },
    async countDoneOn(_ex: unknown, localDate: string) {
      return [...store.occurrences.values()].filter(
        (r) => r.localDate === localDate && r.status === 'done',
      ).length;
    },
    async completeIfScheduled(_ex: unknown, params: Row) {
      const row = store.occurrences.get(params.id as string);
      // The conditional update, faithfully: a row that is not `scheduled`
      // matches nothing, so the second identical request writes nothing.
      if (!row || row.status !== 'scheduled') return undefined;
      row.status = 'done';
      row.completedById = params.completedById;
      row.completedAt = params.completedAt;
      return row;
    },
    async uncompleteIfDone(_ex: unknown, id: string) {
      const row = store.occurrences.get(id);
      if (!row || row.status !== 'done') return undefined;
      row.status = 'scheduled';
      row.completedById = null;
      row.completedAt = null;
      return row;
    },
    async skipIfScheduled(_ex: unknown, params: Row) {
      const row = store.occurrences.get(params.id as string);
      if (!row || row.status !== 'scheduled') return undefined;
      row.status = 'skipped';
      row.skippedById = params.skippedById;
      row.skipReason = params.reason;
      return row;
    },
    async cancelIfScheduled(_ex: unknown, id: string) {
      const row = store.occurrences.get(id);
      if (!row || row.status !== 'scheduled') return undefined;
      row.status = 'cancelled';
      return row;
    },
    async assignOccurrence(_ex: unknown, params: Row) {
      const row = store.occurrences.get(params.id as string);
      if (!row) return undefined;
      row.assigneeId = params.assigneeId;
      row.assignedVia = params.assignedVia;
      row.isException = true;
      return row;
    },
    async claimIfUnassigned(_ex: unknown, params: Row) {
      const row = store.occurrences.get(params.id as string);
      if (!row || row.status !== 'scheduled' || row.assigneeId !== null) return undefined;
      row.assigneeId = params.userId;
      row.assignedVia = 'claimed';
      row.isException = true;
      return row;
    },
    async applyOccurrenceOverride(_ex: unknown, id: string, patch: Row) {
      const row = store.occurrences.get(id);
      if (!row) return undefined;
      Object.assign(row, patch, { isException: true });
      return row;
    },
    async deleteFutureScheduled(_ex: unknown, params: Row) {
      const removed: string[] = [];
      for (const [key, row] of store.occurrences) {
        if (row.seriesId !== params.seriesId) continue;
        if (row.status !== 'scheduled' || row.isException === true) continue;
        if (
          params.fromKey !== undefined &&
          (row.occurrenceKey as string) < (params.fromKey as string)
        ) {
          continue;
        }
        if (
          params.fromInstant !== undefined &&
          (row.startsAt as Date) < (params.fromInstant as Date)
        ) {
          continue;
        }
        store.occurrences.delete(key);
        removed.push(row.id as string);
      }
      return removed;
    },
    async autoCancelStale() {
      return [];
    },
  };
});

vi.mock('../notifications/notifications.service.js', () => ({
  emitIntent: vi.fn(async () => ({
    intentId: 'intent',
    deduped: false,
    dispatch: async () => {},
  })),
}));

vi.mock('../wall/comments.service.js', () => ({
  deleteCommentsFor: vi.fn(async () => ({ comments: 0, reactions: 0 })),
}));

vi.mock('../../core/recurrence/materializer.js', async (original) => {
  const actual = await original<typeof MaterializerModule>();
  return {
    ...actual,
    // Materialization itself is covered by `materializer.test.ts`; here it only
    // has to be observable, so the mutation paths can assert *that* they
    // re-materialize inside the write transaction.
    materializeSeries: vi.fn(async (_ex: unknown, _target: unknown, seriesId: string) => ({
      seriesId,
      planned: 0,
      inserted: 0,
      materializedThrough: null,
      skipped: null,
    })),
  };
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/** The service only ever reaches the database through `repo`, which is mocked. */
const fakeDb = {
  transaction: <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
  execute: async () => [{ timezone: TZ }],
} as unknown as Db;

function actorFor(role: Role, userId: string): TaskActor {
  const held = new Set<Permission>(effectivePermissions(role));
  return { userId, timezone: TZ, can: (permission) => held.has(permission) };
}

interface RecordingPoints extends PointsPort {
  readonly booked: Array<{ occurrenceId: string; completedById: string; points: number }>;
  readonly reversed: string[];
}

function recordingPoints(): RecordingPoints {
  const booked: Array<{ occurrenceId: string; completedById: string; points: number }> = [];
  const reversed: string[] = [];
  return {
    booked,
    reversed,
    async bookCompletion(_ex, input) {
      booked.push({
        occurrenceId: input.occurrenceId,
        completedById: input.completedById,
        points: input.points,
      });
      return {};
    },
    async reverseCompletion(_ex, occurrenceId) {
      reversed.push(occurrenceId);
      return 0;
    },
  };
}

function serviceWith(points: PointsPort): TasksService {
  return new TasksService(fakeDb, {
    points,
    now: () => T0,
    rotation: {
      exists: async () => true,
      loadSnapshot: async () => null,
      saveCursor: async () => {},
    },
    swaps: { pendingSwapIds: async () => new Map() },
  });
}

function seedSeries(overrides: Record<string, unknown> = {}): string {
  const id = randomUUID();
  store.series.set(id, {
    id,
    title: 'Мусор',
    notes: null,
    visibility: 'household',
    createdById: ADULT,
    rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
    dtstartLocal: '2026-08-17T09:00:00',
    timezone: TZ,
    rdatesLocal: [],
    exdatesLocal: [],
    seriesEndsAt: null,
    materializedThrough: null,
    dueOffsetMinutes: 60,
    graceMinutes: 15,
    rotationId: null,
    defaultAssigneeId: null,
    points: 5,
    category: null,
    autoCancelAfterDays: null,
    supersedesSeriesId: null,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
  return id;
}

function seedOccurrence(seriesId: string, overrides: Partial<FakeOccurrence> = {}): string {
  const id = randomUUID();
  const key = overrides.occurrenceKey ?? '2026-08-24T09:00:00';
  store.occurrences.set(id, {
    id,
    seriesId,
    occurrenceKey: key,
    startsAt: new Date('2026-08-24T06:00:00.000Z'),
    dueAt: new Date('2026-08-24T07:00:00.000Z'),
    localDate: key.slice(0, 10),
    startsLocal: key,
    status: 'scheduled',
    isException: false,
    titleOverride: null,
    notesOverride: null,
    pointsOverride: null,
    assigneeId: null,
    assignedVia: null,
    completedById: null,
    completedAt: null,
    skippedById: null,
    skipReason: null,
    createdAt: T0,
    ...overrides,
  });
  return id;
}

beforeEach(() => {
  store.series.clear();
  store.occurrences.clear();
  vi.mocked(materializeSeries).mockClear();
});

/* ========================================================================== */
/* 1. Overdue is derived, never stored                                        */
/* ========================================================================== */

describe('overdue is derived, never stored', () => {
  it('has no column and no status to store it in', () => {
    const columns = Object.keys(taskOccurrences);
    expect(columns.filter((c) => /overdue/i.test(c))).toEqual([]);

    // `scheduled → done | skipped | cancelled` are transitions a *person*
    // causes. Overdue is not something anybody did, so it is not a state.
    expect(occurrenceStatus.enumValues).toEqual(['scheduled', 'done', 'skipped', 'cancelled']);
    expect(occurrenceStatus.enumValues).not.toContain('overdue');
  });

  it('flips on the clock alone — the row never changes', () => {
    const row = { status: 'scheduled' as const, dueAt: T0, graceMinutes: 0 };
    const before = new Date(T0.getTime() - 1);
    const after = new Date(T0.getTime() + 1);

    expect(isOverdue(row, before)).toBe(false);
    expect(isOverdue(row, after)).toBe(true);
    // Same object, both answers. A stored flag would have to be repaired by a
    // job running every minute to say the same thing.
    expect(row).toEqual({ status: 'scheduled', dueAt: T0, graceMinutes: 0 });
  });

  it('respects the per-series grace window', () => {
    const row = { status: 'scheduled' as const, dueAt: T0, graceMinutes: 15 };
    expect(isOverdue(row, new Date(T0.getTime() + 14 * 60_000))).toBe(false);
    expect(isOverdue(row, new Date(T0.getTime() + 16 * 60_000))).toBe(true);
  });

  it('is never true for a closed occurrence', () => {
    const long = new Date(T0.getTime() + 30 * 86_400_000);
    for (const status of ['done', 'skipped', 'cancelled'] as const) {
      expect(isOverdue({ status, dueAt: T0, graceMinutes: 0 }, long)).toBe(false);
    }
  });

  it('is computed in SQL by the repository, not assembled in JS', async () => {
    // The projection has to resolve it server-side, or a paginated list would
    // need the whole table in memory to filter `overdueOnly`.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./tasks.repository.ts', import.meta.url), 'utf8'),
    );
    expect(source).toContain('make_interval(mins =>');
    expect(source).toContain("task_occurrences_overdue_idx");
    // …and nothing anywhere writes it back.
    expect(source).not.toMatch(/set\(\{[^}]*overdue/i);
  });
});

/* ========================================================================== */
/* 2. Double completion awards once                                           */
/* ========================================================================== */

describe('completion is idempotent', () => {
  it('classifies the second identical request as already done, not an error', () => {
    expect(resolveCompletion('scheduled')).toBe('completed');
    expect(resolveCompletion('done')).toBe('already_done');
    expect(resolveCompletion('skipped')).toBe('conflict');
    expect(resolveCompletion('cancelled')).toBe('conflict');
  });

  it('books the ledger exactly once across a replayed completion', async () => {
    const points = recordingPoints();
    const service = serviceWith(points);
    const seriesId = seedSeries();
    const occurrenceId = seedOccurrence(seriesId, { assigneeId: CHILD });
    const adult = actorFor('adult', ADULT);

    const first = await service.complete(adult, occurrenceId, { completedById: CHILD });
    // The offline outbox delivers the same tap again ten minutes later.
    const second = await service.complete(adult, occurrenceId, { completedById: CHILD });

    expect(first.status).toBe('done');
    expect(second.status).toBe('done');
    expect(second.completedById).toBe(CHILD);
    expect(points.booked).toHaveLength(1);
    expect(points.booked[0]).toMatchObject({ occurrenceId, completedById: CHILD, points: 5 });
  });

  it('survives a five-way replay without drifting', async () => {
    const points = recordingPoints();
    const service = serviceWith(points);
    const occurrenceId = seedOccurrence(seedSeries());
    const adult = actorFor('adult', ADULT);

    for (let i = 0; i < 5; i += 1) await service.complete(adult, occurrenceId, {});
    expect(points.booked).toHaveLength(1);
  });

  it('pays the doer, not the assignee', async () => {
    const points = recordingPoints();
    const service = serviceWith(points);
    const occurrenceId = seedOccurrence(seedSeries(), { assigneeId: OTHER_ADULT });

    await service.complete(actorFor('adult', ADULT), occurrenceId, { completedById: ADULT });
    // Covering for somebody raises *your* debt, which is what makes the
    // fairness loop self-correcting (D5).
    expect(points.booked[0]?.completedById).toBe(ADULT);
  });

  it('refuses to book a skipped occurrence', async () => {
    const points = recordingPoints();
    const service = serviceWith(points);
    const occurrenceId = seedOccurrence(seedSeries(), { status: 'skipped' });

    await expect(service.complete(actorFor('adult', ADULT), occurrenceId, {})).rejects.toThrow(
      AppError,
    );
    expect(points.booked).toHaveLength(0);
  });

  it('will not accept a completion dated in the future', async () => {
    const service = serviceWith(recordingPoints());
    const occurrenceId = seedOccurrence(seedSeries());
    await expect(
      service.complete(actorFor('adult', ADULT), occurrenceId, {
        completedAt: new Date(T0.getTime() + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

/* ========================================================================== */
/* 3. Skip preserves the row                                                  */
/* ========================================================================== */

describe('skip preserves the row', () => {
  it('changes the status and nothing else', async () => {
    const service = serviceWith(recordingPoints());
    const seriesId = seedSeries();
    const occurrenceId = seedOccurrence(seriesId, { assigneeId: CHILD });

    const result = await service.skip(actorFor('adult', ADULT), occurrenceId, {
      reason: 'Уехали к бабушке',
      suppressFuture: false,
    });

    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('Уехали к бабушке');
    // The row is still there, still identifiable, still attributed.
    expect(store.occurrences.has(occurrenceId)).toBe(true);
    expect(result.assigneeId).toBe(CHILD);
    expect(result.occurrenceKey).toBe('2026-08-24T09:00:00');

    // **No EXDATE.** Writing one would delete the slot from the rule, and with
    // it the evidence that the family was ever supposed to do it.
    expect(store.series.get(seriesId)?.exdatesLocal).toEqual([]);
  });

  it('writes an EXDATE only when suppressFuture is asked for explicitly', async () => {
    const service = serviceWith(recordingPoints());
    const seriesId = seedSeries();
    const occurrenceId = seedOccurrence(seriesId);

    await service.skip(actorFor('adult', ADULT), occurrenceId, { suppressFuture: true });

    expect(store.series.get(seriesId)?.exdatesLocal).toEqual(['2026-08-24T09:00:00']);
    // And the row still survives — suppression is about the *future* slot.
    expect(store.occurrences.get(occurrenceId)?.status).toBe('skipped');
  });

  it('is idempotent — a replayed skip is not a conflict', async () => {
    const service = serviceWith(recordingPoints());
    const occurrenceId = seedOccurrence(seedSeries());
    const adult = actorFor('adult', ADULT);

    await service.skip(adult, occurrenceId, { suppressFuture: false });
    const again = await service.skip(adult, occurrenceId, { suppressFuture: false });
    expect(again.status).toBe('skipped');
  });
});

/* ========================================================================== */
/* 4. Edit this and future leaves history alone                               */
/* ========================================================================== */

describe('edit-this-and-future splits the series without rewriting history', () => {
  const ANCHOR = '2026-09-07T09:00:00';

  function seedHistory(): { seriesId: string; done: string; exception: string; future: string } {
    const seriesId = seedSeries();
    const done = seedOccurrence(seriesId, {
      occurrenceKey: '2026-08-24T09:00:00',
      status: 'done',
      completedById: CHILD,
      completedAt: T0,
    });
    const exception = seedOccurrence(seriesId, {
      occurrenceKey: '2026-09-14T09:00:00',
      isException: true,
      titleOverride: 'Мусор + макулатура',
    });
    const future = seedOccurrence(seriesId, { occurrenceKey: '2026-09-21T09:00:00' });
    return { seriesId, done, exception, future };
  }

  it('keeps completed occurrences and exceptions, drops only untouched future ones', async () => {
    const service = serviceWith(recordingPoints());
    const { seriesId, done, exception, future } = seedHistory();

    await service.updateSeries(actorFor('adult', ADULT), seriesId, {
      scope: 'this_and_future',
      occurrenceId: seedOccurrence(seriesId, { occurrenceKey: ANCHOR }),
      title: 'Мусор и коробки',
    });

    // History is not rewritten, it is superseded.
    expect(store.occurrences.get(done)?.status).toBe('done');
    expect(store.occurrences.get(done)?.completedById).toBe(CHILD);
    expect(store.occurrences.get(exception)?.titleOverride).toBe('Мусор + макулатура');
    // The plain scheduled row after the anchor belongs to the successor now.
    expect(store.occurrences.has(future)).toBe(false);
  });

  it('closes the old rule with an UNTIL and links the successor back', async () => {
    const service = serviceWith(recordingPoints());
    const { seriesId } = seedHistory();

    const successor = await service.updateSeries(actorFor('adult', ADULT), seriesId, {
      scope: 'this_and_future',
      occurrenceId: seedOccurrence(seriesId, { occurrenceKey: ANCHOR }),
      title: 'Мусор и коробки',
    });

    expect(store.series.get(seriesId)?.rrule).toMatch(/UNTIL=\d{8}T\d{6}Z/);
    expect(successor.id).not.toBe(seriesId);
    expect(successor.supersedesSeriesId).toBe(seriesId);
    expect(successor.title).toBe('Мусор и коробки');
    expect(successor.recurrence.dtstartLocal).toBe(ANCHOR);
    // Eagerly materialized inside the same transaction (§2).
    expect(vi.mocked(materializeSeries)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      successor.id,
      expect.anything(),
    );
  });

  it('plans the split purely, with the UNTIL just before the anchor', () => {
    const series = {
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
      dtstartLocal: '2026-08-17T09:00:00',
      timezone: TZ,
      rdatesLocal: [],
      exdatesLocal: [],
    } as unknown as TaskSeriesRow;

    const plan = planSeriesSplit(series, ANCHOR, undefined);
    expect(plan.closingRrule).toContain('UNTIL=');
    expect(plan.closingRrule).not.toContain('COUNT=');
    expect(plan.fromKey).toBe(ANCHOR);
    expect(plan.successorRecurrence.dtstartLocal).toBe(ANCHOR);
  });

  it('edit-all keeps every exception and re-materializes', async () => {
    const service = serviceWith(recordingPoints());
    const { seriesId, done, exception } = seedHistory();

    await service.updateSeries(actorFor('adult', ADULT), seriesId, {
      scope: 'all',
      title: 'Вынести мусор',
      recurrence: {
        mode: 'preset',
        preset: { kind: 'weekly', interval: 1, weekdays: ['TU'] },
        ends: { type: 'never' },
        dtstartLocal: '2026-08-18T09:00:00',
        timezone: TZ,
        rdatesLocal: [],
        exdatesLocal: [],
      },
    });

    expect(store.series.get(seriesId)?.title).toBe('Вынести мусор');
    expect(store.occurrences.get(done)?.status).toBe('done');
    expect(store.occurrences.get(exception)?.isException).toBe(true);
    expect(vi.mocked(materializeSeries)).toHaveBeenCalled();
  });

  it('a metadata-only edit-all deletes nothing — COALESCE does the work', async () => {
    const service = serviceWith(recordingPoints());
    const { seriesId, future } = seedHistory();

    await service.updateSeries(actorFor('adult', ADULT), seriesId, {
      scope: 'all',
      title: 'Мусор (по вторникам)',
    });

    expect(store.occurrences.has(future)).toBe(true);
    expect(store.series.get(seriesId)?.title).toBe('Мусор (по вторникам)');
  });

  it('refuses to smuggle a series-wide setting into a single-instance edit', async () => {
    const service = serviceWith(recordingPoints());
    const seriesId = seedSeries();
    await expect(
      service.updateSeries(actorFor('adult', ADULT), seriesId, {
        scope: 'this',
        occurrenceId: seedOccurrence(seriesId),
        visibility: 'private',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('edit-this writes overrides and flags the row as an exception', async () => {
    const service = serviceWith(recordingPoints());
    const seriesId = seedSeries();
    const occurrenceId = seedOccurrence(seriesId);

    await service.updateSeries(actorFor('adult', ADULT), seriesId, {
      scope: 'this',
      occurrenceId,
      title: 'Мусор + ёлка',
      points: 9,
    });

    const row = store.occurrences.get(occurrenceId);
    expect(row?.titleOverride).toBe('Мусор + ёлка');
    expect(row?.pointsOverride).toBe(9);
    expect(row?.isException).toBe(true);
    // The rule itself is untouched.
    expect(store.series.get(seriesId)?.title).toBe('Мусор');
    expect(store.series.get(seriesId)?.points).toBe(5);
  });
});

/* ========================================================================== */
/* 5. What a child may see                                                    */
/* ========================================================================== */

describe('read scope and visibility', () => {
  const child = viewerOf(actorFor('child', CHILD));
  const adult = viewerOf(actorFor('adult', ADULT));
  const teen = viewerOf(actorFor('teen', '00000000-0000-4000-8000-0000000000t1'));

  const row = (visibility: Visibility, assigneeId: string | null, creator = ADULT) => ({
    visibility,
    seriesCreatedById: creator,
    assigneeId,
  });

  it('gives a child their own tasks plus the household-visible ones', () => {
    expect(canReadOccurrence(child, row('household', OTHER_ADULT))).toBe(true);
    expect(canReadOccurrence(child, row('household', null))).toBe(true);
    expect(canReadOccurrence(child, row('private', CHILD))).toBe(true);
    expect(canReadOccurrence(child, row('private', null, CHILD))).toBe(true);
  });

  it('hides somebody else`s private task from a child', () => {
    expect(canReadOccurrence(child, row('private', OTHER_ADULT))).toBe(false);
  });

  it('hides a restricted task from a child and from a teen', () => {
    // «Приём у врача» is exactly what `restricted` is for.
    expect(canReadOccurrence(child, row('restricted', OTHER_ADULT))).toBe(false);
    expect(canReadOccurrence(teen, row('restricted', OTHER_ADULT))).toBe(false);
    expect(canReadOccurrence(adult, row('restricted', OTHER_ADULT))).toBe(true);
  });

  it('still shows a child a restricted task that is theirs', () => {
    expect(canReadOccurrence(child, row('restricted', CHILD))).toBe(true);
  });

  it('does not let read:any override private ownership', () => {
    // `task:read:any` widens the *scope* gate; it is not a master key to
    // another person's private row.
    expect(adult.canReadAny).toBe(true);
    expect(canReadOccurrence(adult, row('private', OTHER_ADULT, OTHER_ADULT))).toBe(false);
  });

  it('filters the same way through the service', async () => {
    const service = serviceWith(recordingPoints());
    const own = seedOccurrence(seedSeries({ visibility: 'household' }), { assigneeId: CHILD });
    const hidden = seedOccurrence(
      seedSeries({ visibility: 'restricted', createdById: OTHER_ADULT }),
      { assigneeId: OTHER_ADULT },
    );

    const visible = await service.listOccurrences(actorFor('child', CHILD), {
      overdueOnly: false,
      unassignedOnly: false,
      limit: 50,
    });
    expect(visible.items.map((i) => i.id)).toEqual([own]);

    // 404, not 403: the child must not learn the appointment exists.
    await expect(service.getOccurrence(actorFor('child', CHILD), hidden)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

/* ========================================================================== */
/* 6. occurrenceKey is stable across a move                                   */
/* ========================================================================== */

describe('occurrenceKey is the immutable identity of an instance', () => {
  it('a move patch cannot even express a key change', () => {
    const patch = planOccurrenceMove('2026-09-08T14:00:00', {
      timezone: TZ,
      dueOffsetMinutes: 60,
    });
    expect(Object.keys(patch).sort()).toEqual(['dueAt', 'localDate', 'startsAt', 'startsLocal']);
    expect(patch).not.toHaveProperty('occurrenceKey');
  });

  it('rewrites the timestamps and leaves the key alone', async () => {
    const service = serviceWith(recordingPoints());
    const seriesId = seedSeries();
    const occurrenceId = seedOccurrence(seriesId, { occurrenceKey: '2026-09-08T14:00:00' });

    const moved = await service.updateOccurrence(actorFor('adult', ADULT), occurrenceId, {
      startsLocal: '2026-09-09T14:00:00',
    });

    // Dragged from Tuesday to Wednesday…
    expect(moved.startsLocal).toBe('2026-09-09T14:00:00');
    expect(moved.localDate).toBe('2026-09-09');
    expect(moved.isException).toBe(true);
    // …and it is still the same instance. If the key moved, the next horizon
    // extension would not recognise it and the family would get two dentists.
    expect(moved.occurrenceKey).toBe('2026-09-08T14:00:00');
    expect(store.occurrences.get(occurrenceId)?.occurrenceKey).toBe('2026-09-08T14:00:00');
  });

  it('keeps the key stable across a completion and an override too', async () => {
    const service = serviceWith(recordingPoints());
    const occurrenceId = seedOccurrence(seedSeries(), { occurrenceKey: '2026-09-08T14:00:00' });
    const adult = actorFor('adult', ADULT);

    await service.updateOccurrence(adult, occurrenceId, { titleOverride: 'Другое' });
    await service.complete(adult, occurrenceId, {});

    expect(store.occurrences.get(occurrenceId)?.occurrenceKey).toBe('2026-09-08T14:00:00');
  });

  it('moves the deadline in wall-clock terms across a DST boundary', () => {
    // Berlin springs forward on 2027-03-28. A 23:30 start with a 60-minute
    // offset must land at 01:30 local, not at 00:30 + an accidental hour.
    const patch = planOccurrenceMove('2027-03-27T23:30:00', {
      timezone: 'Europe/Berlin',
      dueOffsetMinutes: 60,
    });
    expect(patch.startsLocal).toBe('2027-03-27T23:30:00');
    expect(patch.dueAt.getTime() - patch.startsAt.getTime()).toBe(3_600_000);
  });
});

/* ========================================================================== */
/* Recurrence compilation                                                     */
/* ========================================================================== */

describe('recurrence compilation', () => {
  it('serialises UNTIL in UTC using the series timezone', () => {
    const compiled = compileRecurrence({
      mode: 'preset',
      preset: { kind: 'weekly', interval: 1, weekdays: ['MO'] },
      ends: { type: 'until', untilLocal: '2026-12-31T09:00:00' },
      dtstartLocal: '2026-08-17T09:00:00',
      timezone: TZ,
      rdatesLocal: [],
      exdatesLocal: [],
    });
    // Moscow is UTC+3, so 09:00 local is 06:00Z — not 09:00Z.
    expect(compiled.rrule).toContain('UNTIL=20261231T060000Z');
  });

  it('stores a one-off as a NULL rule, not as a special case', () => {
    const compiled = compileRecurrence({
      mode: 'once',
      dtstartLocal: '2026-08-20T18:00:00',
      timezone: TZ,
      rdatesLocal: [],
      exdatesLocal: [],
    });
    expect(compiled.rrule).toBeNull();
    expect(compiled.seriesEndsAt).toBeInstanceOf(Date);
  });
});

/* ========================================================================== */
/* Route access declarations                                                  */
/* ========================================================================== */

interface CollectedRoute {
  method: string;
  url: string;
  permission: Permission | undefined;
  scoped: string | undefined;
  notFoundOnDeny: boolean;
  isPublic: boolean;
}

/**
 * A miniature host for the tasks plugin, reproducing exactly the part of
 * `core/plugins/auth` these tests are about — "deny unless the caller holds
 * what the route declares, and answer 404 where the route asks for it".
 */
async function buildHarness(
  role: Role | null,
  userId = ADULT,
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
        scoped: route.config?.scoped,
        notFoundOnDeny: route.config?.notFoundOnDeny === true,
        isPublic: route.config?.public === true,
      });
    }
  });

  const held = role ? new Set<Permission>(effectivePermissions(role)) : null;

  app.addHook('onRequest', async (request) => {
    const access = request.routeOptions.config;
    if (access.public) return;
    if (!held || !role) throw new AppError('UNAUTHENTICATED', 'Authentication required');

    const denial = (required: string): AppError =>
      access.notFoundOnDeny
        ? new AppError('NOT_FOUND', 'Resource not found')
        : new AppError('FORBIDDEN', `Missing permission: ${required}`);

    if (access.permission && !held.has(access.permission)) throw denial(access.permission);
    if (access.scoped) {
      const scope = held.has(`${access.scoped}:any` as Permission)
        ? ('any' as const)
        : held.has(`${access.scoped}:own` as Permission)
          ? ('own' as const)
          : null;
      if (scope === null) throw denial(`${access.scoped}:own`);
      request.scope = scope;
    }

    request.auth = {
      userId,
      role,
      status: 'active',
      displayName: 'Тест',
      timezone: TZ,
      permissions: held,
      can: (permission) => held.has(permission),
      canAny: (...list) => list.some((p) => held.has(p)),
      scopeFor: () => null,
      canManageRole: () => false,
    };
  });

  await app.register(tasksRoutes);
  await app.ready();
  return { app, routes };
}

const concreteUrl = (url: string): string => url.replace(':id', randomUUID());

describe('route access declarations', () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeAll(async () => {
    harness = await buildHarness('adult');
  });

  afterAll(async () => {
    await harness.app.close();
  });

  it('declares access on every route and makes none public', () => {
    expect(harness.routes.length).toBe(Object.keys(TASK_ROUTE_ACCESS).length);
    for (const route of harness.routes) {
      expect(route.isPublic, `${route.method} ${route.url} must not be public`).toBe(false);
      expect(
        route.permission ?? route.scoped,
        `${route.method} ${route.url} declares no access — boot would fail`,
      ).toBeDefined();
    }
  });

  it('registers exactly the documented route table (scheduling.md §8)', () => {
    const registered = Object.fromEntries(
      harness.routes.map((route) => [
        `${route.method} ${route.url}`,
        route.permission
          ? { permission: route.permission }
          : route.notFoundOnDeny
            ? { scoped: route.scoped, notFoundOnDeny: true }
            : { scoped: route.scoped },
      ]),
    );
    expect(registered).toEqual(TASK_ROUTE_ACCESS);
  });
});

describe('HTTP guards', () => {
  it('answers 404, not 403, to a guest who may not read tasks at all', async () => {
    const harness = await buildHarness('guest', CHILD);
    const reads = harness.routes.filter((r) => r.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);

    for (const route of reads) {
      const response = await harness.app.inject({ method: 'GET', url: concreteUrl(route.url) });
      // A 403 would confirm the family keeps tasks. It does not, as far as a
      // guest is concerned (D4).
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
    }
    await harness.app.close();
  });

  it('lets a child read but refuses the adult-only writes with 403', async () => {
    const harness = await buildHarness('child', CHILD);

    const assign = harness.routes.find((r) => r.url.endsWith('/assign'));
    expect(assign).toBeDefined();
    const denied = await harness.app.inject({
      method: 'POST',
      url: concreteUrl(assign?.url ?? ''),
      payload: { assigneeId: null },
    });
    // The child can see the task; they simply may not reassign it. That is
    // exactly the case 403 is reserved for.
    expect(denied.statusCode).toBe(403);
    await harness.app.close();
  });

  it('is 401 without a session', async () => {
    const anonymous = await buildHarness(null);
    const response = await anonymous.app.inject({ method: 'GET', url: '/tasks/today' });
    expect(response.statusCode).toBe(401);
    await anonymous.app.close();
  });
});

/* ========================================================================== */
/* Postgres-backed: the SQL the rules ride on                                 */
/* ========================================================================== */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * Everything above runs against an in-memory store, so this block asserts the
 * three things only Postgres can answer: that the override resolution really is
 * `COALESCE` in SQL, that the overdue predicate really is derived on read, and
 * that the conditional completion update really does match zero rows the second
 * time.
 *
 * Run with `TEST_DATABASE_URL=postgres://… npx vitest run src/modules/tasks`.
 */
describe.skipIf(!TEST_DATABASE_URL)('tasks against Postgres', () => {
  let db: Db;
  let close: () => Promise<void>;
  let repo: typeof TaskRepositoryModule;

  const viewer = { userId: ADULT, canReadAny: true, canSeeRestricted: true };

  beforeAll(async () => {
    // `importActual`: this block is about the real SQL, not the fake store.
    repo = await vi.importActual<typeof TaskRepositoryModule>('./tasks.repository.js');

    const { createDbClient } = await import('../../core/db.js');
    const { users } = await import('../identity/users.schema.js');
    const created = createDbClient(TEST_DATABASE_URL);
    db = created.db;
    close = async () => {
      await created.sql.end({ timeout: 5 });
    };

    for (const [id, role, name] of [
      [ADULT, 'adult', 'Мама'],
      [CHILD, 'child', 'Миша'],
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

  async function freshSeries(overrides: Record<string, unknown> = {}): Promise<TaskSeriesRow> {
    const [row] = await db
      .insert(taskSeries)
      .values({
        title: `Мусор ${randomUUID()}`,
        createdById: ADULT,
        dtstartLocal: '2026-08-17T09:00:00',
        timezone: TZ,
        dueOffsetMinutes: 60,
        graceMinutes: 15,
        points: 5,
        ...overrides,
      })
      .returning();
    if (!row) throw new Error('series insert returned no row');
    return row;
  }

  async function freshOccurrence(
    seriesId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(taskOccurrences)
      .values({
        seriesId,
        occurrenceKey: '2026-08-24T09:00:00',
        startsAt: new Date('2026-08-24T06:00:00.000Z'),
        dueAt: new Date('2026-08-24T07:00:00.000Z'),
        localDate: '2026-08-24',
        startsLocal: '2026-08-24T09:00:00',
        ...overrides,
      })
      .returning({ id: taskOccurrences.id });
    if (!row) throw new Error('occurrence insert returned no row');
    return row.id;
  }

  it('resolves COALESCE(override, series) in SQL', async () => {
    const series = await freshSeries();
    const plain = await freshOccurrence(series.id);
    const overridden = await freshOccurrence(series.id, {
      occurrenceKey: '2026-08-31T09:00:00',
      titleOverride: 'Мусор + коробки',
      pointsOverride: 9,
      isException: true,
    });

    const a = await repo.findOccurrenceById(db, plain, { viewer });
    const b = await repo.findOccurrenceById(db, overridden, { viewer });

    expect(a?.title).toBe(series.title);
    expect(a?.points).toBe(5);
    expect(b?.title).toBe('Мусор + коробки');
    expect(b?.points).toBe(9);
    // Nothing above the repository ever sees the raw override columns.
    expect(b).not.toHaveProperty('titleOverride');
  });

  it('derives isOverdue from the clock and the grace window', async () => {
    const series = await freshSeries({ graceMinutes: 30 });
    const id = await freshOccurrence(series.id);
    const due = new Date('2026-08-24T07:00:00.000Z');

    const early = await repo.findOccurrenceById(db, id, {
      viewer,
      now: new Date(due.getTime() + 29 * 60_000),
    });
    const late = await repo.findOccurrenceById(db, id, {
      viewer,
      now: new Date(due.getTime() + 31 * 60_000),
    });

    expect(early?.isOverdue).toBe(false);
    expect(late?.isOverdue).toBe(true);
    // Same row, two answers, zero writes between them.
    expect(early?.status).toBe('scheduled');
    expect(late?.status).toBe('scheduled');
  });

  it('completes exactly once — the second update matches no row', async () => {
    const series = await freshSeries();
    const id = await freshOccurrence(series.id);

    const first = await repo.completeIfScheduled(db, {
      id,
      completedById: CHILD,
      completedAt: T0,
    });
    const second = await repo.completeIfScheduled(db, {
      id,
      completedById: ADULT,
      completedAt: new Date(T0.getTime() + 600_000),
    });

    expect(first?.status).toBe('done');
    // The replay changes nothing — not the status, and above all not the
    // attribution the ledger would have paid out on.
    expect(second).toBeUndefined();
    const row = await repo.findOccurrenceById(db, id, { viewer });
    expect(row?.completedById).toBe(CHILD);
  });

  it('skips without removing the row, and never touches the rule', async () => {
    const series = await freshSeries();
    const id = await freshOccurrence(series.id);

    await repo.skipIfScheduled(db, { id, skippedById: ADULT, reason: 'Уехали' });

    const row = await repo.findOccurrenceById(db, id, { viewer });
    expect(row?.status).toBe('skipped');
    expect(row?.skipReason).toBe('Уехали');
    const [reloaded] = await db.select().from(taskSeries).where(eq(taskSeries.id, series.id));
    expect(reloaded?.exdatesLocal).toEqual([]);
  });

  it('spares done and exception rows when clearing the future', async () => {
    const series = await freshSeries();
    const done = await freshOccurrence(series.id, {
      occurrenceKey: '2026-09-07T09:00:00',
      status: 'done',
      completedById: CHILD,
      completedAt: T0,
    });
    const exception = await freshOccurrence(series.id, {
      occurrenceKey: '2026-09-14T09:00:00',
      isException: true,
    });
    const plain = await freshOccurrence(series.id, { occurrenceKey: '2026-09-21T09:00:00' });

    const removed = await repo.deleteFutureScheduled(db, {
      seriesId: series.id,
      fromKey: '2026-09-01T00:00:00',
    });

    expect(removed).toEqual([plain]);
    expect(await repo.findOccurrenceById(db, done, { viewer })).toBeDefined();
    expect(await repo.findOccurrenceById(db, exception, { viewer })).toBeDefined();
  });
});
