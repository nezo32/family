import { z } from 'zod';

import {
  choreWeightSchema,
  cursorPaginationSchema,
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonEmptyString,
  paginatedSchema,
  queryBooleanSchema,
} from './common.js';

/**
 * Chore fairness contracts (D5): rotations, blackouts, swaps, kudos and the
 * fairness read models.
 *
 * There are no points anywhere in this file, and there must never be again:
 * scoring a person turns a family into a leaderboard (D5). Fairness is measured
 * in **chores completed**, a scheduling input the rotation divides by capacity
 * — never a balance shown to anybody as a total.
 *
 * The framing rule for every response here: surface load as a neutral
 * "this week" split, never a sibling leaderboard. That is why the fairness
 * summary reports a *share* and a *debt*, and deliberately has no rank field.
 */

export const rotationStrategySchema = z.enum([
  'round_robin',
  'weighted_balance',
  'fixed',
  'anyone',
]);
export type RotationStrategy = z.infer<typeof rotationStrategySchema>;

export const swapStatusSchema = z.enum(['pending', 'accepted', 'declined', 'cancelled', 'expired']);
export type SwapStatus = z.infer<typeof swapStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Rotations                                                                   */
/* -------------------------------------------------------------------------- */

export const rotationMemberInputSchema = z.object({
  userId: idSchema,
  /** Overrides `users.choreWeight` for this rotation. `0.00` excuses without removing. */
  weight: choreWeightSchema.default('1.00'),
  position: z.number().int().min(0).max(999).default(0),
  active: z.boolean().default(true),
});
export type RotationMemberInput = z.infer<typeof rotationMemberInputSchema>;

export const rotationCreateSchema = z.object({
  name: nonEmptyString(100),
  strategy: rotationStrategySchema.default('weighted_balance'),
  /** Lookback window for the debt calculation. D5 says 28 days. */
  balanceWindowDays: z.number().int().min(1).max(365).default(28),
  members: z.array(rotationMemberInputSchema).max(50).default([]),
});
export type RotationCreate = z.infer<typeof rotationCreateSchema>;

export const rotationUpdateSchema = z.object({
  name: nonEmptyString(100).optional(),
  strategy: rotationStrategySchema.optional(),
  balanceWindowDays: z.number().int().min(1).max(365).optional(),
  /** Full replacement of the member set when present. */
  members: z.array(rotationMemberInputSchema).max(50).optional(),
  /**
   * Re-run assignment for still-`scheduled` future occurrences of every series
   * on this rotation. Off by default: D5 freezes assignment at materialization,
   * and silently reshuffling next week destroys trust.
   */
  reassignFuture: z.boolean().default(false),
});
export type RotationUpdate = z.infer<typeof rotationUpdateSchema>;

export const rotationMemberResponseSchema = z.object({
  userId: idSchema,
  weight: choreWeightSchema,
  position: z.number().int(),
  active: z.boolean(),
});

export const rotationResponseSchema = z.object({
  id: idSchema,
  name: z.string(),
  strategy: rotationStrategySchema,
  balanceWindowDays: z.number().int(),
  cursor: z.number().int(),
  members: z.array(rotationMemberResponseSchema),
  /** How many live series pick their assignee from this rotation. */
  seriesCount: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type RotationResponse = z.infer<typeof rotationResponseSchema>;

export const rotationListQuerySchema = cursorPaginationSchema.extend({
  strategy: rotationStrategySchema.optional(),
});

export const rotationListResponseSchema = paginatedSchema(rotationResponseSchema);

/**
 * "Who would this rotation pick, and why?" — a dry run over the current
 * balances. Exists so fairness is auditable rather than magic; the UI shows it
 * when a member asks why they got the bins again.
 */
export const rotationPreviewQuerySchema = z.object({
  /** Instant to evaluate eligibility (blackouts) at. Defaults to now. */
  at: isoDateTimeSchema.optional(),
  /** Coerced: this is a querystring, so `?count=5` arrives as the string "5". */
  count: z.coerce.number().int().min(1).max(20).default(5),
});

export const rotationPreviewResponseSchema = z.object({
  rotationId: idSchema,
  strategy: rotationStrategySchema,
  picks: z.array(
    z.object({
      userId: idSchema,
      /** `(completed + committed) / weight` at the moment of the pick. Lowest wins. */
      debt: z.number(),
      /** Chores they completed inside the balance window. */
      completed: z.number().int(),
      /** Chores already on their plate but not done yet. */
      committed: z.number().int(),
      weight: choreWeightSchema,
      eligible: z.boolean(),
      /** Why not, when `eligible` is false: `blackout` / `inactive` / `zero_weight`. */
      reason: z.string().nullable(),
    }),
  ),
});
export type RotationPreviewResponse = z.infer<typeof rotationPreviewResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Blackouts                                                                   */
/* -------------------------------------------------------------------------- */

export const blackoutCreateSchema = z
  .object({
    /** Omit to create one for yourself. Another user needs `task:assign:any`. */
    userId: idSchema.optional(),
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    reason: z.string().max(200).nullish(),
  })
  .refine((v) => v.startsAt < v.endsAt, {
    message: 'Начало должно быть раньше окончания',
    path: ['endsAt'],
  });
export type BlackoutCreate = z.infer<typeof blackoutCreateSchema>;

export const blackoutResponseSchema = z.object({
  id: idSchema,
  userId: idSchema,
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  reason: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type BlackoutResponse = z.infer<typeof blackoutResponseSchema>;

export const blackoutListQuerySchema = cursorPaginationSchema.extend({
  userId: idSchema.optional(),
  /** Include windows that have already closed. */
  includePast: queryBooleanSchema.default(false),
});

export const blackoutListResponseSchema = paginatedSchema(blackoutResponseSchema);

/* -------------------------------------------------------------------------- */
/* Swaps                                                                       */
/* -------------------------------------------------------------------------- */

export const swapCreateSchema = z.object({
  occurrenceId: idSchema,
  /** Omit for an **open offer** to the whole family; first taker wins. */
  toUserId: idSchema.optional(),
  message: z.string().max(500).nullish(),
  /** Auto-expire. Defaults server-side to the occurrence deadline. */
  expiresAt: isoDateTimeSchema.optional(),
});
export type SwapCreate = z.infer<typeof swapCreateSchema>;

/** Accept or decline. Accepting reassigns the occurrence with `assignedVia: 'swap'`. */
export const swapRespondSchema = z.object({
  accept: z.boolean(),
  message: z.string().max(500).nullish(),
});
export type SwapRespond = z.infer<typeof swapRespondSchema>;

export const swapResponseSchema = z.object({
  id: idSchema,
  occurrenceId: idSchema,
  /** Denormalized so a swap card renders without a second request. */
  occurrenceTitle: z.string(),
  occurrenceDueAt: isoDateTimeSchema,
  fromUserId: idSchema,
  toUserId: idSchema.nullable(),
  status: swapStatusSchema,
  message: z.string().nullable(),
  respondedById: idSchema.nullable(),
  respondedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type SwapResponse = z.infer<typeof swapResponseSchema>;

export const swapListQuerySchema = cursorPaginationSchema.extend({
  status: z.array(swapStatusSchema).optional(),
  /** `incoming` = addressed to me or open; `outgoing` = I asked. */
  direction: z.enum(['incoming', 'outgoing', 'all']).default('all'),
});
export type SwapListQuery = z.infer<typeof swapListQuerySchema>;

export const swapListResponseSchema = paginatedSchema(swapResponseSchema);

/* -------------------------------------------------------------------------- */
/* Fairness read model                                                         */
/* -------------------------------------------------------------------------- */

export const fairnessQuerySchema = z.object({
  /**
   * Defaults to the rotation's `balanceWindowDays`, i.e. 28 (D5).
   *
   * `z.coerce` because this is a querystring: both callers send
   * `?windowDays=7`, which arrives as the string `"7"` and would fail a bare
   * `z.number()` with a 400 on every call.
   */
  windowDays: z.coerce.number().int().min(1).max(365).default(28),
  rotationId: idSchema.optional(),
});
export type FairnessQuery = z.infer<typeof fairnessQuerySchema>;

/**
 * "This week's split of the housework", the neutral view from D5. Note the
 * absence of a rank: the UI compares each member to their *own fair share*, not
 * to each other, and shows no per-person total at all.
 */
export const fairnessMemberSchema = z.object({
  userId: idSchema,
  weight: choreWeightSchema,
  /** Chores completed in the window. A scheduling input, never a score. */
  completed: z.number().int(),
  /** Still-scheduled chores assigned in the window. */
  committed: z.number().int(),
  /** `(completed + committed) / weight` — the rotation's ordering key. */
  debt: z.number(),
  /** This member's weight as a fraction of total weight, 0..1. */
  fairShare: z.number(),
  /** This member's actual load as a fraction of the total, 0..1. */
  actualShare: z.number(),
  /** Chores they took over for somebody else. The quiet hero metric. */
  coveredForOthers: z.number().int(),
});
export type FairnessMember = z.infer<typeof fairnessMemberSchema>;

export const fairnessSummaryResponseSchema = z.object({
  windowDays: z.number().int(),
  from: isoDateSchema,
  to: isoDateSchema,
  rotationId: idSchema.nullable(),
  members: z.array(fairnessMemberSchema),
  /**
   * Max minus min `actualShare / fairShare`. 0 = perfectly balanced. Shown as a
   * single family-level number so the fix is a family conversation, not a
   * ranking.
   */
  imbalance: z.number(),
});
export type FairnessSummaryResponse = z.infer<typeof fairnessSummaryResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Kudos                                                                       */
/* -------------------------------------------------------------------------- */

export const kudosCreateSchema = z.object({
  toUserId: idSchema,
  occurrenceId: idSchema.nullish(),
  /** A single emoji. A thank-you addressed to a person, never a tally (D5). */
  emoji: z.string().min(1).max(8).default('\u{1F44F}'),
  message: z.string().max(280).nullish(),
});
export type KudosCreate = z.infer<typeof kudosCreateSchema>;

export const kudosResponseSchema = z.object({
  id: idSchema,
  fromUserId: idSchema,
  toUserId: idSchema,
  occurrenceId: idSchema.nullable(),
  emoji: z.string(),
  message: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type KudosResponse = z.infer<typeof kudosResponseSchema>;

export const kudosListQuerySchema = cursorPaginationSchema.extend({
  toUserId: idSchema.optional(),
  occurrenceId: idSchema.optional(),
});

export const kudosListResponseSchema = paginatedSchema(kudosResponseSchema);
