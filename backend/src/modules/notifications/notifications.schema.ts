import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, emptyJsonObject, emptyTextArray, primaryId, timestamps } from '../../db/base.js';
import { users } from '../identity/users.schema.js';

/**
 * Notifications — the delivery pipeline (D10).
 *
 * ```
 * domain event
 *   -> notification_intents        (one row per "something happened", deduped)
 *   -> fan-out by permission + preference
 *   -> notification_deliveries     (one row per recipient × channel × device)
 *   -> BullMQ dispatcher -> web push / telegram / in-app inbox
 * ```
 *
 * Two tables, not one, because *what happened* and *who was told, how, when and
 * whether it worked* have different cardinalities and different lifetimes. See
 * `docs/architecture/notifications.md`.
 *
 * Single tenant (D1): there is no `household_id` anywhere; recipients are plain
 * `users.id` references.
 */

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The catalog of things we may notify about. Deliberately an enum and **not** a
 * table: the set is closed, it is compiled into the code that renders each
 * message, and the preferences screen is driven by
 * `NOTIFICATION_TYPE_LABELS_RU` in `@family/shared`. Adding a type is a code
 * change plus a migration, which is exactly the review we want.
 */
export const notificationType = pgEnum('notification_type', [
  // tasks & chores
  'task_assigned',
  'task_due_soon',
  'task_overdue',
  'task_completed',
  'chore_swap_requested',
  'chore_swap_answered',
  // calendar
  'event_reminder',
  'event_created',
  'birthday_today',
  // moneybox goals
  'goal_contribution',
  'goal_milestone_reached',
  'goal_reached',
  // shopping
  'shopping_urgent_item',
  // membership & administration
  'member_pending_approval',
  'member_approved',
  // family wall
  'announcement_posted',
  'kudos_received',
  // periodic & system
  'weekly_digest',
  'system_alert',
]);

/**
 * What a quiet-hours window does to a delivery that lands inside it.
 *
 * - `defer`   — hold the delivery and send it at the end of the window. **The
 *               default, and the only behaviour D10 blesses for real events.**
 * - `silence` — deliver in-app only; do not raise a push/Telegram notification
 *               for this window at all. Chosen explicitly by a user who would
 *               rather miss a ping than receive it late.
 *
 * Neither mode ever drops the notification: the in-app inbox row is always
 * written.
 */
export const quietMode = pgEnum('quiet_mode', ['defer', 'silence']);

/**
 * Priority drives quiet-hours and rate-limit behaviour, not ordering:
 * `critical` is the only level allowed to punch through quiet hours and the
 * per-user hourly push cap.
 */
export const notificationPriority = pgEnum('notification_priority', [
  'low',
  'normal',
  'high',
  'critical',
]);

export const notificationChannel = pgEnum('notification_channel', ['push', 'telegram', 'in_app']);

/**
 * Delivery lifecycle:
 *
 * ```
 * pending ──┬─> scheduled ──> sent ──> read      (in-app / any channel the user opens)
 *           ├─> sent
 *           ├─> failed        (after the retry budget is exhausted)
 *           └─> suppressed    (channel unavailable or turned off after fan-out)
 * ```
 */
export const deliveryStatus = pgEnum('delivery_status', [
  'pending',
  'scheduled',
  'sent',
  'failed',
  'suppressed',
  'read',
]);

/* -------------------------------------------------------------------------- */
/* Web Push subscriptions                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One row per browser/device that granted notification permission — a user with
 * a phone, a laptop and an installed PWA has three rows.
 *
 * Pruning rule (D10): a `410 Gone` or `404 Not Found` from the push service
 * means the subscription is dead. Delete the row (or stamp `expired_at` and let
 * the cleanup job delete it) — never keep retrying it.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: primaryId(),

    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * The push service URL from `PushSubscription.endpoint`. Globally unique —
     * it *is* the identity of the subscription, so a re-subscribe on the same
     * device upserts rather than duplicating.
     */
    endpoint: text().notNull(),

    /** `PushSubscription.toJSON().keys.p256dh` — the client public key. */
    p256dh: text().notNull(),
    /** `PushSubscription.toJSON().keys.auth` — the shared auth secret. */
    auth: text().notNull(),

    /** Raw UA string captured at subscribe time; used to label the device list. */
    userAgent: text().notNull().default(''),
    /** Human label the user can edit: «iPhone Ани», «Ноутбук». */
    deviceLabel: text(),

    /**
     * Was the page running as an installed (Home-Screen) PWA when this
     * subscription was created? iOS only delivers push to installed PWAs, so a
     * non-standalone iOS row is almost certainly already dead and the UI must
     * tell the user to re-install rather than silently failing.
     */
    isStandalone: boolean().notNull().default(false),

    lastSuccessAt: timestamp({ withTimezone: true }),
    lastFailureAt: timestamp({ withTimezone: true }),
    /** Consecutive failures. Reset to 0 on success; prune past the threshold. */
    failureCount: integer().notNull().default(0),

    /**
     * Set when the push service reported the subscription gone, or when the
     * health-check ping failed. Non-null => never dispatch to this row again;
     * the cleanup job removes it and the UI shows the "уведомления отключились"
     * banner.
     */
    expiredAt: timestamp({ withTimezone: true }),

    ...createdAt(),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_uq').on(t.endpoint),
    index('push_subscriptions_user_idx').on(t.userId),
    /** The dispatcher's hot path: live subscriptions for one user. */
    index('push_subscriptions_live_idx')
      .on(t.userId)
      .where(sql`${t.expiredAt} is null`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Telegram                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Telegram delivery target. At most one per user (the PK), populated from the
 * `telegram:bot_access` OAuth scope (D3) — that scope is precisely what lets the
 * bot open a DM without the user having to message it first.
 */
export const telegramLinks = pgTable('telegram_links', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  /**
   * Telegram chat id. 64-bit on paper; every real id is far inside 2^53, so
   * `mode: 'number'` is safe and avoids bigint marshalling everywhere.
   */
  telegramChatId: bigint({ mode: 'number' }).notNull(),

  /** `@username`, stored without the `@`. Nullable — Telegram users may have none. */
  telegramUsername: text(),

  /**
   * False once the bot gets `403 Forbidden: bot was blocked by the user`. The
   * dispatcher must check this before enqueuing, and the UI must offer a
   * re-link, otherwise every Telegram send silently burns a retry budget.
   */
  canDm: boolean().notNull().default(true),

  linkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------------------- */
/* Preferences                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Per-user, per-type channel matrix. **Sparse on purpose**: a missing row means
 * "use the code-side default" (`DEFAULT_NOTIFICATION_PREFERENCES` in
 * `@family/shared`), so adding a new notification type does not require
 * backfilling a row for every user, and changing a default actually reaches the
 * people who never touched the screen.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: primaryId(),

    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    type: notificationType().notNull(),

    channelPush: boolean().notNull().default(true),
    channelTelegram: boolean().notNull().default(false),
    /** The bell icon. Effectively always on — it is the durable record. */
    channelInApp: boolean().notNull().default(true),

    /** Master switch for this type. False => suppress every channel. */
    enabled: boolean().notNull().default(true),

    ...timestamps(),
  },
  (t) => [uniqueIndex('notification_preferences_user_type_uq').on(t.userId, t.type)],
);

/**
 * Quiet-hours windows. Multiple rows per user compose (a delivery is quiet if it
 * falls inside *any* window).
 *
 * Times are floating local wall clock `HH:mm` in the user's timezone
 * (`users.timezone`, falling back to `family_settings.timezone`) — never a UTC
 * instant, per the D2 time model. A window whose `endsAt` is <= `startsAt`
 * wraps past midnight (`22:00 -> 07:00`).
 */
export const quietHours = pgTable(
  'quiet_hours',
  {
    id: primaryId(),

    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** 0 = Sunday … 6 = Saturday. NULL = every day. */
    dayOfWeek: integer(),

    /** `HH:mm`, inclusive. */
    startsAt: text().notNull(),
    /** `HH:mm`, exclusive. `<= startsAt` means the window wraps past midnight. */
    endsAt: text().notNull(),

    mode: quietMode().notNull().default('defer'),

    ...createdAt(),
  },
  (t) => [index('quiet_hours_user_idx').on(t.userId)],
);

/* -------------------------------------------------------------------------- */
/* Intents                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * "Something happened and somebody should know." One row per *domain event*,
 * independent of how many people end up being told.
 *
 * The producer writes an intent and stops thinking about notifications; the
 * fan-out worker turns it into `notification_deliveries`.
 */
export const notificationIntents = pgTable(
  'notification_intents',
  {
    id: primaryId(),

    type: notificationType().notNull(),

    /** Who caused it. NULL for system/scheduler-originated intents. */
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),

    /** Loose polymorphic pointer: `'task_occurrence'`, `'event'`, `'goal'`, … */
    entityType: text(),
    entityId: uuid(),

    /**
     * Everything the renderers need to build the title/body/deep link *at send
     * time* without re-reading the source row — the task may have been renamed
     * or deleted by the time a deferred delivery fires. Denormalize on purpose.
     */
    payload: jsonb().$type<Record<string, unknown>>().notNull().default(emptyJsonObject),

    /**
     * Idempotency guard. A stable, caller-computed string such as
     * `task_due_soon:<occurrenceId>:2026-08-19` or
     * `event_reminder:<occurrenceId>:30m`. A retried BullMQ job, a double-click
     * or a re-run materializer inserts the same key and loses the race, so the
     * family is never told twice. NULL opts out (genuinely one-off intents).
     */
    dedupeKey: text(),

    priority: notificationPriority().notNull().default('normal'),

    ...createdAt(),
  },
  (t) => [
    /**
     * Partial unique index: NULLs do not collide in Postgres anyway, but the
     * predicate keeps the index to the rows that actually carry a key.
     * `INSERT ... ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
     * DO NOTHING` is the intended write path.
     */
    uniqueIndex('notification_intents_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index('notification_intents_type_created_idx').on(t.type, t.createdAt.desc()),
    index('notification_intents_entity_idx').on(t.entityType, t.entityId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Deliveries                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One row per (intent × recipient × channel × device). This is simultaneously:
 *
 * - the **work queue payload** for the dispatcher,
 * - the **in-app inbox** (channel `in_app`; `read_at` is what clears the bell),
 * - the **audit log** of what we actually sent, when, and why it failed.
 *
 * Deliveries are never deleted by the app; the cleanup job trims old rows.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: primaryId(),

    intentId: uuid()
      .notNull()
      .references(() => notificationIntents.id, { onDelete: 'cascade' }),

    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    channel: notificationChannel().notNull(),
    status: deliveryStatus().notNull().default('pending'),

    /**
     * When the dispatcher may send this. Set to the **end of the quiet-hours
     * window** when deferred, or to a future instant for reminders and digests.
     * NULL means "as soon as possible".
     */
    scheduledFor: timestamp({ withTimezone: true }),

    sentAt: timestamp({ withTimezone: true }),
    readAt: timestamp({ withTimezone: true }),

    /** Retry counter driving the exponential backoff. */
    attempt: integer().notNull().default(0),
    /** Last transport error, truncated. Diagnostics only — never shown to users. */
    lastError: text(),

    /**
     * Which device this push row targets. `set null` (not cascade): when a dead
     * subscription is pruned we keep the historical delivery record.
     */
    subscriptionId: uuid().references(() => pushSubscriptions.id, { onDelete: 'set null' }),

    ...createdAt(),
  },
  (t) => [
    /** The bell icon / inbox query. */
    index('notification_deliveries_inbox_idx').on(t.userId, t.status, t.createdAt.desc()),
    /** The dispatcher sweep: everything deferred that is now due. */
    index('notification_deliveries_due_idx')
      .on(t.scheduledFor)
      .where(sql`${t.status} = 'scheduled'`),
    index('notification_deliveries_intent_idx').on(t.intentId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Escalation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * "If nobody acknowledged a `task_overdue` within 60 minutes, tell an adult."
 *
 * Rows are family-wide configuration (single tenant), evaluated by the
 * escalation sweep job. Exactly one of `escalateToRole` / `escalateToUserId`
 * should be set; role wins if both are, and the sweep skips the original
 * recipients so escalation never re-notifies the person who already ignored it.
 */
export const escalationPolicies = pgTable(
  'escalation_policies',
  {
    id: primaryId(),

    type: notificationType().notNull(),

    /** Minutes after the original delivery before escalating. */
    afterMinutes: integer().notNull(),

    /** A `Role` value from `@family/shared` — text, so the enum stays in one place. */
    escalateToRole: text(),
    escalateToUserId: uuid().references(() => users.id, { onDelete: 'set null' }),

    enabled: boolean().notNull().default(true),

    ...timestamps(),
  },
  (t) => [index('escalation_policies_type_idx').on(t.type).where(sql`${t.enabled}`)],
);

/* -------------------------------------------------------------------------- */
/* Weekly digest                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Opt-in weekly summary. One row per user; absent row => no digest.
 * `weekday`/`timeOfDay` are local wall clock in the user's timezone, resolved by
 * the digest job the same way quiet hours are.
 */
export const digestSubscriptions = pgTable('digest_subscriptions', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** 0 = Sunday … 6 = Saturday. */
  weekday: integer().notNull().default(0),
  /** `HH:mm` local. */
  timeOfDay: text().notNull().default('19:00'),

  /** Which blocks to include — values from `DIGEST_SECTIONS` in `@family/shared`. */
  sections: text().array().notNull().default(emptyTextArray),

  enabled: boolean().notNull().default(true),

  /** Guards against a double send when the job re-runs. */
  lastSentAt: timestamp({ withTimezone: true }),

  ...timestamps(),
});

/* -------------------------------------------------------------------------- */
/* Row types                                                                   */
/* -------------------------------------------------------------------------- */

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscriptionRow = typeof pushSubscriptions.$inferInsert;

export type TelegramLinkRow = typeof telegramLinks.$inferSelect;
export type NewTelegramLinkRow = typeof telegramLinks.$inferInsert;

export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreferenceRow = typeof notificationPreferences.$inferInsert;

export type QuietHoursRow = typeof quietHours.$inferSelect;
export type NewQuietHoursRow = typeof quietHours.$inferInsert;

export type NotificationIntentRow = typeof notificationIntents.$inferSelect;
export type NewNotificationIntentRow = typeof notificationIntents.$inferInsert;

export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDeliveryRow = typeof notificationDeliveries.$inferInsert;

export type EscalationPolicyRow = typeof escalationPolicies.$inferSelect;
export type NewEscalationPolicyRow = typeof escalationPolicies.$inferInsert;

export type DigestSubscriptionRow = typeof digestSubscriptions.$inferSelect;
export type NewDigestSubscriptionRow = typeof digestSubscriptions.$inferInsert;
