import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, money, primaryId, softDelete, timestamps } from '../../db/base.js';
import { users } from '../identity/users.schema.js';

/**
 * Moneybox — savings goals ("копилка").
 *
 * Single tenant (D1): there is no `household_id` anywhere. Rows point at
 * `users.id` directly and "the family" is simply "every row in `users`".
 *
 * Money (D6): every amount is an **integer minor unit** (копейка) in a
 * `bigint` column via `money()`. Never a float, never `numeric`.
 *
 * ## Balance is derived, never stored
 *
 * `goal_transactions` is **append-only**. A goal's current amount is
 *
 * ```sql
 * SELECT goal_id, SUM(delta) AS current_amount
 *   FROM goal_transactions
 *  GROUP BY goal_id;
 * ```
 *
 * There is deliberately **no cached balance column** on `savings_goals`: a
 * cached balance is a second source of truth that drifts the first time a
 * withdrawal is inserted outside the service. Corrections are new rows with
 * `kind = 'correction'`, never `UPDATE`s or `DELETE`s of history. If the
 * aggregate ever becomes hot (it will not at family scale — a few thousand
 * rows), add a materialized view, not a column.
 */

export const goalStatus = pgEnum('goal_status', ['active', 'reached', 'archived', 'cancelled']);

/**
 * Shared visibility enum. `household` = visible to the whole family,
 * `private` = visible to `owner_id` (plus admins/owners) only.
 *
 * The goals module currently owns this enum because it is the first module to
 * need it; tasks/events should **import** it rather than declare a second
 * `pgEnum('visibility', ...)`, which would collide at migration time.
 */
import { visibility } from '../../db/enums.js';

export { visibility };

export const goalTxnKind = pgEnum('goal_txn_kind', [
  'contribution',
  'withdrawal',
  'correction',
  'interest',
]);

export const savingsGoals = pgTable(
  'savings_goals',
  {
    id: primaryId(),

    title: text().notNull(),
    description: text(),

    /** Target in integer minor units. `100000` = 1 000,00 ₽. */
    targetAmount: money().notNull(),
    /** ISO-4217. The family is single-currency in practice; the column keeps the data honest. */
    currency: text().notNull().default('RUB'),

    /** Calendar date, not an instant — "by 1 September" is a wall-clock statement. */
    deadline: date(),

    imageUrl: text(),
    /** Hex accent used by the progress ring. */
    color: text(),
    /** Lucide icon name, resolved on the client. */
    icon: text(),

    status: goalStatus().notNull().default('active'),
    visibility: visibility().notNull().default('household'),

    /**
     * NULL => a **shared family goal** (everyone contributes, everyone sees it).
     * Non-NULL => a personal goal belonging to that user.
     *
     * `onDelete: 'restrict'` on purpose: silently nulling this on user deletion
     * would promote a private goal to a family-wide one. Members are suspended
     * (D3 `user_status`), not hard-deleted; if a hard delete is ever needed, the
     * service must re-home or archive the goals first.
     */
    ownerId: uuid().references(() => users.id, { onDelete: 'restrict' }),

    createdById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /** Set once `SUM(delta) >= target_amount`; also flips `status` to `reached`. */
    reachedAt: timestamp({ withTimezone: true }),

    sortOrder: integer().notNull().default(0),

    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    index('savings_goals_status_idx').on(t.status),
    index('savings_goals_owner_idx').on(t.ownerId),
    /** The default board: live goals in display order. */
    index('savings_goals_active_idx')
      .on(t.sortOrder, t.createdAt)
      .where(sql`${t.deletedAt} is null and ${t.status} = 'active'`),
    index('savings_goals_deadline_idx')
      .on(t.deadline)
      .where(sql`${t.deadline} is not null and ${t.deletedAt} is null`),
    check('savings_goals_target_positive', sql`${t.targetAmount} > 0`),
  ],
);

/**
 * Checkpoints along a goal — "половина пути", "задаток внесён". Purely
 * motivational: a milestone is reached when the goal's derived balance crosses
 * `target_amount`; nothing about the ledger changes.
 */
export const goalMilestones = pgTable(
  'goal_milestones',
  {
    id: primaryId(),

    goalId: uuid()
      .notNull()
      .references(() => savingsGoals.id, { onDelete: 'cascade' }),

    title: text().notNull(),
    /** Absolute threshold in minor units (not a delta, not a percentage). */
    targetAmount: money().notNull(),

    reachedAt: timestamp({ withTimezone: true }),
    sortOrder: integer().notNull().default(0),

    ...createdAt(),
  },
  (t) => [
    index('goal_milestones_goal_idx').on(t.goalId, t.sortOrder),
    check('goal_milestones_target_positive', sql`${t.targetAmount} > 0`),
  ],
);

/**
 * The moneybox ledger. **APPEND-ONLY** (D6; the same rule as `points_ledger` in
 * D5): no `UPDATE`, no `DELETE`, no soft delete. A mistake is corrected by
 * inserting the inverse row with `kind = 'correction'` and a note.
 *
 * Balance:
 *   `SELECT goal_id, SUM(delta) FROM goal_transactions GROUP BY goal_id`
 * Per-member contribution split:
 *   `SELECT goal_id, user_id, SUM(delta) FROM goal_transactions GROUP BY goal_id, user_id`
 */
export const goalTransactions = pgTable(
  'goal_transactions',
  {
    id: primaryId(),

    goalId: uuid()
      .notNull()
      .references(() => savingsGoals.id, { onDelete: 'cascade' }),

    /** Whose money this is — drives the "кто сколько внёс" breakdown. */
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /**
     * Signed integer minor units. Positive = money in, negative = money out.
     * The sign is authoritative; `kind` is a label for the UI and for reports.
     */
    delta: money().notNull(),
    kind: goalTxnKind().notNull().default('contribution'),

    note: text(),

    /** When it happened in the real world (back-dating allowed), not when it was typed. */
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

    /** Who entered the row — an adult may record a child's contribution. */
    createdById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    ...createdAt(),
  },
  (t) => [
    /** Ledger view + the `SUM(delta)` rollup, both keyed by goal. */
    index('goal_transactions_goal_occurred_idx').on(t.goalId, t.occurredAt.desc()),
    index('goal_transactions_user_idx').on(t.userId, t.occurredAt.desc()),
    check('goal_transactions_delta_not_zero', sql`${t.delta} <> 0`),
  ],
);

export type SavingsGoalRow = typeof savingsGoals.$inferSelect;
export type NewSavingsGoalRow = typeof savingsGoals.$inferInsert;
export type GoalMilestoneRow = typeof goalMilestones.$inferSelect;
export type NewGoalMilestoneRow = typeof goalMilestones.$inferInsert;
export type GoalTransactionRow = typeof goalTransactions.$inferSelect;
export type NewGoalTransactionRow = typeof goalTransactions.$inferInsert;
