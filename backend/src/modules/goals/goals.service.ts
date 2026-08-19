import { sql } from 'drizzle-orm';

import { ROLE_PERMISSIONS, ROLES } from '@family/shared';
import type {
  CreateContribution,
  CreateCorrection,
  CreateGoal,
  CreateMilestone,
  CreateWithdrawal,
  GoalStatus,
  GoalTxnKind,
  ListGoalsQuery,
  ListGoalTransactionsQuery,
  Permission,
  UpdateGoal,
  UpdateMilestone,
} from '@family/shared';

import type { Db, Executor } from '../../core/db.js';
import { badRequest, conflict, forbidden, internal, notFound } from '../../core/errors.js';
import {
  notificationIntents,
  type NewNotificationIntentRow,
} from '../notifications/notifications.schema.js';
import type { GoalMilestoneRow, GoalTransactionRow, SavingsGoalRow } from './goals.schema.js';
import * as repo from './goals.repository.js';

/**
 * Moneybox business rules. No HTTP knowledge (D8) — the routes translate
 * `AppError`s into responses.
 *
 * ## Money (D6)
 *
 * Every amount in this file is an **integer number of minor units** (копейки).
 * There is no `/`, no `*` by a fraction, no `parseFloat` and no `toFixed`
 * anywhere in the module: `progressPercent` is derived with an integer
 * round-half-up identity, and the only division is integer division by a
 * positive target. Formatting is the client's job.
 *
 * ## Signs
 *
 * `contribute()` and `withdraw()` both take a **positive** amount; the service
 * decides the sign. That is deliberate: a client bug that flips a sign must not
 * be able to silently credit a goal. `correct()` is the single signed input and
 * it needs `goal:update`.
 *
 * ## Fire-once transitions
 *
 * Reaching a milestone (or the goal) is a *transition*, recorded by stamping
 * `reached_at`, not a value recomputed on read. The stamp is written with a
 * conditional `WHERE reached_at IS NULL`, so a retried request — or two racing
 * contributions — produce exactly one stamped row and therefore exactly one
 * notification intent. The BullMQ `jobId` and the `notification_intents`
 * dedupe key are the second and third lines of that defence.
 */

/* -------------------------------------------------------------------------- */
/* Actor & permissions (D4)                                                    */
/* -------------------------------------------------------------------------- */

/** Structurally satisfied by `AuthContext`, so routes just pass `req.auth`. */
export interface GoalActor {
  readonly userId: string;
  can(permission: Permission): boolean;
}

/**
 * The `:any`-equivalent authority for goals.
 *
 * `household.md` §5 says a `private` goal is readable by "`owner_id` plus
 * owner/admin", but D4 forbids branching on `role ===` and the permission
 * catalog (lead-owned, fixed) has no `goal:read:any`. `member:update:any` is
 * the catalog entry that means "administers the family" and is held by exactly
 * owner and admin — so it is the honest permission-shaped expression of that
 * rule. If the lead would rather add `goal:read:any` to the catalog, this
 * constant is the only line that changes.
 */
export const GOAL_ADMIN_PERMISSION: Permission = 'goal:read:any';

export function canReadAnyGoal(actor: GoalActor): boolean {
  return actor.can('goal:read') && actor.can(GOAL_ADMIN_PERMISSION);
}

export function viewerOf(actor: GoalActor): repo.GoalViewer {
  return { userId: actor.userId, canReadAny: canReadAnyGoal(actor) };
}

/** Pure mirror of the SQL filter in the repository — used by tests and guards. */
export function canReadGoal(
  actor: GoalActor,
  goal: { ownerId: string | null; visibility: string },
): boolean {
  if (!actor.can('goal:read')) return false;
  if (goal.visibility === 'household') return true;
  if (goal.ownerId !== null && goal.ownerId === actor.userId) return true;
  return canReadAnyGoal(actor);
}

/**
 * Missing `goal:read` is **404, not 403** (D4, household.md §5): a caller who
 * may not read the moneybox at all should not learn that it exists. Children
 * hold zero `goal:*` permissions and land here.
 *
 * For an HTTP caller the route guard now reaches this verdict first —
 * `GOAL_ROUTE_ACCESS` marks every read `notFoundOnDeny: true`, so the 404 is
 * produced in `core/plugins/auth` and this function never runs. It is kept
 * because it is the same answer at the other layer: the dashboard aggregate and
 * the digest job call these functions directly, with no route in front of them,
 * and they must not be able to assemble a moneybox tile for a child.
 */
function requireGoalRead(actor: GoalActor): void {
  if (!actor.can('goal:read')) throw notFound('Goal');
}

/**
 * 403 territory: the caller may read the goal but may not perform this action.
 * A teen holds `goal:read` and nothing else, so every write lands here.
 */
function requirePermission(actor: GoalActor, permission: Permission): void {
  if (!actor.can(permission)) throw forbidden(`Missing permission: ${permission}`);
}

/* -------------------------------------------------------------------------- */
/* Integer money helpers — pure, no database                                   */
/* -------------------------------------------------------------------------- */

/**
 * The boundary guard for D6. Anything that is not an exact integer is rejected
 * before it can reach a `bigint` column and be silently truncated.
 */
export function assertIntegerMinorUnits(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw badRequest(`${field} must be an integer number of minor units`, {
      [field]: ['Ожидается целое число копеек'],
    });
  }
  return value;
}

/**
 * `round(current / target * 100)` without ever creating a float.
 *
 * One definition, shared with the SQL projection: `repo.percentOf` is the same
 * integer identity that `PROGRESS_PERCENT_EXPR` evaluates in Postgres, so the
 * list endpoint, the detail endpoint and the summary tile cannot disagree.
 * Floored at 0, **not capped at 100** — an over-funded goal reads `112 %`
 * (household.md §2.5).
 */
export const progressPercent = repo.percentOf;

/** `target - current`, floored at 0. */
export function remainingAmount(currentAmount: number, targetAmount: number): number {
  return Math.max(targetAmount - currentAmount, 0);
}

/**
 * The balance definition, in one place: a goal's current amount is the sum of
 * its ledger and nothing else. Integer addition only, so it is associative and
 * order-independent — the reason D6 mandates minor units in the first place.
 */
export function sumLedger(deltas: readonly number[]): number {
  let total = 0;
  for (const delta of deltas) total += delta;
  return total;
}

/** Money in. Always positive. */
export function contributionDelta(amount: number): number {
  assertIntegerMinorUnits(amount, 'amount');
  if (amount <= 0) throw badRequest('Contribution amount must be positive');
  return amount;
}

/**
 * Money out. Submitted **positive**, negated here — the API never accepts a
 * signed number on `/withdrawals` (household.md §2.4).
 */
export function withdrawalDelta(amount: number): number {
  assertIntegerMinorUnits(amount, 'amount');
  if (amount <= 0) throw badRequest('Withdrawal amount must be positive');
  return -amount;
}

/**
 * A withdrawal may never take a moneybox below zero — you cannot take out money
 * that was never put in, and a negative balance would make every progress
 * figure nonsense.
 *
 * The one exception is an explicit `correction`, which exists precisely to undo
 * a wrong row and therefore has to be allowed to go anywhere. Corrections need
 * `goal:update`.
 */
export function assertBalanceNotNegative(
  newBalance: number,
  options: { isCorrection: boolean },
): void {
  if (newBalance < 0 && !options.isCorrection) {
    throw conflict('Withdrawal would take the goal below zero');
  }
}

/* -------------------------------------------------------------------------- */
/* Milestone / goal crossing — pure                                            */
/* -------------------------------------------------------------------------- */

export interface MilestoneState {
  readonly id: string;
  readonly title: string;
  readonly targetAmount: number;
  readonly reachedAt: Date | null;
}

export interface CrossingInput {
  readonly currentAmount: number;
  readonly targetAmount: number;
  readonly goalReachedAt: Date | null;
  readonly milestones: readonly MilestoneState[];
}

export interface CrossingResult {
  readonly milestones: MilestoneState[];
  readonly goalReached: boolean;
}

/**
 * Which checkpoints the new balance just crossed.
 *
 * The fire-once guard is the **stored `reachedAt`**, not a comparison against a
 * previously observed balance. That matters: a retried POST re-reads the same
 * ledger, but the first attempt already stamped `reached_at`, so the second
 * attempt finds nothing new. A guard based on "previous balance < target <=
 * new balance" would fire again on any retry that recomputed the same numbers.
 *
 * `reachedAt` is intentionally **sticky**: withdrawing below a milestone does
 * not un-reach it. A checkpoint is a thing that happened, and un-announcing it
 * would let a withdraw/contribute cycle spam the family.
 */
export function detectCrossings(input: CrossingInput): CrossingResult {
  const milestones = input.milestones.filter(
    (m) => m.reachedAt === null && input.currentAmount >= m.targetAmount,
  );
  const goalReached = input.goalReachedAt === null && input.currentAmount >= input.targetAmount;
  return { milestones, goalReached };
}

/* -------------------------------------------------------------------------- */
/* Notification intents (D10) — local seam                                     */
/* -------------------------------------------------------------------------- */

/**
 * TODO(notifications): the notifications module currently ships only its
 * schema — there is no `notifications.service.ts` to call. This is a deliberate
 * seam, not a permanent home: when the intent API lands, delete
 * `stageIntents`/`flushIntents` and call it instead. The shape below is exactly
 * `notification_intents`, so the swap is mechanical.
 *
 * Cross-module rule (D8): this touches the notifications **schema**, never a
 * notifications repository or service internal.
 */
export type GoalIntentType = 'goal_contribution' | 'goal_milestone_reached' | 'goal_reached';

export interface GoalIntent {
  readonly type: GoalIntentType;
  readonly actorId: string;
  readonly entityType: 'goal' | 'goal_milestone';
  readonly entityId: string;
  readonly dedupeKey: string;
  readonly priority: 'low' | 'normal' | 'high';
  readonly payload: Record<string, unknown>;
  /** Who may be told. See {@link audienceFor}. */
  readonly audience: Record<string, unknown>;
}

/**
 * The roles that hold `goal:read`, **derived from the catalog** rather than
 * spelled out. D4 forbids branching on `role ===` for access decisions; this is
 * not one — it is the audience declaration `notification_intents.audience`
 * expects — but deriving it anyway means granting a role `goal:read` tomorrow
 * automatically starts notifying it, with no second list to forget.
 */
export const GOAL_READER_ROLES: string[] = ROLES.filter((role) =>
  ROLE_PERMISSIONS[role].includes('goal:read'),
);

/**
 * Who a goal's notifications may reach.
 *
 * A `private` goal notifies **its owner only**: telling the family that
 * "Подарок" just hit 50 % would leak both the goal and the surprise. A shared
 * goal notifies everyone who can read goals at all — which is what keeps a
 * child, who holds no `goal:*` permission, out of the fan-out.
 */
export function audienceFor(goal: {
  ownerId: string | null;
  visibility: string;
}): Record<string, unknown> {
  if (goal.visibility !== 'household' && goal.ownerId !== null) {
    return { users: [goal.ownerId] };
  }
  return { roles: GOAL_READER_ROLES };
}

/** Stable per-event key. Same event ⇒ same key ⇒ told once, ever. */
export function intentDedupeKey(type: GoalIntentType, entityId: string): string {
  return `${type}:${entityId}`;
}

interface QueuedIntent {
  intentId: string;
  dedupeKey: string;
}

/**
 * Writes the intent rows **inside the caller's transaction**, so an intent can
 * never outlive a rolled-back ledger write.
 *
 * `ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING` means a
 * duplicate loses the race and returns nothing — so it is never queued either.
 */
async function stageIntents(x: Executor, intents: readonly GoalIntent[]): Promise<QueuedIntent[]> {
  if (intents.length === 0) return [];

  const values: NewNotificationIntentRow[] = intents.map((intent) => ({
    type: intent.type,
    actorId: intent.actorId,
    entityType: intent.entityType,
    entityId: intent.entityId,
    payload: intent.payload,
    audience: intent.audience,
    dedupeKey: intent.dedupeKey,
    priority: intent.priority,
  }));

  const rows = await x
    .insert(notificationIntents)
    .values(values)
    .onConflictDoNothing({
      target: notificationIntents.dedupeKey,
      // The unique index is partial; Postgres needs the predicate to infer it.
      where: sql`dedupe_key is not null`,
    })
    .returning({ id: notificationIntents.id, dedupeKey: notificationIntents.dedupeKey });

  return rows.flatMap((row) =>
    row.dedupeKey ? [{ intentId: row.id, dedupeKey: row.dedupeKey }] : [],
  );
}

/**
 * Hands the staged intents to BullMQ **after** the transaction commits.
 *
 * The `jobId` is the intent's dedupe key, so a retried request that somehow got
 * past the unique index still cannot enqueue a second dispatch: BullMQ silently
 * drops an add with an existing id.
 *
 * A queue outage must not fail a committed money write. The intent rows are
 * durable, so the dispatcher can pick them up later; we log and move on.
 */
async function flushIntents(queued: readonly QueuedIntent[]): Promise<void> {
  if (queued.length === 0) return;

  // Imported lazily on purpose: `core/queue/queues.js` pulls in BullMQ, ioredis
  // and the shared logger at module load. Keeping it out of the static graph
  // means reading a goal, running the money unit tests or generating OpenAPI
  // never opens a Redis socket — only an actual notification does.
  const { enqueue } = await import('../../core/queue/queues.js');

  for (const item of queued) {
    try {
      await enqueue(
        'notification.dispatch',
        { intentId: item.intentId },
        { jobId: item.dedupeKey },
      );
    } catch (error) {
      console.warn(
        `[goals] failed to enqueue notification dispatch for intent ${item.intentId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

export interface GoalWithMilestones extends repo.GoalProjection {
  milestones: GoalMilestoneRow[];
  contributors?: repo.GoalContributorRow[];
}

async function attachMilestones(
  x: Executor,
  goals: repo.GoalProjection[],
): Promise<GoalWithMilestones[]> {
  if (goals.length === 0) return [];
  const rows = await repo.listMilestones(
    x,
    goals.map((g) => g.id),
  );
  const byGoal = new Map<string, GoalMilestoneRow[]>();
  for (const row of rows) {
    const bucket = byGoal.get(row.goalId);
    if (bucket) bucket.push(row);
    else byGoal.set(row.goalId, [row]);
  }
  return goals.map((goal) => ({ ...goal, milestones: byGoal.get(goal.id) ?? [] }));
}

/* -------------------------------------------------------------------------- */
/* Goals — reads                                                               */
/* -------------------------------------------------------------------------- */

export async function listGoals(
  db: Executor,
  actor: GoalActor,
  query: ListGoalsQuery,
): Promise<repo.Page<GoalWithMilestones>> {
  requireGoalRead(actor);

  const page = await repo.listGoals(db, viewerOf(actor), {
    ...(query.status ? { status: query.status } : {}),
    scope: query.scope,
    ...(query.ownerId ? { ownerId: query.ownerId } : {}),
    includeArchived: query.includeArchived,
    sort: query.sort,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit: query.limit,
  });

  return { items: await attachMilestones(db, page.items), nextCursor: page.nextCursor };
}

/**
 * A goal the caller may not read does not exist as far as this API is
 * concerned — **404, never 403** (D4).
 */
export async function getGoal(
  db: Executor,
  actor: GoalActor,
  goalId: string,
): Promise<GoalWithMilestones> {
  requireGoalRead(actor);

  const goal = await repo.findGoalById(db, viewerOf(actor), goalId);
  if (!goal) throw notFound('Goal');

  const [withMilestones] = await attachMilestones(db, [goal]);
  if (!withMilestones) throw internal('Goal projection lost its milestones');

  return { ...withMilestones, contributors: await repo.listContributors(db, goalId) };
}

export async function getSummary(db: Executor, actor: GoalActor): Promise<repo.GoalsSummary> {
  requireGoalRead(actor);
  return repo.goalsSummary(db, viewerOf(actor));
}

export async function listMilestones(
  db: Executor,
  actor: GoalActor,
  goalId: string,
): Promise<GoalMilestoneRow[]> {
  requireGoalRead(actor);
  const goal = await repo.findGoalById(db, viewerOf(actor), goalId);
  if (!goal) throw notFound('Goal');
  return repo.listMilestones(db, [goalId]);
}

export async function listTransactions(
  db: Executor,
  actor: GoalActor,
  goalId: string,
  query: ListGoalTransactionsQuery,
): Promise<repo.Page<GoalTransactionRow>> {
  requireGoalRead(actor);
  const goal = await repo.findGoalById(db, viewerOf(actor), goalId);
  if (!goal) throw notFound('Goal');

  return repo.listTransactions(db, goalId, {
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit: query.limit,
  });
}

/* -------------------------------------------------------------------------- */
/* Goals — writes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `visibility: 'private'` without an owner would be a goal nobody can read, so
 * it resolves to the actor. Assigning a *different* owner is a `goal:update`
 * action even on create.
 */
function resolveOwner(
  actor: GoalActor,
  visibility: 'household' | 'private',
  ownerId: string | null | undefined,
): string | null {
  if (ownerId === undefined || ownerId === null) {
    return visibility === 'private' ? actor.userId : null;
  }
  if (ownerId !== actor.userId) requirePermission(actor, 'goal:update');
  return ownerId;
}

/**
 * You may not write a goal into a state you could not then read.
 *
 * Without this, an adult could hand somebody else a `private` goal and get a
 * 404 back from their own successful `POST` — the read filter would already
 * have excluded them. Refusing up front is both clearer and safer than
 * returning a resource the caller cannot fetch again.
 */
function assertStaysReadable(
  actor: GoalActor,
  goal: { ownerId: string | null; visibility: string },
): void {
  if (!canReadGoal(actor, goal)) {
    throw forbidden('Cannot make a goal private to somebody else');
  }
}

export async function createGoal(
  db: Db,
  actor: GoalActor,
  input: CreateGoal,
): Promise<GoalWithMilestones> {
  requireGoalRead(actor);
  requirePermission(actor, 'goal:create');
  assertIntegerMinorUnits(input.targetAmount, 'targetAmount');
  if (input.targetAmount <= 0) throw badRequest('targetAmount must be positive');

  const ownerId = resolveOwner(actor, input.visibility, input.ownerId);
  assertStaysReadable(actor, { ownerId, visibility: input.visibility });

  const goalId = await db.transaction(async (tx) => {
    const sortOrder = input.sortOrder ?? (await repo.nextGoalSortOrder(tx));

    const goal = await repo.insertGoal(tx, {
      title: input.title,
      description: input.description ?? null,
      targetAmount: input.targetAmount,
      currency: input.currency,
      deadline: input.deadline ?? null,
      imageUrl: input.imageUrl ?? null,
      color: input.color ?? null,
      icon: input.icon ?? null,
      visibility: input.visibility,
      ownerId,
      createdById: actor.userId,
      sortOrder,
    });

    if (input.milestones?.length) {
      await repo.insertMilestones(tx, buildMilestoneRows(goal.id, input.milestones));
    }

    return goal.id;
  });

  return getGoal(db, actor, goalId);
}

function buildMilestoneRows(goalId: string, milestones: readonly CreateMilestone[]) {
  return milestones.map((milestone, index) => {
    assertIntegerMinorUnits(milestone.targetAmount, 'milestones.targetAmount');
    return {
      goalId,
      title: milestone.title,
      targetAmount: milestone.targetAmount,
      sortOrder: milestone.sortOrder ?? index,
    };
  });
}

export async function updateGoal(
  db: Db,
  actor: GoalActor,
  goalId: string,
  patch: UpdateGoal,
): Promise<GoalWithMilestones> {
  requireGoalRead(actor);
  requirePermission(actor, 'goal:update');

  const current = await repo.findGoalById(db, viewerOf(actor), goalId);
  if (!current) throw notFound('Goal');

  if (patch.targetAmount !== undefined) {
    assertIntegerMinorUnits(patch.targetAmount, 'targetAmount');
    if (patch.targetAmount <= 0) throw badRequest('targetAmount must be positive');
  }

  /**
   * Never sum across currencies (household.md §2.7). Once the ledger has rows,
   * its denomination is fixed; re-denominating would silently rewrite history.
   */
  if (
    patch.currency !== undefined &&
    patch.currency !== current.currency &&
    current.transactionCount > 0
  ) {
    throw conflict('Cannot change the currency of a goal that already has transactions');
  }

  const nextVisibility = patch.visibility ?? current.visibility;
  const ownerId =
    patch.ownerId !== undefined
      ? resolveOwner(actor, nextVisibility, patch.ownerId)
      : nextVisibility === 'private' && current.ownerId === null
        ? actor.userId
        : current.ownerId;

  assertStaysReadable(actor, { ownerId, visibility: nextVisibility });

  let queued: QueuedIntent[] = [];

  await db.transaction(async (tx) => {
    const updated = await repo.updateGoalRow(tx, goalId, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
      ...(patch.targetAmount !== undefined ? { targetAmount: patch.targetAmount } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.deadline !== undefined ? { deadline: patch.deadline ?? null } : {}),
      ...(patch.imageUrl !== undefined ? { imageUrl: patch.imageUrl ?? null } : {}),
      ...(patch.color !== undefined ? { color: patch.color ?? null } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon ?? null } : {}),
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ownerId,
    });
    if (!updated) throw notFound('Goal');

    // Lowering the target below the current balance is a crossing too — the
    // same transition, so it goes through the same fire-once path.
    if (patch.targetAmount !== undefined) {
      const balance = await repo.goalBalance(tx, goalId);
      const intents = await applyCrossings(tx, updated, balance, actor.userId);
      queued = await stageIntents(tx, intents);
    }
  });

  await flushIntents(queued);
  return getGoal(db, actor, goalId);
}

/**
 * Delete.
 *
 * A goal whose ledger has rows is **archived, not deleted**: the transactions
 * are append-only history and hiding the goal would orphan them. An untouched
 * goal (nobody ever put money in) is a genuine mistake and is soft-deleted.
 */
export async function deleteGoal(
  db: Db,
  actor: GoalActor,
  goalId: string,
): Promise<{ archived: boolean }> {
  requireGoalRead(actor);
  requirePermission(actor, 'goal:delete');

  const goal = await repo.findGoalById(db, viewerOf(actor), goalId);
  if (!goal) throw notFound('Goal');

  if (goal.transactionCount > 0) {
    await repo.updateGoalRow(db, goalId, { status: 'archived' });
    return { archived: true };
  }

  await repo.softDeleteGoal(db, goalId);
  return { archived: false };
}

export async function reorderGoals(
  db: Db,
  actor: GoalActor,
  ids: readonly string[],
): Promise<void> {
  requireGoalRead(actor);
  requirePermission(actor, 'goal:update');

  await db.transaction(async (tx) => {
    // Ids outside the caller's read scope are dropped rather than rejected: the
    // client is reordering the board it can see, and a private goal it cannot
    // see must not be revealed by an error either.
    const visible = await repo.filterVisibleGoalIds(tx, viewerOf(actor), ids);
    await repo.reorderGoals(tx, visible);
  });
}

/* -------------------------------------------------------------------------- */
/* Milestones — writes                                                         */
/* -------------------------------------------------------------------------- */

export async function createMilestone(
  db: Db,
  actor: GoalActor,
  goalId: string,
  input: CreateMilestone,
): Promise<GoalMilestoneRow> {
  requireGoalRead(actor);
  requirePermission(actor, 'goal:update');
  assertIntegerMinorUnits(input.targetAmount, 'targetAmount');

  const goal = await repo.findGoalById(db, viewerOf(actor), goalId);
  if (!goal) throw notFound('Goal');

  const [row] = await repo.insertMilestones(db, buildMilestoneRows(goalId, [input]));
  if (!row) throw internal('Milestone insert returned no row');

  // A checkpoint created below the current balance is already behind us. Stamp
  // it silently rather than announcing a crossing that never happened.
  if (goal.currentAmount >= row.targetAmount) {
    const [stamped] = await repo.markMilestonesReached(db, [row.id], new Date());
    return stamped ?? row;
  }
  return row;
}

export async function updateMilestone(
  db: Db,
  actor: GoalActor,
  goalId: string,
  milestoneId: string,
  patch: UpdateMilestone,
): Promise<GoalMilestoneRow> {
  requireGoalRead(actor);
  requirePermission(actor, 'goal:update');

  const goal = await repo.findGoalById(db, viewerOf(actor), goalId);
  if (!goal) throw notFound('Goal');

  const existing = await repo.findMilestone(db, goalId, milestoneId);
  if (!existing) throw notFound('Milestone');

  if (patch.targetAmount !== undefined) assertIntegerMinorUnits(patch.targetAmount, 'targetAmount');

  const row = await repo.updateMilestoneRow(db, milestoneId, {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.targetAmount !== undefined ? { targetAmount: patch.targetAmount } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
  });
  if (!row) throw notFound('Milestone');
  return row;
}

/** Hard delete: milestones are motivation, not history (household.md §1). */
export async function deleteMilestone(
  db: Db,
  actor: GoalActor,
  goalId: string,
  milestoneId: string,
): Promise<void> {
  requireGoalRead(actor);
  requirePermission(actor, 'goal:update');

  const goal = await repo.findGoalById(db, viewerOf(actor), goalId);
  if (!goal) throw notFound('Goal');

  const existing = await repo.findMilestone(db, goalId, milestoneId);
  if (!existing) throw notFound('Milestone');

  await repo.deleteMilestone(db, milestoneId);
}

/* -------------------------------------------------------------------------- */
/* Ledger                                                                      */
/* -------------------------------------------------------------------------- */

export interface LedgerResult {
  transaction: GoalTransactionRow;
  goal: GoalWithMilestones;
  /** `false` when an identical `clientId` had already been recorded. */
  created: boolean;
}

interface LedgerWrite {
  delta: number;
  kind: GoalTxnKind;
  note: string | null;
  occurredAt: Date;
  userId: string;
  clientId: string | undefined;
  isCorrection: boolean;
}

const CLOSED_STATUSES: readonly GoalStatus[] = ['archived', 'cancelled'];

/**
 * Recording money on somebody else's behalf — a parent entering a child's
 * piggy-bank cash — is a `goal:update` action, not a `goal:contribute` one
 * (household.md §5).
 */
function resolveLedgerUser(actor: GoalActor, userId: string | undefined): string {
  if (!userId || userId === actor.userId) return actor.userId;
  requirePermission(actor, 'goal:update');
  return userId;
}

async function applyCrossings(
  tx: Executor,
  goal: SavingsGoalRow,
  balance: number,
  actorId: string,
): Promise<GoalIntent[]> {
  const milestones = await repo.listMilestones(tx, [goal.id]);

  const crossing = detectCrossings({
    currentAmount: balance,
    targetAmount: goal.targetAmount,
    goalReachedAt: goal.reachedAt,
    milestones,
  });

  const now = new Date();
  const audience = audienceFor(goal);
  const intents: GoalIntent[] = [];

  // `markMilestonesReached` re-checks `reached_at IS NULL` in SQL and returns
  // only the rows it actually stamped — that returned set, not the detection
  // above, is what we announce.
  const stamped = await repo.markMilestonesReached(
    tx,
    crossing.milestones.map((m) => m.id),
    now,
  );

  for (const milestone of stamped) {
    intents.push({
      type: 'goal_milestone_reached',
      actorId,
      entityType: 'goal_milestone',
      entityId: milestone.id,
      dedupeKey: intentDedupeKey('goal_milestone_reached', milestone.id),
      priority: 'normal',
      audience,
      payload: {
        goalId: goal.id,
        goalTitle: goal.title,
        milestoneId: milestone.id,
        milestoneTitle: milestone.title,
        milestoneTargetAmount: milestone.targetAmount,
        currentAmount: balance,
        targetAmount: goal.targetAmount,
        currency: goal.currency,
      },
    });
  }

  if (crossing.goalReached) {
    const reached = await repo.markGoalReached(tx, goal.id, now);
    if (reached) {
      intents.push({
        type: 'goal_reached',
        actorId,
        entityType: 'goal',
        entityId: goal.id,
        dedupeKey: intentDedupeKey('goal_reached', goal.id),
        priority: 'high',
        audience,
        payload: {
          goalId: goal.id,
          goalTitle: goal.title,
          targetAmount: goal.targetAmount,
          currentAmount: balance,
          currency: goal.currency,
        },
      });
    }
  }

  return intents;
}

/**
 * The one place a ledger row is written.
 *
 * Everything that has to be atomic is inside a single transaction that starts
 * by taking a row lock on the goal:
 *
 * 1. `SELECT … FOR UPDATE` the goal (serializes concurrent writers),
 * 2. read the balance as `SUM(delta)` — never a column,
 * 3. refuse a withdrawal that would go below zero,
 * 4. append the row (idempotent on `clientId`),
 * 5. re-read `SUM(delta)`, stamp any crossed milestones and the goal itself,
 * 6. stage notification intents.
 *
 * The queue is touched only after the commit.
 */
async function recordLedgerEntry(
  db: Db,
  actor: GoalActor,
  goalId: string,
  write: LedgerWrite,
): Promise<LedgerResult> {
  assertIntegerMinorUnits(write.delta, 'delta');
  if (write.delta === 0) throw badRequest('delta must not be zero');

  const viewer = viewerOf(actor);

  const outcome = await db.transaction(async (tx) => {
    // Read scope first: a goal the caller may not see must 404, not 403.
    const visible = await repo.findGoalById(tx, viewer, goalId);
    if (!visible) throw notFound('Goal');

    const goal = await repo.lockGoal(tx, goalId);
    if (!goal) throw notFound('Goal');

    if (CLOSED_STATUSES.includes(goal.status)) {
      throw conflict(`Goal is ${goal.status} and no longer accepts transactions`);
    }

    const balanceBefore = await repo.goalBalance(tx, goalId);
    assertBalanceNotNegative(balanceBefore + write.delta, { isCorrection: write.isCorrection });

    const inserted = await repo.insertTransaction(tx, {
      ...(write.clientId ? { id: write.clientId } : {}),
      goalId,
      userId: write.userId,
      delta: write.delta,
      kind: write.kind,
      note: write.note,
      occurredAt: write.occurredAt,
      createdById: actor.userId,
    });

    // A replay contributed nothing: the row was already counted, the crossings
    // were already stamped and announced. Stop here so nothing fires twice.
    if (!inserted.created) return { transaction: inserted.row, created: false, queued: [] };

    const balanceAfter = await repo.goalBalance(tx, goalId);
    const intents = await applyCrossings(tx, goal, balanceAfter, actor.userId);

    if (write.delta > 0 && !write.isCorrection) {
      intents.unshift({
        type: 'goal_contribution',
        actorId: actor.userId,
        entityType: 'goal',
        entityId: goal.id,
        dedupeKey: intentDedupeKey('goal_contribution', inserted.row.id),
        priority: 'low',
        audience: audienceFor(goal),
        payload: {
          goalId: goal.id,
          goalTitle: goal.title,
          transactionId: inserted.row.id,
          userId: write.userId,
          delta: write.delta,
          kind: write.kind,
          currentAmount: balanceAfter,
          targetAmount: goal.targetAmount,
          currency: goal.currency,
        },
      });
    }

    return {
      transaction: inserted.row,
      created: true,
      queued: await stageIntents(tx, intents),
    };
  });

  await flushIntents(outcome.queued);

  return {
    transaction: outcome.transaction,
    goal: await getGoal(db, actor, goalId),
    created: outcome.created,
  };
}

/** Money in. Positive amount; `kind` may only be a crediting kind. */
export async function contribute(
  db: Db,
  actor: GoalActor,
  goalId: string,
  input: CreateContribution,
): Promise<LedgerResult> {
  requireGoalRead(actor);
  requirePermission(actor, 'goal:contribute');

  return recordLedgerEntry(db, actor, goalId, {
    delta: contributionDelta(input.amount),
    kind: input.kind,
    note: input.note ?? null,
    occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
    userId: resolveLedgerUser(actor, input.userId),
    clientId: input.clientId,
    isCorrection: false,
  });
}

/**
 * Money out. The caller submits a **positive** amount and the service negates
 * it; the balance may not go below zero.
 */
export async function withdraw(
  db: Db,
  actor: GoalActor,
  goalId: string,
  input: CreateWithdrawal,
): Promise<LedgerResult> {
  requireGoalRead(actor);
  requirePermission(actor, 'goal:contribute');

  return recordLedgerEntry(db, actor, goalId, {
    delta: withdrawalDelta(input.amount),
    kind: 'withdrawal',
    note: input.note ?? null,
    occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
    userId: resolveLedgerUser(actor, input.userId),
    clientId: input.clientId,
    isCorrection: false,
  });
}

/**
 * The only signed input, and the only write allowed to take a balance negative
 * — that is what makes an append-only ledger correctable without an `UPDATE`.
 * Requires `goal:update`, and the note is mandatory by contract.
 */
export async function correct(
  db: Db,
  actor: GoalActor,
  goalId: string,
  input: CreateCorrection,
): Promise<LedgerResult> {
  requireGoalRead(actor);
  requirePermission(actor, 'goal:update');

  return recordLedgerEntry(db, actor, goalId, {
    delta: assertIntegerMinorUnits(input.delta, 'delta'),
    kind: 'correction',
    note: input.note,
    occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
    userId: resolveLedgerUser(actor, input.userId),
    clientId: input.clientId,
    isCorrection: true,
  });
}
