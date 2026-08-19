import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  cursorPaginationSchema,
  deliveryAckRequestSchema,
  deliveryAckResponseSchema,
  deliveryReceiptsResponseSchema,
  digestSubscriptionSchema,
  idSchema,
  inAppNotificationSchema,
  markReadRequestSchema,
  notificationTestRequestSchema,
  notificationTestResponseSchema,
  okSchema,
  paginatedSchema,
  preferencesResponseSchema,
  pushSubscriptionRequestSchema,
  pushSubscriptionSummarySchema,
  pushUnsubscribeRequestSchema,
  quietHoursSchema,
  unreadCountSchema,
  updatePreferencesRequestSchema,
  updateQuietHoursRequestSchema,
  vapidPublicKeySchema,
} from '@family/shared';

import { getConfig } from '../../core/config.js';
import { getDb } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import type { AuthContext } from '../../core/auth/context.js';
import * as service from './notifications.service.js';

/**
 * `/api/notifications/*`.
 *
 * Thin by design (D8): every handler resolves the caller, calls one service
 * function and returns. No business rules live here.
 *
 * ## Access
 *
 * Everything except the VAPID public key requires a session, and every personal
 * route is guarded by `notification:manage:own` — the one permission every role
 * holds, including `guest`, because muting your own notifications must never be
 * a privilege.
 *
 * ## These endpoints must NEVER be cached by the service worker
 *
 * The frontend's Workbox config must register a `NetworkOnly` route for
 * `/api/notifications/*` **before** the generic `/api/` `NetworkFirst` rule
 * (Workbox is first-match-wins). Caching any of them produces a specific,
 * horrible bug class:
 *
 * - a cached `unread-count` leaves a badge that never clears;
 * - a cached `subscriptions` response makes a device that has silently lost push
 *   look healthy forever — the exact failure D11 exists to catch;
 * - a replayed/cached ack POST corrupts the receipt timeline;
 * - a cached `vapid-public-key` survives a key rotation and every subsequent
 *   `subscribe()` produces a subscription the server can never push to.
 */

function auth(request: FastifyRequest): AuthContext {
  // The `onRequest` hook in `core/plugins/auth.ts` has already run and thrown
  // for every route in this file except the public VAPID key one, so this is a
  // type narrowing rather than a real check.
  if (!request.auth) throw new AppError('UNAUTHENTICATED', 'Authentication required');
  return request.auth;
}

/** `?unreadOnly=true`. `z.coerce.boolean()` would turn `"false"` into `true`. */
const booleanQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const deliveryParams = z.object({ id: idSchema });

const notificationsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /* ---------------------------------------------------------------------- */
  /* Inbox                                                                   */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/notifications',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'In-app notification inbox (the bell)',
        querystring: cursorPaginationSchema.extend({ unreadOnly: booleanQuery }),
        response: { 200: paginatedSchema(inAppNotificationSchema) },
      },
    },
    async (request) => {
      const { cursor, limit, unreadOnly } = request.query;
      return service.listInbox(getDb(), auth(request).userId, {
        limit,
        ...(cursor ? { cursor } : {}),
        unreadOnly,
      });
    },
  );

  app.get(
    '/notifications/unread-count',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Unread count for the bell badge and navigator.setAppBadge()',
        response: { 200: unreadCountSchema },
      },
    },
    async (request) => ({ unread: await service.getBadgeCount(getDb(), auth(request).userId) }),
  );

  app.post(
    '/notifications/read',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Mark inbox notifications read',
        body: markReadRequestSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const body = request.body;
      await service.markRead(getDb(), auth(request).userId, {
        ...(body.ids ? { ids: body.ids } : {}),
        ...(body.all ? { all: body.all } : {}),
        ...(body.before ? { before: body.before } : {}),
      });
      return { ok: true } as const;
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Receipts (D11)                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Called by the service worker's `push` handler **after** `showNotification()`
   * resolves. Fire-and-forget: the SW must swallow every failure, because
   * showing the notification is the one thing iOS actually requires and an ack
   * that throws inside `waitUntil` can cost us the subscription.
   */
  app.post(
    '/notifications/deliveries/:id/delivered',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Ack that a notification arrived on the device',
        params: deliveryParams,
        body: deliveryAckRequestSchema,
        response: { 200: deliveryAckResponseSchema },
      },
    },
    async (request) =>
      ackRoute(auth(request).userId, request.params.id, request.body, 'delivered'),
  );

  /** Called from `notificationclick`, before navigating. */
  app.post(
    '/notifications/deliveries/:id/interacted',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Ack that the user tapped a notification',
        params: deliveryParams,
        body: deliveryAckRequestSchema,
        response: { 200: deliveryAckResponseSchema },
      },
    },
    async (request) =>
      ackRoute(auth(request).userId, request.params.id, request.body, 'interacted'),
  );

  /**
   * The «Подтвердить» button, offered for `high`/`critical` intents only. This
   * is the only signal that stops a `critical` escalation chain.
   */
  app.post(
    '/notifications/deliveries/:id/acknowledge',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Explicit human acknowledgement of a high/critical notification',
        params: deliveryParams,
        body: deliveryAckRequestSchema,
        response: { 200: deliveryAckResponseSchema },
      },
    },
    async (request) =>
      ackRoute(auth(request).userId, request.params.id, request.body, 'acknowledged'),
  );

  async function ackRoute(
    userId: string,
    deliveryId: string,
    body: { occurredAt?: string },
    kind: service.AckKind,
  ) {
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : undefined;
    const result = await service.ackDelivery(getDb(), userId, deliveryId, kind, occurredAt);
    return {
      id: result.id,
      status: result.status,
      deliveredAt: result.deliveredAt?.toISOString() ?? null,
      interactedAt: result.interactedAt?.toISOString() ?? null,
      acknowledgedAt: result.acknowledgedAt?.toISOString() ?? null,
    };
  }

  /** What the sender sees next to an item: «Доставлено» / «Не доставлено». */
  app.get(
    '/notifications/intents/:id/receipts',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Per-recipient delivery receipts for one intent',
        params: deliveryParams,
        response: { 200: deliveryReceiptsResponseSchema },
      },
    },
    async (request) => {
      const result = await service.getIntentReceipts(getDb(), request.params.id);
      return {
        intentId: result.intentId,
        escalationState: result.escalationState,
        receipts: result.receipts.map((r) => ({
          id: r.id,
          userId: r.userId,
          channel: r.channel,
          status: r.status,
          sentAt: r.sentAt?.toISOString() ?? null,
          deliveredAt: r.deliveredAt?.toISOString() ?? null,
          interactedAt: r.interactedAt?.toISOString() ?? null,
          acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Preferences & quiet hours                                               */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/notifications/preferences',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Resolved preference matrix, quiet hours and channel readiness',
        response: { 200: preferencesResponseSchema },
      },
    },
    async (request) => {
      const caller = auth(request);
      return service.getPreferences(getDb(), caller.userId, caller.role);
    },
  );

  app.put(
    '/notifications/preferences',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Bulk-update the preference matrix',
        body: updatePreferencesRequestSchema,
        response: { 200: preferencesResponseSchema },
      },
    },
    async (request) => {
      const caller = auth(request);
      return service.updatePreferences(
        getDb(),
        caller.userId,
        caller.role,
        request.body.preferences,
      );
    },
  );

  app.put(
    '/notifications/quiet-hours',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Replace the quiet-hours window set',
        body: updateQuietHoursRequestSchema,
        response: { 200: z.array(quietHoursSchema) },
      },
    },
    async (request) =>
      service.updateQuietHours(getDb(), auth(request).userId, request.body.windows),
  );

  /* ---------------------------------------------------------------------- */
  /* Push subscriptions                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Public on purpose: the client needs `applicationServerKey` **before** it can
   * call `subscribe()`, and on iOS no `await` may run between the user's tap and
   * `Notification.requestPermission()`. The key is a public key; publishing it is
   * what it is for.
   */
  app.get(
    '/notifications/vapid-public-key',
    {
      config: { public: true },
      schema: {
        tags: ['notifications'],
        summary: 'VAPID application server key (public)',
        response: { 200: vapidPublicKeySchema },
      },
    },
    async () => {
      const { push } = getConfig();
      if (!push.enabled) {
        throw new AppError('SERVICE_UNAVAILABLE', 'Web push is not configured on this deployment');
      }
      return { publicKey: push.publicKey };
    },
  );

  app.get(
    '/notifications/subscriptions',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Devices subscribed to push (never returns the endpoint)',
        querystring: z.object({ endpoint: z.string().url().max(2048).optional() }),
        response: { 200: z.array(pushSubscriptionSummarySchema) },
      },
    },
    async (request) =>
      service.listSubscriptions(getDb(), auth(request).userId, request.query.endpoint),
  );

  app.post(
    '/notifications/subscriptions',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Upsert this device subscription (idempotent on endpoint)',
        body: pushSubscriptionRequestSchema,
        response: { 200: pushSubscriptionSummarySchema },
      },
    },
    async (request) => {
      const body = request.body;
      return service.upsertSubscription(getDb(), auth(request).userId, {
        endpoint: body.endpoint,
        keys: body.keys,
        deviceLabel: body.deviceLabel ?? null,
        isStandalone: body.isStandalone,
        userAgent: body.userAgent ?? request.headers['user-agent'] ?? '',
      });
    },
  );

  app.post(
    '/notifications/subscriptions/ack',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Health-check reply from the service worker',
        body: z.object({ endpoint: z.string().url().max(2048) }),
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await service.ackSubscription(getDb(), auth(request).userId, request.body.endpoint);
      return { ok: true } as const;
    },
  );

  app.delete(
    '/notifications/subscriptions',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Unsubscribe this device (idempotent)',
        body: pushUnsubscribeRequestSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await service.removeSubscription(getDb(), auth(request).userId, request.body.endpoint);
      return { ok: true } as const;
    },
  );

  /**
   * «Отправить тестовое уведомление». Rate-limited because it is the one
   * endpoint a bored child will hammer, and each call is a real push.
   */
  app.post(
    '/notifications/test',
    {
      config: {
        permission: 'notification:manage:own',
        rateLimit: { max: 5, timeWindow: '1 hour' },
      },
      schema: {
        tags: ['notifications'],
        summary: 'Send a test notification to this user',
        body: notificationTestRequestSchema,
        response: { 200: notificationTestResponseSchema },
      },
    },
    async (request) => {
      const body = request.body;
      const results = await service.sendTestNotification(getDb(), auth(request).userId, {
        channel: body.channel,
        ...(body.subscriptionId ? { subscriptionId: body.subscriptionId } : {}),
      });
      return { results };
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Weekly digest                                                           */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/notifications/digest',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Weekly digest subscription',
        response: { 200: digestSubscriptionSchema },
      },
    },
    async (request) => service.getDigestSubscription(getDb(), auth(request).userId),
  );

  app.put(
    '/notifications/digest',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Update the weekly digest subscription',
        body: digestSubscriptionSchema,
        response: { 200: digestSubscriptionSchema },
      },
    },
    async (request) => {
      const body = request.body;
      return service.updateDigestSubscription(getDb(), auth(request).userId, {
        enabled: body.enabled,
        weekday: body.weekday,
        timeOfDay: body.timeOfDay,
        sections: body.sections,
      });
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Telegram                                                                */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/notifications/telegram',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Telegram link status',
        response: {
          200: z.object({
            linked: z.boolean(),
            username: z.string().nullable(),
            canDm: z.boolean(),
          }),
        },
      },
    },
    async (request) => service.getTelegramStatus(getDb(), auth(request).userId),
  );

  /**
   * Unlink only. **Linking** lives in the auth module (D3 OIDC with
   * `telegram:bot_access`); duplicating the OAuth flow here would give us two
   * places to get token handling wrong.
   */
  app.delete(
    '/notifications/telegram',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['notifications'],
        summary: 'Unlink the Telegram bot from this account',
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await service.unlinkTelegram(getDb(), auth(request).userId);
      return { ok: true } as const;
    },
  );
};

export default notificationsRoutes;
