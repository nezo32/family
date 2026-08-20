import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../core/db.js';
import type { AssignmentRun } from './chores.service.js';
import type { ChoreIntent } from './swaps.service.js';
import type * as RealChoresRepo from './chores.repository.js';
import {
  materializeThroughPort,
  type ExtraColumnValue,
  type MaterializerPort,
  type PlannedOccurrence,
  type SeriesSnapshot,
} from '../../core/recurrence/materializer.js';

/**
 * The chores service suite.
 *
 * Postgres appears only in the last block, and only for the thing a fake cannot
 * honestly reproduce: the fairness roster SQL. Everything above it is driven
 * through an in-memory stand-in for `chores.repository.ts` that enforces the
 * *same* two rules the schema does:
 *
 * - `kudos_from_occurrence_emoji_uq` — one emoji per person per occurrence;
 * - the conditional completion UPDATE — `WHERE status = 'scheduled'`.
 *
 * The second one is what makes completion idempotent, and since the removal of
 * the points ledger (D5) it is the *only* thing that has to be: fairness counts
 * `task_occurrences` rows where `status = 'done'`, and one row can only be done
 * once. There is no longer a second place for a duplicate award to land, which
 * is a guarantee this suite gets for free rather than having to police.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures & the in-memory repository                                         */
/* -------------------------------------------------------------------------- */

const T0 = new Date('2026-09-07T09:00:00.000Z');
const DAY = 86_400_000;

const ADULT = '00000000-0000-4000-8000-00000000000a';
const TEEN = '00000000-0000-4000-8000-00000000000b';
const CHILD = '00000000-0000-4000-8000-00000000000c';
const OCCURRENCE = '00000000-0000-4000-8000-0000000000f1';
const ROTATION = '00000000-0000-4000-8000-0000000000e1';

interface FakeOccurrence {
  id: string;
  seriesId: string;
  title: string;
  status: 'scheduled' | 'done' | 'skipped' | 'cancelled';
  startsAt: Date;
  dueAt: Date;
  graceMinutes: number;
  assigneeId: string | null;
  assignedVia: 'rotation' | 'manual' | 'swap' | 'claimed' | null;
  completedById: string | null;
  completedAt: Date | null;
  rotationId: string | null;
}

const store = vi.hoisted(() => ({
  occurrences: new Map<string, Record<string, unknown>>(),
  kudos: [] as Array<Record<string, unknown>>,
  swaps: [] as Array<Record<string, unknown>>,
  members: [] as Array<Record<string, unknown>>,
  seq: 0,
  nextId(): string {
    this.seq += 1;
    return `row-${this.seq}`;
  },
  reset(): void {
    this.occurrences.clear();
    this.kudos.length = 0;
    this.swaps.length = 0;
    this.members.length = 0;
    this.seq = 0;
  },
}));

vi.mock('./chores.repository.js', () => ({
  findOccurrence: (_ex: unknown, id: string) => Promise.resolve(store.occurrences.get(id)),

  markOccurrenceDone: (_ex: unknown, id: string, by: string, at: Date) => {
    const row = store.occurrences.get(id);
    // The conditional UPDATE: `WHERE status = 'scheduled'`.
    if (!row || row.status !== 'scheduled') return Promise.resolve(false);
    Object.assign(row, { status: 'done', completedById: by, completedAt: at });
    return Promise.resolve(true);
  },

  markOccurrenceScheduled: (_ex: unknown, id: string) => {
    const row = store.occurrences.get(id);
    if (!row || row.status !== 'done') return Promise.resolve(false);
    Object.assign(row, { status: 'scheduled', completedById: null, completedAt: null });
    return Promise.resolve(true);
  },

  reassignOccurrence: (_ex: unknown, id: string, assigneeId: string, via: string) => {
    const row = store.occurrences.get(id);
    if (!row || row.status !== 'scheduled') return Promise.resolve(false);
    Object.assign(row, { assigneeId, assignedVia: via });
    return Promise.resolve(true);
  },

  insertKudos: (_ex: unknown, values: Record<string, unknown>) => {
    const duplicate = store.kudos.some(
      (k) =>
        k.fromUserId === values.fromUserId &&
        k.occurrenceId === values.occurrenceId &&
        k.emoji === values.emoji,
    );
    if (duplicate) return Promise.resolve(undefined);
    const row = { id: store.nextId(), message: null, createdAt: T0, ...values };
    store.kudos.push(row);
    return Promise.resolve(row);
  },

  findAcceptedSwapForOccurrence: (_ex: unknown, occurrenceId: string) =>
    Promise.resolve(
      store.swaps.find((s) => s.occurrenceId === occurrenceId && s.status === 'accepted'),
    ),

  findPendingSwapForOccurrence: (_ex: unknown, occurrenceId: string) =>
    Promise.resolve(
      store.swaps.find((s) => s.occurrenceId === occurrenceId && s.status === 'pending'),
    ),

  insertSwap: (_ex: unknown, values: Record<string, unknown>) => {
    // `chore_swaps_one_pending_uq`: at most one pending row per occurrence.
    const live = store.swaps.some(
      (s) => s.occurrenceId === values.occurrenceId && s.status === 'pending',
    );
    if (live) return Promise.resolve(undefined);
    const row = {
      id: store.nextId(),
      status: 'pending',
      message: null,
      respondedById: null,
      respondedAt: null,
      expiresAt: null,
      createdAt: T0,
      ...values,
    };
    store.swaps.push(row);
    return Promise.resolve(row);
  },

  findSwapById: (_ex: unknown, id: string) => Promise.resolve(store.swaps.find((s) => s.id === id)),

  transitionSwap: (
    _ex: unknown,
    id: string,
    next: string,
    by: { respondedById: string | null; respondedAt: Date },
  ) => {
    const row = store.swaps.find((s) => s.id === id);
    if (!row || row.status !== 'pending') return Promise.resolve(undefined);
    Object.assign(row, { status: next, ...by });
    return Promise.resolve(row);
  },

  expirePendingSwaps: (_ex: unknown, now: Date) => {
    const expired = store.swaps.filter(
      (s) => s.status === 'pending' && s.expiresAt instanceof Date && s.expiresAt < now,
    );
    for (const row of expired) Object.assign(row, { status: 'expired', respondedAt: now });
    return Promise.resolve(expired);
  },

  findBlackoutsForUsers: () => Promise.resolve(new Map<string, never[]>()),
  findRotationMembers: (_ex: unknown, rotationId: string) =>
    Promise.resolve(store.members.filter((m) => m.rotationId === rotationId)),

  decodeCursor: () => ({ createdAt: T0, id: 'x' }),
  toPage: (rows: unknown[], limit: number) => ({ items: rows.slice(0, limit), nextCursor: null }),
}));

const { ChoresService, rotationDecorator } = await import('./chores.service.js');
const { RotationRun } = await import('./rotation.js');

/** `db.transaction(fn)` is the only `Db` member these tests reach. */
const fakeDb = {
  transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
} as unknown as Db;

function actor(id: string, permissions: string[] = []) {
  return {
    id,
    displayName: `user-${id.slice(-1)}`,
    can: (permission: string) => permissions.includes(permission),
  };
}

function putOccurrence(overrides: Partial<FakeOccurrence> = {}): FakeOccurrence {
  const row: FakeOccurrence = {
    id: OCCURRENCE,
    seriesId: 'series-1',
    title: 'Мусор',
    status: 'scheduled',
    startsAt: T0,
    dueAt: new Date(T0.getTime() + 3_600_000),
    graceMinutes: 15,
    assigneeId: TEEN,
    assignedVia: 'rotation',
    completedById: null,
    completedAt: null,
    rotationId: ROTATION,
    ...overrides,
  };
  store.occurrences.set(row.id, row as unknown as Record<string, unknown>);
  return row;
}

beforeEach(() => {
  store.reset();
});

/* -------------------------------------------------------------------------- */
/* Completion — the chore counts for the doer                                  */
/* -------------------------------------------------------------------------- */

describe('completeChore', () => {
  const service = () => new ChoresService(fakeDb, { now: () => T0 });

  it('credits the doer, not the assignee (D5)', async () => {
    putOccurrence({ assigneeId: TEEN });

    const result = await service().completeChore(actor(ADULT, ['task:complete:any']), OCCURRENCE);

    expect(result.completedById).toBe(ADULT);
    expect(result.coveredFor).toBe(TEEN);
    // `completed_by_id` is the whole fairness record: the rotation counts this
    // row against the adult, so covering for the teen means the rotation asks
    // less of the adult next week. Nobody's score moved, because there is no
    // score to move.
    expect(store.occurrences.get(OCCURRENCE)).toMatchObject({
      status: 'done',
      completedById: ADULT,
      completedAt: T0,
    });
  });

  it('counts once when the same completion arrives twice', async () => {
    putOccurrence({ assigneeId: TEEN });
    const svc = service();

    const first = await svc.completeChore(actor(TEEN, ['task:complete:own']), OCCURRENCE);
    const second = await svc.completeChore(actor(TEEN, ['task:complete:own']), OCCURRENCE);

    expect(first.alreadyCompleted).toBe(false);
    // The second delivery of the same intent — a double tap, an offline queue
    // replaying — is a success, not an error, and it wrote nothing.
    expect(second.alreadyCompleted).toBe(true);
    expect(second.completedById).toBe(TEEN);
    // One row, one completion. That is the entire idempotency guarantee now.
    expect(store.occurrences.get(OCCURRENCE)).toMatchObject({ completedById: TEEN });
  });

  it('says thank you automatically when somebody covered, and nothing accrues', async () => {
    putOccurrence({ assigneeId: TEEN });

    await service().completeChore(actor(CHILD, ['task:complete:any']), OCCURRENCE);

    expect(store.kudos).toHaveLength(1);
    expect(store.kudos[0]).toMatchObject({ fromUserId: TEEN, toUserId: CHILD });
  });

  it('does not thank anybody when the assignee did their own chore', async () => {
    putOccurrence({ assigneeId: TEEN });

    const result = await service().completeChore(actor(TEEN), OCCURRENCE);

    expect(result.coveredFor).toBeNull();
    expect(store.kudos).toHaveLength(0);
  });

  it('refuses a completion on behalf of somebody else without task:complete:any', async () => {
    putOccurrence();
    await expect(
      service().completeChore(actor(CHILD), OCCURRENCE, { completedById: TEEN }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to complete a skipped occurrence', async () => {
    putOccurrence({ status: 'skipped' });
    await expect(service().completeChore(actor(TEEN), OCCURRENCE)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('reopening takes the chore straight back out of the fairness count', async () => {
    putOccurrence({ assigneeId: TEEN });
    const svc = service();
    await svc.completeChore(actor(TEEN), OCCURRENCE);

    await svc.uncompleteChore(actor(ADULT, ['task:complete:any']), OCCURRENCE);

    // No compensating entries, no streak to rewind: the row leaves `done`, and
    // every count that reads `status = 'done'` follows in the same statement.
    expect(store.occurrences.get(OCCURRENCE)).toMatchObject({
      status: 'scheduled',
      completedById: null,
      completedAt: null,
    });
  });

  it('refuses to reopen something that was never completed', async () => {
    putOccurrence({ assigneeId: TEEN });
    await expect(
      service().uncompleteChore(actor(ADULT, ['task:complete:any']), OCCURRENCE),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

/* -------------------------------------------------------------------------- */
/* Swaps                                                                       */
/* -------------------------------------------------------------------------- */

describe('swaps', () => {
  /**
   * Records the **whole** intent, not just its type.
   *
   * The stub used to keep `type` alone, which is exactly why nobody noticed
   * that the emitter hardcoded `priority: 'normal'` for a `high` type and
   * spelled an open offer's audience `{}`. An assertion that cannot see the
   * audience cannot catch a notification sent to the wrong people.
   */
  const emitted: ChoreIntent[] = [];
  /** Set by the emitter, cleared per test: did anything reach the queue? */
  let dispatched = 0;
  const service = () =>
    new ChoresService(fakeDb, {
      now: () => T0,
      emitIntent: (_ex, intent) => {
        emitted.push(intent);
        return Promise.resolve(() => {
          dispatched += 1;
          return Promise.resolve();
        });
      },
    });

  beforeEach(() => {
    emitted.length = 0;
    dispatched = 0;
    store.members.push(
      { rotationId: ROTATION, userId: TEEN, weight: '1.00', position: 0, active: true },
      { rotationId: ROTATION, userId: CHILD, weight: '1.00', position: 1, active: true },
      { rotationId: ROTATION, userId: ADULT, weight: '1.00', position: 2, active: true },
    );
  });

  it('lets the assignee offer their chore and tells the other side', async () => {
    putOccurrence({ assigneeId: TEEN });

    const swap = await service().swaps.request(actor(TEEN, ['task:update:own']), {
      occurrenceId: OCCURRENCE,
      toUserId: CHILD,
    });

    expect(swap.status).toBe('pending');
    expect(swap.fromUserId).toBe(TEEN);
    // Defaults to the chore's own deadline: an offer that outlives the chore is
    // noise.
    expect(swap.expiresAt).toBe(new Date(T0.getTime() + 3_600_000).toISOString());
    expect(emitted.map((e) => e.type)).toEqual(['chore_swap_requested']);
    // Directed at exactly one person — never the whole family.
    expect(emitted[0]?.audience).toEqual({ users: [CHILD] });
    // Enqueued, and only after the transaction returned.
    expect(dispatched).toBe(1);
  });

  it('surfaces the one-pending-per-occurrence index as a clean 409', async () => {
    putOccurrence({ assigneeId: TEEN });
    const svc = service();
    const input = { occurrenceId: OCCURRENCE, toUserId: CHILD };

    await svc.swaps.request(actor(TEEN, ['task:update:own']), input);
    await expect(svc.swaps.request(actor(TEEN, ['task:update:own']), input)).rejects.toMatchObject({
      code: 'CONFLICT',
      statusCode: 409,
    });
  });

  it('refuses to offer away somebody else’s chore', async () => {
    putOccurrence({ assigneeId: TEEN });
    await expect(
      service().swaps.request(actor(CHILD, ['task:update:own']), {
        occurrenceId: OCCURRENCE,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('needs an adult to accept a handoff, but not to decline one', async () => {
    putOccurrence({ assigneeId: TEEN });
    const svc = service();
    const swap = await svc.swaps.request(actor(TEEN, ['task:update:own']), {
      occurrenceId: OCCURRENCE,
      toUserId: CHILD,
    });

    await expect(
      svc.swaps.respond(actor(CHILD, ['task:update:own']), swap.id, { accept: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const declined = await svc.swaps.respond(actor(CHILD, ['task:update:own']), swap.id, {
      accept: false,
    });
    expect(declined.status).toBe('declined');
  });

  it('rewrites only the assignee on acceptance', async () => {
    putOccurrence({ assigneeId: TEEN });
    const svc = service();
    const swap = await svc.swaps.request(actor(TEEN, ['task:update:own']), {
      occurrenceId: OCCURRENCE,
      toUserId: CHILD,
    });

    await svc.swaps.respond(actor(ADULT, ['task:assign:any', 'chore:swap:accept']), swap.id, {
      accept: true,
    });

    // One foreign key, and nothing else. A swap carries no sweetener to book:
    // «дам тебе 5 баллов» is the trade D5 took off the table.
    expect(store.occurrences.get(OCCURRENCE)).toMatchObject({
      assigneeId: CHILD,
      assignedVia: 'swap',
    });
    expect(emitted.map((e) => e.type)).toEqual(['chore_swap_requested', 'chore_swap_answered']);
  });

  it('produces one winner and one 409 when two people answer the same offer', async () => {
    putOccurrence({ assigneeId: TEEN });
    const svc = service();
    const swap = await svc.swaps.request(actor(TEEN, ['task:update:own']), {
      occurrenceId: OCCURRENCE,
    });

    await svc.swaps.respond(actor(ADULT, ['task:assign:any', 'chore:swap:accept']), swap.id, {
      accept: true,
    });
    await expect(
      svc.swaps.respond(actor(ADULT, ['task:assign:any', 'chore:swap:accept']), swap.id, {
        accept: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('expires only offers that are still pending and actually overdue', async () => {
    store.swaps.push(
      { id: 's1', occurrenceId: 'o1', status: 'pending', expiresAt: new Date(T0.getTime() - 1) },
      { id: 's2', occurrenceId: 'o2', status: 'pending', expiresAt: new Date(T0.getTime() + DAY) },
      { id: 's3', occurrenceId: 'o3', status: 'accepted', expiresAt: new Date(T0.getTime() - 1) },
    );

    expect(await service().swaps.expireDue(fakeDb, T0)).toBe(1);
    expect(store.swaps.map((s) => s.status)).toEqual(['expired', 'pending', 'accepted']);
    // Running the sweep again is a no-op.
    expect(await service().swaps.expireDue(fakeDb, T0)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Assignment is frozen at materialization                                     */
/* -------------------------------------------------------------------------- */

/**
 * An in-memory stand-in for `task_occurrences`, faithful on the one rule that
 * matters here: `UNIQUE (series_id, occurrence_key)` +
 * `ON CONFLICT DO NOTHING`.
 */
class FakeOccurrenceStore implements MaterializerPort {
  readonly rows = new Map<string, Record<string, ExtraColumnValue>>();
  private watermark: Date | null = null;

  constructor(private readonly series: SeriesSnapshot) {}

  lockSeries(): Promise<SeriesSnapshot | null> {
    return Promise.resolve({ ...this.series, materializedThrough: this.watermark });
  }

  insertOccurrences(
    occurrences: readonly PlannedOccurrence[],
    extras: ReadonlyArray<Record<string, ExtraColumnValue>>,
  ): Promise<number> {
    let inserted = 0;
    occurrences.forEach((occurrence, index) => {
      if (this.rows.has(occurrence.occurrenceKey)) return;
      this.rows.set(occurrence.occurrenceKey, extras[index] ?? {});
      inserted += 1;
    });
    return Promise.resolve(inserted);
  }

  advanceWatermark(_seriesId: string, through: Date): Promise<void> {
    if (this.watermark === null || this.watermark < through) this.watermark = through;
    return Promise.resolve();
  }

  listDueSeriesIds(): Promise<string[]> {
    return Promise.resolve([this.series.id]);
  }

  assignees(): Array<ExtraColumnValue | undefined> {
    return [...this.rows.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, extras]) => extras.assignee_id);
  }
}

describe('assignment is written once at materialization and frozen (D5)', () => {
  const series: SeriesSnapshot = {
    id: 'series-frozen',
    rule: {
      rrule: 'FREQ=DAILY',
      dtstartLocal: '2026-09-07T09:00:00',
      timezone: 'Europe/Moscow',
      rdatesLocal: [],
      exdatesLocal: [],
    },
    offsetMinutes: 60,
    seriesEndsAt: null,
    materializedThrough: null,
    archivedAt: null,
  };

  /** A run built straight from the pure planner — no repository, no database. */
  function run(cursor = 0): AssignmentRun {
    const planner = new RotationRun({
      strategy: 'weighted_balance',
      cursor,
      members: [
        {
          userId: ADULT,
          weight: 1,
          position: 0,
          active: true,
          completed: 0,
          committed: 0,
          lastAssignedAt: null,
          blackouts: [],
        },
        {
          userId: TEEN,
          weight: 1,
          position: 1,
          active: true,
          completed: 0,
          committed: 0,
          lastAssignedAt: null,
          blackouts: [],
        },
      ],
    });
    return {
      rotationId: ROTATION,
      strategy: 'weighted_balance',
      assign: (at) => {
        const pick = planner.assign(at);
        return { assigneeId: pick.userId, assignedVia: pick.assignedVia, debt: pick.debt };
      },
      commit: () => Promise.resolve(),
    };
  }

  it('a second pass over the same window reassigns nobody', async () => {
    const port = new FakeOccurrenceStore(series);
    const now = new Date('2026-09-06T00:00:00.000Z');

    const first = await materializeThroughPort(port, series.id, {
      now,
      horizonDays: 14,
      decorate: rotationDecorator(run()),
    });
    const before = port.assignees();
    expect(first.inserted).toBeGreaterThan(10);
    expect(before.every((a) => a === ADULT || a === TEEN)).toBe(true);

    // Second pass, deliberately with a *fresh* rotation run whose roster has
    // moved on — exactly what a horizon extension a week later looks like.
    const second = await materializeThroughPort(port, series.id, {
      now,
      horizonDays: 14,
      decorate: rotationDecorator(run(1)),
    });

    expect(second.inserted).toBe(0);
    expect(port.assignees()).toEqual(before);
  });

  it('extends the horizon without touching what is already assigned', async () => {
    const port = new FakeOccurrenceStore(series);
    const now = new Date('2026-09-06T00:00:00.000Z');

    await materializeThroughPort(port, series.id, {
      now,
      horizonDays: 7,
      decorate: rotationDecorator(run()),
    });
    const before = port.assignees();

    await materializeThroughPort(port, series.id, {
      now,
      horizonDays: 21,
      decorate: rotationDecorator(run()),
    });

    expect(port.assignees().slice(0, before.length)).toEqual(before);
    expect(port.rows.size).toBeGreaterThan(before.length);
  });

  it('alternates fairly across the horizon rather than dumping it on one person', async () => {
    const port = new FakeOccurrenceStore(series);
    await materializeThroughPort(port, series.id, {
      now: new Date('2026-09-06T00:00:00.000Z'),
      horizonDays: 20,
      decorate: rotationDecorator(run()),
    });

    const assignees = port.assignees();
    const adult = assignees.filter((a) => a === ADULT).length;
    const teen = assignees.filter((a) => a === TEEN).length;
    expect(Math.abs(adult - teen)).toBeLessThanOrEqual(1);
  });

  it('leaves every occurrence claimable under the `anyone` strategy', async () => {
    const port = new FakeOccurrenceStore(series);
    const planner = new RotationRun({
      strategy: 'anyone',
      cursor: 0,
      members: [
        {
          userId: ADULT,
          weight: 1,
          position: 0,
          active: true,
          completed: 0,
          committed: 0,
          lastAssignedAt: null,
          blackouts: [],
        },
      ],
    });
    const anyoneRun: AssignmentRun = {
      rotationId: ROTATION,
      strategy: 'anyone',
      assign: (at) => {
        const pick = planner.assign(at);
        return { assigneeId: pick.userId, assignedVia: pick.assignedVia, debt: pick.debt };
      },
      commit: () => Promise.resolve(),
    };

    await materializeThroughPort(port, series.id, {
      now: new Date('2026-09-06T00:00:00.000Z'),
      horizonDays: 10,
      decorate: rotationDecorator(anyoneRun),
    });

    expect(port.rows.size).toBeGreaterThan(5);
    expect([...port.rows.values()].every((extras) => extras.assignee_id === null)).toBe(true);
    expect([...port.rows.values()].every((extras) => extras.assigned_via === null)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Keyset pagination                                                           */
/* -------------------------------------------------------------------------- */

describe('cursor encoding', () => {
  it('round-trips', async () => {
    const actual = await vi.importActual<typeof RealChoresRepo>('./chores.repository.js');
    const row = { createdAt: T0, id: OCCURRENCE };
    expect(actual.decodeCursor(actual.encodeCursor(row))).toEqual(row);
  });

  it('restarts pagination on rubbish instead of throwing', async () => {
    // This used to `throw badRequest('Malformed cursor')` while events, goals
    // and notifications quietly served page one for the same input. The codec
    // is `core/pagination.ts` now and forgiving everywhere: a cursor is a token
    // we issued, so a stale one is our redeploy, not the user's mistake.
    const actual = await vi.importActual<typeof RealChoresRepo>('./chores.repository.js');
    expect(actual.decodeCursor('not-a-cursor')).toBeUndefined();
    expect(actual.decodeCursor('')).toBeUndefined();
    expect(actual.decodeCursor(undefined)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Postgres                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Run with `TEST_DATABASE_URL=postgres://… pnpm --filter @family/backend test`
 * against a database that has the migrations applied. Skipped otherwise so
 * `pnpm test` stays runnable without Docker.
 *
 * This covers the thing the fake above cannot honestly reproduce: the fairness
 * roster SQL, which is where "how many chores did you do" is actually counted.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('chores against Postgres', () => {
  /** A series plus three occurrences: one done, one scheduled, one skipped. */
  async function seedRoster() {
    const { createDbClient } = await import('../../core/db.js');
    const { users } = await import('../identity/users.schema.js');
    const { rotationMembers, rotations } = await import('./chores.schema.js');
    const { taskOccurrences, taskSeries } = await import('../tasks/tasks.schema.js');

    const created = createDbClient(TEST_DATABASE_URL);
    const db = created.db;

    const [member] = await db
      .insert(users)
      .values({ displayName: 'Тест-дежурный', role: 'teen', status: 'active' })
      .returning();
    if (!member) throw new Error('could not seed a test user');

    const [rotation] = await db
      .insert(rotations)
      .values({ name: `тест-дежурство-${Date.now()}`, strategy: 'weighted_balance' })
      .returning();
    if (!rotation) throw new Error('could not seed a test rotation');

    await db
      .insert(rotationMembers)
      .values({ rotationId: rotation.id, userId: member.id, weight: '0.50', position: 0 });

    const [series] = await db
      .insert(taskSeries)
      .values({
        title: 'Мусор',
        createdById: member.id,
        rrule: 'FREQ=DAILY',
        dtstartLocal: '2026-09-07T09:00:00',
        timezone: 'Europe/Moscow',
        rotationId: rotation.id,
      })
      .returning();
    if (!series) throw new Error('could not seed a test series');

    const now = new Date();
    const rows = await db
      .insert(taskOccurrences)
      .values([
        {
          seriesId: series.id,
          occurrenceKey: '2026-09-07T09:00:00',
          startsAt: now,
          dueAt: now,
          localDate: '2026-09-07',
          startsLocal: '2026-09-07T09:00:00',
          status: 'done',
          assigneeId: member.id,
          completedById: member.id,
          completedAt: now,
        },
        {
          seriesId: series.id,
          occurrenceKey: '2026-09-08T09:00:00',
          startsAt: new Date(now.getTime() + DAY),
          dueAt: new Date(now.getTime() + DAY),
          localDate: '2026-09-08',
          startsLocal: '2026-09-08T09:00:00',
          status: 'scheduled',
          assigneeId: member.id,
        },
        {
          // Skipped: neither done nor still owed, so it counts for nothing.
          seriesId: series.id,
          occurrenceKey: '2026-09-09T09:00:00',
          startsAt: new Date(now.getTime() + 2 * DAY),
          dueAt: new Date(now.getTime() + 2 * DAY),
          localDate: '2026-09-09',
          startsLocal: '2026-09-09T09:00:00',
          status: 'skipped',
          assigneeId: member.id,
        },
      ])
      .returning();

    const seriesId = series.id;
    const rotationId = rotation.id;
    const memberId = member.id;
    const cleanup = async (): Promise<void> => {
      const { eq } = await import('drizzle-orm');
      await db.delete(taskSeries).where(eq(taskSeries.id, seriesId));
      await db.delete(rotations).where(eq(rotations.id, rotationId));
      await db.delete(users).where(eq(users.id, memberId));
      await created.sql.end({ timeout: 5 });
    };

    return { db, member, rotation, doneId: rows[0]?.id as string, cleanup };
  }

  it('counts completed and committed chores for a roster in one query', async () => {
    const actual = await vi.importActual<typeof RealChoresRepo>('./chores.repository.js');
    const { db, rotation, cleanup } = await seedRoster();
    try {
      const roster = await actual.loadRotationRoster(db, rotation.id, {
        now: new Date(),
        through: new Date(Date.now() + 7 * DAY),
        windowDays: 28,
      });

      expect(roster).toHaveLength(1);
      // One chore done, one still owed, the skipped one counted nowhere.
      expect(roster[0]?.completed).toBe(1);
      expect(roster[0]?.committed).toBe(1);
      expect(roster[0]?.weight).toBe(0.5);
    } finally {
      await cleanup();
    }
  });

  it('counts a chore once however often it is completed, and drops it on reopen', async () => {
    const actual = await vi.importActual<typeof RealChoresRepo>('./chores.repository.js');
    const { db, member, rotation, doneId, cleanup } = await seedRoster();
    try {
      // The conditional UPDATE refuses a row that is already `done`, so the
      // replay writes nothing — and even if it had, the count is over rows.
      expect(await actual.markOccurrenceDone(db, doneId, member.id, new Date())).toBe(false);

      const after = await actual.loadRotationRoster(db, rotation.id, {
        now: new Date(),
        through: new Date(Date.now() + 7 * DAY),
        windowDays: 28,
      });
      expect(after[0]?.completed).toBe(1);

      // Reopening removes it from the count in the same statement — no
      // compensating entry anywhere, because there is nothing to compensate.
      expect(await actual.markOccurrenceScheduled(db, doneId)).toBe(true);
      const reopened = await actual.loadRotationRoster(db, rotation.id, {
        now: new Date(),
        through: new Date(Date.now() + 7 * DAY),
        windowDays: 28,
      });
      expect(reopened[0]?.completed).toBe(0);
      expect(reopened[0]?.committed).toBe(2);
    } finally {
      await cleanup();
    }
  });
});
