import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';

import { percentOf as sharedPercentOf } from '@family/shared';
import { decodeCursor, encodeCursor, type Cursor } from '../../core/pagination.js';
import type { GoalStatus, GoalTxnKind, GoalVisibility } from '@family/shared';

import type { Executor } from '../../core/db.js';
import { internal } from '../../core/errors.js';
import {
  goalMilestones,
  goalTransactions,
  savingsGoals,
  type GoalMilestoneRow,
  type GoalTransactionRow,
  type NewGoalMilestoneRow,
  type NewGoalTransactionRow,
  type NewSavingsGoalRow,
  type SavingsGoalRow,
} from './goals.schema.js';

/**
 * Moneybox data access. No HTTP knowledge, no business rules (D8).
 *
 * Every function takes an {@link Executor} first, so the same call works on the
 * pool handle or inside an open transaction — the ledger writes in
 * `goals.service.ts` need the latter.
 *
 * ## The one invariant this file exists to protect
 *
 * **A goal's balance is `SUM(delta)` over `goal_transactions`. Always.**
 * There is no cached column, no counter, no materialized total (D6, and
 * `docs/architecture/household.md` §2.3). Every read path here derives it, and
 * every write path here is an `INSERT` — the ledger is never `UPDATE`d or
 * `DELETE`d.
 *
 * The projection is a `LEFT JOIN LATERAL` on to the goal row rather than a
 * per-goal follow-up query: a list of twenty goals costs one round trip, not
 * twenty-one. Postgres evaluates the lateral once per goal row against
 * `goal_transactions_goal_occurred_idx`.
 *
 * ## Money never touches a float
 *
 * `SUM(bigint)` comes back from Postgres as `numeric`, which `postgres.js`
 * hands over as a **string**. Casting to `::bigint` in SQL and parsing with
 * {@link toMinorUnits} keeps the value an exact integer end to end; nothing in
 * this module ever calls `parseFloat`, `Number()` on a decimal, or divides
 * before the wire.
 */

/* -------------------------------------------------------------------------- */
/* Integer-minor-unit boundary                                                 */
/* -------------------------------------------------------------------------- */

const INTEGER_TEXT = /^-?\d+$/;

/**
 * Normalizes whatever the driver produced for a money column into an exact
 * integer number of minor units.
 *
 * Throws rather than coercing: a fractional копейка arriving from the database
 * means somebody wrote a `numeric` where a `bigint` belongs, and silently
 * rounding it would be the first step of the drift D6 exists to prevent.
 */
export function toMinorUnits(value: string | number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;

  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw internal(`Money value ${value.toString()} exceeds the exact integer range`);
    }
    return Number(value);
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw internal(`Money value ${String(value)} is not an exact integer`);
    }
    return value;
  }

  const trimmed = value.trim();
  if (!INTEGER_TEXT.test(trimmed)) {
    throw internal(`Money value "${value}" is not an integer minor-unit literal`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw internal(`Money value "${value}" exceeds the exact integer range`);
  }
  return parsed;
}

function toCount(value: string | number | null | undefined): number {
  return toMinorUnits(value);
}

/**
 * `round(current / target * 100)` with **integer arithmetic only**.
 *
 * The definition now lives in `@family/shared` (`domain/percent.ts`) so the
 * dashboard, the goals screen and the shared formatter cannot round it
 * differently — they used to, and `285/1000` came out as 29 here and 28 there.
 * Re-exported under the repository's own name because
 * {@link PROGRESS_PERCENT_EXPR} mirrors it in SQL and the two belong side by
 * side; `goals.service.ts` re-exports it again as `progressPercent`.
 */
export const percentOf = sharedPercentOf;

/* -------------------------------------------------------------------------- */
/* Read scope                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Who is looking. `canReadAny` is the `:any`-equivalent authority described in
 * `household.md` §5 — see `GOAL_ADMIN_PERMISSION` in the service for how it is
 * derived from the (fixed) permission catalog.
 */
export interface GoalViewer {
  readonly userId: string;
  readonly canReadAny: boolean;
}

/**
 * Row-level narrowing for `private` goals.
 *
 * `visibility` is the shared three-value pgEnum (`household | private |
 * restricted`); goals only ever write the first two, and the filter is written
 * **allow-list style** so an unexpected third value fails closed rather than
 * leaking.
 */
export function goalVisibilityFilter(viewer: GoalViewer): SQL | undefined {
  if (viewer.canReadAny) return undefined;
  return or(
    eq(savingsGoals.visibility, 'household'),
    // A NULL owner can never match a non-null caller id, so a private family
    // goal (which the service refuses to create) stays invisible.
    eq(savingsGoals.ownerId, viewer.userId),
  );
}

function liveGoal(): SQL | undefined {
  return isNull(savingsGoals.deletedAt);
}

/* -------------------------------------------------------------------------- */
/* Balance projection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The lateral that turns the append-only ledger into a balance.
 *
 * Correlated on `savings_goals.id`, so it is evaluated per goal row of the
 * (already filtered and limited) outer query rather than over the whole table.
 */
const BALANCE_LATERAL = sql`(
  select
    coalesce(sum(${goalTransactions.delta}), 0)::bigint as amount,
    count(*)::int as txn_count
  from ${goalTransactions}
  where ${goalTransactions.goalId} = ${savingsGoals.id}
) as "gb"`;

/** `SUM(delta)`, in minor units, as text. */
const CURRENT_AMOUNT_EXPR = sql<string>`"gb"."amount"::text`;

/**
 * `round(current / target * 100)`, computed with **integer arithmetic only**:
 *
 * ```
 * round(c/t*100) == floor((c*200 + t) / (2t))
 * ```
 *
 * Floored at 0 but deliberately **not** capped at 100 — an over-funded goal
 * reads `112 %` (household.md §2.5). `target_amount > 0` is a table CHECK, so
 * the division is safe.
 */
const PROGRESS_PERCENT_EXPR = sql<number>`greatest(
  (("gb"."amount" * 200) + ${savingsGoals.targetAmount}) / (${savingsGoals.targetAmount} * 2),
  0
)::int`;

/** `target - current`, floored at 0. */
const REMAINING_AMOUNT_EXPR = sql<string>`greatest(${savingsGoals.targetAmount} - "gb"."amount", 0)::text`;

const GOAL_SELECTION = {
  id: savingsGoals.id,
  title: savingsGoals.title,
  description: savingsGoals.description,
  targetAmount: savingsGoals.targetAmount,
  currency: savingsGoals.currency,
  deadline: savingsGoals.deadline,
  imageUrl: savingsGoals.imageUrl,
  color: savingsGoals.color,
  icon: savingsGoals.icon,
  status: savingsGoals.status,
  visibility: savingsGoals.visibility,
  ownerId: savingsGoals.ownerId,
  createdById: savingsGoals.createdById,
  reachedAt: savingsGoals.reachedAt,
  sortOrder: savingsGoals.sortOrder,
  createdAt: savingsGoals.createdAt,
  updatedAt: savingsGoals.updatedAt,
  currentAmount: CURRENT_AMOUNT_EXPR,
  progressPercent: PROGRESS_PERCENT_EXPR,
  remainingAmount: REMAINING_AMOUNT_EXPR,
  transactionCount: sql<number>`"gb"."txn_count"`,
} as const;

/** A goal plus its derived money fields. The only shape the service hands out. */
export interface GoalProjection {
  id: string;
  title: string;
  description: string | null;
  targetAmount: number;
  /** Derived: `SUM(delta)`. Never read from a column. */
  currentAmount: number;
  progressPercent: number;
  remainingAmount: number;
  currency: string;
  deadline: string | null;
  imageUrl: string | null;
  color: string | null;
  icon: string | null;
  status: GoalStatus;
  visibility: GoalVisibility;
  ownerId: string | null;
  createdById: string;
  reachedAt: Date | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  /** Ledger row count — lets the service pick "archive" over "soft delete". */
  transactionCount: number;
}

type RawGoalProjection = {
  [K in keyof typeof GOAL_SELECTION]: unknown;
};

/**
 * The DB `visibility` enum has a third value (`restricted`) that goals never
 * write. Anything that is not `household` is treated as `private`, which is the
 * safe direction: an unknown value narrows access instead of widening it.
 */
function normalizeVisibility(value: unknown): GoalVisibility {
  return value === 'household' ? 'household' : 'private';
}

function mapGoal(row: RawGoalProjection): GoalProjection {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description ?? null) as string | null,
    targetAmount: toMinorUnits(row.targetAmount as number),
    currentAmount: toMinorUnits(row.currentAmount as string),
    progressPercent: toCount(row.progressPercent as number),
    remainingAmount: toMinorUnits(row.remainingAmount as string),
    currency: row.currency as string,
    deadline: (row.deadline ?? null) as string | null,
    imageUrl: (row.imageUrl ?? null) as string | null,
    color: (row.color ?? null) as string | null,
    icon: (row.icon ?? null) as string | null,
    status: row.status as GoalStatus,
    visibility: normalizeVisibility(row.visibility),
    ownerId: (row.ownerId ?? null) as string | null,
    createdById: row.createdById as string,
    reachedAt: (row.reachedAt ?? null) as Date | null,
    sortOrder: toCount(row.sortOrder as number),
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
    transactionCount: toCount(row.transactionCount as number),
  };
}

/* -------------------------------------------------------------------------- */
/* Cursor pagination                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Keyset cursors come from `core/pagination.ts`.
 *
 * The `{ v, id }` shape below was the goals module's own, and it is the form the
 * whole app converged on: `v` carries any sort key as text, which is what the
 * `sortOrder | deadline | progress | createdAt` orderings here need and what a
 * bare `createdAt|id` string could never express. The forgiving `null` on a
 * malformed cursor was this module's policy too, and is now everyone's.
 */
export { encodeCursor, decodeCursor };
export type { Cursor };

type SortField = 'sortOrder' | 'deadline' | 'progress' | 'createdAt';

interface SortSpec {
  /** Expression used both for `ORDER BY` and for the keyset comparison. */
  readonly key: SQL;
  /** Text projection of the key, stored in the cursor. */
  readonly keyText: SQL<string>;
  /** SQL cast applied to the cursor value so the row comparison type-checks. */
  readonly cast: string;
  readonly direction: 'asc' | 'desc';
}

const SORT_SPECS: Record<SortField, SortSpec> = {
  sortOrder: {
    key: sql`${savingsGoals.sortOrder}`,
    keyText: sql<string>`${savingsGoals.sortOrder}::text`,
    cast: 'int',
    direction: 'asc',
  },
  /** NULL deadlines sort last, which a sentinel expresses without `NULLS LAST`
   *  (a keyset comparison cannot see a `NULLS LAST` clause). */
  deadline: {
    key: sql`coalesce(${savingsGoals.deadline}, '9999-12-31'::date)`,
    keyText: sql<string>`coalesce(${savingsGoals.deadline}, '9999-12-31'::date)::text`,
    cast: 'date',
    direction: 'asc',
  },
  progress: {
    key: PROGRESS_PERCENT_EXPR,
    keyText: sql<string>`(${PROGRESS_PERCENT_EXPR})::text`,
    cast: 'int',
    direction: 'desc',
  },
  createdAt: {
    key: sql`${savingsGoals.createdAt}`,
    keyText: sql<string>`${savingsGoals.createdAt}::text`,
    cast: 'timestamptz',
    direction: 'desc',
  },
};

/**
 * Keyset predicate as a Postgres **row comparison** — `(key, id) > (v, id)`.
 *
 * The tiebreaker follows the primary direction on purpose: a mixed-direction
 * pair cannot be expressed as a row comparison, and an inconsistent tiebreak is
 * how a paginated list starts repeating rows.
 */
function keysetPredicate(spec: SortSpec, cursor: Cursor): SQL {
  const operator = spec.direction === 'asc' ? sql`>` : sql`<`;
  // The cursor value travels as text and is cast back to the key's own type, so
  // the comparison is done by Postgres in the right domain (date, int,
  // timestamptz) rather than lexicographically.
  const value = sql`${cursor.v}::text::${sql.raw(spec.cast)}`;
  return sql`(${spec.key}, ${savingsGoals.id}) ${operator} (${value}, ${cursor.id}::uuid)`;
}

/* -------------------------------------------------------------------------- */
/* Goals — reads                                                               */
/* -------------------------------------------------------------------------- */

export interface ListGoalsParams {
  readonly status?: readonly GoalStatus[];
  readonly scope: 'all' | 'family' | 'mine';
  readonly ownerId?: string;
  readonly includeArchived: boolean;
  readonly sort: SortField;
  readonly cursor?: string;
  readonly limit: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

function listFilters(viewer: GoalViewer, params: ListGoalsParams): SQL[] {
  const filters: SQL[] = [];
  const live = liveGoal();
  if (live) filters.push(live);

  const visible = goalVisibilityFilter(viewer);
  if (visible) filters.push(visible);

  if (params.status && params.status.length > 0) {
    filters.push(inArray(savingsGoals.status, [...params.status]));
  } else if (!params.includeArchived) {
    filters.push(inArray(savingsGoals.status, ['active', 'reached']));
  }

  if (params.scope === 'family') filters.push(isNull(savingsGoals.ownerId));
  if (params.scope === 'mine') filters.push(eq(savingsGoals.ownerId, viewer.userId));
  if (params.ownerId) filters.push(eq(savingsGoals.ownerId, params.ownerId));

  return filters;
}

/**
 * One query, one round trip: goals + derived balance + progress, keyset
 * paginated. There is deliberately no per-goal balance lookup anywhere.
 */
export async function listGoals(
  x: Executor,
  viewer: GoalViewer,
  params: ListGoalsParams,
): Promise<Page<GoalProjection>> {
  const spec = SORT_SPECS[params.sort];
  const filters = listFilters(viewer, params);

  const cursor = decodeCursor(params.cursor);
  if (cursor) filters.push(keysetPredicate(spec, cursor));

  const order =
    spec.direction === 'asc'
      ? [asc(spec.key), asc(savingsGoals.id)]
      : [desc(spec.key), desc(savingsGoals.id)];

  const rows = await x
    .select({ ...GOAL_SELECTION, cursorKey: spec.keyText })
    .from(savingsGoals)
    .leftJoinLateral(BALANCE_LATERAL, sql`true`)
    .where(and(...filters))
    .orderBy(...order)
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((row) => mapGoal(row)),
    nextCursor: hasMore && last ? encodeCursor({ v: String(last.cursorKey), id: last.id }) : null,
  };
}

/** Single goal with its derived amounts, narrowed to the viewer's read scope. */
export async function findGoalById(
  x: Executor,
  viewer: GoalViewer,
  goalId: string,
): Promise<GoalProjection | null> {
  const filters: SQL[] = [eq(savingsGoals.id, goalId)];
  const live = liveGoal();
  if (live) filters.push(live);
  const visible = goalVisibilityFilter(viewer);
  if (visible) filters.push(visible);

  const [row] = await x
    .select(GOAL_SELECTION)
    .from(savingsGoals)
    .leftJoinLateral(BALANCE_LATERAL, sql`true`)
    .where(and(...filters))
    .limit(1);

  return row ? mapGoal(row) : null;
}

/**
 * Locks the goal row for the duration of a ledger write.
 *
 * `SELECT … FOR UPDATE` serializes concurrent contributions and withdrawals on
 * one goal, which is what makes the "a withdrawal may not drive the balance
 * below zero" check race-free — without it two simultaneous withdrawals both
 * read the old balance and both pass.
 *
 * Selects the base row only: `FOR UPDATE` cannot be applied to the nullable
 * side of the balance outer join.
 */
export async function lockGoal(x: Executor, goalId: string): Promise<SavingsGoalRow | null> {
  const [row] = await x
    .select()
    .from(savingsGoals)
    .where(and(eq(savingsGoals.id, goalId), isNull(savingsGoals.deletedAt)))
    .for('update')
    .limit(1);
  return row ?? null;
}

/**
 * The balance, on its own. **`SUM(delta)`, every single time.**
 *
 * Used inside the ledger transaction after the `FOR UPDATE` lock, so it always
 * sees the goal's committed history plus this transaction's own inserts.
 */
export async function goalBalance(x: Executor, goalId: string): Promise<number> {
  const [row] = await x
    .select({ amount: sql<string>`coalesce(sum(${goalTransactions.delta}), 0)::bigint::text` })
    .from(goalTransactions)
    .where(eq(goalTransactions.goalId, goalId));
  return toMinorUnits(row?.amount);
}

export interface GoalContributorRow {
  userId: string;
  amount: number;
  transactionCount: number;
  lastContributedAt: Date | null;
}

/** `SUM(delta) GROUP BY user_id` — the "кто сколько внёс" breakdown. */
export async function listContributors(x: Executor, goalId: string): Promise<GoalContributorRow[]> {
  const rows = await x
    .select({
      userId: goalTransactions.userId,
      amount: sql<string>`sum(${goalTransactions.delta})::bigint::text`,
      transactionCount: sql<number>`count(*)::int`,
      lastContributedAt: sql<Date | null>`max(${goalTransactions.occurredAt})`,
    })
    .from(goalTransactions)
    .where(eq(goalTransactions.goalId, goalId))
    .groupBy(goalTransactions.userId)
    .orderBy(desc(sql`sum(${goalTransactions.delta})`));

  return rows.map((row) => ({
    userId: row.userId,
    amount: toMinorUnits(row.amount),
    transactionCount: toCount(row.transactionCount),
    lastContributedAt: row.lastContributedAt ?? null,
  }));
}

export interface GoalsSummary {
  goalCount: number;
  activeCount: number;
  reachedCount: number;
  totalTarget: number;
  totalSaved: number;
  totalRemaining: number;
  progressPercent: number;
}

/**
 * Board-level totals for the dashboard tile. Aggregated in SQL over the same
 * lateral projection, so the summary can never disagree with the list.
 */
export async function goalsSummary(x: Executor, viewer: GoalViewer): Promise<GoalsSummary> {
  const filters: SQL[] = [];
  const live = liveGoal();
  if (live) filters.push(live);
  const visible = goalVisibilityFilter(viewer);
  if (visible) filters.push(visible);
  filters.push(inArray(savingsGoals.status, ['active', 'reached']));

  const [row] = await x
    .select({
      goalCount: sql<number>`count(*)::int`,
      activeCount: sql<number>`count(*) filter (where ${savingsGoals.status} = 'active')::int`,
      reachedCount: sql<number>`count(*) filter (where ${savingsGoals.status} = 'reached')::int`,
      totalTarget: sql<string>`coalesce(sum(${savingsGoals.targetAmount}), 0)::bigint::text`,
      totalSaved: sql<string>`coalesce(sum("gb"."amount"), 0)::bigint::text`,
      totalRemaining: sql<string>`coalesce(sum(greatest(${savingsGoals.targetAmount} - "gb"."amount", 0)), 0)::bigint::text`,
    })
    .from(savingsGoals)
    .leftJoinLateral(BALANCE_LATERAL, sql`true`)
    .where(and(...filters));

  const totalTarget = toMinorUnits(row?.totalTarget);
  const totalSaved = toMinorUnits(row?.totalSaved);

  return {
    goalCount: toCount(row?.goalCount),
    activeCount: toCount(row?.activeCount),
    reachedCount: toCount(row?.reachedCount),
    totalTarget,
    totalSaved,
    totalRemaining: toMinorUnits(row?.totalRemaining),
    progressPercent: percentOf(totalSaved, totalTarget),
  };
}

/* -------------------------------------------------------------------------- */
/* Goals — writes                                                              */
/* -------------------------------------------------------------------------- */

export async function insertGoal(x: Executor, values: NewSavingsGoalRow): Promise<SavingsGoalRow> {
  const [row] = await x.insert(savingsGoals).values(values).returning();
  if (!row) throw internal('Goal insert returned no row');
  return row;
}

export async function updateGoalRow(
  x: Executor,
  goalId: string,
  patch: Partial<NewSavingsGoalRow>,
): Promise<SavingsGoalRow | null> {
  const [row] = await x
    .update(savingsGoals)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(savingsGoals.id, goalId), isNull(savingsGoals.deletedAt)))
    .returning();
  return row ?? null;
}

/**
 * Flips a goal to `reached` **conditionally**.
 *
 * `AND reached_at IS NULL` is the whole point: two concurrent contributions
 * that both cross the target produce exactly one updated row, so `goal.reached`
 * is announced once. Returns `null` when the goal was already reached.
 */
export async function markGoalReached(
  x: Executor,
  goalId: string,
  at: Date,
): Promise<SavingsGoalRow | null> {
  const [row] = await x
    .update(savingsGoals)
    .set({ status: 'reached', reachedAt: at, updatedAt: at })
    .where(
      and(
        eq(savingsGoals.id, goalId),
        isNull(savingsGoals.reachedAt),
        isNull(savingsGoals.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Next free display position, so a new goal lands at the end of the board. */
export async function nextGoalSortOrder(x: Executor): Promise<number> {
  const [row] = await x
    .select({ next: sql<number>`coalesce(max(${savingsGoals.sortOrder}), -1) + 1` })
    .from(savingsGoals)
    .where(isNull(savingsGoals.deletedAt));
  return toCount(row?.next);
}

/** Soft delete. Only ever used on a goal with an empty ledger (see the service). */
export async function softDeleteGoal(x: Executor, goalId: string): Promise<void> {
  await x
    .update(savingsGoals)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(savingsGoals.id, goalId), isNull(savingsGoals.deletedAt)));
}

/** Rewrites `sort_order` from an ordered id list, ignoring ids outside scope. */
export async function reorderGoals(x: Executor, orderedIds: readonly string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  await Promise.all(
    orderedIds.map((id, index) =>
      x
        .update(savingsGoals)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(and(eq(savingsGoals.id, id), isNull(savingsGoals.deletedAt))),
    ),
  );
}

/** Filters an id list down to the goals the viewer may actually see. */
export async function filterVisibleGoalIds(
  x: Executor,
  viewer: GoalViewer,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const filters: SQL[] = [inArray(savingsGoals.id, [...ids])];
  const live = liveGoal();
  if (live) filters.push(live);
  const visible = goalVisibilityFilter(viewer);
  if (visible) filters.push(visible);

  const rows = await x
    .select({ id: savingsGoals.id })
    .from(savingsGoals)
    .where(and(...filters));
  const found = new Set(rows.map((r) => r.id));
  return ids.filter((id) => found.has(id));
}

/* -------------------------------------------------------------------------- */
/* Milestones                                                                  */
/* -------------------------------------------------------------------------- */

export async function listMilestones(
  x: Executor,
  goalIds: readonly string[],
): Promise<GoalMilestoneRow[]> {
  if (goalIds.length === 0) return [];
  return x
    .select()
    .from(goalMilestones)
    .where(inArray(goalMilestones.goalId, [...goalIds]))
    .orderBy(asc(goalMilestones.sortOrder), asc(goalMilestones.targetAmount));
}

export async function findMilestone(
  x: Executor,
  goalId: string,
  milestoneId: string,
): Promise<GoalMilestoneRow | null> {
  const [row] = await x
    .select()
    .from(goalMilestones)
    .where(and(eq(goalMilestones.id, milestoneId), eq(goalMilestones.goalId, goalId)))
    .limit(1);
  return row ?? null;
}

export async function insertMilestones(
  x: Executor,
  values: readonly NewGoalMilestoneRow[],
): Promise<GoalMilestoneRow[]> {
  if (values.length === 0) return [];
  return x
    .insert(goalMilestones)
    .values([...values])
    .returning();
}

export async function updateMilestoneRow(
  x: Executor,
  milestoneId: string,
  patch: Partial<NewGoalMilestoneRow>,
): Promise<GoalMilestoneRow | null> {
  const [row] = await x
    .update(goalMilestones)
    .set(patch)
    .where(eq(goalMilestones.id, milestoneId))
    .returning();
  return row ?? null;
}

/** Milestones are motivation, not history — a hard delete is correct here. */
export async function deleteMilestone(x: Executor, milestoneId: string): Promise<void> {
  await x.delete(goalMilestones).where(eq(goalMilestones.id, milestoneId));
}

/**
 * Stamps `reached_at` on the milestones that just crossed.
 *
 * `AND reached_at IS NULL` makes this the idempotency point for the whole
 * milestone-notification path: a retried request updates zero rows and the
 * `RETURNING` list comes back empty, so nothing is announced twice.
 */
export async function markMilestonesReached(
  x: Executor,
  milestoneIds: readonly string[],
  at: Date,
): Promise<GoalMilestoneRow[]> {
  if (milestoneIds.length === 0) return [];
  return x
    .update(goalMilestones)
    .set({ reachedAt: at })
    .where(and(inArray(goalMilestones.id, [...milestoneIds]), isNull(goalMilestones.reachedAt)))
    .returning();
}

/* -------------------------------------------------------------------------- */
/* Ledger — append only                                                        */
/* -------------------------------------------------------------------------- */

export interface InsertTransactionResult {
  row: GoalTransactionRow;
  /** `false` when an identical `clientId` had already been recorded. */
  created: boolean;
}

/**
 * Appends one ledger row.
 *
 * There is no update and no delete counterpart in this file, and there never
 * will be (D6): a mistake is offset by a `correction` row.
 *
 * **Idempotency.** `goal_transactions` has no `client_id` column, but the
 * contract's `clientId` is already a UUID — so the service passes it as the
 * row's primary key. A replayed offline submit therefore collides on the PK,
 * `ON CONFLICT DO NOTHING` swallows it, and the existing row is returned with
 * `created: false`. One index, no extra column, and the guarantee is enforced
 * by Postgres rather than by a read-then-write race.
 */
export async function insertTransaction(
  x: Executor,
  values: NewGoalTransactionRow,
): Promise<InsertTransactionResult> {
  const [row] = await x
    .insert(goalTransactions)
    .values(values)
    .onConflictDoNothing({ target: goalTransactions.id })
    .returning();

  if (row) return { row, created: true };

  if (!values.id) throw internal('Ledger insert returned no row');
  const existing = await findTransactionById(x, values.id);
  if (!existing) throw internal('Ledger insert conflicted but the existing row is unreadable');
  return { row: existing, created: false };
}

export async function findTransactionById(
  x: Executor,
  transactionId: string,
): Promise<GoalTransactionRow | null> {
  const [row] = await x
    .select()
    .from(goalTransactions)
    .where(eq(goalTransactions.id, transactionId))
    .limit(1);
  return row ?? null;
}

export interface ListTransactionsParams {
  readonly kind?: readonly GoalTxnKind[];
  readonly userId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit: number;
}

/** Newest first, keyset paginated on `(occurred_at, id)`. */
export async function listTransactions(
  x: Executor,
  goalId: string,
  params: ListTransactionsParams,
): Promise<Page<GoalTransactionRow>> {
  const filters: SQL[] = [eq(goalTransactions.goalId, goalId)];

  if (params.kind && params.kind.length > 0) {
    filters.push(inArray(goalTransactions.kind, [...params.kind]));
  }
  if (params.userId) filters.push(eq(goalTransactions.userId, params.userId));
  if (params.from) filters.push(gte(goalTransactions.occurredAt, new Date(params.from)));
  if (params.to) filters.push(lte(goalTransactions.occurredAt, new Date(params.to)));

  const cursor = decodeCursor(params.cursor);
  if (cursor) {
    filters.push(
      sql`(${goalTransactions.occurredAt}, ${goalTransactions.id}) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await x
    .select()
    .from(goalTransactions)
    .where(and(...filters))
    .orderBy(desc(goalTransactions.occurredAt), desc(goalTransactions.id))
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page.at(-1);

  return {
    items: page,
    nextCursor:
      hasMore && last ? encodeCursor({ v: last.occurredAt.toISOString(), id: last.id }) : null,
  };
}
