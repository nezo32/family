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
 * Postgres appears only in the last block, and only for the two things a fake
 * cannot honestly reproduce: the fairness roster SQL and the partial unique
 * indexes. Everything above it is driven through an in-memory stand-in for
 * `chores.repository.ts` that enforces the *same* three rules the schema does:
 *
 * - `points_ledger_award_once_uq` — one `chore_completed` / `on_time_bonus` per
 *   `(occurrence, user)`;
 * - `kudos_from_occurrence_emoji_uq` — one emoji per person per occurrence;
 * - the conditional completion UPDATE — `WHERE status = 'scheduled'`.
 *
 * Those three are what make completion idempotent, so they are what the fake
 * has to get right for these tests to mean anything.
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
  points: number;
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

interface FakeLedgerRow {
  id: string;
  userId: string;
  delta: number;
  reason: string;
  occurrenceId: string | null;
  awardedById: string | null;
  note: string | null;
  createdAt: Date;
}

const store = vi.hoisted(() => ({
  occurrences: new Map<string, Record<string, unknown>>(),
  ledger: [] as Array<Record<string, unknown>>,
  kudos: [] as Array<Record<string, unknown>>,
  streaks: new Map<string, Record<string, unknown>>(),
  swaps: [] as Array<Record<string, unknown>>,
  members: [] as Array<Record<string, unknown>>,
  fairness: [] as Array<Record<string, unknown>>,
  memberWeights: [] as Array<Record<string, unknown>>,
  seq: 0,
  nextId(): string {
    this.seq += 1;
    return `row-${this.seq}`;
  },
  reset(): void {
    this.occurrences.clear();
    this.ledger.length = 0;
    this.kudos.length = 0;
    this.streaks.clear();
    this.swaps.length = 0;
    this.members.length = 0;
    this.fairness.length = 0;
    this.memberWeights.length = 0;
    this.seq = 0;
  },
}));

/** The two automatic reasons inside `points_ledger_award_once_uq`. */
const GUARDED = new Set(['chore_completed', 'on_time_bonus']);

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

  insertLedgerEntry: (_ex: unknown, values: Record<string, unknown>) => {
    const reason = values.reason as string;
    const occurrenceId = (values.occurrenceId ?? null) as string | null;
    if (occurrenceId !== null && GUARDED.has(reason)) {
      const duplicate = store.ledger.some(
        (e) => e.occurrenceId === occurrenceId && e.userId === values.userId && e.reason === reason,
      );
      // ON CONFLICT DO NOTHING against the partial unique index.
      if (duplicate) return Promise.resolve(undefined);
    }
    const row = {
      id: store.nextId(),
      awardedById: null,
      note: null,
      occurrenceId,
      createdAt: T0,
      ...values,
    };
    store.ledger.push(row);
    return Promise.resolve(row);
  },

  insertLedgerEntryAlways: (_ex: unknown, values: Record<string, unknown>) => {
    const row = {
      id: store.nextId(),
      awardedById: null,
      note: null,
      occurrenceId: null,
      createdAt: T0,
      ...values,
    };
    store.ledger.push(row);
    return Promise.resolve(row);
  },

  findLedgerEntry: (_ex: unknown, occurrenceId: string, userId: string, reason: string) =>
    Promise.resolve(
      store.ledger.find(
        (e) => e.occurrenceId === occurrenceId && e.userId === userId && e.reason === reason,
      ),
    ),

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

  findStreak: (_ex: unknown, userId: string) => Promise.resolve(store.streaks.get(userId)),

  upsertStreak: (_ex: unknown, values: Record<string, unknown>) => {
    const row = { updatedAt: T0, ...values };
    store.streaks.set(values.userId as string, row);
    return Promise.resolve(row);
  },

  listStreakEvents: () => Promise.resolve([]),

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
      bonusPoints: 0,
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
  listChoreMemberWeights: () => Promise.resolve(store.memberWeights),
  loadFairnessRows: () => Promise.resolve(store.fairness),

  decodeCursor: () => ({ createdAt: T0, id: 'x' }),
  toPage: (rows: unknown[], limit: number) => ({ items: rows.slice(0, limit), nextCursor: null }),
}));

const { ChoresService, rotationDecorator } = await import('./chores.service.js');
const {
  applyStreakEvent,
  coverBonusFor,
  EMPTY_STREAK,
  foldStreak,
  isOnTime,
  onTimeBonusFor,
} = await import('./points.service.js');
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
    points: 10,
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

function ledgerFor(userId: string): FakeLedgerRow[] {
  return store.ledger.filter((e) => e.userId === userId) as unknown as FakeLedgerRow[];
}

function balanceOf(userId: string): number {
  return ledgerFor(userId).reduce((sum, e) => sum + e.delta, 0);
}

beforeEach(() => {
  store.reset();
});

/* -------------------------------------------------------------------------- */
/* Pure scoring rules                                                          */
/* -------------------------------------------------------------------------- */

describe('scoring rules', () => {
  const due = new Date('2026-09-07T20:00:00.000Z');

  it('treats the grace window as still on time, and one millisecond past it as not', () => {
    expect(isOnTime(due, due, 0)).toBe(true);
    expect(isOnTime(new Date(due.getTime() + 15 * 60_000), due, 15)).toBe(true);
    expect(isOnTime(new Date(due.getTime() + 15 * 60_000 + 1), due, 15)).toBe(false);
  });

  it('pays no on-time bonus on a zero-point chore', () => {
    expect(onTimeBonusFor(0)).toBe(0);
    expect(onTimeBonusFor(-5)).toBe(0);
  });

  it('rounds the on-time bonus up to at least one point', () => {
    expect(onTimeBonusFor(1)).toBe(1);
    expect(onTimeBonusFor(20)).toBe(5);
  });

  it('always pays something for covering, even for a zero-point chore', () => {
    expect(coverBonusFor(0)).toBe(1);
    expect(coverBonusFor(10)).toBe(5);
  });
});

describe('streaks count occurrences, not calendar days', () => {
  it('extends on an on-time resolution and resets on a late one', () => {
    let state = applyStreakEvent(EMPTY_STREAK, { resolvedAt: new Date(T0), onTime: true });
    state = applyStreakEvent(state, { resolvedAt: new Date(T0.getTime() + 7 * DAY), onTime: true });
    expect(state.current).toBe(2);

    // Seven days apart and still a streak: a weekly chore must not be punished
    // for not being a daily one.
    state = applyStreakEvent(state, { resolvedAt: new Date(T0.getTime() + 14 * DAY), onTime: false });
    expect(state.current).toBe(0);
    expect(state.longest).toBe(2);
  });

  it('ignores an event at or before the stored resume point, so a replay is a no-op', () => {
    const first = applyStreakEvent(EMPTY_STREAK, { resolvedAt: T0, onTime: true });
    const replay = applyStreakEvent(first, { resolvedAt: T0, onTime: true });
    expect(replay).toBe(first);
    expect(replay.current).toBe(1);
  });

  it('folds a batch oldest-first', () => {
    const state = foldStreak(EMPTY_STREAK, [
      { resolvedAt: new Date(T0.getTime() + 0 * DAY), onTime: true },
      { resolvedAt: new Date(T0.getTime() + 1 * DAY), onTime: true },
      { resolvedAt: new Date(T0.getTime() + 2 * DAY), onTime: false },
      { resolvedAt: new Date(T0.getTime() + 3 * DAY), onTime: true },
    ]);
    expect(state).toEqual({
      current: 1,
      longest: 2,
      lastResolvedAt: new Date(T0.getTime() + 3 * DAY),
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Completion — points follow the doer                                         */
/* -------------------------------------------------------------------------- */

describe('completeChore', () => {
  const service = () => new ChoresService(fakeDb, { now: () => T0 });

  it('books the points to the doer, not to the assignee (D5)', async () => {
    putOccurrence({ assigneeId: TEEN, points: 10 });

    const result = await service().completeChore(actor(ADULT, ['task:complete:any']), OCCURRENCE);

    expect(result.completedById).toBe(ADULT);
    expect(result.coveredFor).toBe(TEEN);
    // The assignee earns nothing at all — that is what makes the loop
    // self-correcting rather than a chore-shaped IOU.
    expect(balanceOf(TEEN)).toBe(0);
    expect(ledgerFor(ADULT).map((e) => e.reason).sort()).toEqual([
      'chore_completed',
      'covered_for_other',
      'on_time_bonus',
    ]);
    expect(balanceOf(ADULT)).toBe(10 + 3 + 5);
  });

  it('awards exactly once when the same completion arrives twice', async () => {
    putOccurrence({ assigneeId: TEEN, points: 10 });
    const svc = service();

    const first = await svc.completeChore(actor(TEEN, ['task:complete:own']), OCCURRENCE);
    const second = await svc.completeChore(actor(TEEN, ['task:complete:own']), OCCURRENCE);

    expect(first.alreadyCompleted).toBe(false);
    expect(second.alreadyCompleted).toBe(true);
    expect(second.pointsAwarded).toBe(0);
    expect(store.ledger).toHaveLength(2); // chore_completed + on_time_bonus
    expect(balanceOf(TEEN)).toBe(13);
  });

  it('is idempotent even if the ledger write is retried directly', async () => {
    // Belt and braces: the conditional UPDATE is the first guard, the partial
    // unique index is the second, and either alone must be enough.
    putOccurrence({ assigneeId: TEEN, points: 10 });
    const svc = service();
    await svc.completeChore(actor(TEEN), OCCURRENCE);

    await svc.points.bookCompletion({} as never, {
      occurrenceId: OCCURRENCE,
      completedById: TEEN,
      assigneeId: TEEN,
      points: 10,
      dueAt: new Date(T0.getTime() + 3_600_000),
      graceMinutes: 15,
      completedAt: T0,
    });

    expect(balanceOf(TEEN)).toBe(13);
  });

  it('pays no on-time bonus when the deadline plus grace has passed', async () => {
    putOccurrence({ assigneeId: TEEN, points: 10, dueAt: new Date(T0.getTime() - DAY) });

    const result = await service().completeChore(actor(TEEN), OCCURRENCE);

    expect(result.onTime).toBe(false);
    expect(ledgerFor(TEEN).map((e) => e.reason)).toEqual(['chore_completed']);
  });

  it('says thank you automatically when somebody covered, and carries no points doing it', async () => {
    putOccurrence({ assigneeId: TEEN, points: 10 });

    await service().completeChore(actor(CHILD, ['task:complete:any']), OCCURRENCE);

    expect(store.kudos).toHaveLength(1);
    expect(store.kudos[0]).toMatchObject({ fromUserId: TEEN, toUserId: CHILD });
    // Kudos are not a second currency (D5).
    expect(store.ledger.some((e) => e.reason === 'kudos_received')).toBe(false);
  });

  it('books the swap sweetener as a transfer, so the family total does not drift', async () => {
    putOccurrence({ assigneeId: CHILD, points: 10 });
    store.swaps.push({
      id: 'swap-1',
      occurrenceId: OCCURRENCE,
      fromUserId: TEEN,
      toUserId: CHILD,
      status: 'accepted',
      bonusPoints: 4,
    });

    await service().completeChore(actor(CHILD), OCCURRENCE);

    expect(balanceOf(TEEN)).toBe(-4);
    expect(ledgerFor(CHILD).filter((e) => e.reason === 'swap_bonus')[0]?.delta).toBe(4);
    expect(store.ledger.reduce((sum, e) => sum + (e.delta as number), 0)).toBe(13);
  });

  it('moves the assignee streak, and only forward', async () => {
    putOccurrence({ assigneeId: TEEN, points: 10 });
    const svc = service();

    const result = await svc.completeChore(actor(TEEN), OCCURRENCE);
    expect(result.currentStreak).toBe(1);
    expect(store.streaks.get(TEEN)).toMatchObject({ current: 1, longest: 1 });

    await svc.completeChore(actor(TEEN), OCCURRENCE);
    expect(store.streaks.get(TEEN)).toMatchObject({ current: 1 });
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

  it('reverses with compensating entries rather than deletes', async () => {
    putOccurrence({ assigneeId: TEEN, points: 10 });
    const svc = service();
    await svc.completeChore(actor(TEEN), OCCURRENCE);

    await svc.uncompleteChore(actor(ADULT, ['task:complete:any']), OCCURRENCE);

    expect(balanceOf(TEEN)).toBe(0);
    // Nothing was removed: the history still shows the award and the reversal.
    expect(store.ledger).toHaveLength(4);
    expect(store.ledger.filter((e) => e.reason === 'penalty')).toHaveLength(2);
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
      bonusPoints: 2,
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
    const input = { occurrenceId: OCCURRENCE, toUserId: CHILD, bonusPoints: 0 };

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
        bonusPoints: 0,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('needs an adult to accept a handoff, but not to decline one', async () => {
    putOccurrence({ assigneeId: TEEN });
    const svc = service();
    const swap = await svc.swaps.request(actor(TEEN, ['task:update:own']), {
      occurrenceId: OCCURRENCE,
      toUserId: CHILD,
      bonusPoints: 0,
    });

    await expect(
      svc.swaps.respond(actor(CHILD, ['task:update:own']), swap.id, { accept: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const declined = await svc.swaps.respond(actor(CHILD, ['task:update:own']), swap.id, {
      accept: false,
    });
    expect(declined.status).toBe('declined');
  });

  it('rewrites only the assignee on acceptance — no points move yet', async () => {
    putOccurrence({ assigneeId: TEEN });
    const svc = service();
    const swap = await svc.swaps.request(actor(TEEN, ['task:update:own']), {
      occurrenceId: OCCURRENCE,
      toUserId: CHILD,
      bonusPoints: 3,
    });

    await svc.swaps.respond(actor(ADULT, ['task:assign:any', 'chore:swap:accept']), swap.id, { accept: true });

    expect(store.occurrences.get(OCCURRENCE)).toMatchObject({
      assigneeId: CHILD,
      assignedVia: 'swap',
    });
    expect(store.ledger).toHaveLength(0);
    expect(emitted.map((e) => e.type)).toEqual(['chore_swap_requested', 'chore_swap_answered']);
  });

  it('produces one winner and one 409 when two people answer the same offer', async () => {
    putOccurrence({ assigneeId: TEEN });
    const svc = service();
    const swap = await svc.swaps.request(actor(TEEN, ['task:update:own']), {
      occurrenceId: OCCURRENCE,
      bonusPoints: 0,
    });

    await svc.swaps.respond(actor(ADULT, ['task:assign:any', 'chore:swap:accept']), swap.id, { accept: true });
    await expect(
      svc.swaps.respond(actor(ADULT, ['task:assign:any', 'chore:swap:accept']), swap.id, { accept: true }),
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
/* Fairness summary                                                            */
/* -------------------------------------------------------------------------- */

describe('fairnessSummary — the neutral load bar', () => {
  it('compares each member to their own fair share and exposes no ranking', async () => {
    store.memberWeights.push(
      { userId: ADULT, weight: '1.00', position: 0 },
      { userId: CHILD, weight: '0.40', position: 1 },
    );
    store.fairness.push(
      { userId: ADULT, completed: 7, committed: 20, earned: 50, coveredForOthers: 1 },
      { userId: CHILD, completed: 3, committed: 10, earned: 18, coveredForOthers: 0 },
    );

    const summary = await new ChoresService(fakeDb, { now: () => T0 }).fairnessSummary({
      windowDays: 28,
    });

    const adult = summary.members.find((m) => m.userId === ADULT);
    const child = summary.members.find((m) => m.userId === CHILD);
    expect(adult?.fairShare).toBeCloseTo(1 / 1.4, 4);
    expect(child?.fairShare).toBeCloseTo(0.4 / 1.4, 4);
    expect(adult?.actualShare).toBeCloseTo(70 / 98, 4);
    // 70 points on one unit of weight and 28 on 0.4 of a unit is the *same*
    // load per unit — equal debt is the definition of balanced here, and the
    // family-level number says so with a single 0.
    expect(adult?.debt).toBe(70);
    expect(child?.debt).toBe(70);
    expect(summary.imbalance).toBeCloseTo(0, 4);

    // No rank field, anywhere, ever (D5).
    for (const member of summary.members) {
      expect(Object.keys(member)).not.toContain('rank');
    }
  });

  it('reports everybody at their fair share on a week with no load at all', async () => {
    store.memberWeights.push(
      { userId: ADULT, weight: '1.00', position: 0 },
      { userId: CHILD, weight: '1.00', position: 1 },
    );
    store.fairness.push(
      { userId: ADULT, completed: 0, committed: 0, earned: 0, coveredForOthers: 0 },
      { userId: CHILD, completed: 0, committed: 0, earned: 0, coveredForOthers: 0 },
    );

    const summary = await new ChoresService(fakeDb, { now: () => T0 }).fairnessSummary({
      windowDays: 7,
    });

    expect(summary.members.map((m) => m.actualShare)).toEqual([0.5, 0.5]);
    expect(summary.imbalance).toBe(0);
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
          earned: 0,
          committed: 0,
          lastAssignedAt: null,
          blackouts: [],
        },
        {
          userId: TEEN,
          weight: 1,
          position: 1,
          active: true,
          earned: 0,
          committed: 0,
          lastAssignedAt: null,
          blackouts: [],
        },
      ],
    });
    return {
      rotationId: ROTATION,
      strategy: 'weighted_balance',
      assign: (at, points) => {
        const pick = planner.assign(at, points);
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
      decorate: rotationDecorator(run(), 10),
    });
    const before = port.assignees();
    expect(first.inserted).toBeGreaterThan(10);
    expect(before.every((a) => a === ADULT || a === TEEN)).toBe(true);

    // Second pass, deliberately with a *fresh* rotation run whose roster has
    // moved on — exactly what a horizon extension a week later looks like.
    const second = await materializeThroughPort(port, series.id, {
      now,
      horizonDays: 14,
      decorate: rotationDecorator(run(1), 10),
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
      decorate: rotationDecorator(run(), 10),
    });
    const before = port.assignees();

    await materializeThroughPort(port, series.id, {
      now,
      horizonDays: 21,
      decorate: rotationDecorator(run(), 10),
    });

    expect(port.assignees().slice(0, before.length)).toEqual(before);
    expect(port.rows.size).toBeGreaterThan(before.length);
  });

  it('alternates fairly across the horizon rather than dumping it on one person', async () => {
    const port = new FakeOccurrenceStore(series);
    await materializeThroughPort(port, series.id, {
      now: new Date('2026-09-06T00:00:00.000Z'),
      horizonDays: 20,
      decorate: rotationDecorator(run(), 10),
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
          earned: 0,
          committed: 0,
          lastAssignedAt: null,
          blackouts: [],
        },
      ],
    });
    const anyoneRun: AssignmentRun = {
      rotationId: ROTATION,
      strategy: 'anyone',
      assign: (at, points) => {
        const pick = planner.assign(at, points);
        return { assigneeId: pick.userId, assignedVia: pick.assignedVia, debt: pick.debt };
      },
      commit: () => Promise.resolve(),
    };

    await materializeThroughPort(port, series.id, {
      now: new Date('2026-09-06T00:00:00.000Z'),
      horizonDays: 10,
      decorate: rotationDecorator(anyoneRun, 10),
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
  it('round-trips and rejects rubbish', async () => {
    const actual = await vi.importActual<typeof RealChoresRepo>('./chores.repository.js');
    const row = { createdAt: T0, id: OCCURRENCE };
    expect(actual.decodeCursor(actual.encodeCursor(row))).toEqual(row);
    expect(() => actual.decodeCursor('not-a-cursor')).toThrow();
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
 * These cover the two things the fake above cannot honestly reproduce: the
 * fairness roster SQL and the partial unique indexes that make the whole
 * idempotency story true rather than merely intended.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('chores against Postgres', () => {
  it('computes earned and committed for a roster in one query', async () => {
    const actual = await vi.importActual<typeof RealChoresRepo>('./chores.repository.js');
    const { createDbClient } = await import('../../core/db.js');
    const { users } = await import('../identity/users.schema.js');
    const { rotationMembers, rotations, pointsLedger } = await import('./chores.schema.js');
    const { eq } = await import('drizzle-orm');

    const created = createDbClient(TEST_DATABASE_URL);
    const db = created.db;
    try {
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
      await db
        .insert(pointsLedger)
        .values({ userId: member.id, delta: 12, reason: 'chore_completed' });
      // Outside the debt reasons — must not count towards `earned`.
      await db.insert(pointsLedger).values({ userId: member.id, delta: 99, reason: 'manual_award' });

      const roster = await actual.loadRotationRoster(db, rotation.id, {
        now: new Date(),
        through: new Date(Date.now() + 7 * DAY),
        windowDays: 28,
      });

      expect(roster).toHaveLength(1);
      expect(roster[0]?.earned).toBe(12);
      expect(roster[0]?.committed).toBe(0);
      expect(roster[0]?.weight).toBe(0.5);

      await db.delete(pointsLedger).where(eq(pointsLedger.userId, member.id));
      await db.delete(rotations).where(eq(rotations.id, rotation.id));
      await db.delete(users).where(eq(users.id, member.id));
    } finally {
      await created.sql.end({ timeout: 5 });
    }
  });

  it('refuses a second chore_completed award for the same occurrence and user', async () => {
    const actual = await vi.importActual<typeof RealChoresRepo>('./chores.repository.js');
    const { createDbClient } = await import('../../core/db.js');
    const { users } = await import('../identity/users.schema.js');
    const { pointsLedger } = await import('./chores.schema.js');
    const { eq } = await import('drizzle-orm');

    const created = createDbClient(TEST_DATABASE_URL);
    const db = created.db;
    try {
      const [member] = await db
        .insert(users)
        .values({ displayName: 'Тест-очки', role: 'teen', status: 'active' })
        .returning();
      if (!member) throw new Error('could not seed a test user');

      // A NULL occurrence sits outside the partial index, so both rows land —
      // which is the discretionary-award escape hatch working as designed.
      const first = await actual.insertLedgerEntry(db, {
        userId: member.id,
        delta: 5,
        reason: 'manual_award',
      });
      const second = await actual.insertLedgerEntry(db, {
        userId: member.id,
        delta: 5,
        reason: 'manual_award',
      });
      expect(first).toBeDefined();
      expect(second).toBeDefined();

      await db.delete(pointsLedger).where(eq(pointsLedger.userId, member.id));
      await db.delete(users).where(eq(users.id, member.id));
    } finally {
      await created.sql.end({ timeout: 5 });
    }
  });
});
