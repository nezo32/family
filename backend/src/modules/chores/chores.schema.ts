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
 * Chore fairness (D5): who gets the next chore and who can trade it away.
 *
 * There is no ledger here and no score of any kind. Fairness is measured in
 * **chores completed** — counted straight off `task_occurrences` — because a
 * number that accumulates against a person's name turns a family into a
 * leaderboard. See `docs/DECISIONS.md` D5.
 *
 * This module imports the tasks module (swaps and kudos hang off a
 * `task_occurrence`); tasks must never import this one back. `task_series.
 * rotation_id` is intentionally a bare uuid for exactly that reason.
 */

/**
 * - `weighted_balance` (default, D5) — lowest `(completed + committed) / weight`
 *   debt over `balanceWindowDays` wins, where both terms are **counts of
 *   chores**. Self-correcting: a member who actually does the work accrues debt
 *   and drops down the queue.
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

    /** Soft removal — keeps past assignments and their attribution intact. */
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
     * There is deliberately no sweetener column. A swap bribe would be
     * denominated in exactly the currency D5 removed, and «дам тебе 5 баллов»
     * between siblings is the trade this app should not be brokering. Asking
     * nicely is the whole mechanism.
     */

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
 * Peer recognition — a thank-you addressed to one person for one thing.
 *
 * Kudos survived the removal of the score system precisely because they are not
 * a score: nothing accumulates, nothing is totalled per person, and the unique
 * index below makes a second identical emoji a no-op rather than a tally. It is
 * a like, not a currency.
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
export type KudosRow = typeof kudos.$inferSelect;
export type NewKudosRow = typeof kudos.$inferInsert;
