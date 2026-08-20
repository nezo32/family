import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  defaultNotificationPreference,
  ESCALATION_DEADLINE_MINUTES,
  NOTIFICATION_LIMITS,
  NOTIFICATION_TYPE_DEFAULT_PRIORITY,
  NOTIFICATION_TYPES,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  effectivePermissions,
  nextEscalationState,
  requiresExplicitAcknowledgement,
  requiredAckSignal,
  type DeliveryStatus,
  type DigestSection,
  type EscalationState,
  type InAppNotification,
  type NotificationChannel,
  type NotificationPreference,
  type NotificationPriority,
  type NotificationType,
  type Permission,
  type PushSubscriptionSummary,
  type Role,
} from '@family/shared';

import type { Db, Executor } from '../../core/db.js';
import { AppError, notFound } from '../../core/errors.js';
import {
  decodeTimestampCursor,
  encodeTimestampCursor,
  type TimestampCursor,
} from '../../core/pagination.js';
import { logger } from '../../core/logger.js';
import { enqueue } from '../../core/queue/queues.js';
import { bumpRevisions } from '../../core/revisions.js';
import * as repo from './notifications.repository.js';
import type {
  EscalationPolicyRow,
  NotificationDeliveryRow,
  NotificationIntentRow,
  NewNotificationDeliveryRow,
  PushSubscriptionRow,
} from './notifications.schema.js';
import { PUSH_FAILURE_EXPIRY_THRESHOLD, sendPush, type PushMessage } from './push.adapter.js';
import { familyDefaultWindow, resolveQuietDecision, type QuietWindow } from './quiet-hours.js';
import { renderNotification } from './render.js';
import { sendTelegramMessage } from './telegram.adapter.js';

/**
 * The notifications pipeline.
 *
 * ```
 * emitIntent()  →  notification_intents        (deduped on dedupe_key)
 *      │
 *      │  job: notification.dispatch           (fan-out, idempotent)
 *      ├── recipients = audience ∩ RBAC read scope ∩ status='active' ∩ not-the-actor
 *      ├── preference = stored row ?? defaultNotificationPreference(type, role)
 *      ├── channels   = enabled prefs ∩ channels the user actually has
 *      └── timing     = quiet hours → send now | scheduled_for = end of window
 *      ▼
 * notification_deliveries
 *      │  job: notification.deliver            (one row, idempotent)
 *      ▼
 * web push │ telegram │ in-app (the row itself is the delivery)
 *      │
 *      │  the service worker / the user acks arrival (D11)
 *      ▼
 * delivered → interacted → acknowledged
 *      │  job: notification.escalate           (only if the ack never comes)
 *      ▼
 * re-deliver → other channel → another person
 * ```
 *
 * Producers only ever call `emitIntent`. They do not think about channels,
 * devices, timezones, preferences or quiet hours — which is exactly what keeps
 * the fan-out rules in one place instead of smeared across eight modules.
 */

/* ========================================================================== */
/* THE PUBLIC EMIT API — this is what every other module calls                 */
/* ========================================================================== */

/**
 * Who should be told. Exactly one shape per intent.
 *
 * - `{ users: [...] }`   explicit recipients (the common case)
 * - `{ roles: [...] }`   everyone currently holding one of these roles
 * - `{ everyone: true }` every active family member
 *
 * In all three cases the fan-out then drops anyone who cannot *read* the
 * underlying entity, so an over-broad audience is safe: a child never receives
 * `member_pending_approval` even if you address it to `everyone`.
 */
export type NotificationAudience =
  { users: readonly string[] } | { roles: readonly Role[] } | { everyone: true };

export interface EmitIntentInput {
  /** What happened. Drives the renderer, the preference row and the priority. */
  type: NotificationType;
  /** Who should hear about it. */
  audience: NotificationAudience;
  /**
   * Everything the renderer needs, **denormalized on purpose**. A deferred
   * delivery can fire eight hours later, by which time the task may have been
   * renamed or deleted; the message is rendered from this, never from a fresh
   * read. Keep it small — ids and short strings.
   */
  payload?: Record<string, unknown>;
  /** Who caused it. `null` for scheduler/system intents. */
  actorId?: string | null;
  /** Loose polymorphic pointer: `'task_occurrence'`, `'event'`, `'goal'`, … */
  entityType?: string | null;
  entityId?: string | null;
  /** Defaults to `NOTIFICATION_TYPE_DEFAULT_PRIORITY[type]`. */
  priority?: NotificationPriority;
  /**
   * **Pass this.** A stable, caller-computed idempotency key such as
   * `task_due_soon:<occurrenceId>:2026-08-19`. A retried job, a double-click or
   * a re-run materializer then produces at most one intent. `null` opts out and
   * should be rare.
   */
  dedupeKey?: string | null;
  /**
   * By default the actor is never notified about their own action. Set this for
   * the handful of cases where they should be (a test push, a system alert).
   */
  notifyActor?: boolean;
}

export interface EmitIntentResult {
  /** The intent row id — the existing one when `deduped` is true. */
  intentId: string;
  /** True when an intent with this `dedupeKey` already existed. Nothing was written. */
  deduped: boolean;
  /**
   * Enqueues the fan-out job. **Call this after your transaction commits.**
   *
   * Enqueuing inside the transaction is the classic way to have a worker read a
   * row that does not exist yet. It is idempotent (the BullMQ `jobId` is the
   * intent id), so calling it twice is free and calling it on a deduped result
   * is a no-op.
   */
  dispatch: () => Promise<void>;
}

/**
 * Write one intent. **The only function other modules should call.**
 *
 * Runs on the caller's executor, so passing an open transaction makes the intent
 * and the domain write commit together: a rolled-back task never produces a
 * notification, and a committed one always does.
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   const occurrence = await tasks.assign(tx, …);
 *   const intent = await notifications.emitIntent(tx, {
 *     type: 'task_assigned',
 *     audience: { users: [occurrence.assigneeId] },
 *     actorId: ctx.userId,
 *     entityType: 'task_occurrence',
 *     entityId: occurrence.id,
 *     dedupeKey: `task_assigned:${occurrence.id}:${occurrence.assigneeId}`,
 *     payload: { title: occurrence.title, dueLabel: '19:00' },
 *   });
 *   afterCommit(() => intent.dispatch());   // ← after commit, never inside
 * });
 * ```
 *
 * Outside a transaction, use {@link emit}, which does both steps for you.
 */
export async function emitIntent(x: Executor, input: EmitIntentInput): Promise<EmitIntentResult> {
  const priority = input.priority ?? NOTIFICATION_TYPE_DEFAULT_PRIORITY[input.type];

  const inserted = await repo.insertIntent(x, {
    type: input.type,
    actorId: input.actorId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    payload: input.payload ?? {},
    audience: serializeAudience(input.audience, input.notifyActor === true),
    dedupeKey: input.dedupeKey ?? null,
    priority,
  });

  if (inserted) {
    const intentId = inserted.id;
    return {
      intentId,
      deduped: false,
      dispatch: () =>
        enqueue('notification.dispatch', { intentId }, { jobId: `fanout:${intentId}` }),
    };
  }

  // Lost the ON CONFLICT race (or a retry replayed the same key). The family has
  // already been told, or is about to be — do nothing at all.
  const existing = input.dedupeKey ? await repo.findIntentByDedupeKey(x, input.dedupeKey) : null;
  return {
    intentId: existing?.id ?? '',
    deduped: true,
    dispatch: () => Promise.resolve(),
  };
}

/**
 * `emitIntent` + `dispatch()` in one call, for producers that are **not** inside
 * a transaction (schedulers, jobs, the test endpoint).
 */
export async function emit(db: Db, input: EmitIntentInput): Promise<EmitIntentResult> {
  const result = await emitIntent(db, input);
  await result.dispatch();
  return result;
}

/**
 * The roles that currently hold `permission`, **derived from the catalog**.
 *
 * D4 forbids branching on `role ===` for access decisions; this is not one — it
 * is the `{ roles: [...] }` audience declaration `emitIntent` expects. Deriving
 * it means granting a role `member:approve` tomorrow automatically starts
 * notifying it, with no second list to forget. The fan-out re-checks the
 * permission anyway (`REQUIRED_PERMISSIONS`), so this only narrows the query.
 */
export function rolesWithPermission(permission: Permission): Role[] {
  return ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));
}

/**
 * Run the `dispatch()` thunks a transaction produced, **after it committed**.
 *
 * Two rules in one helper, so no producer has to remember either:
 *
 * - *After* the commit. Enqueuing inside the transaction is the classic way to
 *   have a worker read a row that does not exist yet, and `dispatchIntent`
 *   treats a missing intent as "nothing to do" — the notification is then lost
 *   for good, because nothing re-dispatches an intent that never fanned out.
 * - *Fail-soft*. Redis being down must not turn a committed kudos into a 500.
 *   The intent row is durable and idempotent on its dedupe key, so the worst
 *   case is a late notification, not a wrong one.
 */
export async function dispatchAfterCommit(
  dispatches: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  for (const dispatch of dispatches) {
    try {
      await dispatch();
    } catch (error) {
      logger.error({ err: error }, 'failed to enqueue a notification dispatch');
    }
  }
}

function serializeAudience(
  audience: NotificationAudience,
  notifyActor: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = notifyActor ? { notifyActor: true } : {};
  if ('users' in audience) return { ...base, users: [...audience.users] };
  if ('roles' in audience) return { ...base, roles: [...audience.roles] };
  return { ...base, everyone: true };
}

function parseAudience(raw: Record<string, unknown>): {
  audience: NotificationAudience;
  notifyActor: boolean;
} {
  const notifyActor = raw.notifyActor === true;
  const users = raw.users;
  if (Array.isArray(users)) {
    return {
      audience: { users: users.filter((u): u is string => typeof u === 'string') },
      notifyActor,
    };
  }
  const roles = raw.roles;
  if (Array.isArray(roles)) {
    return {
      audience: { roles: roles.filter((r): r is Role => typeof r === 'string') },
      notifyActor,
    };
  }
  return { audience: { everyone: true }, notifyActor };
}

/* ========================================================================== */
/* Fan-out                                                                     */
/* ========================================================================== */

/**
 * Permission a recipient must hold to be told about a type.
 *
 * This is the **enforcement** step of §3.2: the role overrides in
 * `NOTIFICATION_PREFERENCE_ROLE_OVERRIDES` are only UI defaults, and a stale
 * preference row must never be able to leak a `goal_contribution` to a child.
 * An empty list means "no read permission required".
 */
const REQUIRED_PERMISSIONS: Record<NotificationType, readonly Permission[]> = {
  task_assigned: ['task:read:own', 'task:read:any'],
  task_due_soon: ['task:read:own', 'task:read:any'],
  task_overdue: ['task:read:own', 'task:read:any'],
  task_completed: ['task:read:own', 'task:read:any'],
  chore_swap_requested: ['task:read:own', 'task:read:any'],
  chore_swap_answered: ['task:read:own', 'task:read:any'],
  event_reminder: ['event:read'],
  event_created: ['event:read'],
  birthday_today: ['event:read'],
  goal_contribution: ['goal:read'],
  goal_milestone_reached: ['goal:read'],
  goal_reached: ['goal:read'],
  shopping_urgent_item: ['shopping:read'],
  member_pending_approval: ['member:approve'],
  member_approved: ['member:read'],
  announcement_posted: ['post:create', 'member:read'],
  kudos_received: [],
  weekly_digest: [],
  system_alert: [],
};

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set<string>(PERMISSIONS);

function permissionsOf(user: repo.RecipientRow): ReadonlySet<Permission> {
  const keep = (values: string[]): Permission[] =>
    values.filter((v): v is Permission => KNOWN_PERMISSIONS.has(v));
  return new Set(
    effectivePermissions(user.role, keep(user.permissionGrants), keep(user.permissionDenies)),
  );
}

function mayReceive(user: repo.RecipientRow, type: NotificationType): boolean {
  const required = REQUIRED_PERMISSIONS[type];
  if (required.length === 0) return true;
  const held = permissionsOf(user);
  return required.some((p) => held.has(p));
}

/**
 * Fan one intent out into delivery rows. Idempotent: if this intent already has
 * deliveries, we re-enqueue whatever is still outstanding and return. That makes
 * a retried BullMQ job, a duplicated `dispatch()` call and the recovery sweep
 * all free.
 */
export async function dispatchIntent(db: Db, intentId: string, now = new Date()): Promise<void> {
  const intent = await repo.getIntent(db, intentId);
  if (!intent) {
    logger.warn({ intentId }, 'dispatch: intent no longer exists');
    return;
  }

  const existing = await repo.listDeliveriesForIntent(db, intentId);
  if (existing.length > 0) {
    await enqueueDeliveries(existing, now);
    return;
  }

  const { audience, notifyActor } = parseAudience(intent.audience);
  const recipients = await resolveRecipients(db, audience, intent, notifyActor);
  if (recipients.length === 0) {
    logger.debug({ intentId, type: intent.type }, 'dispatch: no eligible recipients');
    return;
  }

  const userIds = recipients.map((r) => r.id);
  const [family, preferences, quietRows, telegram] = await Promise.all([
    repo.getFamilyDefaults(db),
    repo.listPreferencesForUsers(db, userIds, intent.type),
    repo.listQuietHoursForUsers(db, userIds),
    repo.listTelegramLinks(db, userIds),
  ]);

  const preferenceByUser = new Map(preferences.map((p) => [p.userId, p]));
  const telegramByUser = new Map(telegram.map((t) => [t.userId, t]));
  const quietByUser = new Map<string, QuietWindow[]>();
  for (const row of quietRows) {
    const list = quietByUser.get(row.userId) ?? [];
    list.push({
      dayOfWeek: row.dayOfWeek,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      mode: row.mode,
    });
    quietByUser.set(row.userId, list);
  }
  const familyWindows = familyDefaultWindow(family.quietHoursStart, family.quietHoursEnd);

  const rows: NewNotificationDeliveryRow[] = [];

  for (const user of recipients) {
    const stored = preferenceByUser.get(user.id);
    const fallback = defaultNotificationPreference(intent.type, user.role);
    const pref = stored
      ? {
          enabled: stored.enabled,
          push: stored.channelPush,
          telegram: stored.channelTelegram,
          inApp: stored.channelInApp,
        }
      : fallback;

    // §3.7 — the in-app row is ALWAYS written, regardless of preferences and
    // quiet hours. It is the durable record; suppressing it would lose
    // information the user can never recover.
    rows.push({
      intentId,
      userId: user.id,
      channel: 'in_app',
      status: 'sent',
      sentAt: now,
    });

    if (!pref.enabled) continue;

    const timezone = user.timezone ?? family.timezone;
    // A user who has never opened the editor inherits the family window rather
    // than having no quiet hours at all — the safe default.
    const windows = quietByUser.get(user.id) ?? familyWindows;
    const decision = resolveQuietDecision(windows, timezone, now, intent.priority);

    const status: DeliveryStatus =
      decision.action === 'send'
        ? 'pending'
        : decision.action === 'defer'
          ? 'scheduled'
          : 'suppressed';
    const scheduledFor = decision.action === 'defer' ? decision.scheduledFor : null;

    if (pref.push) {
      const subscriptions = await repo.listPushSubscriptions(db, user.id, { liveOnly: true });
      if (subscriptions.length === 0) {
        // A record, not silence: the UI must be able to say honestly
        // «push включён, но ни одного устройства не подписано».
        rows.push({ intentId, userId: user.id, channel: 'push', status: 'suppressed' });
      } else {
        for (const subscription of subscriptions) {
          rows.push({
            intentId,
            userId: user.id,
            channel: 'push',
            status,
            scheduledFor,
            subscriptionId: subscription.id,
          });
        }
      }
    }

    if (pref.telegram) {
      const link = telegramByUser.get(user.id);
      rows.push({
        intentId,
        userId: user.id,
        channel: 'telegram',
        status: link?.canDm ? status : 'suppressed',
        scheduledFor: link?.canDm ? scheduledFor : null,
      });
    }
  }

  const inserted = await repo.insertDeliveries(db, rows);

  /*
   * D12: tell the change feed the inbox moved.
   *
   * The hook belongs here and not in `deliver()`, which is where you would look
   * first: `enqueueDeliveries` skips `in_app` outright, so `deliver()` never
   * runs for the very rows this is about. Fan-out is the moment an in-app
   * notification comes into existence.
   *
   * Without it the bell is the one stale surface left in the app — everything
   * else now refreshes within seconds, and the bell would wait for a window
   * focus. That is the surface that says a family member is waiting to be let
   * in, and a delay there has already caused real confusion once.
   *
   * The predicate reads as "did this fan-out produce an inbox row". Today §3.7
   * writes one per recipient unconditionally, so it is true whenever anybody
   * was reached — but checking the channel rather than `inserted.length` keeps
   * it honest if the in-app row ever becomes suppressible.
   *
   * Awaited, per the note in `core/revisions.ts`: this runs inside a worker, and
   * a job that returns before its bump is dispatched can have its process torn
   * down first. `bumpRevisions` never throws, so Redis being unavailable cannot
   * break a fan-out that has already committed.
   */
  if (inserted.some((r) => r.channel === 'in_app')) await bumpRevisions(['notifications']);

  await enqueueDeliveries(inserted, now);

  logger.debug(
    { intentId, type: intent.type, recipients: recipients.length, deliveries: inserted.length },
    'intent fanned out',
  );
}

async function resolveRecipients(
  db: Db,
  audience: NotificationAudience,
  intent: NotificationIntentRow,
  notifyActor: boolean,
): Promise<repo.RecipientRow[]> {
  let candidates: repo.RecipientRow[];
  if ('users' in audience) {
    candidates = await repo.listActiveUsersByIds(db, [...audience.users]);
  } else if ('roles' in audience) {
    candidates = await repo.listActiveUsersByRoles(db, [...audience.roles]);
  } else {
    candidates = await repo.listActiveUsers(db);
  }

  return candidates.filter((user) => {
    // §3.4 self-suppression — you are never told about your own action. The
    // exceptions are explicit: system alerts and the "send me a test" path.
    if (!notifyActor && intent.actorId === user.id && intent.type !== 'system_alert') {
      return false;
    }
    return mayReceive(user, intent.type);
  });
}

/** Enqueues `notification.deliver` for pending rows, delayed for scheduled ones. */
async function enqueueDeliveries(rows: NotificationDeliveryRow[], now: Date): Promise<void> {
  for (const row of rows) {
    if (row.channel === 'in_app') continue;
    if (row.status === 'pending') {
      await enqueue('notification.deliver', { deliveryId: row.id }, { jobId: `deliver:${row.id}` });
    } else if (row.status === 'scheduled' && row.scheduledFor) {
      // A BullMQ delayed job *is* the quiet-hours release mechanism. The daily
      // maintenance sweep re-enqueues anything a Redis flush lost.
      await enqueue(
        'notification.deliver',
        { deliveryId: row.id },
        {
          jobId: `deliver:${row.id}:${row.scheduledFor.getTime()}`,
          delay: Math.max(0, row.scheduledFor.getTime() - now.getTime()),
        },
      );
    }
  }
}

/* ========================================================================== */
/* Delivery                                                                    */
/* ========================================================================== */

/** How far a rate-limited push is pushed back before being tried again. */
const RATE_LIMIT_DEFER_MS = 15 * 60_000;

/**
 * Send one delivery row.
 *
 * Idempotent by construction: only `pending`/`scheduled` rows do anything, and
 * the very first thing a successful send does is move the status forward. A
 * replayed job on an already-sent row returns immediately, which matters because
 * BullMQ guarantees at-least-once, not exactly-once.
 *
 * Throws on a **retryable** transport failure so the queue's exponential backoff
 * takes over. Permanent failures never throw — they mark the row `failed`, which
 * is information, whereas a burned retry is not.
 */
export async function deliver(db: Db, deliveryId: string, now = new Date()): Promise<void> {
  const found = await repo.getDeliveryWithIntent(db, deliveryId);
  if (!found) {
    logger.warn({ deliveryId }, 'deliver: row no longer exists');
    return;
  }

  const { delivery, intent } = found;
  if (delivery.status !== 'pending' && delivery.status !== 'scheduled') return;

  if (delivery.channel === 'in_app') {
    await repo.advanceDeliveryStatus(db, delivery.id, 'sent', { sentAt: now });
    return;
  }

  // Quiet hours are re-evaluated at send time, not only at fan-out: a delayed
  // job can fire early after a clock change, and the user may have edited their
  // windows in between. Deferring again is always safe; sending early is not.
  const deferral = await quietDeferral(db, delivery.userId, intent.priority, now);
  if (deferral) {
    await reschedule(db, delivery.id, deferral, now);
    return;
  }

  // Anti-spam caps (§5). `critical` bypasses; only `system_alert` is critical.
  if (delivery.channel === 'push' && intent.priority !== 'critical') {
    const since = new Date(now.getTime() - 3_600_000);
    const [perUser, perType] = await Promise.all([
      repo.countRecentPushes(db, delivery.userId, since),
      repo.countRecentPushes(db, delivery.userId, since, intent.type),
    ]);
    if (
      perUser >= NOTIFICATION_LIMITS.maxPushPerUserPerHour ||
      perType >= NOTIFICATION_LIMITS.maxPushPerTypePerHour
    ) {
      logger.info(
        { deliveryId: delivery.id, userId: delivery.userId, perUser, perType },
        'push rate cap reached — deferring 15 minutes',
      );
      await reschedule(db, delivery.id, new Date(now.getTime() + RATE_LIMIT_DEFER_MS), now);
      return;
    }
  }

  const rendered = renderNotification(intent.type, intent.payload);

  if (delivery.channel === 'push') {
    await deliverPush(db, delivery, intent, rendered, now);
    return;
  }

  await deliverTelegram(db, delivery, rendered, now);
}

async function quietDeferral(
  db: Db,
  userId: string,
  priority: NotificationPriority,
  now: Date,
): Promise<Date | null> {
  const [family, quietRows] = await Promise.all([
    repo.getFamilyDefaults(db),
    repo.listQuietHoursForUser(db, userId),
  ]);
  const user = (await repo.listActiveUsersByIds(db, [userId]))[0];
  const timezone = user?.timezone ?? family.timezone;
  const windows: QuietWindow[] =
    quietRows.length > 0
      ? quietRows.map((row) => ({
          dayOfWeek: row.dayOfWeek,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          mode: row.mode,
        }))
      : familyDefaultWindow(family.quietHoursStart, family.quietHoursEnd);

  const decision = resolveQuietDecision(windows, timezone, now, priority);
  return decision.action === 'defer' ? decision.scheduledFor : null;
}

async function reschedule(db: Db, deliveryId: string, at: Date | null, now: Date): Promise<void> {
  const target = at ?? new Date(now.getTime() + RATE_LIMIT_DEFER_MS);
  await repo.advanceDeliveryStatus(db, deliveryId, 'scheduled', { scheduledFor: target });
  await enqueue(
    'notification.deliver',
    { deliveryId },
    {
      jobId: `deliver:${deliveryId}:${target.getTime()}`,
      delay: Math.max(0, target.getTime() - now.getTime()),
    },
  );
}

async function deliverPush(
  db: Db,
  delivery: NotificationDeliveryRow,
  intent: NotificationIntentRow,
  rendered: { title: string; body: string; navigate: string | null },
  now: Date,
): Promise<void> {
  if (!delivery.subscriptionId) {
    await repo.advanceDeliveryStatus(db, delivery.id, 'suppressed', {
      lastError: 'no_subscription',
    });
    return;
  }

  const subscription = await repo.getPushSubscription(db, delivery.subscriptionId);
  if (!subscription || subscription.expiredAt) {
    await repo.advanceDeliveryStatus(db, delivery.id, 'suppressed', {
      lastError: 'subscription_gone',
    });
    return;
  }

  const badge = await repo.countUnread(db, delivery.userId);
  const message: PushMessage = {
    deliveryId: delivery.id,
    intentId: intent.id,
    type: intent.type,
    title: rendered.title,
    body: rendered.body,
    navigate: rendered.navigate,
    badge,
    priority: intent.priority,
    needsAcknowledgement: requiresExplicitAcknowledgement(intent.priority),
  };

  const result = await sendPush(
    {
      id: subscription.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
    message,
  );

  if (result.ok) {
    // `sent`, deliberately NOT `delivered`: a 201 from a push service means
    // "accepted for delivery" and nothing more (D11). `deliveredAt` is written
    // only when the service worker acks a real arrival.
    await repo.advanceDeliveryStatus(db, delivery.id, 'sent', { sentAt: now, lastError: null });
    await repo.recordPushAccepted(db, subscription.id, now);
    await scheduleEscalationCheck(intent, now);
    return;
  }

  if (result.prune) {
    await repo.expirePushSubscription(db, subscription.id, now);
    await repo.advanceDeliveryStatus(db, delivery.id, 'failed', { lastError: result.reason });
    return;
  }

  if (result.countsAsFailure) {
    const failures = await repo.recordPushFailure(db, subscription.id, now);
    if (failures >= PUSH_FAILURE_EXPIRY_THRESHOLD) {
      logger.warn(
        { subscriptionId: subscription.id, failures },
        'expiring push subscription after consecutive transport failures',
      );
      await repo.expirePushSubscription(db, subscription.id, now);
    }
  }

  await failOrRetry(db, delivery, result.retryable, result.reason, result.retryAfterSeconds);
}

async function deliverTelegram(
  db: Db,
  delivery: NotificationDeliveryRow,
  rendered: { title: string; body: string; navigate: string | null },
  now: Date,
): Promise<void> {
  const link = await repo.getTelegramLink(db, delivery.userId);
  if (!link || !link.canDm) {
    await repo.advanceDeliveryStatus(db, delivery.id, 'suppressed', {
      lastError: 'telegram_unavailable',
    });
    return;
  }

  const result = await sendTelegramMessage({
    chatId: link.telegramChatId,
    title: rendered.title,
    body: rendered.body,
    link: rendered.navigate ? absoluteAppUrl(rendered.navigate) : null,
  });

  if (result.ok) {
    // Telegram returns a real message_id only once the message exists in the
    // chat — that is a genuine arrival receipt, unlike a push service's 201.
    await repo.advanceDeliveryStatus(db, delivery.id, 'delivered', {
      sentAt: now,
      deliveredAt: now,
      lastError: null,
    });
    return;
  }

  if (result.action === 'block') {
    await repo.disableTelegramDm(db, delivery.userId);
    await repo.advanceDeliveryStatus(db, delivery.id, 'suppressed', { lastError: 'blocked' });
    return;
  }

  await failOrRetry(
    db,
    delivery,
    result.action === 'retry',
    result.reason,
    result.retryAfterSeconds,
  );
}

/**
 * Either burn a retry (by throwing, so BullMQ backs off) or give up and record
 * why. Nothing here ever touches a subscription row.
 */
async function failOrRetry(
  db: Db,
  delivery: NotificationDeliveryRow,
  retryable: boolean,
  reason: string,
  retryAfterSeconds?: number,
): Promise<void> {
  const attempt = await repo.incrementDeliveryAttempt(db, delivery.id, reason);

  if (!retryable || attempt >= NOTIFICATION_LIMITS.maxDeliveryAttempts) {
    await repo.advanceDeliveryStatus(db, delivery.id, 'failed', { lastError: reason });
    return;
  }

  const error = new Error(`delivery ${delivery.id} failed: ${reason}`);
  if (retryAfterSeconds !== undefined) {
    Object.assign(error, { retryAfterSeconds });
  }
  throw error;
}

function absoluteAppUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  // Imported lazily to keep this module free of a boot-time config read.
  const origin = process.env.APP_PUBLIC_URL ?? 'http://localhost:5173';
  return `${origin.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}

/* ========================================================================== */
/* Receipts (D11)                                                              */
/* ========================================================================== */

export type AckKind = 'delivered' | 'interacted' | 'acknowledged';

const ACK_STATUS: Record<AckKind, DeliveryStatus> = {
  delivered: 'delivered',
  interacted: 'interacted',
  acknowledged: 'acknowledged',
};

const ACK_FIELD: Record<AckKind, 'deliveredAt' | 'interactedAt' | 'acknowledgedAt'> = {
  delivered: 'deliveredAt',
  interacted: 'interactedAt',
  acknowledged: 'acknowledgedAt',
};

export interface AckResult {
  id: string;
  status: DeliveryStatus;
  deliveredAt: Date | null;
  interactedAt: Date | null;
  acknowledgedAt: Date | null;
}

/**
 * Clamps a client-supplied timestamp into `[sentAt - skew, now]`.
 *
 * An ack may be replayed from an IndexedDB queue hours later, carrying a clock
 * we have no reason to trust. Without the clamp, a device whose clock is a day
 * fast would record a receipt in the future and defeat the escalation deadline;
 * one a day slow would look like it arrived before we sent it.
 */
export function clampAckTimestamp(
  occurredAt: Date | undefined,
  sentAt: Date | null,
  now: Date,
): Date {
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) return now;
  const skewMs = NOTIFICATION_LIMITS.ackClockSkewToleranceMinutes * 60_000;
  const floor = sentAt ? sentAt.getTime() - skewMs : now.getTime() - 7 * 24 * 3_600_000;
  return new Date(Math.min(now.getTime(), Math.max(floor, occurredAt.getTime())));
}

/**
 * Record a receipt. Idempotent and cheap — a replay stamps nothing new and
 * cannot move the status backwards.
 *
 * A delivery belonging to another user is a `404`, never a `403`: confirming
 * that a delivery id exists would leak which notifications other family members
 * received (D4).
 */
export async function ackDelivery(
  db: Db,
  userId: string,
  deliveryId: string,
  kind: AckKind,
  occurredAt?: Date,
  now = new Date(),
): Promise<AckResult> {
  const delivery = await repo.getDelivery(db, deliveryId);
  if (!delivery || delivery.userId !== userId) throw notFound('Delivery');

  const at = clampAckTimestamp(occurredAt, delivery.sentAt, now);

  // `coalesce` keeps the first observation: a replay never rewrites history.
  const stamped = await repo.stampDeliveryReceipt(db, deliveryId, ACK_FIELD[kind], at);
  // Forward-only. Returns null when the row already sits at or above this
  // status, which is exactly what makes a replayed ack a no-op.
  const advanced = await repo.advanceDeliveryStatus(db, deliveryId, ACK_STATUS[kind], {});
  const row = advanced ?? stamped ?? delivery;

  // A real arrival is the only thing that resets the subscription health
  // counters — and, on iOS, the only way we ever learn the device is alive.
  if (kind === 'delivered' && delivery.subscriptionId) {
    await repo.recordPushDelivered(db, delivery.subscriptionId, at);
  }

  return {
    id: row.id,
    status: row.status,
    deliveredAt: row.deliveredAt,
    interactedAt: row.interactedAt,
    acknowledgedAt: row.acknowledgedAt,
  };
}

/**
 * What the *sender* sees: «Доставлено» / «Не доставлено» per recipient.
 *
 * Scoped to the caller. Receipts expose who read what and when — a family-wide
 * announcement would otherwise let any recipient, including a child, read every
 * other member's read and acknowledgement timestamps. Only the person who
 * caused the notification, or somebody it was actually sent to, may look.
 */
export async function getIntentReceipts(
  db: Db,
  intentId: string,
  viewerId: string,
): Promise<{
  intentId: string;
  escalationState: EscalationState;
  receipts: Array<{
    id: string;
    userId: string;
    channel: NotificationChannel;
    status: DeliveryStatus;
    sentAt: Date | null;
    deliveredAt: Date | null;
    interactedAt: Date | null;
    acknowledgedAt: Date | null;
  }>;
}> {
  const intent = await repo.getIntent(db, intentId);
  if (!intent) throw notFound('Notification');

  const deliveries = await repo.listDeliveriesForIntent(db, intentId);

  // 404 rather than 403: an outsider must not learn the intent exists (D4).
  const mayView = intent.actorId === viewerId || deliveries.some((d) => d.userId === viewerId);
  if (!mayView) throw notFound('Notification');

  return {
    intentId,
    escalationState: intent.escalationState,
    receipts: deliveries.map((d) => ({
      id: d.id,
      userId: d.userId,
      channel: d.channel,
      status: d.status,
      sentAt: d.sentAt,
      deliveredAt: d.deliveredAt,
      interactedAt: d.interactedAt,
      acknowledgedAt: d.acknowledgedAt,
    })),
  };
}

/* ========================================================================== */
/* Escalation (D11)                                                            */
/* ========================================================================== */

/**
 * Who a notification nobody acknowledged is handed to, when the family has not
 * said otherwise.
 *
 * Adults only, and derived from the role catalog rather than spelled out: the
 * whole point of rung three is that a *second, responsible* person hears about
 * something the first one did not. Escalating to a child would be noise at best
 * and a privacy leak at worst — the fan-out would drop them anyway, leaving the
 * escalation silently reaching nobody.
 */
export const ESCALATION_FALLBACK_ROLES: readonly Role[] = ['owner', 'admin', 'adult'];

/**
 * The starting configuration for `escalation_policies` — **defaults, not law**.
 *
 * Before this existed the table was read by `listEnabledEscalationPolicies` and
 * written by nothing at all, so D11's third rung («escalate to another person»)
 * was a permanent no-op for every type: `targets` was always empty unless the
 * intent happened to be `critical`, and nothing in the product emits `critical`
 * except an escalation itself.
 *
 * Only types that can actually escalate appear here — `ESCALATION_DEADLINE_MINUTES`
 * is `null` for `normal`/`low`, so a policy on `task_completed` could never fire.
 * `afterMinutes` is measured from the **first** hand-off to a transport, so it
 * is the total patience budget, not a fourth deadline stacked on the ladder.
 */
export const DEFAULT_ESCALATION_POLICIES: readonly {
  type: NotificationType;
  afterMinutes: number;
  escalateToRole: Role;
}[] = [
  // An overdue chore is the everyday case: the teen's phone is face-down, so
  // after an hour an adult is told rather than the task rotting silently.
  { type: 'task_overdue', afterMinutes: 60, escalateToRole: 'adult' },
  // «Ты где? Приём через 15 минут» — a missed event reminder is time-critical
  // by construction, so the patience budget is short.
  { type: 'event_reminder', afterMinutes: 45, escalateToRole: 'adult' },
  // Somebody is standing in the shop right now. If they never saw it, another
  // adult still can — an hour later it is pointless, so the window is tight.
  { type: 'shopping_urgent_item', afterMinutes: 30, escalateToRole: 'adult' },
  // Nobody answered «поменяемся?» — an adult can reassign the chore by hand.
  { type: 'chore_swap_requested', afterMinutes: 120, escalateToRole: 'adult' },
  // A person is locked out of the family app until *somebody* clicks approve.
  // Owner rather than adult: `member:approve` is an owner/admin permission, so
  // the fan-out would drop a plain adult anyway.
  { type: 'member_pending_approval', afterMinutes: 240, escalateToRole: 'owner' },
  // The one type that is `critical` out of the box.
  { type: 'system_alert', afterMinutes: 15, escalateToRole: 'owner' },
];

/**
 * Put the defaults in the table on first boot, and never again.
 *
 * Seeded **only when the table is completely empty**, which is what makes the
 * rows genuinely configurable: an admin can retarget a policy at one person,
 * lengthen a deadline or set `enabled = false`, and the next restart will not
 * quietly undo it. Turning escalation off is `enabled = false`, not `DELETE` —
 * deleting every row and restarting is, deliberately, how you ask for the
 * defaults back.
 *
 * Idempotent and cheap (one `count(*)` on a table with a handful of rows), so
 * it is safe to call on every boot.
 */
export async function ensureDefaultEscalationPolicies(db: Db): Promise<number> {
  if ((await repo.countEscalationPolicies(db)) > 0) return 0;

  const inserted = await repo.insertEscalationPolicies(
    db,
    DEFAULT_ESCALATION_POLICIES.map((policy) => ({
      type: policy.type,
      afterMinutes: policy.afterMinutes,
      escalateToRole: policy.escalateToRole,
      enabled: true,
    })),
  );

  if (inserted.length > 0) {
    logger.info({ count: inserted.length }, 'seeded the default escalation policies');
  }
  return inserted.length;
}

/** Every policy, enabled or not — the read side of the admin screen. */
export async function listEscalationPolicies(db: Db): Promise<EscalationPolicyRow[]> {
  return repo.listEscalationPolicies(db);
}

export interface EscalationPolicyWrite {
  type: NotificationType;
  afterMinutes: number;
  escalateToRole?: Role | null;
  escalateToUserId?: string | null;
  enabled?: boolean;
}

/**
 * Create a policy. Rejects a row that points at nobody, because that is a
 * silent no-op three rungs down the ladder rather than an error anyone sees.
 */
export async function createEscalationPolicy(
  db: Db,
  input: EscalationPolicyWrite,
): Promise<EscalationPolicyRow> {
  if (!input.escalateToRole && !input.escalateToUserId) {
    throw new AppError('BAD_REQUEST', 'An escalation policy must name a role or a user');
  }
  if (ESCALATION_DEADLINE_MINUTES[NOTIFICATION_TYPE_DEFAULT_PRIORITY[input.type]] === null) {
    throw new AppError(
      'BAD_REQUEST',
      'This notification type never escalates — only high and critical do (D11)',
    );
  }
  const [row] = await repo.insertEscalationPolicies(db, [
    {
      type: input.type,
      afterMinutes: input.afterMinutes,
      escalateToRole: input.escalateToRole ?? null,
      escalateToUserId: input.escalateToUserId ?? null,
      enabled: input.enabled ?? true,
    },
  ]);
  if (!row) throw new AppError('INTERNAL_ERROR', 'Could not create the escalation policy');
  return row;
}

export async function updateEscalationPolicy(
  db: Db,
  id: string,
  patch: Partial<Omit<EscalationPolicyWrite, 'type'>>,
): Promise<EscalationPolicyRow> {
  const row = await repo.updateEscalationPolicy(db, id, {
    ...(patch.afterMinutes !== undefined ? { afterMinutes: patch.afterMinutes } : {}),
    ...(patch.escalateToRole !== undefined ? { escalateToRole: patch.escalateToRole } : {}),
    ...(patch.escalateToUserId !== undefined ? { escalateToUserId: patch.escalateToUserId } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  });
  if (!row) throw notFound('Escalation policy');
  return row;
}

export async function deleteEscalationPolicy(db: Db, id: string): Promise<void> {
  if (!(await repo.deleteEscalationPolicy(db, id))) throw notFound('Escalation policy');
}

/** Schedules the D11 deadline check for a `high`/`critical` intent. */
async function scheduleEscalationCheck(intent: NotificationIntentRow, now: Date): Promise<void> {
  const deadline = ESCALATION_DEADLINE_MINUTES[intent.priority];
  if (deadline === null) return;
  if (intent.escalationState === 'exhausted') return;

  await enqueue(
    'notification.escalate',
    { intentId: intent.id },
    {
      // The jobId includes the rung, so each step schedules exactly one check
      // and a retried send cannot stack duplicates.
      jobId: `escalate:${intent.id}:${intent.escalationState}`,
      delay: deadline * 60_000 + 1_000,
    },
  );
  void now;
}

export type EscalationOutcome =
  | 'satisfied'
  | 'too_early'
  | 'quiet'
  | 'exhausted'
  | 'redelivered'
  | 'channel_fallback'
  | 'person_escalated'
  | 'lost_race'
  | 'not_applicable';

/**
 * Evaluate the escalation ladder for one intent.
 *
 * ```
 * none ─10/30min─> redelivered ─> channel_fallback ─> person_escalated ─> exhausted
 * ```
 *
 * Guardrails, all of them load-bearing:
 *
 * - **At most one chain per intent.** The state lives on the intent and advances
 *   only through a conditional `UPDATE ... WHERE escalation_state = <expected>`,
 *   so two concurrent sweeps produce one winner.
 * - **Quiet hours still apply.** A phone that is legitimately off overnight must
 *   not produce a 03:00 escalation; the sweep evaluates the recipient's windows
 *   exactly as the original delivery did, and simply waits.
 * - **Never for `normal`/`low`.** Notification fatigue is the failure mode that
 *   kills these apps; the weekly digest catches anything routine that was missed.
 */
export async function escalateIntent(
  db: Db,
  intentId: string,
  now = new Date(),
): Promise<EscalationOutcome> {
  const intent = await repo.getIntent(db, intentId);
  if (!intent) return 'not_applicable';

  const deadlineMinutes = ESCALATION_DEADLINE_MINUTES[intent.priority];
  if (deadlineMinutes === null) return 'not_applicable';

  const state: EscalationState = intent.escalationState;
  const next = nextEscalationState(state);
  if (!next) return 'exhausted';

  // Has the loop already closed? For `critical` only an explicit human
  // acknowledgement counts; for `high`, arrival on the device is enough.
  const signal = requiredAckSignal(intent.priority);
  if (await repo.intentHasSignal(db, intentId, signal)) return 'satisfied';

  const deliveries = await repo.listDeliveriesForIntent(db, intentId);
  const transports = deliveries.filter((d) => d.channel !== 'in_app');
  const sent = transports.filter((d) => d.sentAt !== null);
  if (sent.length === 0) return 'too_early';

  const deadlineMs = deadlineMinutes * 60_000;
  const lastActivity = Math.max(
    ...sent.map((d) => d.sentAt?.getTime() ?? 0),
    intent.escalatedAt?.getTime() ?? 0,
  );
  if (now.getTime() - lastActivity < deadlineMs) return 'too_early';

  // Quiet hours: the escalation is held, not dropped. The next sweep (or the
  // re-scheduled job) picks it up once the window closes.
  const primaryUserId = sent[0]?.userId;
  if (primaryUserId) {
    const deferral = await quietDeferral(db, primaryUserId, intent.priority, now);
    if (deferral) {
      await enqueue(
        'notification.escalate',
        { intentId },
        {
          jobId: `escalate:${intentId}:${state}:${deferral.getTime()}`,
          delay: Math.max(0, deferral.getTime() - now.getTime()),
        },
      );
      return 'quiet';
    }
  }

  if (!(await repo.advanceEscalationState(db, intentId, state, next, now))) return 'lost_race';

  switch (next) {
    case 'redelivered': {
      // Step 1 — the device may simply have been off. Re-send once, on the same
      // channel, on the same row.
      const target = sent.find((d) => d.redeliveryCount < 1 && d.deliveredAt === null);
      if (target) {
        await repo.incrementRedeliveryCount(db, target.id);
        await repo.advanceDeliveryStatus(db, target.id, 'pending', {});
        // `advanceDeliveryStatus` is forward-only, so an already-`sent` row will
        // not move back; enqueue explicitly and let `deliver` re-check.
        await enqueue(
          'notification.deliver',
          { deliveryId: target.id },
          { jobId: `deliver:${target.id}:redeliver` },
        );
      }
      await scheduleEscalationCheck({ ...intent, escalationState: next }, now);
      return 'redelivered';
    }

    case 'channel_fallback': {
      // Step 2 — Web Push failed, try the bot (or the other way round).
      const userId = sent[0]?.userId;
      if (userId) {
        const used = new Set(transports.map((d) => d.channel));
        const created = await createFallbackDelivery(db, intentId, userId, used, now);
        if (created) {
          await enqueue(
            'notification.deliver',
            { deliveryId: created.id },
            { jobId: `deliver:${created.id}` },
          );
        }
      }
      await scheduleEscalationCheck({ ...intent, escalationState: next }, now);
      return 'channel_fallback';
    }

    case 'person_escalated': {
      // Step 3 — tell somebody else. A NEW intent, never a second delivery on
      // the old one, so the audit trail stays readable and the dedupe key is the
      // only guard needed.
      await escalateToAnotherPerson(db, intent, deliveries, now);
      return 'person_escalated';
    }

    case 'exhausted':
      return 'exhausted';

    case 'none':
      return 'not_applicable';
  }
}

async function createFallbackDelivery(
  db: Db,
  intentId: string,
  userId: string,
  used: Set<NotificationChannel>,
  now: Date,
): Promise<NotificationDeliveryRow | null> {
  if (!used.has('telegram')) {
    const link = await repo.getTelegramLink(db, userId);
    if (link?.canDm) {
      const [row] = await repo.insertDeliveries(db, [
        { intentId, userId, channel: 'telegram', status: 'pending' },
      ]);
      return row ?? null;
    }
  }

  if (!used.has('push')) {
    const subscriptions = await repo.listPushSubscriptions(db, userId, { liveOnly: true });
    const subscription = subscriptions[0];
    if (subscription) {
      const [row] = await repo.insertDeliveries(db, [
        {
          intentId,
          userId,
          channel: 'push',
          status: 'pending',
          subscriptionId: subscription.id,
        },
      ]);
      return row ?? null;
    }
  }

  void now;
  return null;
}

/**
 * Who a policy points at. Exactly one of the two columns is meaningful; a role
 * wins if both are set, and a row with neither is a no-op rather than a crash.
 */
function policyAudience(policy: EscalationPolicyRow): NotificationAudience | null {
  if (policy.escalateToRole) {
    const role = policy.escalateToRole as Role;
    return ROLES.includes(role) ? { roles: [role] } : null;
  }
  if (policy.escalateToUserId) return { users: [policy.escalateToUserId] };
  return null;
}

async function escalateToAnotherPerson(
  db: Db,
  intent: NotificationIntentRow,
  deliveries: NotificationDeliveryRow[],
  now: Date,
): Promise<void> {
  const originalRecipients = new Set(deliveries.map((d) => d.userId));
  const policies = await repo.listEnabledEscalationPolicies(db, intent.type);

  // The first hand-off is what starts the clock a policy's `afterMinutes`
  // measures from — not this rung, which has already burned two deadlines.
  const firstSentAt = Math.min(
    ...deliveries.filter((d) => d.sentAt !== null).map((d) => d.sentAt?.getTime() ?? Infinity),
  );
  const elapsedMinutes = Number.isFinite(firstSentAt)
    ? (now.getTime() - firstSentAt) / 60_000
    : Infinity;

  const due = policies.filter((policy) => policy.afterMinutes <= elapsedMinutes);

  // Escalation is the loudest thing this system does, so it always arrives as
  // `critical`: quiet hours may be crossed and an explicit human ack is the
  // only thing that closes the loop (D11).
  const bumped: NotificationPriority = 'critical';

  const targets: NotificationAudience[] = due.length
    ? due.flatMap((policy) => {
        const audience = policyAudience(policy);
        return audience ? [audience] : [];
      })
    : // No row matched. `ensureDefaultEscalationPolicies` normally guarantees
      // one, but a family that deleted every policy must not turn a genuinely
      // critical, unacknowledged event into silence — reaching *somebody* beats
      // reaching nobody. Same roles as the seeded default, one source of truth.
      intent.priority === 'critical'
      ? [{ roles: [...ESCALATION_FALLBACK_ROLES] }]
      : [];

  for (const [index, audience] of targets.entries()) {
    const filtered = filterAudience(audience, originalRecipients);
    if (!filtered) continue;

    const result = await emitIntent(db, {
      type: intent.type,
      audience: filtered,
      actorId: null,
      entityType: intent.entityType,
      entityId: intent.entityId,
      priority: bumped,
      // The `escalation:` prefix is also what makes an escalation ineligible for
      // escalation — there is no loop.
      dedupeKey: `escalation:${intent.id}:${index}`,
      payload: {
        ...intent.payload,
        escalatedFromIntentId: intent.id,
        escalatedFromUserIds: [...originalRecipients],
      },
    });
    await result.dispatch();
  }

  logger.warn(
    { intentId: intent.id, type: intent.type, targets: targets.length, policies: due.length },
    'escalated an unacknowledged notification to another person',
  );
}

function filterAudience(
  audience: NotificationAudience,
  exclude: Set<string>,
): NotificationAudience | null {
  if ('users' in audience) {
    const users = audience.users.filter((u) => !exclude.has(u));
    return users.length > 0 ? { users } : null;
  }
  // Role audiences are filtered later by `resolveRecipients`; excluding the
  // original recipients happens there via the payload, so keep the role as-is
  // and rely on the dedupe key to prevent a repeat.
  return audience;
}

/**
 * Safety net for lost delayed jobs: scan for `sent`-but-unconfirmed deliveries
 * and run the ladder. Idempotent — `escalateIntent` does all the claiming.
 */
export async function runEscalationSweep(db: Db, now = new Date()): Promise<number> {
  // 10 minutes is the shortest deadline (critical); per-priority filtering
  // happens inside `escalateIntent`.
  const cutoff = new Date(now.getTime() - 10 * 60_000);
  const candidates = await repo.listUnconfirmedDeliveries(db, cutoff);

  const seen = new Set<string>();
  let escalated = 0;
  for (const { intent } of candidates) {
    if (seen.has(intent.id)) continue;
    seen.add(intent.id);
    const outcome = await escalateIntent(db, intent.id, now);
    if (
      outcome === 'redelivered' ||
      outcome === 'channel_fallback' ||
      outcome === 'person_escalated'
    ) {
      escalated += 1;
    }
  }
  return escalated;
}

/* ========================================================================== */
/* In-app inbox                                                                */
/* ========================================================================== */

/** Inbox paging uses the app-wide keyset codec — `core/pagination.ts`. */
function encodeCursor(createdAt: Date, id: string): string {
  return encodeTimestampCursor({ createdAt, id });
}

function decodeCursor(cursor: string): TimestampCursor | undefined {
  return decodeTimestampCursor(cursor) ?? undefined;
}

/**
 * The bell. Copy is rendered **server-side** from the intent payload so the
 * client never re-templates it and the two can never disagree (D7).
 */
export async function listInbox(
  db: Db,
  userId: string,
  options: { limit: number; cursor?: string; unreadOnly?: boolean },
): Promise<{ items: InAppNotification[]; nextCursor: string | null }> {
  const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
  const rows = await repo.listInbox(db, userId, {
    limit: options.limit + 1,
    ...(cursor ? { cursor } : {}),
    ...(options.unreadOnly ? { unreadOnly: true } : {}),
  });

  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > options.limit && last ? encodeCursor(last.createdAt, last.id) : null;

  return {
    items: page.map((row) => {
      const rendered = renderNotification(row.type, row.payload);
      return {
        id: row.id,
        type: row.type,
        priority: row.priority,
        title: rendered.title,
        body: rendered.body,
        entityType: row.entityType,
        entityId: row.entityId,
        link: rendered.navigate,
        actor: row.actorId
          ? { id: row.actorId, displayName: row.actorName ?? '', avatarUrl: row.actorAvatarUrl }
          : null,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
        status: row.status,
        needsAcknowledgement:
          requiresExplicitAcknowledgement(row.priority) && row.acknowledgedAt === null,
        acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      };
    }),
    nextCursor,
  };
}

export async function getUnreadCount(db: Db, userId: string): Promise<number> {
  return repo.countUnread(db, userId);
}

/** The value the client passes to `navigator.setAppBadge()`. */
export async function getBadgeCount(db: Db, userId: string): Promise<number> {
  return repo.countUnread(db, userId);
}

export async function markRead(
  db: Db,
  userId: string,
  selector: { ids?: string[]; all?: boolean; before?: string },
  now = new Date(),
): Promise<number> {
  return repo.markRead(
    db,
    userId,
    {
      ...(selector.ids ? { ids: selector.ids } : {}),
      ...(selector.all ? { all: true } : {}),
      ...(selector.before ? { before: new Date(selector.before) } : {}),
    },
    now,
  );
}

/**
 * §G4's undo for «Прочитано»: put specific rows back to unread.
 *
 * Ids only — see `markUnreadRequestSchema` for why there is no `all` here — and
 * scoped to the caller in the repository, so an id belonging to another family
 * member is a silent no-op rather than a 403 (D4). Returns how many rows
 * actually moved, which is 0 for a replayed undo and for a row somebody else
 * owns; both are the same answer to the client and neither is an error.
 *
 * The D11 receipt columns are untouched. See the repository for the status
 * restore and why it only ever fires on a row sitting at exactly `read`.
 */
export async function markUnread(db: Db, userId: string, ids: string[]): Promise<number> {
  return repo.markUnread(db, userId, ids);
}

/* ========================================================================== */
/* Subscriptions                                                               */
/* ========================================================================== */

/**
 * D11 — "this device has stopped receiving anything".
 *
 * Pure, so the threshold can be pinned by a test. `consecutiveNoAck` counts
 * sends since the last arrival ack; on iOS this is the *only* evidence we ever
 * get that a subscription has died, because Safari never fires
 * `pushsubscriptionchange` and the endpoint keeps returning 201 regardless.
 */
export function isSubscriptionUnhealthy(row: {
  consecutiveNoAck: number;
  expiredAt: Date | null;
  unhealthyAt: Date | null;
}): boolean {
  if (row.expiredAt !== null || row.unhealthyAt !== null) return true;
  return row.consecutiveNoAck >= NOTIFICATION_LIMITS.maxSendsWithoutAck;
}

function toSummary(row: PushSubscriptionRow, currentEndpoint?: string): PushSubscriptionSummary {
  return {
    id: row.id,
    deviceLabel: row.deviceLabel,
    userAgent: row.userAgent,
    isStandalone: row.isStandalone,
    isCurrent: currentEndpoint !== undefined && row.endpoint === currentEndpoint,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    failureCount: row.failureCount,
    expiredAt: row.expiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lastDeliveredAt: row.lastDeliveredAt?.toISOString() ?? null,
    consecutiveNoAck: row.consecutiveNoAck,
    unhealthyAt: row.unhealthyAt?.toISOString() ?? null,
    isHealthy: !isSubscriptionUnhealthy(row),
  };
  // NOTE: `endpoint`, `p256dh` and `auth` are deliberately absent. The endpoint
  // is a capability URL — anyone holding it can push to that device.
}

/**
 * Idempotent upsert keyed on `endpoint`, safe to call on every app start and on
 * every `visibilitychange → visible` (the iOS foreground reconcile loop).
 *
 * Re-binding `userId` is what makes a shared family tablet work.
 */
export async function upsertSubscription(
  db: Db,
  userId: string,
  input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    deviceLabel?: string | null;
    isStandalone: boolean;
    userAgent?: string;
  },
): Promise<PushSubscriptionSummary> {
  const row = await repo.upsertPushSubscription(db, {
    userId,
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    userAgent: input.userAgent ?? '',
    deviceLabel: input.deviceLabel ?? null,
    isStandalone: input.isStandalone,
  });
  return toSummary(row, input.endpoint);
}

/**
 * Revoke a subscription by id — how a family member kills push on a lost or
 * replaced device from a phone they still have. Idempotent; a row that is
 * already gone is a success, so a double tap cannot produce a scary error.
 */
export async function removeSubscriptionById(
  db: Db,
  userId: string,
  subscriptionId: string,
): Promise<void> {
  await repo.deletePushSubscriptionById(db, userId, subscriptionId);
}

export async function removeSubscription(db: Db, userId: string, endpoint: string): Promise<void> {
  // Idempotent: unsubscribing a device that is already gone is a success, not a
  // 404. The client calls this from an unload path where it cannot retry.
  await repo.deletePushSubscription(db, userId, endpoint);
}

export async function listSubscriptions(
  db: Db,
  userId: string,
  currentEndpoint?: string,
): Promise<PushSubscriptionSummary[]> {
  const rows = await repo.listPushSubscriptions(db, userId);
  return rows.map((row) => toSummary(row, currentEndpoint));
}

/** `POST /subscriptions/ack` — the health-check reply from the service worker. */
export async function ackSubscription(
  db: Db,
  userId: string,
  endpoint: string,
  now = new Date(),
): Promise<void> {
  const row = await repo.getPushSubscriptionByEndpoint(db, endpoint);
  if (!row || row.userId !== userId) throw notFound('Subscription');
  await repo.recordPushDelivered(db, row.id, now);
}

/* ========================================================================== */
/* Preferences & quiet hours                                                   */
/* ========================================================================== */

export interface PreferencesView {
  preferences: NotificationPreference[];
  quietHours: Array<{
    id: string;
    dayOfWeek: number | null;
    startsAt: string;
    endsAt: string;
    mode: 'defer' | 'silence';
    createdAt: string;
  }>;
  channels: { pushReady: boolean; pushHealthy: boolean; telegramReady: boolean };
}

/**
 * The resolved matrix: stored rows layered over
 * `defaultNotificationPreference(type, role)`.
 *
 * Storage is sparse on purpose — an absent row means "use the code-side
 * default", which is what lets a new notification type ship without backfilling
 * a row per user and lets a changed default reach the people who never opened
 * the settings screen.
 */
export async function getPreferences(db: Db, userId: string, role: Role): Promise<PreferencesView> {
  const [stored, quiet, counts, telegram] = await Promise.all([
    repo.listPreferencesForUser(db, userId),
    repo.listQuietHoursForUser(db, userId),
    repo.countLivePushSubscriptions(db, userId),
    repo.getTelegramLink(db, userId),
  ]);

  const byType = new Map(stored.map((row) => [row.type, row]));

  return {
    preferences: NOTIFICATION_TYPES.map((type) => {
      const row = byType.get(type);
      if (row) {
        return {
          type,
          enabled: row.enabled,
          channelPush: row.channelPush,
          channelTelegram: row.channelTelegram,
          channelInApp: row.channelInApp,
        };
      }
      const fallback = defaultNotificationPreference(type, role);
      return {
        type,
        enabled: fallback.enabled,
        channelPush: fallback.push,
        channelTelegram: fallback.telegram,
        channelInApp: fallback.inApp,
      };
    }),
    quietHours: quiet.map((row) => ({
      id: row.id,
      dayOfWeek: row.dayOfWeek,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      mode: row.mode,
      createdAt: row.createdAt.toISOString(),
    })),
    channels: {
      pushReady: counts.live > 0,
      pushHealthy: counts.healthy > 0,
      telegramReady: Boolean(telegram?.canDm),
    },
  };
}

export async function updatePreferences(
  db: Db,
  userId: string,
  role: Role,
  preferences: NotificationPreference[],
): Promise<PreferencesView> {
  await repo.upsertPreferences(
    db,
    userId,
    preferences.map((p) => ({
      type: p.type,
      enabled: p.enabled,
      channelPush: p.channelPush,
      channelTelegram: p.channelTelegram,
      // The bell is the durable record; a user may not switch it off, because
      // the alternative is a notification that exists nowhere at all.
      channelInApp: DEFAULT_NOTIFICATION_PREFERENCES[p.type].inApp ? true : p.channelInApp,
    })),
  );
  return getPreferences(db, userId, role);
}

export async function updateQuietHours(
  db: Db,
  userId: string,
  windows: Array<{
    dayOfWeek: number | null;
    startsAt: string;
    endsAt: string;
    mode: 'defer' | 'silence';
  }>,
): Promise<PreferencesView['quietHours']> {
  const rows = await repo.replaceQuietHours(db, userId, windows);
  return rows.map((row) => ({
    id: row.id,
    dayOfWeek: row.dayOfWeek,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    mode: row.mode,
    createdAt: row.createdAt.toISOString(),
  }));
}

/* ========================================================================== */
/* Telegram link                                                               */
/* ========================================================================== */

export async function getTelegramStatus(
  db: Db,
  userId: string,
): Promise<{ linked: boolean; username: string | null; canDm: boolean }> {
  const link = await repo.getTelegramLink(db, userId);
  return {
    linked: Boolean(link),
    username: link?.telegramUsername ?? null,
    canDm: link?.canDm ?? false,
  };
}

export async function unlinkTelegram(db: Db, userId: string): Promise<void> {
  await repo.deleteTelegramLink(db, userId);
}

/* ========================================================================== */
/* Test notification                                                           */
/* ========================================================================== */

export interface TestResult {
  channel: NotificationChannel;
  subscriptionId: string | null;
  deviceLabel: string | null;
  ok: boolean;
  reason: string | null;
}

/**
 * «Отправить тестовое уведомление» — the single biggest support-ticket deflector
 * in the app, and on iOS the only honest way for a family member to find out
 * whether the whole chain works.
 *
 * It goes through the real pipeline (a real intent, real delivery rows, the real
 * adapters) because a test that takes a shortcut tests nothing. It bypasses only
 * the two things that would make it useless: self-suppression and quiet hours.
 */
export async function sendTestNotification(
  db: Db,
  userId: string,
  request: { channel: 'push' | 'telegram'; subscriptionId?: string },
  now = new Date(),
): Promise<TestResult[]> {
  const intentResult = await emitIntent(db, {
    type: 'system_alert',
    audience: { users: [userId] },
    actorId: userId,
    notifyActor: true,
    entityType: 'notification_test',
    priority: 'critical', // bypasses quiet hours and the hourly caps — as a test must
    dedupeKey: null,
    payload: {
      title: 'Проверка уведомлений',
      message: 'Если вы это видите — уведомления работают.',
      link: '/settings/notifications',
    },
  });

  const intent = await repo.getIntent(db, intentResult.intentId);
  if (!intent) throw new AppError('INTERNAL_ERROR', 'test intent vanished');

  const rendered = renderNotification(intent.type, intent.payload);
  const results: TestResult[] = [];

  if (request.channel === 'telegram') {
    const link = await repo.getTelegramLink(db, userId);
    const [row] = await repo.insertDeliveries(db, [
      { intentId: intent.id, userId, channel: 'telegram', status: 'pending' },
    ]);
    if (!link?.canDm || !row) {
      results.push({
        channel: 'telegram',
        subscriptionId: null,
        deviceLabel: null,
        ok: false,
        reason: 'no_target',
      });
      return results;
    }
    await deliverTelegram(db, row, rendered, now);
    const after = await repo.getDelivery(db, row.id);
    results.push({
      channel: 'telegram',
      subscriptionId: null,
      deviceLabel: null,
      ok: after?.status === 'delivered' || after?.status === 'sent',
      reason: after?.lastError ?? null,
    });
    return results;
  }

  const all = await repo.listPushSubscriptions(db, userId, { liveOnly: true });
  const targets = request.subscriptionId ? all.filter((s) => s.id === request.subscriptionId) : all;

  if (targets.length === 0) {
    results.push({
      channel: 'push',
      subscriptionId: null,
      deviceLabel: null,
      ok: false,
      reason: 'no_target',
    });
    return results;
  }

  for (const subscription of targets) {
    const [row] = await repo.insertDeliveries(db, [
      {
        intentId: intent.id,
        userId,
        channel: 'push',
        status: 'pending',
        subscriptionId: subscription.id,
      },
    ]);
    if (!row) continue;

    try {
      await deliverPush(db, row, intent, rendered, now);
    } catch (error) {
      // `deliverPush` throws on a retryable transport error; for a test we want
      // the truth reported back, not a queued retry.
      logger.debug({ err: error, subscriptionId: subscription.id }, 'test push failed');
    }

    const after = await repo.getDelivery(db, row.id);
    results.push({
      channel: 'push',
      subscriptionId: subscription.id,
      deviceLabel: subscription.deviceLabel,
      ok: after?.status === 'sent' || after?.status === 'delivered',
      reason: after?.lastError ?? null,
    });
  }

  return results;
}

/* ========================================================================== */
/* Weekly digest — preferences only                                            */
/* ========================================================================== */

/*
 * The digest *subscription* is read and written here, because it is a
 * notification preference and it is served by this module's settings routes.
 * The digest **send** is not: `scheduler.weekly-digest` belongs to
 * `dashboard/dashboard.jobs.ts`, and this module deliberately owns no part of
 * it (see the note at the bottom of `notifications.jobs.ts`).
 *
 * There used to be a second, complete implementation here — `runWeeklyDigest`,
 * `buildWeeklyDigest` and a `registerDigestSectionProvider` seam — competing
 * for the same job name. It is deleted rather than left dormant: an unused
 * sweep that is one `registerJobHandler` line away from silently taking the job
 * over is not documentation, it is a loaded gun. Its send-once claim was keyed
 * on a date plus a trailing 23 hours and its due-check was a one-hour window,
 * so it could send twice in a week when somebody edited their weekday and skip
 * the week entirely when a worker missed a tick — both of which the surviving
 * implementation was written to make impossible.
 */

export async function getDigestSubscription(
  db: Db,
  userId: string,
): Promise<{
  enabled: boolean;
  weekday: number;
  timeOfDay: string;
  sections: DigestSection[];
  lastSentAt: string | null;
}> {
  const row = await repo.getDigestSubscription(db, userId);
  if (!row) {
    return {
      enabled: false,
      weekday: 0,
      timeOfDay: '19:00',
      sections: ['tasks', 'events', 'goals', 'birthdays'],
      lastSentAt: null,
    };
  }
  return {
    enabled: row.enabled,
    weekday: row.weekday,
    timeOfDay: row.timeOfDay,
    sections: row.sections as DigestSection[],
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
  };
}

export async function updateDigestSubscription(
  db: Db,
  userId: string,
  input: { enabled: boolean; weekday: number; timeOfDay: string; sections: DigestSection[] },
): Promise<Awaited<ReturnType<typeof getDigestSubscription>>> {
  await repo.upsertDigestSubscription(db, userId, {
    enabled: input.enabled,
    weekday: input.weekday,
    timeOfDay: input.timeOfDay,
    sections: [...input.sections],
  });
  return getDigestSubscription(db, userId);
}

/* ========================================================================== */
/* Maintenance                                                                 */
/* ========================================================================== */

/**
 * Daily housekeeping plus the two D11 health signals.
 *
 * Everything here is idempotent and safe to run twice: the counters are
 * conditional updates and the sweeps re-enqueue jobs whose ids already exist.
 */
export async function runPushHealthCheck(
  db: Db,
  now = new Date(),
): Promise<{
  unhealthy: number;
  expired: number;
  requeued: number;
  escalated: number;
}> {
  // 1. Subscriptions that have gone N sends without an arrival ack. On iOS this
  //    is the ONLY way to notice a dead subscription — Safari never fires
  //    `pushsubscriptionchange`, the endpoint keeps returning 201, and the user
  //    believes notifications are on.
  const unhealthy = await repo.markUnhealthySubscriptions(
    db,
    NOTIFICATION_LIMITS.maxSendsWithoutAck,
    now,
  );
  for (const row of unhealthy) {
    logger.warn(
      { subscriptionId: row.id, userId: row.userId, consecutiveNoAck: row.consecutiveNoAck },
      'push subscription marked unhealthy — user will see the re-enable banner',
    );
  }

  // 2. Prune anything not seen in 90 days (§14), then delete rows expired for a
  //    week so the device list does not grow forever.
  const stale = await repo.listStalePushSubscriptions(
    db,
    new Date(now.getTime() - 90 * 24 * 3_600_000),
  );
  for (const row of stale) await repo.expirePushSubscription(db, row.id, now);
  await repo.deleteExpiredSubscriptions(db, new Date(now.getTime() - 7 * 24 * 3_600_000));
  await repo.deleteOldDeliveries(db, new Date(now.getTime() - 90 * 24 * 3_600_000));

  // 3. Safety nets for anything a Redis flush lost.
  const due = await repo.listDueDeliveries(db, now);
  for (const row of due) {
    await enqueue(
      'notification.deliver',
      { deliveryId: row.id },
      { jobId: `deliver:${row.id}:sweep` },
    );
  }
  const orphans = await repo.listUndispatchedIntents(db, new Date(now.getTime() - 5 * 60_000));
  for (const intent of orphans) {
    logger.warn({ intentId: intent.id }, 'intent had no deliveries — producer forgot dispatch()');
    await enqueue(
      'notification.dispatch',
      { intentId: intent.id },
      { jobId: `fanout:${intent.id}:sweep` },
    );
  }

  // 4. The D11 enforcement loop.
  const escalated = await runEscalationSweep(db, now);

  return {
    unhealthy: unhealthy.length,
    expired: stale.length,
    requeued: due.length + orphans.length,
    escalated,
  };
}
