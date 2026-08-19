import { z } from 'zod';

import {
  currencySchema,
  cursorPaginationSchema,
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  minorUnitsSchema,
  nonEmptyString,
  paginatedSchema,
  positiveMinorUnitsSchema,
} from './common.js';

/**
 * Moneybox contracts (savings goals + append-only ledger).
 *
 * Money rules (D6) restated here because this is the file every client reads:
 *
 * - Every amount crossing the wire is an **integer minor unit** (копейка).
 *   `1 000,00 ₽` is `100000`. The client formats; it never divides before send.
 * - `currentAmount` is **derived** (`SUM(delta)`), never stored and never
 *   accepted as input. It is present on responses only.
 * - A contribution is a positive amount; a withdrawal is submitted as a
 *   positive amount too and the service negates it. Only a correction may carry
 *   a signed delta, and only from an actor holding `goal:update`.
 *
 * Responses carry raw user ids (`ownerId`, `createdById`, …) rather than
 * embedded user objects: the client already holds the member roster from
 * `member:read` and joining client-side keeps names/avatars fresh in one place.
 */

export const goalStatusSchema = z.enum(['active', 'reached', 'archived', 'cancelled']);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

export const goalVisibilitySchema = z.enum(['household', 'private']);
export type GoalVisibility = z.infer<typeof goalVisibilitySchema>;

export const goalTxnKindSchema = z.enum(['contribution', 'withdrawal', 'correction', 'interest']);
export type GoalTxnKind = z.infer<typeof goalTxnKindSchema>;

/* -------------------------------------------------------------------------- */
/* Milestones                                                                  */
/* -------------------------------------------------------------------------- */

export const createMilestoneSchema = z.object({
  title: nonEmptyString(120),
  /** Absolute threshold in minor units, not a delta and not a percentage. */
  targetAmount: positiveMinorUnitsSchema,
  sortOrder: z.number().int().min(0).optional(),
});
export type CreateMilestone = z.infer<typeof createMilestoneSchema>;

export const updateMilestoneSchema = createMilestoneSchema.partial();
export type UpdateMilestone = z.infer<typeof updateMilestoneSchema>;

export const milestoneResponseSchema = z.object({
  id: idSchema,
  goalId: idSchema,
  title: z.string(),
  targetAmount: minorUnitsSchema,
  reachedAt: isoDateTimeSchema.nullable(),
  sortOrder: z.number().int(),
  createdAt: isoDateTimeSchema,
});
export type MilestoneResponse = z.infer<typeof milestoneResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Goals                                                                       */
/* -------------------------------------------------------------------------- */

const goalWritableFields = z.object({
  title: nonEmptyString(160),
  description: z.string().trim().max(2000).nullish(),
  targetAmount: positiveMinorUnitsSchema,
  currency: currencySchema,
  deadline: isoDateSchema.nullish(),
  imageUrl: z.string().url().max(2048).nullish(),
  /** `#RRGGBB`. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullish(),
  icon: z.string().trim().max(64).nullish(),
  visibility: goalVisibilitySchema.default('household'),
  /**
   * `null` / omitted => a **shared family goal**. A non-null id makes it that
   * member's personal goal; only `goal:update` holders may set it to somebody
   * other than themselves.
   */
  ownerId: idSchema.nullish(),
  sortOrder: z.number().int().min(0).optional(),
});

export const createGoalSchema = goalWritableFields.extend({
  /** Optional checkpoints created in the same transaction as the goal. */
  milestones: z.array(createMilestoneSchema).max(20).optional(),
});
export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = goalWritableFields.partial().extend({
  /**
   * `reached` is normally set by the service when `SUM(delta)` crosses the
   * target; it stays writable so a goal can be archived or cancelled by hand.
   */
  status: goalStatusSchema.optional(),
});
export type UpdateGoal = z.infer<typeof updateGoalSchema>;

/** Per-member split of a goal's balance — `SUM(delta) GROUP BY user_id`. */
export const goalContributorSchema = z.object({
  userId: idSchema,
  amount: minorUnitsSchema,
  transactionCount: z.number().int().min(0),
  lastContributedAt: isoDateTimeSchema.nullable(),
});
export type GoalContributor = z.infer<typeof goalContributorSchema>;

export const goalResponseSchema = z.object({
  id: idSchema,
  title: z.string(),
  description: z.string().nullable(),

  targetAmount: minorUnitsSchema,
  /** **Derived**: `SUM(delta)` over `goal_transactions`. Never stored, never accepted as input. */
  currentAmount: minorUnitsSchema,
  /**
   * `round(currentAmount / targetAmount * 100)`, floored at 0. Deliberately
   * **not** capped at 100 — an over-funded goal should read "112 %" rather than
   * pretend it is exactly full. Computed server-side so every surface agrees.
   */
  progressPercent: z.number().int().min(0),
  /** `targetAmount - currentAmount`, floored at 0. */
  remainingAmount: minorUnitsSchema,

  currency: z.string(),
  deadline: isoDateSchema.nullable(),
  imageUrl: z.string().nullable(),
  color: z.string().nullable(),
  icon: z.string().nullable(),

  status: goalStatusSchema,
  visibility: goalVisibilitySchema,
  /** `null` => shared family goal. */
  ownerId: idSchema.nullable(),
  createdById: idSchema,

  reachedAt: isoDateTimeSchema.nullable(),
  sortOrder: z.number().int(),

  milestones: z.array(milestoneResponseSchema).default([]),
  /** Present on the detail endpoint; omitted from list responses. */
  contributors: z.array(goalContributorSchema).optional(),

  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type GoalResponse = z.infer<typeof goalResponseSchema>;

export const listGoalsQuerySchema = cursorPaginationSchema.extend({
  status: z.array(goalStatusSchema).optional(),
  /** `family` = `owner_id IS NULL`, `mine` = owned by the caller. */
  scope: z.enum(['all', 'family', 'mine']).default('all'),
  ownerId: idSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
  sort: z.enum(['sortOrder', 'deadline', 'progress', 'createdAt']).default('sortOrder'),
});
export type ListGoalsQuery = z.infer<typeof listGoalsQuerySchema>;

export const goalListResponseSchema = paginatedSchema(goalResponseSchema);
export type GoalListResponse = z.infer<typeof goalListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Ledger                                                                      */
/* -------------------------------------------------------------------------- */

const txnMetaFields = z.object({
  note: z.string().trim().max(500).nullish(),
  /** Back-dating is allowed; defaults to `now()` server-side. */
  occurredAt: isoDateTimeSchema.optional(),
  /**
   * Whose money it is. Defaults to the caller. Recording on behalf of somebody
   * else (a parent entering a child's piggy-bank money) requires `goal:update`.
   */
  userId: idSchema.optional(),
  /**
   * Idempotency key for a retried/offline submit. The service returns the
   * existing row instead of double-crediting the goal.
   */
  clientId: idSchema.optional(),
});

/** Money in. Always a positive amount; `kind` may only be a crediting kind. */
export const createContributionSchema = txnMetaFields.extend({
  amount: positiveMinorUnitsSchema,
  kind: z.enum(['contribution', 'interest']).default('contribution'),
});
export type CreateContribution = z.infer<typeof createContributionSchema>;

/** Money out. Submitted **positive**; the service writes `delta = -amount`. */
export const createWithdrawalSchema = txnMetaFields.extend({
  amount: positiveMinorUnitsSchema,
});
export type CreateWithdrawal = z.infer<typeof createWithdrawalSchema>;

/**
 * The only signed input. History is append-only (D6): a wrong row is never
 * edited or deleted, it is offset by a correction. Requires `goal:update`.
 */
export const createCorrectionSchema = txnMetaFields.extend({
  delta: minorUnitsSchema.refine((v) => v !== 0, 'Коррекция не может быть нулевой'),
  note: nonEmptyString(500),
});
export type CreateCorrection = z.infer<typeof createCorrectionSchema>;

export const goalTransactionResponseSchema = z.object({
  id: idSchema,
  goalId: idSchema,
  userId: idSchema,
  /** Signed minor units: positive = in, negative = out. */
  delta: minorUnitsSchema,
  kind: goalTxnKindSchema,
  note: z.string().nullable(),
  occurredAt: isoDateTimeSchema,
  createdById: idSchema,
  createdAt: isoDateTimeSchema,
});
export type GoalTransactionResponse = z.infer<typeof goalTransactionResponseSchema>;

export const listGoalTransactionsQuerySchema = cursorPaginationSchema.extend({
  kind: z.array(goalTxnKindSchema).optional(),
  userId: idSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export type ListGoalTransactionsQuery = z.infer<typeof listGoalTransactionsQuerySchema>;

export const goalTransactionListResponseSchema = paginatedSchema(goalTransactionResponseSchema);
export type GoalTransactionListResponse = z.infer<typeof goalTransactionListResponseSchema>;

/** Response of a contribute/withdraw call: the row plus the recomputed goal. */
export const goalLedgerMutationResponseSchema = z.object({
  transaction: goalTransactionResponseSchema,
  goal: goalResponseSchema,
});
export type GoalLedgerMutationResponse = z.infer<typeof goalLedgerMutationResponseSchema>;

export const reorderGoalsSchema = z.object({
  /** Full ordered id list; index becomes `sort_order`. */
  ids: z.array(idSchema).min(1).max(200),
});
export type ReorderGoals = z.infer<typeof reorderGoalsSchema>;
