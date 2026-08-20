import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import {
  DELIVERY_STATUS_RANK,
  type DeliveryStatus,
  type EscalationState,
  type NotificationType,
} from '@family/shared';

import type { Executor } from '../../core/db.js';
import { ts } from '../../core/sql.js';
import { familySettings } from '../identity/identity.schema.js';
import { users } from '../identity/users.schema.js';
import {
  digestSubscriptions,
  escalationPolicies,
  notificationDeliveries,
  notificationIntents,
  notificationPreferences,
  pushSubscriptions,
  quietHours,
  telegramLinks,
  type DigestSubscriptionRow,
  type EscalationPolicyRow,
  type NewEscalationPolicyRow,
  type NewNotificationDeliveryRow,
  type NewNotificationIntentRow,
  type NotificationDeliveryRow,
  type NotificationIntentRow,
  type NotificationPreferenceRow,
  type PushSubscriptionRow,
  type QuietHoursRow,
  type TelegramLinkRow,
} from './notifications.schema.js';

/**
 * Notifications data access.
 *
 * Every function takes an `Executor` (a pool handle *or* an open transaction) as
 * its first argument, per D8 — that is what lets `emitIntent` write the intent
 * row inside the producer's transaction so a rolled-back task can never produce
 * a notification. No HTTP knowledge, no business rules, no logging.
 *
 * Two invariants are enforced here rather than in the service because they are
 * about *rows*, not policy:
 *
 * 1. **Intent dedupe** is an `ON CONFLICT (dedupe_key) DO NOTHING` against the
 *    partial unique index, not a read-then-write. Two concurrent producers must
 *    produce one intent, and a check-then-insert loses that race.
 * 2. **Delivery status never regresses** (D11). Every status write carries a
 *    `WHERE rank(status) < rank(new)` predicate built from
 *    `DELIVERY_STATUS_RANK`, so a late `delivered` ack cannot drag an already
 *    `acknowledged` row backwards and a replayed offline ack is a no-op.
 */

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

const first = <T>(rows: T[]): T | null => rows[0] ?? null;

/**
 * SQL predicate: "the row's current status ranks strictly below `next`".
 *
 * Expressed as an explicit `CASE` over the enum rather than a lookup table so
 * the ordering lives in one place in TypeScript and is compiled into the query.
 */
function statusRanksBelow(next: DeliveryStatus) {
  const target = DELIVERY_STATUS_RANK[next];
  const cases = Object.entries(DELIVERY_STATUS_RANK)
    .map(([status, rank]) => sql`when ${notificationDeliveries.status} = ${status} then ${rank}`)
    .reduce((acc, part) => sql`${acc} ${part}`);
  return sql`(case ${cases} else 0 end) < ${target}`;
}

/** Users we are ever allowed to notify: active members only (fan-out rule §3). */
export interface RecipientRow {
  id: string;
  role: (typeof users.$inferSelect)['role'];
  displayName: string;
  timezone: string | null;
  permissionGrants: string[];
  permissionDenies: string[];
}

const recipientColumns = {
  id: users.id,
  role: users.role,
  displayName: users.displayName,
  timezone: users.timezone,
  permissionGrants: users.permissionGrants,
  permissionDenies: users.permissionDenies,
};

/* -------------------------------------------------------------------------- */
/* Family settings & recipients                                                */
/* -------------------------------------------------------------------------- */

/** The singleton family timezone, used whenever `users.timezone` is NULL. */
export async function getFamilyDefaults(
  x: Executor,
): Promise<{ timezone: string; quietHoursStart: string; quietHoursEnd: string }> {
  const rows = await x
    .select({
      timezone: familySettings.timezone,
      quietHoursStart: familySettings.quietHoursStart,
      quietHoursEnd: familySettings.quietHoursEnd,
    })
    .from(familySettings)
    .limit(1);

  return (
    first(rows) ?? { timezone: 'Europe/Moscow', quietHoursStart: '22:00', quietHoursEnd: '07:30' }
  );
}

export async function listActiveUsers(x: Executor): Promise<RecipientRow[]> {
  return x.select(recipientColumns).from(users).where(eq(users.status, 'active'));
}

export async function listActiveUsersByIds(x: Executor, ids: string[]): Promise<RecipientRow[]> {
  if (ids.length === 0) return [];
  return x
    .select(recipientColumns)
    .from(users)
    .where(and(eq(users.status, 'active'), inArray(users.id, ids)));
}

export async function listActiveUsersByRoles(
  x: Executor,
  roles: string[],
): Promise<RecipientRow[]> {
  if (roles.length === 0) return [];
  return x
    .select(recipientColumns)
    .from(users)
    .where(
      and(
        eq(users.status, 'active'),
        inArray(users.role, roles as (typeof users.$inferSelect)['role'][]),
      ),
    );
}

export async function getActorSummary(
  x: Executor,
  actorId: string,
): Promise<{ id: string; displayName: string; avatarUrl: string | null } | null> {
  const rows = await x
    .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  return first(rows);
}

/* -------------------------------------------------------------------------- */
/* Intents                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Inserts an intent, losing the race silently when `dedupeKey` already exists.
 *
 * Returns `null` on conflict — the caller then looks the existing row up. The
 * `targetWhere` mirrors the partial unique index predicate, which Postgres
 * requires in order to use it for conflict arbitration.
 */
export async function insertIntent(
  x: Executor,
  values: NewNotificationIntentRow,
): Promise<NotificationIntentRow | null> {
  const rows = await x
    .insert(notificationIntents)
    .values(values)
    .onConflictDoNothing({
      target: notificationIntents.dedupeKey,
      // Mirrors the partial unique index predicate; Postgres requires it to use
      // that index for conflict arbitration.
      where: sql`${notificationIntents.dedupeKey} is not null`,
    })
    .returning();
  return first(rows);
}

export async function findIntentByDedupeKey(
  x: Executor,
  dedupeKey: string,
): Promise<NotificationIntentRow | null> {
  const rows = await x
    .select()
    .from(notificationIntents)
    .where(eq(notificationIntents.dedupeKey, dedupeKey))
    .limit(1);
  return first(rows);
}

export async function getIntent(
  x: Executor,
  intentId: string,
): Promise<NotificationIntentRow | null> {
  const rows = await x
    .select()
    .from(notificationIntents)
    .where(eq(notificationIntents.id, intentId))
    .limit(1);
  return first(rows);
}

/**
 * Advances the escalation ladder **only** from the expected state (D11).
 *
 * Returns `true` when this caller won the transition. Two sweeps racing on the
 * same intent produce exactly one winner, which is the whole guardrail: the
 * family is never told twice that nobody answered.
 */
export async function advanceEscalationState(
  x: Executor,
  intentId: string,
  from: EscalationState,
  to: EscalationState,
  at: Date,
): Promise<boolean> {
  const rows = await x
    .update(notificationIntents)
    .set({ escalationState: to, escalatedAt: at })
    .where(and(eq(notificationIntents.id, intentId), eq(notificationIntents.escalationState, from)))
    .returning({ id: notificationIntents.id });
  return rows.length > 0;
}

/** Intents that were emitted but never fanned out — the lost-`dispatch()` net. */
export async function listUndispatchedIntents(
  x: Executor,
  olderThan: Date,
  limit = 200,
): Promise<NotificationIntentRow[]> {
  return x
    .select()
    .from(notificationIntents)
    .where(
      and(
        lt(notificationIntents.createdAt, olderThan),
        sql`not exists (select 1 from ${notificationDeliveries} d where d.intent_id = ${notificationIntents.id})`,
      ),
    )
    .orderBy(asc(notificationIntents.createdAt))
    .limit(limit);
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                 */
/* -------------------------------------------------------------------------- */

export async function listPreferencesForUsers(
  x: Executor,
  userIds: string[],
  type: NotificationType,
): Promise<NotificationPreferenceRow[]> {
  if (userIds.length === 0) return [];
  return x
    .select()
    .from(notificationPreferences)
    .where(
      and(inArray(notificationPreferences.userId, userIds), eq(notificationPreferences.type, type)),
    );
}

export async function listPreferencesForUser(
  x: Executor,
  userId: string,
): Promise<NotificationPreferenceRow[]> {
  return x.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
}

export async function upsertPreferences(
  x: Executor,
  userId: string,
  rows: Array<{
    type: NotificationType;
    enabled: boolean;
    channelPush: boolean;
    channelTelegram: boolean;
    channelInApp: boolean;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  await x
    .insert(notificationPreferences)
    .values(rows.map((r) => ({ ...r, userId })))
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.type],
      set: {
        enabled: sql`excluded.enabled`,
        channelPush: sql`excluded.channel_push`,
        channelTelegram: sql`excluded.channel_telegram`,
        channelInApp: sql`excluded.channel_in_app`,
        updatedAt: new Date(),
      },
    });
}

/* -------------------------------------------------------------------------- */
/* Quiet hours                                                                 */
/* -------------------------------------------------------------------------- */

export async function listQuietHoursForUsers(
  x: Executor,
  userIds: string[],
): Promise<QuietHoursRow[]> {
  if (userIds.length === 0) return [];
  return x.select().from(quietHours).where(inArray(quietHours.userId, userIds));
}

export async function listQuietHoursForUser(x: Executor, userId: string): Promise<QuietHoursRow[]> {
  return x.select().from(quietHours).where(eq(quietHours.userId, userId));
}

/** `PUT /quiet-hours` replaces the whole set — simplest thing that is correct. */
export async function replaceQuietHours(
  x: Executor,
  userId: string,
  windows: Array<{
    dayOfWeek: number | null;
    startsAt: string;
    endsAt: string;
    mode: 'defer' | 'silence';
  }>,
): Promise<QuietHoursRow[]> {
  await x.delete(quietHours).where(eq(quietHours.userId, userId));
  if (windows.length === 0) return [];
  return x
    .insert(quietHours)
    .values(windows.map((w) => ({ ...w, userId })))
    .returning();
}

/* -------------------------------------------------------------------------- */
/* Push subscriptions                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Upsert keyed on `endpoint` alone — never `(userId, endpoint)`.
 *
 * The endpoint *is* the identity of a subscription (see
 * `docs/research/ios-pwa-push.md` §14). Re-binding `userId` on conflict is what
 * makes a shared family tablet work: Аня signs out, Петя signs in, the browser
 * hands back the same endpoint, and the row moves to Петя instead of silently
 * pushing Петя's notifications to Аня's account.
 *
 * A re-subscribe also clears the health counters: the device is demonstrably
 * alive right now.
 */
export async function upsertPushSubscription(
  x: Executor,
  values: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string;
    deviceLabel: string | null;
    isStandalone: boolean;
  },
): Promise<PushSubscriptionRow> {
  const rows = await x
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: values.userId,
        p256dh: values.p256dh,
        auth: values.auth,
        userAgent: values.userAgent,
        deviceLabel: values.deviceLabel,
        isStandalone: values.isStandalone,
        failureCount: 0,
        consecutiveNoAck: 0,
        unhealthyAt: null,
        expiredAt: null,
      },
    })
    .returning();

  const row = first(rows);
  if (!row) throw new Error('upsertPushSubscription returned no row');
  return row;
}

export async function listPushSubscriptions(
  x: Executor,
  userId: string,
  options: { liveOnly?: boolean } = {},
): Promise<PushSubscriptionRow[]> {
  const predicate = options.liveOnly
    ? and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.expiredAt))
    : eq(pushSubscriptions.userId, userId);
  return x
    .select()
    .from(pushSubscriptions)
    .where(predicate)
    .orderBy(desc(pushSubscriptions.createdAt));
}

export async function getPushSubscription(
  x: Executor,
  id: string,
): Promise<PushSubscriptionRow | null> {
  const rows = await x
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.id, id))
    .limit(1);
  return first(rows);
}

export async function getPushSubscriptionByEndpoint(
  x: Executor,
  endpoint: string,
): Promise<PushSubscriptionRow | null> {
  const rows = await x
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .limit(1);
  return first(rows);
}

/** Idempotent: unsubscribing a device that is already gone is a success. */
export async function deletePushSubscription(
  x: Executor,
  userId: string,
  endpoint: string,
): Promise<number> {
  const rows = await x
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .returning({ id: pushSubscriptions.id });
  return rows.length;
}

/**
 * Delete one of the caller's own subscriptions by row id.
 *
 * This is the "revoke my lost phone" path. It cannot key on `endpoint` the way
 * the self-unsubscribe route does, because the endpoint is a capability URL and
 * is deliberately withheld from list responses — the other device has no way to
 * know it. Scoping the delete to `userId` is what keeps it safe.
 */
export async function deletePushSubscriptionById(
  x: Executor,
  userId: string,
  id: string,
): Promise<number> {
  const rows = await x
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.id, id)))
    .returning({ id: pushSubscriptions.id });
  return rows.length;
}

/** `404`/`410` from the push service, or a health check that gave up. */
export async function expirePushSubscription(x: Executor, id: string, at: Date): Promise<void> {
  await x
    .update(pushSubscriptions)
    .set({ expiredAt: at, lastFailureAt: at })
    .where(and(eq(pushSubscriptions.id, id), isNull(pushSubscriptions.expiredAt)));
}

/**
 * The push service accepted the message. Note what this does **not** do: it
 * does not touch `consecutiveNoAck`. A `201` is not a receipt (D11).
 */
export async function recordPushAccepted(x: Executor, id: string, at: Date): Promise<void> {
  await x
    .update(pushSubscriptions)
    .set({
      lastSuccessAt: at,
      failureCount: 0,
      consecutiveNoAck: sql`${pushSubscriptions.consecutiveNoAck} + 1`,
    })
    .where(eq(pushSubscriptions.id, id));
}

/** Transport failure. Returns the new consecutive-failure count. */
export async function recordPushFailure(x: Executor, id: string, at: Date): Promise<number> {
  const rows = await x
    .update(pushSubscriptions)
    .set({ lastFailureAt: at, failureCount: sql`${pushSubscriptions.failureCount} + 1` })
    .where(eq(pushSubscriptions.id, id))
    .returning({ failureCount: pushSubscriptions.failureCount });
  return first(rows)?.failureCount ?? 0;
}

/**
 * A real arrival ack from the service worker. Resets the health counters and
 * clears the «уведомления отключились» banner.
 */
export async function recordPushDelivered(x: Executor, id: string, at: Date): Promise<void> {
  await x
    .update(pushSubscriptions)
    .set({ lastDeliveredAt: at, consecutiveNoAck: 0, unhealthyAt: null, failureCount: 0 })
    .where(eq(pushSubscriptions.id, id));
}

/**
 * Marks every live subscription that has gone `threshold` sends without an
 * arrival ack. Returns the rows it just marked, so the caller can log/alert
 * once rather than every sweep.
 */
export async function markUnhealthySubscriptions(
  x: Executor,
  threshold: number,
  at: Date,
): Promise<PushSubscriptionRow[]> {
  return x
    .update(pushSubscriptions)
    .set({ unhealthyAt: at })
    .where(
      and(
        isNull(pushSubscriptions.expiredAt),
        isNull(pushSubscriptions.unhealthyAt),
        gte(pushSubscriptions.consecutiveNoAck, threshold),
      ),
    )
    .returning();
}

/** Live subscriptions not seen in `before` — the 90-day prune (§14). */
export async function listStalePushSubscriptions(
  x: Executor,
  before: Date,
): Promise<PushSubscriptionRow[]> {
  return x
    .select()
    .from(pushSubscriptions)
    .where(
      and(
        isNull(pushSubscriptions.expiredAt),
        or(
          and(isNull(pushSubscriptions.lastSuccessAt), lt(pushSubscriptions.createdAt, before)),
          and(
            isNotNull(pushSubscriptions.lastSuccessAt),
            lt(pushSubscriptions.lastSuccessAt, before),
          ),
        ),
      ),
    );
}

export async function countLivePushSubscriptions(
  x: Executor,
  userId: string,
): Promise<{ live: number; healthy: number }> {
  const rows = await x
    .select({
      live: sql<number>`count(*)::int`,
      healthy: sql<number>`count(*) filter (where ${pushSubscriptions.unhealthyAt} is null)::int`,
    })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.expiredAt)));
  return first(rows) ?? { live: 0, healthy: 0 };
}

/* -------------------------------------------------------------------------- */
/* Telegram                                                                    */
/* -------------------------------------------------------------------------- */

export async function getTelegramLink(
  x: Executor,
  userId: string,
): Promise<TelegramLinkRow | null> {
  const rows = await x
    .select()
    .from(telegramLinks)
    .where(eq(telegramLinks.userId, userId))
    .limit(1);
  return first(rows);
}

export async function listTelegramLinks(
  x: Executor,
  userIds: string[],
): Promise<TelegramLinkRow[]> {
  if (userIds.length === 0) return [];
  return x.select().from(telegramLinks).where(inArray(telegramLinks.userId, userIds));
}

/** `403 bot was blocked by the user` — stop burning the retry budget forever. */
export async function disableTelegramDm(x: Executor, userId: string): Promise<void> {
  await x.update(telegramLinks).set({ canDm: false }).where(eq(telegramLinks.userId, userId));
}

export async function deleteTelegramLink(x: Executor, userId: string): Promise<void> {
  await x.delete(telegramLinks).where(eq(telegramLinks.userId, userId));
}

/* -------------------------------------------------------------------------- */
/* Deliveries                                                                  */
/* -------------------------------------------------------------------------- */

export async function insertDeliveries(
  x: Executor,
  rows: NewNotificationDeliveryRow[],
): Promise<NotificationDeliveryRow[]> {
  if (rows.length === 0) return [];
  return x.insert(notificationDeliveries).values(rows).returning();
}

export async function listDeliveriesForIntent(
  x: Executor,
  intentId: string,
): Promise<NotificationDeliveryRow[]> {
  return x
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.intentId, intentId));
}

export async function getDelivery(
  x: Executor,
  id: string,
): Promise<NotificationDeliveryRow | null> {
  const rows = await x
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, id))
    .limit(1);
  return first(rows);
}

/** The delivery plus its intent — everything a dispatcher needs in one round trip. */
export interface DeliveryWithIntent {
  delivery: NotificationDeliveryRow;
  intent: NotificationIntentRow;
}

export async function getDeliveryWithIntent(
  x: Executor,
  id: string,
): Promise<DeliveryWithIntent | null> {
  const rows = await x
    .select({ delivery: notificationDeliveries, intent: notificationIntents })
    .from(notificationDeliveries)
    .innerJoin(notificationIntents, eq(notificationDeliveries.intentId, notificationIntents.id))
    .where(eq(notificationDeliveries.id, id))
    .limit(1);
  return first(rows);
}

/**
 * Moves a delivery forward. **Never backwards** (D11).
 *
 * Returns the updated row, or `null` when the write was rejected because the row
 * already sits at or above the target status — which is precisely what makes a
 * replayed ack a cheap no-op instead of a corruption.
 */
export async function advanceDeliveryStatus(
  x: Executor,
  id: string,
  status: DeliveryStatus,
  patch: Partial<{
    sentAt: Date;
    deliveredAt: Date;
    interactedAt: Date;
    acknowledgedAt: Date;
    readAt: Date;
    scheduledFor: Date | null;
    lastError: string | null;
    attempt: number;
  }> = {},
): Promise<NotificationDeliveryRow | null> {
  const rows = await x
    .update(notificationDeliveries)
    .set({ status, ...patch })
    .where(and(eq(notificationDeliveries.id, id), statusRanksBelow(status)))
    .returning();
  return first(rows);
}

/**
 * Stamps one of the D11 receipt timestamps without necessarily changing status.
 *
 * Used when an ack arrives out of order — a `delivered` ack that lands after the
 * user already tapped still deserves its timestamp, it just must not move the
 * status back to `delivered`. `coalesce` keeps the *first* observation, so a
 * replay never rewrites history.
 */
export async function stampDeliveryReceipt(
  x: Executor,
  id: string,
  field: 'deliveredAt' | 'interactedAt' | 'acknowledgedAt',
  at: Date,
): Promise<NotificationDeliveryRow | null> {
  const column = notificationDeliveries[field];
  const rows = await x
    .update(notificationDeliveries)
    .set({ [field]: sql`coalesce(${column}, ${ts(at)})` })
    .where(eq(notificationDeliveries.id, id))
    .returning();
  return first(rows);
}

export async function incrementDeliveryAttempt(
  x: Executor,
  id: string,
  lastError: string | null,
): Promise<number> {
  const rows = await x
    .update(notificationDeliveries)
    .set({ attempt: sql`${notificationDeliveries.attempt} + 1`, lastError })
    .where(eq(notificationDeliveries.id, id))
    .returning({ attempt: notificationDeliveries.attempt });
  return first(rows)?.attempt ?? 0;
}

export async function incrementRedeliveryCount(x: Executor, id: string): Promise<void> {
  await x
    .update(notificationDeliveries)
    .set({ redeliveryCount: sql`${notificationDeliveries.redeliveryCount} + 1` })
    .where(eq(notificationDeliveries.id, id));
}

/** Deferred rows whose window has closed. The safety net behind delayed jobs. */
export async function listDueDeliveries(
  x: Executor,
  now: Date,
  limit = 500,
): Promise<NotificationDeliveryRow[]> {
  return x
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.status, 'scheduled'),
        isNotNull(notificationDeliveries.scheduledFor),
        lte(notificationDeliveries.scheduledFor, now),
      ),
    )
    .orderBy(asc(notificationDeliveries.scheduledFor))
    .limit(limit);
}

/**
 * The D11 enforcement sweep input: rows we handed off but never saw arrive,
 * past their per-priority deadline.
 *
 * `in_app` rows are excluded — they are the durable record, not a transport,
 * and "the user has not opened the app" is not a delivery failure.
 */
export async function listUnconfirmedDeliveries(
  x: Executor,
  sentBefore: Date,
  limit = 200,
): Promise<DeliveryWithIntent[]> {
  return x
    .select({ delivery: notificationDeliveries, intent: notificationIntents })
    .from(notificationDeliveries)
    .innerJoin(notificationIntents, eq(notificationDeliveries.intentId, notificationIntents.id))
    .where(
      and(
        eq(notificationDeliveries.status, 'sent'),
        ne(notificationDeliveries.channel, 'in_app'),
        isNotNull(notificationDeliveries.sentAt),
        lte(notificationDeliveries.sentAt, sentBefore),
        inArray(notificationIntents.priority, ['high', 'critical']),
        eq(notificationIntents.escalationState, 'none'),
      ),
    )
    .orderBy(asc(notificationDeliveries.sentAt))
    .limit(limit);
}

/** Has *any* delivery for this intent reached the required signal? */
export async function intentHasSignal(
  x: Executor,
  intentId: string,
  signal: 'delivered' | 'acknowledged',
): Promise<boolean> {
  const column =
    signal === 'acknowledged'
      ? notificationDeliveries.acknowledgedAt
      : notificationDeliveries.deliveredAt;
  const rows = await x
    .select({ hit: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.intentId, intentId), isNotNull(column)))
    .limit(1);
  return rows.length > 0;
}

/** Trailing-hour push counts, for the anti-spam caps. */
export async function countRecentPushes(
  x: Executor,
  userId: string,
  since: Date,
  type?: NotificationType,
): Promise<number> {
  const predicates = [
    eq(notificationDeliveries.userId, userId),
    eq(notificationDeliveries.channel, 'push'),
    isNotNull(notificationDeliveries.sentAt),
    gte(notificationDeliveries.sentAt, since),
  ];
  const rows = await x
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationDeliveries)
    .innerJoin(notificationIntents, eq(notificationDeliveries.intentId, notificationIntents.id))
    .where(type ? and(...predicates, eq(notificationIntents.type, type)) : and(...predicates));
  return first(rows)?.n ?? 0;
}

/* -------------------------------------------------------------------------- */
/* In-app inbox                                                                */
/* -------------------------------------------------------------------------- */

export interface InboxRow {
  id: string;
  intentId: string;
  type: NotificationType;
  priority: NotificationIntentRow['priority'];
  payload: Record<string, unknown>;
  entityType: string | null;
  entityId: string | null;
  status: DeliveryStatus;
  createdAt: Date;
  readAt: Date | null;
  acknowledgedAt: Date | null;
  actorId: string | null;
  actorName: string | null;
  actorAvatarUrl: string | null;
}

/**
 * Cursor pagination on `(createdAt, id)`.
 *
 * `createdAt` alone is not unique — a fan-out writes several rows in the same
 * millisecond — and a non-unique cursor silently drops or repeats rows.
 */
export async function listInbox(
  x: Executor,
  userId: string,
  options: { limit: number; cursor?: { createdAt: Date; id: string }; unreadOnly?: boolean },
): Promise<InboxRow[]> {
  const predicates = [
    eq(notificationDeliveries.userId, userId),
    eq(notificationDeliveries.channel, 'in_app'),
  ];
  if (options.unreadOnly) predicates.push(isNull(notificationDeliveries.readAt));
  if (options.cursor) {
    predicates.push(
      sql`(${notificationDeliveries.createdAt}, ${notificationDeliveries.id}) < (${ts(options.cursor.createdAt)}, ${options.cursor.id})`,
    );
  }

  return x
    .select({
      id: notificationDeliveries.id,
      intentId: notificationDeliveries.intentId,
      type: notificationIntents.type,
      priority: notificationIntents.priority,
      payload: notificationIntents.payload,
      entityType: notificationIntents.entityType,
      entityId: notificationIntents.entityId,
      status: notificationDeliveries.status,
      createdAt: notificationDeliveries.createdAt,
      readAt: notificationDeliveries.readAt,
      acknowledgedAt: notificationDeliveries.acknowledgedAt,
      actorId: users.id,
      actorName: users.displayName,
      actorAvatarUrl: users.avatarUrl,
    })
    .from(notificationDeliveries)
    .innerJoin(notificationIntents, eq(notificationDeliveries.intentId, notificationIntents.id))
    .leftJoin(users, eq(notificationIntents.actorId, users.id))
    .where(and(...predicates))
    .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
    .limit(options.limit);
}

export async function countUnread(x: Executor, userId: string): Promise<number> {
  const rows = await x
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.userId, userId),
        eq(notificationDeliveries.channel, 'in_app'),
        isNull(notificationDeliveries.readAt),
      ),
    );
  return first(rows)?.n ?? 0;
}

/**
 * Marks in-app rows read. Scoped to `userId` on purpose — `readAt` is per-user
 * state and a delivery id from another family member must be a silent no-op,
 * not a 403 that leaks the row's existence (D4).
 *
 * `markUnread` below is its inverse, and the two are written to be read
 * together: anything this adds to the `set` needs a decision there about how,
 * or whether, it comes back off.
 */
export async function markRead(
  x: Executor,
  userId: string,
  selector: { ids?: string[]; all?: boolean; before?: Date },
  at: Date,
): Promise<number> {
  const predicates = [
    eq(notificationDeliveries.userId, userId),
    eq(notificationDeliveries.channel, 'in_app'),
    isNull(notificationDeliveries.readAt),
  ];
  if (selector.ids?.length) predicates.push(inArray(notificationDeliveries.id, selector.ids));
  if (selector.before) predicates.push(lte(notificationDeliveries.createdAt, selector.before));

  const rows = await x
    .update(notificationDeliveries)
    .set({
      readAt: at,
      // Forward-only, in bulk: a row that is already `interacted` or
      // `acknowledged` keeps its status and merely gains a `readAt`.
      status: sql`(case when ${statusRanksBelow('read')} then 'read' else ${notificationDeliveries.status}::text end)::delivery_status`,
    })
    .where(and(...predicates))
    .returning({ id: notificationDeliveries.id });
  return rows.length;
}

/**
 * The exact inverse of `markRead`, and nothing more (§G4's six-second undo).
 *
 * Scoped to `userId` for the same reason `markRead` is, and it matters more
 * here: this is a write that makes a row *reappear* on somebody's bell. An id
 * belonging to another family member matches nothing and the call reports 0 —
 * a silent no-op rather than a 403 that would confirm the row exists (D4). The
 * IDOR found on the receipt endpoints earlier is the precedent; the fix there
 * and the shape here are the same one.
 *
 * ## The D11 receipt columns are not touched
 *
 * `readAt` is the in-app inbox's own state. `deliveredAt`, `interactedAt` and
 * `acknowledgedAt` are the delivery-confirmation record that answers "did this
 * actually reach them", and no amount of un-reading changes the answer — so
 * they are absent from the `set` on purpose.
 *
 * `status` is the one field that has to move, because `markRead` moved it. It
 * is restored from the receipts rather than guessed: `delivered` when the row
 * has a `deliveredAt` to prove it, otherwise `sent` (which every in-app row is
 * written as at fan-out), otherwise `pending`. And it moves **only** from
 * exactly `read` — a row that has since been opened or acknowledged is past
 * `read` on the D11 ladder, and dragging it back down is precisely the
 * regression `DELIVERY_STATUS_RANK` exists to forbid. Such a row loses its
 * `readAt` and keeps its status.
 */
export async function markUnread(x: Executor, userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const rows = await x
    .update(notificationDeliveries)
    .set({
      readAt: null,
      status: sql`(case
        when ${notificationDeliveries.status} = 'read' then (
          case
            when ${notificationDeliveries.deliveredAt} is not null then 'delivered'
            when ${notificationDeliveries.sentAt} is not null then 'sent'
            else 'pending'
          end
        )
        else ${notificationDeliveries.status}::text
      end)::delivery_status`,
    })
    .where(
      and(
        eq(notificationDeliveries.userId, userId),
        eq(notificationDeliveries.channel, 'in_app'),
        isNotNull(notificationDeliveries.readAt),
        inArray(notificationDeliveries.id, ids),
      ),
    )
    .returning({ id: notificationDeliveries.id });
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* Escalation policies                                                         */
/* -------------------------------------------------------------------------- */

export async function listEnabledEscalationPolicies(
  x: Executor,
  type: NotificationType,
): Promise<EscalationPolicyRow[]> {
  return x
    .select()
    .from(escalationPolicies)
    .where(and(eq(escalationPolicies.enabled, true), eq(escalationPolicies.type, type)))
    .orderBy(asc(escalationPolicies.afterMinutes));
}

/** Every policy, enabled or not — what an admin screen renders. */
export async function listEscalationPolicies(x: Executor): Promise<EscalationPolicyRow[]> {
  return x
    .select()
    .from(escalationPolicies)
    .orderBy(asc(escalationPolicies.type), asc(escalationPolicies.afterMinutes));
}

export async function countEscalationPolicies(x: Executor): Promise<number> {
  const [row] = await x
    .select({ count: sql<number>`count(*)::int` })
    .from(escalationPolicies)
    .limit(1);
  return row?.count ?? 0;
}

export async function insertEscalationPolicies(
  x: Executor,
  values: readonly NewEscalationPolicyRow[],
): Promise<EscalationPolicyRow[]> {
  if (values.length === 0) return [];
  return x
    .insert(escalationPolicies)
    .values([...values])
    .returning();
}

export async function updateEscalationPolicy(
  x: Executor,
  id: string,
  patch: Partial<
    Pick<NewEscalationPolicyRow, 'afterMinutes' | 'escalateToRole' | 'escalateToUserId' | 'enabled'>
  >,
): Promise<EscalationPolicyRow | null> {
  const rows = await x
    .update(escalationPolicies)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(escalationPolicies.id, id))
    .returning();
  return first(rows);
}

export async function deleteEscalationPolicy(x: Executor, id: string): Promise<boolean> {
  const rows = await x
    .delete(escalationPolicies)
    .where(eq(escalationPolicies.id, id))
    .returning({ id: escalationPolicies.id });
  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Weekly digest                                                               */
/* -------------------------------------------------------------------------- */

export async function getDigestSubscription(
  x: Executor,
  userId: string,
): Promise<DigestSubscriptionRow | null> {
  const rows = await x
    .select()
    .from(digestSubscriptions)
    .where(eq(digestSubscriptions.userId, userId))
    .limit(1);
  return first(rows);
}

export async function upsertDigestSubscription(
  x: Executor,
  userId: string,
  values: { enabled: boolean; weekday: number; timeOfDay: string; sections: string[] },
): Promise<DigestSubscriptionRow> {
  const rows = await x
    .insert(digestSubscriptions)
    .values({ ...values, userId })
    .onConflictDoUpdate({
      target: digestSubscriptions.userId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  const row = first(rows);
  if (!row) throw new Error('upsertDigestSubscription returned no row');
  return row;
}

/*
 * `listEnabledDigestSubscriptions` and `claimDigestSend` used to live here.
 *
 * They were the data access behind this module's own weekly-digest sweep, which
 * competed with `dashboard/dashboard.jobs.ts` for the `scheduler.weekly-digest`
 * job name and lost. The sweep is gone (see the note above
 * `getDigestSubscription` in the service), and these went with it rather than
 * staying as two exported, tested-looking functions that make the next person
 * to touch the digest believe this is where it lives. The dashboard reads the
 * same table through its own port in `dashboard/digest.service.ts`.
 *
 * `getDigestSubscription` / `upsertDigestSubscription` above stay: the digest
 * *preference* is a notification setting and is served by this module's routes.
 */

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                     */
/* -------------------------------------------------------------------------- */

export async function deleteExpiredSubscriptions(x: Executor, before: Date): Promise<number> {
  const rows = await x
    .delete(pushSubscriptions)
    .where(and(isNotNull(pushSubscriptions.expiredAt), lt(pushSubscriptions.expiredAt, before)))
    .returning({ id: pushSubscriptions.id });
  return rows.length;
}

export async function deleteOldDeliveries(x: Executor, before: Date): Promise<number> {
  const rows = await x
    .delete(notificationDeliveries)
    .where(lt(notificationDeliveries.createdAt, before))
    .returning({ id: notificationDeliveries.id });
  return rows.length;
}
