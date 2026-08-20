import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { SwapStatus } from '@family/shared';

import type { Executor } from '../../core/db.js';
import { ts } from '../../core/sql.js';
import {
  decodeTimestampCursor,
  encodeTimestampCursor,
  toTimestampPage,
  type Timestamped,
  type TimestampCursor,
} from '../../core/pagination.js';

import { internal } from '../../core/errors.js';
import { taskOccurrences, taskSeries } from '../tasks/tasks.schema.js';
import {
  choreSwaps,
  kudos,
  rotationMembers,
  rotations,
  userBlackouts,
  type ChoreSwapRow,
  type KudosRow,
  type NewChoreSwapRow,
  type NewKudosRow,
  type RotationMemberRow,
  type RotationRow,
  type UserBlackoutRow,
} from './chores.schema.js';
import type { BlackoutWindow, RotationCandidate } from './rotation.js';

/**
 * Chores data access. No HTTP, no business rules (D8).
 *
 * Every function takes an {@link Executor} first so the service can run it
 * inside a transaction — which matters more here than anywhere else in the
 * codebase, because assignment happens *inside* the materializer's transaction.
 *
 * This module reads `task_occurrences` / `task_series` directly. That is
 * allowed and deliberate: D8 forbids importing another module's **repository**,
 * not its schema, and `chores.schema.ts` already references `task_occurrences`
 * for swaps and kudos. The dependency runs one way only — the tasks module
 * reaches chores through the `RotationPort` service seam.
 *
 * The interesting query is {@link loadRotationRoster}: `completed` and
 * `committed` are counted in SQL, in one round trip, because the materializer
 * calls it once per series and an N+1 there would be a per-series stall inside
 * a `FOR UPDATE` lock. Both are counts of `task_occurrences` rows — there is no
 * ledger any more, and that is the point (D5).
 */

/* -------------------------------------------------------------------------- */
/* Keyset pagination                                                           */
/* -------------------------------------------------------------------------- */

export type Cursor = TimestampCursor;

/**
 * Opaque keyset cursor over `(created_at, id)` — `core/pagination.ts`.
 *
 * The codec used to be written out here (and in six other modules) as
 * `base64url("iso|id")` that **threw `400 Malformed cursor`** on anything it
 * could not read. It is the shared `{ v, id }` JSON form now, and a stale
 * cursor quietly restarts at the first page instead of erroring — a bookmarked
 * page-2 link is not the user doing something wrong.
 */
export function encodeCursor(row: Timestamped): string {
  return encodeTimestampCursor(row);
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  return decodeTimestampCursor(raw) ?? undefined;
}

/** Splits an over-fetched `limit + 1` result into a page plus the next cursor. */
export function toPage<T extends Timestamped>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  return toTimestampPage(rows, limit);
}

/* -------------------------------------------------------------------------- */
/* Rotations                                                                   */
/* -------------------------------------------------------------------------- */

export async function insertRotation(
  ex: Executor,
  values: { name: string; strategy: RotationRow['strategy']; balanceWindowDays: number },
): Promise<RotationRow> {
  const [row] = await ex.insert(rotations).values(values).returning();
  if (!row) throw internal('rotations insert returned no row');
  return row;
}

export async function findRotationById(ex: Executor, id: string): Promise<RotationRow | undefined> {
  const [row] = await ex.select().from(rotations).where(eq(rotations.id, id)).limit(1);
  return row;
}

/** `SELECT ... FOR UPDATE`, so a concurrent materialization serialises behind us. */
export async function lockRotation(ex: Executor, id: string): Promise<RotationRow | undefined> {
  const [row] = await ex
    .select()
    .from(rotations)
    .where(eq(rotations.id, id))
    .limit(1)
    .for('update');
  return row;
}

export async function listRotations(
  ex: Executor,
  options: { limit: number; cursor?: Cursor | undefined; strategy?: RotationRow['strategy'] },
): Promise<RotationRow[]> {
  const filters = [
    options.strategy ? eq(rotations.strategy, options.strategy) : undefined,
    options.cursor
      ? or(
          lt(rotations.createdAt, options.cursor.createdAt),
          and(
            eq(rotations.createdAt, options.cursor.createdAt),
            lt(rotations.id, options.cursor.id),
          ),
        )
      : undefined,
  ].filter((f) => f !== undefined);

  return ex
    .select()
    .from(rotations)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(rotations.createdAt), desc(rotations.id))
    .limit(options.limit + 1);
}

export type RotationPatch = Partial<
  Pick<RotationRow, 'name' | 'strategy' | 'balanceWindowDays' | 'cursor'>
>;

export async function updateRotation(
  ex: Executor,
  id: string,
  patch: RotationPatch,
): Promise<RotationRow | undefined> {
  if (Object.keys(patch).length === 0) return findRotationById(ex, id);
  const [row] = await ex
    .update(rotations)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(rotations.id, id))
    .returning();
  return row;
}

/** Round-robin cursor write-back. Kept separate so a run can skip it entirely. */
export async function setRotationCursor(ex: Executor, id: string, cursor: number): Promise<void> {
  await ex.update(rotations).set({ cursor, updatedAt: new Date() }).where(eq(rotations.id, id));
}

export async function deleteRotation(ex: Executor, id: string): Promise<boolean> {
  const rows = await ex
    .delete(rotations)
    .where(eq(rotations.id, id))
    .returning({ id: rotations.id });
  return rows.length > 0;
}

/**
 * How many live series pick their assignee from this rotation.
 *
 * `task_series.rotation_id` deliberately has **no** foreign key (it would make
 * the tasks ⇄ chores import cycle bidirectional), so referential integrity is
 * this function's job: the service refuses a delete while the count is > 0.
 */
export async function countSeriesUsingRotation(ex: Executor, rotationId: string): Promise<number> {
  const [row] = await ex
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(taskSeries)
    .where(and(eq(taskSeries.rotationId, rotationId), isNull(taskSeries.archivedAt)));
  return row?.count ?? 0;
}

export async function listSeriesIdsUsingRotation(
  ex: Executor,
  rotationId: string,
): Promise<string[]> {
  const rows = await ex
    .select({ id: taskSeries.id })
    .from(taskSeries)
    .where(and(eq(taskSeries.rotationId, rotationId), isNull(taskSeries.archivedAt)));
  return rows.map((r) => r.id);
}

/* -------------------------------------------------------------------------- */
/* Rotation members                                                            */
/* -------------------------------------------------------------------------- */

export async function findRotationMembers(
  ex: Executor,
  rotationId: string,
): Promise<RotationMemberRow[]> {
  return ex
    .select()
    .from(rotationMembers)
    .where(eq(rotationMembers.rotationId, rotationId))
    .orderBy(asc(rotationMembers.position), asc(rotationMembers.userId));
}

export async function findRotationMembersFor(
  ex: Executor,
  rotationIds: readonly string[],
): Promise<RotationMemberRow[]> {
  if (rotationIds.length === 0) return [];
  return ex
    .select()
    .from(rotationMembers)
    .where(inArray(rotationMembers.rotationId, [...rotationIds]))
    .orderBy(asc(rotationMembers.position), asc(rotationMembers.userId));
}

export interface RotationMemberInputRow {
  userId: string;
  weight: string;
  position: number;
  active: boolean;
}

/**
 * Full replacement of a member set.
 *
 * Deletes then inserts inside the caller's transaction rather than diffing:
 * the set is at most 50 rows, and a diff would have to reason about a member
 * who was removed and re-added in one request. Past assignments and their
 * attribution are untouched either way — they hang off `users`, not off this
 * table.
 */
export async function replaceRotationMembers(
  ex: Executor,
  rotationId: string,
  members: readonly RotationMemberInputRow[],
): Promise<RotationMemberRow[]> {
  await ex.delete(rotationMembers).where(eq(rotationMembers.rotationId, rotationId));
  if (members.length === 0) return [];
  return ex
    .insert(rotationMembers)
    .values(members.map((m) => ({ ...m, rotationId })))
    .returning();
}

/* -------------------------------------------------------------------------- */
/* Blackouts                                                                   */
/* -------------------------------------------------------------------------- */

export async function insertBlackout(
  ex: Executor,
  values: { userId: string; startsAt: Date; endsAt: Date; reason: string | null },
): Promise<UserBlackoutRow> {
  const [row] = await ex.insert(userBlackouts).values(values).returning();
  if (!row) throw internal('user_blackouts insert returned no row');
  return row;
}

export async function findBlackoutById(
  ex: Executor,
  id: string,
): Promise<UserBlackoutRow | undefined> {
  const [row] = await ex.select().from(userBlackouts).where(eq(userBlackouts.id, id)).limit(1);
  return row;
}

export async function deleteBlackout(ex: Executor, id: string): Promise<boolean> {
  const rows = await ex
    .delete(userBlackouts)
    .where(eq(userBlackouts.id, id))
    .returning({ id: userBlackouts.id });
  return rows.length > 0;
}

export async function listBlackouts(
  ex: Executor,
  options: {
    limit: number;
    cursor?: Cursor | undefined;
    userId?: string;
    includePast: boolean;
    now: Date;
  },
): Promise<UserBlackoutRow[]> {
  const filters = [
    options.userId ? eq(userBlackouts.userId, options.userId) : undefined,
    options.includePast ? undefined : gte(userBlackouts.endsAt, options.now),
    options.cursor
      ? or(
          lt(userBlackouts.createdAt, options.cursor.createdAt),
          and(
            eq(userBlackouts.createdAt, options.cursor.createdAt),
            lt(userBlackouts.id, options.cursor.id),
          ),
        )
      : undefined,
  ].filter((f) => f !== undefined);

  return ex
    .select()
    .from(userBlackouts)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(userBlackouts.createdAt), desc(userBlackouts.id))
    .limit(options.limit + 1);
}

/**
 * Every blackout of the given members that could overlap `[from, to)`.
 *
 * Loaded once per materialization run and handed to the pure planner, so the
 * per-occurrence eligibility check costs no I/O — which is what lets the
 * `decorate` seam stay synchronous.
 */
export async function findBlackoutsForUsers(
  ex: Executor,
  userIds: readonly string[],
  window: { from: Date; to: Date },
): Promise<Map<string, BlackoutWindow[]>> {
  const out = new Map<string, BlackoutWindow[]>();
  if (userIds.length === 0) return out;

  const rows = await ex
    .select({
      userId: userBlackouts.userId,
      startsAt: userBlackouts.startsAt,
      endsAt: userBlackouts.endsAt,
    })
    .from(userBlackouts)
    .where(
      and(
        inArray(userBlackouts.userId, [...userIds]),
        lt(userBlackouts.startsAt, window.to),
        gte(userBlackouts.endsAt, window.from),
      ),
    );

  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push({ startsAt: row.startsAt, endsAt: row.endsAt });
    out.set(row.userId, list);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The fairness roster — the one query this module exists for                  */
/* -------------------------------------------------------------------------- */

interface RosterRow {
  [column: string]: unknown;
  user_id: string;
  weight: string;
  position: number;
  active: boolean;
  completed: string | number | null;
  committed: string | number | null;
  last_assigned_at: Date | string | null;
}

function toNumber(value: string | number | null): number {
  if (value === null) return 0;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

export interface RosterOptions {
  /** Instant the run is planned from. Blackouts are loaded from here forward. */
  readonly now: Date;
  /** Lookback for `completed`. Defaults to the rotation's `balanceWindowDays`. */
  readonly windowDays: number;
  /** How far ahead blackouts must be loaded — the materialization horizon. */
  readonly through: Date;
}

/**
 * The whole roster with its debt inputs, in one round trip.
 *
 * ```
 * completed = COUNT(task_occurrences) done by them inside the balance window
 * committed = COUNT(still-`scheduled` occurrences already assigned to them)
 * debt      = (completed + committed) / weight     -- computed in `rotation.ts`
 * ```
 *
 * Four deliberate choices:
 *
 * - Both terms are **counts of chores**, not sums of points. There is no points
 *   ledger to read any more (D5): a per-person balance is a leaderboard however
 *   it is labelled, so fairness is measured in "how many did you do".
 * - `completed` counts rows, which makes it **idempotent for free**. An
 *   occurrence can be `done` exactly once, so a double tap or an offline replay
 *   cannot inflate anybody's share the way a second ledger row could.
 * - `committed` is not clipped to the balance window at its *upper* end. Every
 *   still-scheduled row from the window start onwards counts, because work
 *   already promised for next month is real load — clipping it would let one
 *   pass hand out the far end of the horizon for free.
 * - `last_assigned_at` is `MAX(starts_at)` over **all** their assignments, not
 *   just the window: "longest since their last assignment" is meaningless if it
 *   resets every 28 days.
 */
export async function loadRotationRoster(
  ex: Executor,
  rotationId: string,
  options: RosterOptions,
): Promise<RotationCandidate[]> {
  const windowStart = new Date(options.now.getTime() - options.windowDays * 86_400_000);

  const rows = await ex.execute<RosterRow>(sql`
    select
      rm.user_id                     as user_id,
      rm.weight                      as weight,
      rm.position                    as position,
      rm.active                      as active,
      coalesce(completed.total, 0)   as completed,
      coalesce(committed.total, 0)   as committed,
      last_assigned.at               as last_assigned_at
    from rotation_members rm
    left join lateral (
      select count(*) as total
      from task_occurrences o
      where o.completed_by_id = rm.user_id
        and o.status = 'done'
        and o.completed_at >= ${ts(windowStart)}
    ) completed on true
    left join lateral (
      select count(*) as total
      from task_occurrences o
      where o.assignee_id = rm.user_id
        and o.status = 'scheduled'
        and o.due_at >= ${ts(windowStart)}
    ) committed on true
    left join lateral (
      select max(o2.starts_at) as at
      from task_occurrences o2
      where o2.assignee_id = rm.user_id
    ) last_assigned on true
    where rm.rotation_id = ${rotationId}
    order by rm.position asc, rm.user_id asc
  `);

  const blackouts = await findBlackoutsForUsers(
    ex,
    rows.map((r) => r.user_id),
    { from: options.now, to: options.through },
  );

  return rows.map((row) => ({
    userId: row.user_id,
    weight: toNumber(row.weight),
    position: row.position,
    active: row.active,
    completed: toNumber(row.completed),
    committed: toNumber(row.committed),
    lastAssignedAt: toDate(row.last_assigned_at),
    blackouts: blackouts.get(row.user_id) ?? [],
  }));
}

/* -------------------------------------------------------------------------- */
/* Occurrences (read-only view for the chores module)                          */
/* -------------------------------------------------------------------------- */

/**
 * The occurrence fields chores cares about, with `COALESCE(override, series)`
 * already resolved so nothing above this layer sees a raw override column
 * (`docs/architecture/scheduling.md` §9).
 */
export interface ChoreOccurrence {
  readonly id: string;
  readonly seriesId: string;
  readonly title: string;
  readonly status: 'scheduled' | 'done' | 'skipped' | 'cancelled';
  readonly startsAt: Date;
  readonly dueAt: Date;
  readonly graceMinutes: number;
  readonly assigneeId: string | null;
  readonly assignedVia: 'rotation' | 'manual' | 'swap' | 'claimed' | null;
  readonly completedById: string | null;
  readonly completedAt: Date | null;
  readonly rotationId: string | null;
}

const occurrenceSelection = {
  id: taskOccurrences.id,
  seriesId: taskOccurrences.seriesId,
  title: sql<string>`coalesce(${taskOccurrences.titleOverride}, ${taskSeries.title})`,
  status: taskOccurrences.status,
  startsAt: taskOccurrences.startsAt,
  dueAt: taskOccurrences.dueAt,
  graceMinutes: taskSeries.graceMinutes,
  assigneeId: taskOccurrences.assigneeId,
  assignedVia: taskOccurrences.assignedVia,
  completedById: taskOccurrences.completedById,
  completedAt: taskOccurrences.completedAt,
  rotationId: taskSeries.rotationId,
};

export async function findOccurrence(
  ex: Executor,
  id: string,
): Promise<ChoreOccurrence | undefined> {
  const [row] = await ex
    .select(occurrenceSelection)
    .from(taskOccurrences)
    .innerJoin(taskSeries, eq(taskSeries.id, taskOccurrences.seriesId))
    .where(eq(taskOccurrences.id, id))
    .limit(1);
  return row;
}

export async function findOccurrences(
  ex: Executor,
  ids: readonly string[],
): Promise<ChoreOccurrence[]> {
  if (ids.length === 0) return [];
  return ex
    .select(occurrenceSelection)
    .from(taskOccurrences)
    .innerJoin(taskSeries, eq(taskSeries.id, taskOccurrences.seriesId))
    .where(inArray(taskOccurrences.id, [...ids]));
}

/**
 * Rewrite the assignee only. Used by swap acceptance, which happens *before*
 * the chore is done — the rotation counts a completion against whoever actually
 * did it, so a reassignment has no consequence beyond this one column (D5).
 */
export async function reassignOccurrence(
  ex: Executor,
  occurrenceId: string,
  assigneeId: string,
  via: 'swap' | 'manual',
): Promise<boolean> {
  const rows = await ex
    .update(taskOccurrences)
    .set({ assigneeId, assignedVia: via })
    .where(and(eq(taskOccurrences.id, occurrenceId), eq(taskOccurrences.status, 'scheduled')))
    .returning({ id: taskOccurrences.id });
  return rows.length > 0;
}

/**
 * Conditional completion: `WHERE status = 'scheduled'`.
 *
 * Returning zero rows is not an error — it is the second tap, the offline
 * queue replaying, or the retry after a timeout. The service turns that into
 * "already done" rather than a second award.
 */
export async function markOccurrenceDone(
  ex: Executor,
  occurrenceId: string,
  completedById: string,
  completedAt: Date,
): Promise<boolean> {
  const rows = await ex
    .update(taskOccurrences)
    .set({ status: 'done', completedById, completedAt })
    .where(and(eq(taskOccurrences.id, occurrenceId), eq(taskOccurrences.status, 'scheduled')))
    .returning({ id: taskOccurrences.id });
  return rows.length > 0;
}

/**
 * Reopen a completed occurrence.
 *
 * Nothing else needs correcting: fairness counts `status = 'done'` rows, so
 * moving this one out of `done` removes it from every count in the same
 * statement.
 */
export async function markOccurrenceScheduled(
  ex: Executor,
  occurrenceId: string,
): Promise<boolean> {
  const rows = await ex
    .update(taskOccurrences)
    .set({ status: 'scheduled', completedById: null, completedAt: null })
    .where(and(eq(taskOccurrences.id, occurrenceId), eq(taskOccurrences.status, 'done')))
    .returning({ id: taskOccurrences.id });
  return rows.length > 0;
}

/** Still-`scheduled` future occurrences of a rotation's series, in key order. */
export async function listFutureRotationOccurrences(
  ex: Executor,
  rotationId: string,
  from: Date,
): Promise<Array<{ id: string; startsAt: Date }>> {
  return ex
    .select({
      id: taskOccurrences.id,
      startsAt: taskOccurrences.startsAt,
    })
    .from(taskOccurrences)
    .innerJoin(taskSeries, eq(taskSeries.id, taskOccurrences.seriesId))
    .where(
      and(
        eq(taskSeries.rotationId, rotationId),
        eq(taskOccurrences.status, 'scheduled'),
        eq(taskOccurrences.isException, false),
        gte(taskOccurrences.startsAt, from),
      ),
    )
    .orderBy(asc(taskOccurrences.startsAt), asc(taskOccurrences.id));
}

/* -------------------------------------------------------------------------- */
/* Swaps                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Insert a swap, letting `chore_swaps_one_pending_uq` arbitrate.
 *
 * Two taps on a flaky mobile connection must not create two live offers, and
 * the partial unique index is the only place that can guarantee it. A conflict
 * comes back as `undefined`, which the service turns into a clean `409`.
 */
export async function insertSwap(
  ex: Executor,
  values: NewChoreSwapRow,
): Promise<ChoreSwapRow | undefined> {
  const [row] = await ex.insert(choreSwaps).values(values).onConflictDoNothing().returning();
  return row;
}

export async function findSwapById(ex: Executor, id: string): Promise<ChoreSwapRow | undefined> {
  const [row] = await ex.select().from(choreSwaps).where(eq(choreSwaps.id, id)).limit(1);
  return row;
}

export async function findPendingSwapForOccurrence(
  ex: Executor,
  occurrenceId: string,
): Promise<ChoreSwapRow | undefined> {
  const [row] = await ex
    .select()
    .from(choreSwaps)
    .where(and(eq(choreSwaps.occurrenceId, occurrenceId), eq(choreSwaps.status, 'pending')))
    .limit(1);
  return row;
}

export async function findAcceptedSwapForOccurrence(
  ex: Executor,
  occurrenceId: string,
): Promise<ChoreSwapRow | undefined> {
  const [row] = await ex
    .select()
    .from(choreSwaps)
    .where(and(eq(choreSwaps.occurrenceId, occurrenceId), eq(choreSwaps.status, 'accepted')))
    .orderBy(desc(choreSwaps.createdAt))
    .limit(1);
  return row;
}

/**
 * Conditional status transition: `WHERE status = 'pending'`.
 *
 * Two people tapping "accept" on the same open offer produces one winner and
 * one `undefined` — which the service reports as `409`, not as a silent
 * second reassignment.
 */
export async function transitionSwap(
  ex: Executor,
  id: string,
  next: Exclude<SwapStatus, 'pending'>,
  by: { respondedById: string | null; respondedAt: Date },
): Promise<ChoreSwapRow | undefined> {
  const [row] = await ex
    .update(choreSwaps)
    .set({ status: next, respondedById: by.respondedById, respondedAt: by.respondedAt })
    .where(and(eq(choreSwaps.id, id), eq(choreSwaps.status, 'pending')))
    .returning();
  return row;
}

/** The nightly sweep. Bulk, conditional, and safe to run twice. */
export async function expirePendingSwaps(ex: Executor, now: Date): Promise<ChoreSwapRow[]> {
  return ex
    .update(choreSwaps)
    .set({ status: 'expired', respondedAt: now })
    .where(
      and(
        eq(choreSwaps.status, 'pending'),
        sql`${choreSwaps.expiresAt} is not null`,
        lt(choreSwaps.expiresAt, now),
      ),
    )
    .returning();
}

export interface SwapWithOccurrence extends ChoreSwapRow {
  occurrenceTitle: string;
  occurrenceDueAt: Date;
}

export async function listSwaps(
  ex: Executor,
  options: {
    limit: number;
    cursor?: Cursor | undefined;
    statuses?: readonly SwapStatus[] | undefined;
    direction: 'incoming' | 'outgoing' | 'all';
    userId: string;
    /** `true` widens `all` to the whole family (an adult triaging handoffs). */
    seeEverything: boolean;
  },
): Promise<SwapWithOccurrence[]> {
  const directionFilter = (() => {
    switch (options.direction) {
      case 'outgoing':
        return eq(choreSwaps.fromUserId, options.userId);
      case 'incoming':
        // Addressed to me, or an open offer anybody may take.
        return or(eq(choreSwaps.toUserId, options.userId), isNull(choreSwaps.toUserId));
      case 'all':
        return options.seeEverything
          ? undefined
          : or(
              eq(choreSwaps.fromUserId, options.userId),
              eq(choreSwaps.toUserId, options.userId),
              isNull(choreSwaps.toUserId),
            );
    }
  })();

  const filters = [
    directionFilter,
    options.statuses?.length ? inArray(choreSwaps.status, [...options.statuses]) : undefined,
    options.cursor
      ? or(
          lt(choreSwaps.createdAt, options.cursor.createdAt),
          and(
            eq(choreSwaps.createdAt, options.cursor.createdAt),
            lt(choreSwaps.id, options.cursor.id),
          ),
        )
      : undefined,
  ].filter((f) => f !== undefined);

  return ex
    .select({
      id: choreSwaps.id,
      occurrenceId: choreSwaps.occurrenceId,
      fromUserId: choreSwaps.fromUserId,
      toUserId: choreSwaps.toUserId,
      status: choreSwaps.status,
      message: choreSwaps.message,
      respondedById: choreSwaps.respondedById,
      respondedAt: choreSwaps.respondedAt,
      expiresAt: choreSwaps.expiresAt,
      createdAt: choreSwaps.createdAt,
      occurrenceTitle: sql<string>`coalesce(${taskOccurrences.titleOverride}, ${taskSeries.title})`,
      occurrenceDueAt: taskOccurrences.dueAt,
    })
    .from(choreSwaps)
    .innerJoin(taskOccurrences, eq(taskOccurrences.id, choreSwaps.occurrenceId))
    .innerJoin(taskSeries, eq(taskSeries.id, taskOccurrences.seriesId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(choreSwaps.createdAt), desc(choreSwaps.id))
    .limit(options.limit + 1);
}

/* -------------------------------------------------------------------------- */
/* Kudos                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `kudos_from_occurrence_emoji_uq` makes a repeated clap a no-op rather than a
 * tally. `undefined` back means "already given" — a `409` for a human request,
 * and simply nothing for the auto-kudos on a covered chore.
 */
export async function insertKudos(
  ex: Executor,
  values: NewKudosRow,
): Promise<KudosRow | undefined> {
  const [row] = await ex.insert(kudos).values(values).onConflictDoNothing().returning();
  return row;
}

export async function listKudos(
  ex: Executor,
  options: {
    limit: number;
    cursor?: Cursor | undefined;
    toUserId?: string | undefined;
    occurrenceId?: string | undefined;
  },
): Promise<KudosRow[]> {
  const filters = [
    options.toUserId ? eq(kudos.toUserId, options.toUserId) : undefined,
    options.occurrenceId ? eq(kudos.occurrenceId, options.occurrenceId) : undefined,
    options.cursor
      ? or(
          lt(kudos.createdAt, options.cursor.createdAt),
          and(eq(kudos.createdAt, options.cursor.createdAt), lt(kudos.id, options.cursor.id)),
        )
      : undefined,
  ].filter((f) => f !== undefined);

  return ex
    .select()
    .from(kudos)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(kudos.createdAt), desc(kudos.id))
    .limit(options.limit + 1);
}
