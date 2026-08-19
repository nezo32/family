import { z } from 'zod';

import type { Role } from '../domain/roles.js';
import { idSchema, isoDateTimeSchema, nonEmptyString, timeOfDaySchema } from './common.js';

/**
 * Notification contracts — the shared vocabulary between the API, the worker and
 * the preferences screen.
 *
 * This file is deliberately the **one place in `@family/shared` that carries
 * Russian copy**: the preferences matrix is a pure catalog render (type → label,
 * description, group, defaults), and duplicating that catalog in the frontend
 * would guarantee it drifts from the enum the backend fans out on.
 */

/* -------------------------------------------------------------------------- */
/* Types & channels                                                            */
/* -------------------------------------------------------------------------- */

/** Mirrors the `notification_type` pgEnum. Keep the two in lockstep. */
export const NOTIFICATION_TYPES = [
  'task_assigned',
  'task_due_soon',
  'task_overdue',
  'task_completed',
  'chore_swap_requested',
  'chore_swap_answered',
  'event_reminder',
  'event_created',
  'birthday_today',
  'goal_contribution',
  'goal_milestone_reached',
  'goal_reached',
  'shopping_urgent_item',
  'member_pending_approval',
  'member_approved',
  'announcement_posted',
  'kudos_received',
  'weekly_digest',
  'system_alert',
] as const;

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const NOTIFICATION_CHANNELS = ['push', 'telegram', 'in_app'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const NOTIFICATION_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export const notificationPrioritySchema = z.enum(NOTIFICATION_PRIORITIES);
export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;

/**
 * Delivery lifecycle (D11).
 *
 * `sent` means only "the push service accepted it" — a `201` is not proof of
 * anything. The three states after it are the ones that carry real information:
 *
 * ```
 * pending ─> scheduled ─> sent ─> delivered ─> interacted ─> acknowledged
 *                          │        (SW push)   (SW click)    (user confirms)
 *                          ├─> failed
 *                          └─> suppressed
 * ```
 *
 * `read` is the in-app inbox equivalent of `interacted` and is kept for the bell
 * badge. **Status only ever moves forward** — see `DELIVERY_STATUS_RANK`.
 */
export const DELIVERY_STATUSES = [
  'pending',
  'scheduled',
  'sent',
  'failed',
  'suppressed',
  'read',
  'delivered',
  'interacted',
  'acknowledged',
] as const;
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

/**
 * Forward-progress ordering for `deliveryStatus`.
 *
 * A delivery's status may only ever increase. A late `delivered` ack arriving
 * after the user already tapped must not drag `interacted` back down, and a
 * replayed offline ack must be a no-op. Every writer compares ranks first.
 *
 * `failed` and `suppressed` are terminal side-states that sit just above `sent`:
 * a delivery that failed can still be superseded by a genuine `delivered` ack
 * (the push service 500'd on our retry but the first copy landed), which is why
 * they are not the maximum.
 */
export const DELIVERY_STATUS_RANK: Record<DeliveryStatus, number> = {
  pending: 0,
  scheduled: 1,
  suppressed: 2,
  failed: 3,
  sent: 4,
  delivered: 5,
  read: 6,
  interacted: 7,
  acknowledged: 8,
};

/** True when moving `from -> to` is forward progress and therefore allowed. */
export function isForwardDeliveryStatus(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_STATUS_RANK[to] > DELIVERY_STATUS_RANK[from];
}

/**
 * Escalation chain state, recorded on the **intent** so that at most one chain
 * ever runs per event no matter how often the sweep is retried (D11 guardrail).
 *
 * ```
 * none ─> redelivered ─> channel_fallback ─> person_escalated ─> exhausted
 * ```
 */
export const ESCALATION_STATES = [
  'none',
  'redelivered',
  'channel_fallback',
  'person_escalated',
  'exhausted',
] as const;
export const escalationStateSchema = z.enum(ESCALATION_STATES);
export type EscalationState = z.infer<typeof escalationStateSchema>;

export const ESCALATION_STATE_RANK: Record<EscalationState, number> = {
  none: 0,
  redelivered: 1,
  channel_fallback: 2,
  person_escalated: 3,
  exhausted: 4,
};

/** The next rung of the ladder, or `null` when the chain is finished. */
export function nextEscalationState(state: EscalationState): EscalationState | null {
  switch (state) {
    case 'none':
      return 'redelivered';
    case 'redelivered':
      return 'channel_fallback';
    case 'channel_fallback':
      return 'person_escalated';
    case 'person_escalated':
      return 'exhausted';
    case 'exhausted':
      return null;
  }
}

/** Quiet hours defer by default; `silence` drops the *ping*, never the record. */
export const QUIET_MODES = ['defer', 'silence'] as const;
export const quietModeSchema = z.enum(QUIET_MODES);
export type QuietMode = z.infer<typeof quietModeSchema>;

/* -------------------------------------------------------------------------- */
/* Catalog — Russian copy for the preferences screen                           */
/* -------------------------------------------------------------------------- */

export const NOTIFICATION_GROUPS = [
  'tasks',
  'calendar',
  'goals',
  'shopping',
  'family',
  'system',
] as const;
export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

export const NOTIFICATION_GROUP_LABELS_RU: Record<NotificationGroup, string> = {
  tasks: 'Задачи и дежурства',
  calendar: 'Календарь',
  goals: 'Копилки и цели',
  shopping: 'Покупки',
  family: 'Семья',
  system: 'Система',
};

export interface NotificationTypeCopy {
  /** Row title in the preferences matrix. */
  label: string;
  /** One-line explanation under the title. */
  description: string;
  /** Section the row belongs to. */
  group: NotificationGroup;
}

/**
 * The catalog. Every notification type must have an entry — the preferences
 * screen iterates `NOTIFICATION_TYPES` and looks each one up here, so a missing
 * entry is a compile error rather than an empty row.
 */
export const NOTIFICATION_TYPE_LABELS_RU: Record<NotificationType, NotificationTypeCopy> = {
  task_assigned: {
    label: 'Назначена задача',
    description: 'Вам поручили задачу или дежурство.',
    group: 'tasks',
  },
  task_due_soon: {
    label: 'Скоро срок',
    description: 'До срока вашей задачи осталось совсем немного.',
    group: 'tasks',
  },
  task_overdue: {
    label: 'Задача просрочена',
    description: 'Задача не была выполнена вовремя.',
    group: 'tasks',
  },
  task_completed: {
    label: 'Задача выполнена',
    description: 'Кто-то закрыл задачу, за которой вы следите.',
    group: 'tasks',
  },
  chore_swap_requested: {
    label: 'Просьба поменяться',
    description: 'Кто-то из семьи просит подменить его на дежурстве.',
    group: 'tasks',
  },
  chore_swap_answered: {
    label: 'Ответ на обмен',
    description: 'Вашу просьбу поменяться дежурством приняли или отклонили.',
    group: 'tasks',
  },
  event_reminder: {
    label: 'Напоминание о событии',
    description: 'Событие из календаря скоро начнётся.',
    group: 'calendar',
  },
  event_created: {
    label: 'Новое событие',
    description: 'В семейный календарь добавили событие.',
    group: 'calendar',
  },
  birthday_today: {
    label: 'День рождения',
    description: 'Сегодня день рождения у кого-то из семьи.',
    group: 'calendar',
  },
  goal_contribution: {
    label: 'Взнос в копилку',
    description: 'Кто-то пополнил общую цель.',
    group: 'goals',
  },
  goal_milestone_reached: {
    label: 'Копилка растёт',
    description: 'Цель прошла очередную отметку — четверть, половину, три четверти.',
    group: 'goals',
  },
  goal_reached: {
    label: 'Цель достигнута',
    description: 'Нужная сумма собрана полностью.',
    group: 'goals',
  },
  shopping_urgent_item: {
    label: 'Срочная покупка',
    description: 'В список покупок добавили что-то срочное.',
    group: 'shopping',
  },
  member_pending_approval: {
    label: 'Заявка на вступление',
    description: 'Новый участник ждёт подтверждения администратора.',
    group: 'family',
  },
  member_approved: {
    label: 'Участник принят',
    description: 'Заявку на вступление в семью одобрили.',
    group: 'family',
  },
  announcement_posted: {
    label: 'Новое объявление',
    description: 'На семейной стене появилось объявление.',
    group: 'family',
  },
  kudos_received: {
    label: 'Спасибо от семьи',
    description: 'Кто-то отметил вашу помощь.',
    group: 'family',
  },
  weekly_digest: {
    label: 'Итоги недели',
    description: 'Сводка по задачам, событиям и копилкам за неделю.',
    group: 'system',
  },
  system_alert: {
    label: 'Системное уведомление',
    description: 'Важное сообщение о работе приложения или безопасности аккаунта.',
    group: 'system',
  },
};

export const NOTIFICATION_CHANNEL_LABELS_RU: Record<NotificationChannel, string> = {
  push: 'Push',
  telegram: 'Telegram',
  in_app: 'В приложении',
};

export const QUIET_MODE_LABELS_RU: Record<QuietMode, string> = {
  defer: 'Отложить до конца тишины',
  silence: 'Только в приложении, без звука',
};

/**
 * Default priority per type. Drives quiet-hours bypass and the hourly push cap:
 * only `critical` may break through either.
 */
export const NOTIFICATION_TYPE_DEFAULT_PRIORITY: Record<NotificationType, NotificationPriority> = {
  task_assigned: 'normal',
  task_due_soon: 'normal',
  task_overdue: 'high',
  task_completed: 'low',
  chore_swap_requested: 'high',
  chore_swap_answered: 'normal',
  event_reminder: 'high',
  event_created: 'low',
  birthday_today: 'normal',
  goal_contribution: 'low',
  goal_milestone_reached: 'low',
  goal_reached: 'normal',
  shopping_urgent_item: 'high',
  member_pending_approval: 'high',
  member_approved: 'normal',
  announcement_posted: 'normal',
  kudos_received: 'low',
  weekly_digest: 'low',
  system_alert: 'critical',
};

/* -------------------------------------------------------------------------- */
/* Default preference matrix                                                   */
/* -------------------------------------------------------------------------- */

export interface NotificationChannelDefaults {
  /** Master switch for the type. */
  enabled: boolean;
  push: boolean;
  telegram: boolean;
  inApp: boolean;
}

/**
 * The code-side fallback used whenever a user has no `notification_preferences`
 * row for a type. Sparse storage + this matrix means new notification types
 * ship with a sane default for everybody instead of requiring a backfill.
 *
 * Bias: **in-app is always on** (it is the durable record), push is on only for
 * things that are actually actionable or time-bound, Telegram is opt-in except
 * where the bot DM is the point (admin approvals, system alerts, digest).
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: Record<
  NotificationType,
  NotificationChannelDefaults
> = {
  task_assigned: { enabled: true, push: true, telegram: false, inApp: true },
  task_due_soon: { enabled: true, push: true, telegram: false, inApp: true },
  task_overdue: { enabled: true, push: true, telegram: false, inApp: true },
  task_completed: { enabled: true, push: false, telegram: false, inApp: true },
  chore_swap_requested: { enabled: true, push: true, telegram: false, inApp: true },
  chore_swap_answered: { enabled: true, push: true, telegram: false, inApp: true },
  event_reminder: { enabled: true, push: true, telegram: false, inApp: true },
  event_created: { enabled: true, push: false, telegram: false, inApp: true },
  birthday_today: { enabled: true, push: true, telegram: false, inApp: true },
  goal_contribution: { enabled: true, push: false, telegram: false, inApp: true },
  goal_milestone_reached: { enabled: true, push: true, telegram: false, inApp: true },
  goal_reached: { enabled: true, push: true, telegram: false, inApp: true },
  shopping_urgent_item: { enabled: true, push: true, telegram: false, inApp: true },
  member_pending_approval: { enabled: true, push: true, telegram: true, inApp: true },
  member_approved: { enabled: true, push: true, telegram: false, inApp: true },
  announcement_posted: { enabled: true, push: true, telegram: false, inApp: true },
  kudos_received: { enabled: true, push: true, telegram: false, inApp: true },
  weekly_digest: { enabled: true, push: false, telegram: true, inApp: true },
  system_alert: { enabled: true, push: true, telegram: true, inApp: true },
};

/**
 * Role-specific corrections on top of the base matrix.
 *
 * These are **defaults, not permissions** — the fan-out step still filters
 * recipients by the RBAC catalog, so a child never receives
 * `member_pending_approval` even if a preference row says otherwise. Their
 * purpose is to keep the preferences screen honest: a child should not see a
 * toggle promising notifications they will never get.
 */
export const NOTIFICATION_PREFERENCE_ROLE_OVERRIDES: Partial<
  Record<Role, Partial<Record<NotificationType, Partial<NotificationChannelDefaults>>>>
> = {
  teen: {
    member_pending_approval: { enabled: false, push: false, telegram: false, inApp: false },
    system_alert: { push: false, telegram: false },
    goal_contribution: { enabled: false, push: false, telegram: false, inApp: false },
    goal_milestone_reached: { push: false },
  },
  child: {
    member_pending_approval: { enabled: false, push: false, telegram: false, inApp: false },
    member_approved: { enabled: false, push: false, telegram: false, inApp: false },
    system_alert: { enabled: false, push: false, telegram: false, inApp: false },
    goal_contribution: { enabled: false, push: false, telegram: false, inApp: false },
    goal_milestone_reached: { enabled: false, push: false, telegram: false, inApp: false },
    goal_reached: { push: false },
    weekly_digest: { enabled: false, push: false, telegram: false, inApp: false },
  },
  guest: {
    task_assigned: { enabled: false, push: false, telegram: false, inApp: false },
    task_due_soon: { enabled: false, push: false, telegram: false, inApp: false },
    task_overdue: { enabled: false, push: false, telegram: false, inApp: false },
    task_completed: { enabled: false, push: false, telegram: false, inApp: false },
    chore_swap_requested: { enabled: false, push: false, telegram: false, inApp: false },
    chore_swap_answered: { enabled: false, push: false, telegram: false, inApp: false },
    goal_contribution: { enabled: false, push: false, telegram: false, inApp: false },
    goal_milestone_reached: { enabled: false, push: false, telegram: false, inApp: false },
    goal_reached: { enabled: false, push: false, telegram: false, inApp: false },
    shopping_urgent_item: { enabled: false, push: false, telegram: false, inApp: false },
    member_pending_approval: { enabled: false, push: false, telegram: false, inApp: false },
    member_approved: { enabled: false, push: false, telegram: false, inApp: false },
    kudos_received: { enabled: false, push: false, telegram: false, inApp: false },
    weekly_digest: { enabled: false, push: false, telegram: false, inApp: false },
    system_alert: { enabled: false, push: false, telegram: false, inApp: false },
    event_created: { push: false },
  },
};

/**
 * Resolves the effective default for a (type, role) pair. Callers layer the
 * user's stored `notification_preferences` row on top of this, if one exists.
 */
export function defaultNotificationPreference(
  type: NotificationType,
  role?: Role,
): NotificationChannelDefaults {
  const base = DEFAULT_NOTIFICATION_PREFERENCES[type];
  if (!role) return { ...base };
  const override = NOTIFICATION_PREFERENCE_ROLE_OVERRIDES[role]?.[type];
  return override ? { ...base, ...override } : { ...base };
}

/**
 * Anti-spam budget, shared so the backend limiter and the settings copy cannot
 * disagree. `critical` bypasses every one of these.
 */
export const NOTIFICATION_LIMITS = {
  /** Hard cap on push notifications delivered to one user in a rolling hour. */
  maxPushPerUserPerHour: 6,
  /** Per-type cap in the same window — stops one noisy feature drowning the rest. */
  maxPushPerTypePerHour: 3,
  /**
   * Safe payload budget for a Web Push message. The spec guarantees only 4096
   * bytes *after* encryption padding; anything bigger must be trimmed to a
   * title + deep link and the body fetched by the service worker.
   */
  pushPayloadBudgetBytes: 3072,
  /** Delivery attempts before a row goes to `failed`. */
  maxDeliveryAttempts: 5,
  /**
   * Consecutive push sends with **no `deliveredAt` ack** before a subscription
   * is marked unhealthy and the user is shown
   * «Уведомления отключились — включить снова?» (D11).
   *
   * Three, because iOS itself revokes a subscription after roughly three pushes
   * that show nothing — by the time we have three unacknowledged sends the
   * subscription is almost certainly already dead, and the only recovery is a
   * fresh user gesture.
   */
  maxSendsWithoutAck: 3,
  /**
   * How long an ack may claim to have happened *before* the delivery was sent,
   * in minutes. Offline acks replayed from IndexedDB carry a client clock we do
   * not trust; anything outside the clamp is snapped to server time.
   */
  ackClockSkewToleranceMinutes: 5,
} as const;

/**
 * How long we wait for a `deliveredAt` (or, for `critical`, an
 * `acknowledgedAt`) before escalating — D11.
 *
 * `null` means **never escalate**. Escalating a `normal` or `low` notification
 * would be the cure that is worse than the disease: notification fatigue is the
 * failure mode that kills these apps, and the weekly digest already catches
 * anything routine that was missed.
 */
export const ESCALATION_DEADLINE_MINUTES: Record<NotificationPriority, number | null> = {
  critical: 10,
  high: 30,
  normal: null,
  low: null,
};

/**
 * Which signal closes the loop for a given priority.
 *
 * `critical` is not satisfied by the phone merely receiving the message — a
 * human has to press «Подтвердить». Everything else is satisfied by arrival.
 */
export function requiredAckSignal(priority: NotificationPriority): 'delivered' | 'acknowledged' {
  return priority === 'critical' ? 'acknowledged' : 'delivered';
}

/** Priorities for which the UI shows an explicit «Подтвердить» button. */
export function requiresExplicitAcknowledgement(priority: NotificationPriority): boolean {
  return priority === 'high' || priority === 'critical';
}

/* -------------------------------------------------------------------------- */
/* Push subscriptions                                                          */
/* -------------------------------------------------------------------------- */

/** The `keys` object from `PushSubscription.toJSON()`. */
export const pushSubscriptionKeysSchema = z.object({
  p256dh: nonEmptyString(255),
  auth: nonEmptyString(255),
});

/**
 * `POST /api/notifications/subscriptions` body: the browser's
 * `PushSubscription.toJSON()` verbatim, plus the two things only the client
 * knows — a human label and whether the page is running as an installed PWA.
 */
export const pushSubscriptionRequestSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: pushSubscriptionKeysSchema,
  /** Present in `toJSON()`; we accept and ignore it. */
  expirationTime: z.number().nullish(),
  deviceLabel: nonEmptyString(64).nullish(),
  /**
   * `window.matchMedia('(display-mode: standalone)').matches ||
   * navigator.standalone`. On iOS a non-standalone subscription cannot exist,
   * so `false` here is a strong signal the user needs the install prompt.
   */
  isStandalone: z.boolean().default(false),
  /** Optional; the server prefers the `user-agent` header when present. */
  userAgent: z.string().max(512).optional(),
});
export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionRequestSchema>;

/** `DELETE /api/notifications/subscriptions` — unsubscribe this device. */
export const pushUnsubscribeRequestSchema = z.object({
  endpoint: z.string().url().max(2048),
});
export type PushUnsubscribeRequest = z.infer<typeof pushUnsubscribeRequestSchema>;

/** A row in the "мои устройства" list. Never exposes the crypto keys. */
export const pushSubscriptionSummarySchema = z.object({
  id: idSchema,
  deviceLabel: z.string().nullable(),
  userAgent: z.string(),
  isStandalone: z.boolean(),
  /** True when this row matches the endpoint the calling browser holds. */
  isCurrent: z.boolean().default(false),
  lastSuccessAt: isoDateTimeSchema.nullable(),
  lastFailureAt: isoDateTimeSchema.nullable(),
  failureCount: z.number().int(),
  expiredAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,

  /* --- D11 receipt health ------------------------------------------------- */

  /** Last time the service worker acked an actual arrival on this device. */
  lastDeliveredAt: isoDateTimeSchema.nullable(),
  /** Sends since the last ack. `>= NOTIFICATION_LIMITS.maxSendsWithoutAck` = dead. */
  consecutiveNoAck: z.number().int(),
  /** Stamped when the threshold was crossed. Drives the re-enable banner. */
  unhealthyAt: isoDateTimeSchema.nullable(),
  /** Convenience for the UI: not expired and not over the no-ack threshold. */
  isHealthy: z.boolean(),
});
export type PushSubscriptionSummary = z.infer<typeof pushSubscriptionSummarySchema>;

/** `GET /api/notifications/vapid-public-key` — needed before `subscribe()`. */
export const vapidPublicKeySchema = z.object({ publicKey: z.string().min(1) });

/* -------------------------------------------------------------------------- */
/* Preferences                                                                 */
/* -------------------------------------------------------------------------- */

export const notificationPreferenceSchema = z.object({
  type: notificationTypeSchema,
  enabled: z.boolean(),
  channelPush: z.boolean(),
  channelTelegram: z.boolean(),
  channelInApp: z.boolean(),
});
export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;

/**
 * `PUT /api/notifications/preferences`. Bulk on purpose: the screen is a matrix
 * and users flip several switches before hitting save, and a bulk upsert keeps
 * the whole change in one transaction.
 */
export const updatePreferencesRequestSchema = z.object({
  preferences: z.array(notificationPreferenceSchema).min(1).max(NOTIFICATION_TYPES.length),
});
export type UpdatePreferencesRequest = z.infer<typeof updatePreferencesRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Quiet hours                                                                 */
/* -------------------------------------------------------------------------- */

const quietHoursFields = {
  /** 0 = Sunday … 6 = Saturday. `null` = every day. */
  dayOfWeek: z.number().int().min(0).max(6).nullable().default(null),
  startsAt: timeOfDaySchema,
  endsAt: timeOfDaySchema,
  mode: quietModeSchema.default('defer'),
};

export const quietHoursInputSchema = z
  .object(quietHoursFields)
  .refine((w) => w.startsAt !== w.endsAt, {
    message: 'Начало и конец тишины не могут совпадать',
    path: ['endsAt'],
  });
export type QuietHoursInput = z.infer<typeof quietHoursInputSchema>;

export const quietHoursSchema = z.object({
  id: idSchema,
  ...quietHoursFields,
  createdAt: isoDateTimeSchema,
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** `PUT /api/notifications/quiet-hours` — replaces the whole window set. */
export const updateQuietHoursRequestSchema = z.object({
  windows: z.array(quietHoursInputSchema).max(14),
});
export type UpdateQuietHoursRequest = z.infer<typeof updateQuietHoursRequestSchema>;

/**
 * `GET /api/notifications/preferences`: the resolved matrix (stored rows already
 * merged over `DEFAULT_NOTIFICATION_PREFERENCES`), plus the channel readiness
 * flags the UI needs to explain why a toggle is inert.
 */
export const preferencesResponseSchema = z.object({
  preferences: z.array(notificationPreferenceSchema),
  quietHours: z.array(quietHoursSchema),
  channels: z.object({
    /** At least one live push subscription exists. */
    pushReady: z.boolean(),
    /**
     * At least one live subscription is also *acknowledging* deliveries (D11).
     * `pushReady && !pushHealthy` is exactly the state that renders
     * «Уведомления отключились — включить снова?».
     */
    pushHealthy: z.boolean(),
    /** Telegram is linked and the bot may DM this user. */
    telegramReady: z.boolean(),
  }),
});

export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>;

/* -------------------------------------------------------------------------- */
/* In-app inbox                                                                */
/* -------------------------------------------------------------------------- */

/** What the bell icon renders. Rendering is done server-side; the client only lays it out. */
export const inAppNotificationSchema = z.object({
  id: idSchema,
  type: notificationTypeSchema,
  priority: notificationPrioritySchema,
  /** Already-rendered Russian copy — the client never re-templates it. */
  title: z.string(),
  body: z.string(),
  /** Polymorphic source pointer, for icon choice and analytics. */
  entityType: z.string().nullable(),
  entityId: idSchema.nullable(),
  /** Client route to open on tap, e.g. `/tasks/<id>`. `null` => not navigable. */
  link: z.string().nullable(),
  actor: z
    .object({
      id: idSchema,
      displayName: z.string(),
      avatarUrl: z.string().nullable(),
    })
    .nullable(),
  createdAt: isoDateTimeSchema,
  readAt: isoDateTimeSchema.nullable(),

  /** Lifecycle of this in-app row itself. Only ever moves forward. */
  status: deliveryStatusSchema,
  /**
   * True when this intent's `high`/`critical` priority means the UI must offer
   * an explicit «Подтвердить» button — and when pressing it is what stops the
   * escalation chain (D11).
   */
  needsAcknowledgement: z.boolean(),
  acknowledgedAt: isoDateTimeSchema.nullable(),
});
export type InAppNotification = z.infer<typeof inAppNotificationSchema>;

export const unreadCountSchema = z.object({ unread: z.number().int().min(0) });

/* -------------------------------------------------------------------------- */
/* Delivery receipts (D11)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Body of the three ack endpoints:
 *
 * - `POST /api/notifications/deliveries/:id/delivered`   — service worker `push`
 * - `POST /api/notifications/deliveries/:id/interacted`  — `notificationclick`
 * - `POST /api/notifications/deliveries/:id/acknowledge` — «Подтвердить»
 *
 * `occurredAt` exists because an ack may be replayed from an IndexedDB queue
 * long after the fact: the service worker records when the event *actually*
 * happened and flushes later. The server clamps it into
 * `[sentAt - skew, now]`, so a wrong client clock can never invent a receipt
 * before the message was sent or in the future.
 */
export const deliveryAckRequestSchema = z.object({
  occurredAt: isoDateTimeSchema.optional(),
});
export type DeliveryAckRequest = z.infer<typeof deliveryAckRequestSchema>;

export const deliveryAckResponseSchema = z.object({
  id: idSchema,
  status: deliveryStatusSchema,
  deliveredAt: isoDateTimeSchema.nullable(),
  interactedAt: isoDateTimeSchema.nullable(),
  acknowledgedAt: isoDateTimeSchema.nullable(),
});
export type DeliveryAckResponse = z.infer<typeof deliveryAckResponseSchema>;

/**
 * `GET /api/notifications/intents/:intentId/receipts` — what the *sender* sees
 * next to an item: «Доставлено Ане», «Не доставлено».
 */
export const deliveryReceiptSchema = z.object({
  id: idSchema,
  userId: idSchema,
  channel: notificationChannelSchema,
  status: deliveryStatusSchema,
  sentAt: isoDateTimeSchema.nullable(),
  deliveredAt: isoDateTimeSchema.nullable(),
  interactedAt: isoDateTimeSchema.nullable(),
  acknowledgedAt: isoDateTimeSchema.nullable(),
});
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;

export const deliveryReceiptsResponseSchema = z.object({
  intentId: idSchema,
  escalationState: escalationStateSchema,
  receipts: z.array(deliveryReceiptSchema),
});

/**
 * `POST /api/notifications/read`. Either an explicit id list or `all: true`
 * ("прочитать все") — the bell badge needs both.
 */
export const markReadRequestSchema = z
  .object({
    ids: z.array(idSchema).min(1).max(500).optional(),
    all: z.boolean().optional(),
    /** With `all`, limits the sweep to notifications created at or before this instant. */
    before: isoDateTimeSchema.optional(),
  })
  .refine((v) => v.all === true || (v.ids?.length ?? 0) > 0, {
    message: 'Укажите ids или all',
    path: ['ids'],
  });
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Weekly digest                                                               */
/* -------------------------------------------------------------------------- */

export const DIGEST_SECTIONS = [
  'tasks',
  'events',
  'goals',
  'shopping',
  'wall',
  'points',
  'birthdays',
] as const;
export const digestSectionSchema = z.enum(DIGEST_SECTIONS);
export type DigestSection = z.infer<typeof digestSectionSchema>;

export const DIGEST_SECTION_LABELS_RU: Record<DigestSection, string> = {
  tasks: 'Задачи и дежурства на неделю',
  events: 'События календаря',
  goals: 'Прогресс копилок',
  shopping: 'Списки покупок',
  wall: 'Объявления и благодарности',
  points: 'Баллы и нагрузка',
  birthdays: 'Дни рождения',
};

export const DEFAULT_DIGEST_SECTIONS: readonly DigestSection[] = [
  'tasks',
  'events',
  'goals',
  'birthdays',
];

export const digestSubscriptionSchema = z.object({
  enabled: z.boolean().default(true),
  /** 0 = Sunday … 6 = Saturday. Local to the user's timezone. */
  weekday: z.number().int().min(0).max(6).default(0),
  /** Local wall clock; the digest job resolves it per user timezone. */
  timeOfDay: timeOfDaySchema.default('19:00'),
  sections: z.array(digestSectionSchema).min(1).default([...DEFAULT_DIGEST_SECTIONS]),
  lastSentAt: isoDateTimeSchema.nullish(),
});
export type DigestSubscription = z.infer<typeof digestSubscriptionSchema>;

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/notifications/test` — the "прислать тестовое уведомление" button.
 * Indispensable on iOS, where a broken subscription is otherwise invisible: the
 * response reports what actually happened per target rather than a bare 200.
 */
export const notificationTestRequestSchema = z.object({
  channel: z.enum(['push', 'telegram']).default('push'),
  /** Target one device; omit to fan out to every live subscription. */
  subscriptionId: idSchema.optional(),
});
export type NotificationTestRequest = z.infer<typeof notificationTestRequestSchema>;

export const notificationTestResponseSchema = z.object({
  results: z.array(
    z.object({
      channel: notificationChannelSchema,
      subscriptionId: idSchema.nullable(),
      deviceLabel: z.string().nullable(),
      ok: z.boolean(),
      /** Machine-readable reason on failure: `gone`, `blocked`, `no_target`, … */
      reason: z.string().nullable(),
    }),
  ),
});
export type NotificationTestResponse = z.infer<typeof notificationTestResponseSchema>;
