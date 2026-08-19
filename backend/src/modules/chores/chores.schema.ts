import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId, timestamps } from '../../db/base.js';
import { users } from '../identity/users.schema.js';
import { taskOccurrences } from '../tasks/tasks.schema.js';

/**
 * Chore fairness (D5): who gets the next chore, who can trade it away, and what
 * that is worth.
 *
 * This module imports the tasks module (swaps and points hang off a
 * `task_occurrence`); tasks must never import this one back. `task_series.
 * rotation_id` is intentionally a bare uuid for exactly that reason.
 */

/**
 * - `weighted_balance` (default, D5) — lowest `(earned + committed) / weight`
 *   debt over `balanceWindowDays` wins. Self-correcting: a member who actually
 *   does the work accrues debt and drops down the queue.
 * - `round_robin`      — strict order by `position`, ignoring who did what.
 * - `fixed`            — always the same person (a single active member).
 * - `anyone`           — materialize unassigned; first claimer takes it.
 *
 * Never `random`: re-running the materializer must reproduce the same schedule
 * bit for bit, or the horizon extension silently reshuffles next week.
 */
export const rotationStrategy = pgEnum('rotation_strategy', [
  'round_robin',
  'weighted_balance',
  'fixed',
  'anyone',
]);

export const swapStatus = pgEnum('swap_status', [
  'pending',
  'accepted',
  'declined',
  'cancelled',
  'expired',
]);

/**
 * Why points moved. The ledger is append-only, so a mistake is corrected with a
 * compensating `manual_award`/`penalty` row, never an UPDATE or a DELETE.
 */
export const pointsReason = pgEnum('points_reason', [
  'chore_completed',
  'covered_for_other',
  'on_time_bonus',
  'streak_bonus',
  'manual_award',
  'redeemed',
  'penalty',
  'swap_bonus',
]);

export const rotations = pgTable(
  'rotations',
  {
    id: primaryId(),
    name: text().notNull(),

    strategy: rotationStrategy().notNull().default('weighted_balance'),

    /** Lookback for the `weighted_balance` debt calculation. D5 says 28 days. */
    balanceWindowDays: integer().notNull().default(28),

    /**
     * `round_robin` position of the *next* pick. Advanced by the materializer,
     * so a rotation is a tiny piece of mutable state — which is also why
     * materialization must run in one transaction per series.
     */
    cursor: integer().notNull().default(0),

    ...timestamps(),
  },
  (t) => [uniqueIndex('rotations_name_uq').on(t.name)],
);

export const rotationMembers = pgTable(
  'rotation_members',
  {
    id: primaryId(),

    rotationId: uuid()
      .notNull()
      .references(() => rotations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * Per-rotation capacity multiplier, overriding `users.chore_weight` for this
     * rotation only (a teenager may be a full share for dishes and a half share
     * for cooking). `0.00` excuses a member without removing their history.
     */
    weight: numeric({ precision: 4, scale: 2 }).notNull().default('1.00'),

    /** `round_robin` order and the final deterministic tie-break for `weighted_balance`. */
    position: integer().notNull().default(0),

    /** Soft removal — keeps past assignments and ledger attribution intact. */
    active: boolean().notNull().default(true),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex('rotation_members_rotation_user_uq').on(t.rotationId, t.userId),
    index('rotation_members_rotation_position_idx').on(t.rotationId, t.position),
  ],
);

/**
 * Periods in which a member is not eligible for assignment — holidays, exams,
 * illness, a trip. The rotation skips anyone whose blackout covers the
 * occurrence start; the skipped member keeps their accrued debt, so they come
 * back to the top of the queue afterwards rather than being quietly forgiven.
 */
export const userBlackouts = pgTable(
  'user_blackouts',
  {
    id: primaryId(),

    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    reason: text(),

    ...timestamps(),
  },
  (t) => [index('user_blackouts_user_range_idx').on(t.userId, t.startsAt, t.endsAt)],
);

export const choreSwaps = pgTable(
  'chore_swaps',
  {
    id: primaryId(),

    occurrenceId: uuid()
      .notNull()
      .references(() => taskOccurrences.id, { onDelete: 'cascade' }),

    fromUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** NULL => an **open offer** to the whole family; first taker wins. */
    toUserId: uuid().references(() => users.id, { onDelete: 'cascade' }),

    status: swapStatus().notNull().default('pending'),
    message: text(),

    /**
     * Sweetener the asker offers out of their own balance. Booked as a
     * `swap_bonus` pair only when the swap is accepted *and* the covering member
     * actually completes the chore.
     */
    bonusPoints: integer().notNull().default(0),

    respondedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    respondedAt: timestamp({ withTimezone: true }),

    /** A pending swap past this instant is swept to `expired` by the nightly job. */
    expiresAt: timestamp({ withTimezone: true }),

    ...createdAt(),
  },
  (t) => [
    /**
     * At most one live offer per occurrence. Without this, two taps on a flaky
     * mobile connection create two pending swaps and two people think they have
     * taken the chore.
     */
    uniqueIndex('chore_swaps_one_pending_uq')
      .on(t.occurrenceId)
      .where(sql`${t.status} = 'pending'`),

    index('chore_swaps_to_user_idx').on(t.toUserId, t.status),
    index('chore_swaps_from_user_idx').on(t.fromUserId, t.status),
    index('chore_swaps_occurrence_idx').on(t.occurrenceId),
  ],
);

/**
 * **Append-only** (D5). A balance is `SUM(delta)` over a window — there is no
 * cached balance column anywhere, and adding one would be a regression.
 * Nothing in the application may UPDATE or DELETE a row here.
 */
export const pointsLedger = pgTable(
  'points_ledger',
  {
    id: primaryId(),

    /** Whoever earned it — the doer, not necessarily the assignee (D5). */
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Signed. Negative for `redeemed` / `penalty`. */
    delta: integer().notNull(),

    reason: pointsReason().notNull(),

    /** What it was for. `set null` so a purged occurrence never erases a balance. */
    occurrenceId: uuid().references(() => taskOccurrences.id, { onDelete: 'set null' }),

    /** Who granted a manual award / penalty. NULL for system-generated rows. */
    awardedById: uuid().references(() => users.id, { onDelete: 'set null' }),

    note: text(),

    ...createdAt(),
  },
  (t) => [
    /** Balance and history queries: `WHERE user_id = $1 AND created_at >= $2`. */
    index('points_ledger_user_created_idx').on(t.userId, t.createdAt),

    /**
     * The double-award guard. Completion is the one path a user can trigger
     * repeatedly (double tap, retry after a timeout, an offline queue replaying
     * on reconnect), so the two automatic completion reasons are made
     * idempotent at the database level. Discretionary rows (`manual_award`,
     * `penalty`, `swap_bonus`, ...) are deliberately outside the predicate —
     * an adult may award twice on purpose.
     */
    uniqueIndex('points_ledger_award_once_uq')
      .on(t.occurrenceId, t.userId, t.reason)
      .where(
        sql`${t.occurrenceId} is not null and ${t.reason} in ('chore_completed', 'on_time_bonus')`,
      ),
  ],
);

/**
 * Derived cache, and the one place a derived value is allowed to be stored: a
 * streak is a fold over the whole history, too expensive to recompute per
 * dashboard render. Rebuildable from `points_ledger` + `task_occurrences` at
 * any time, so a bug here loses nothing permanent.
 */
export const userStreaks = pgTable('user_streaks', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  current: integer().notNull().default(0),
  longest: integer().notNull().default(0),

  /** Last occurrence deadline folded into the streak — the resume point. */
  lastResolvedAt: timestamp({ withTimezone: true }),

  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Peer recognition. Cheap, non-competitive, and deliberately **not** points:
 * D5 warns against a sibling leaderboard, so kudos carry no ledger effect.
 */
export const kudos = pgTable(
  'kudos',
  {
    id: primaryId(),

    fromUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** What it is for. NULL => a free-standing thank-you on the family wall. */
    occurrenceId: uuid().references(() => taskOccurrences.id, { onDelete: 'set null' }),

    emoji: text().notNull().default('\u{1F44F}'),
    message: text(),

    ...createdAt(),
  },
  (t) => [
    /**
     * One of each emoji per person per occurrence — a like, not a tally.
     * NULL `occurrence_id` rows are distinct in Postgres, so free-standing
     * kudos are unconstrained, which is what we want.
     */
    uniqueIndex('kudos_from_occurrence_emoji_uq').on(t.fromUserId, t.occurrenceId, t.emoji),
    index('kudos_to_user_idx').on(t.toUserId, t.createdAt),
  ],
);

export type RotationRow = typeof rotations.$inferSelect;
export type NewRotationRow = typeof rotations.$inferInsert;
export type RotationMemberRow = typeof rotationMembers.$inferSelect;
export type NewRotationMemberRow = typeof rotationMembers.$inferInsert;
export type UserBlackoutRow = typeof userBlackouts.$inferSelect;
export type NewUserBlackoutRow = typeof userBlackouts.$inferInsert;
export type ChoreSwapRow = typeof choreSwaps.$inferSelect;
export type NewChoreSwapRow = typeof choreSwaps.$inferInsert;
export type PointsLedgerRow = typeof pointsLedger.$inferSelect;
export type NewPointsLedgerRow = typeof pointsLedger.$inferInsert;
export type UserStreakRow = typeof userStreaks.$inferSelect;
export type NewUserStreakRow = typeof userStreaks.$inferInsert;
export type KudosRow = typeof kudos.$inferSelect;
export type NewKudosRow = typeof kudos.$inferInsert;
