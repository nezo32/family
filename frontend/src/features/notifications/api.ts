import {
  deliveryReceiptsResponseSchema,
  inAppNotificationSchema,
  unreadCountSchema,
  type DeliveryAckResponse,
  type InAppNotification,
  type PreferencesResponse,
} from '@family/shared';
import { z } from 'zod';
import { api } from '@/shared/api/client';

/**
 * Typed fetchers and query keys for the notification inbox (the bell).
 *
 * Three things here are load-bearing:
 *
 * 1. **Responses are parsed, not cast.** `api.get<T>()` is a type assertion and
 *    nothing more; a backend that renames a field would otherwise surface as
 *    `undefined` three components deep. The `/api/me` incident is the reason
 *    this file parses.
 * 2. **Acknowledgement is not "mark read".** `POST /notifications/read` clears
 *    the badge; `POST /notifications/deliveries/:id/acknowledge` is the D11
 *    receipt, and for a `critical` intent it is the *only* signal that stops the
 *    escalation ladder handing the notification to another family member.
 *    Reading the row does not stop it. Tapping it does not stop it.
 * 3. **None of these may be cached by the service worker.** `sw.ts` must keep
 *    `/api/notifications/*` on `NetworkOnly`: a cached `unread-count` leaves a
 *    badge that never clears, and a cached inbox hides the very thing the
 *    escalation is escalating about.
 */

/* -------------------------------------------------------------------------- */
/* query keys                                                                  */
/* -------------------------------------------------------------------------- */

export const notificationKeys = {
  all: ['notifications'] as const,
  inbox: () => [...notificationKeys.all, 'inbox'] as const,
  /** The list is keyed by its filter: «только непрочитанные» is a separate page set. */
  list: (unreadOnly: boolean) => [...notificationKeys.inbox(), { unreadOnly }] as const,
  unreadCount: () => [...notificationKeys.all, 'unread-count'] as const,
  receipts: (intentId: string) => [...notificationKeys.all, 'receipts', intentId] as const,
  /** Owned by `features/settings`, refetched from here for the D11 health flag. */
  preferences: ['settings', 'notifications', 'preferences'] as const,
};

/* -------------------------------------------------------------------------- */
/* schemas for the responses this feature reads                                */
/* -------------------------------------------------------------------------- */

const inboxPageSchema = z.object({
  items: z.array(inAppNotificationSchema),
  nextCursor: z.string().nullable(),
});

export type InboxPage = z.infer<typeof inboxPageSchema>;
export type NotificationReceipts = z.infer<typeof deliveryReceiptsResponseSchema>;

/** How many rows one page of the bell holds. */
export const INBOX_PAGE_SIZE = 20;

/* -------------------------------------------------------------------------- */
/* reads                                                                       */
/* -------------------------------------------------------------------------- */

/** `GET /api/notifications` — one cursor page of the inbox. */
export async function fetchInbox(
  params: { cursor?: string | null; limit?: number; unreadOnly?: boolean },
  signal?: AbortSignal,
): Promise<InboxPage> {
  const raw = await api.get<unknown>('/notifications', {
    query: {
      limit: params.limit ?? INBOX_PAGE_SIZE,
      ...(params.cursor ? { cursor: params.cursor } : {}),
      // The server parses this with a `'true' | 'false'` enum, so it must be a
      // string and must be omitted rather than sent as `false`-ish.
      ...(params.unreadOnly ? { unreadOnly: 'true' } : {}),
    },
    ...(signal ? { signal } : {}),
  });
  return inboxPageSchema.parse(raw);
}

/** `GET /api/notifications/unread-count` — the number on the bell. */
export async function fetchUnreadCount(signal?: AbortSignal): Promise<number> {
  const raw = await api.get<unknown>(
    '/notifications/unread-count',
    signal ? { signal } : undefined,
  );
  return unreadCountSchema.parse(raw).unread;
}

/**
 * `GET /api/notifications/intents/:id/receipts` — who actually got it (D11).
 *
 * Read-only, and only meaningful for a notification the caller sent; it is the
 * answer to «дошло ли до Ани» that the family otherwise has to ask out loud.
 */
export async function fetchReceipts(
  intentId: string,
  signal?: AbortSignal,
): Promise<NotificationReceipts> {
  const raw = await api.get<unknown>(
    `/notifications/intents/${encodeURIComponent(intentId)}/receipts`,
    signal ? { signal } : undefined,
  );
  return deliveryReceiptsResponseSchema.parse(raw);
}

/**
 * `GET /api/notifications/preferences`.
 *
 * The inbox only wants `channels.pushHealthy` from this — the flag that means
 * "this device has a live subscription that has stopped acknowledging anything"
 * — but the endpoint is the whole preferences payload and `features/settings`
 * already owns its query key, so the two share one cache entry.
 */
export function fetchNotificationChannels(signal?: AbortSignal): Promise<PreferencesResponse> {
  return api.get<PreferencesResponse>(
    '/notifications/preferences',
    signal ? { signal } : undefined,
  );
}

/* -------------------------------------------------------------------------- */
/* writes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/notifications/read`.
 *
 * Either an explicit id list or `all: true`. `before` pins «прочитать все» to
 * the moment the button was pressed, so a notification that arrives mid-request
 * is not silently swallowed by the sweep.
 */
export function markRead(input: { ids?: string[]; all?: boolean; before?: string }): Promise<void> {
  return api.post<void>('/notifications/read', input);
}

/**
 * `POST /api/notifications/deliveries/:id/acknowledge` — the «Подтвердить» tap.
 *
 * `occurredAt` is when the human actually pressed it, which is not necessarily
 * when the request goes out: an offline tap is queued in IndexedDB and flushed
 * later. The server clamps the value into `[sentAt - skew, now]`, so a wrong
 * device clock cannot invent a receipt.
 */
export function acknowledgeDelivery(
  deliveryId: string,
  occurredAt: string,
): Promise<DeliveryAckResponse> {
  return api.post<DeliveryAckResponse>(
    `/notifications/deliveries/${encodeURIComponent(deliveryId)}/acknowledge`,
    { occurredAt },
  );
}

/* -------------------------------------------------------------------------- */
/* derivations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Does this row still need a human «Подтвердить»?
 *
 * `needsAcknowledgement` is the server's decision (`high`/`critical` priority);
 * once `acknowledgedAt` is set the ladder has already been stopped and the
 * button must not be offered again.
 */
export function needsAck(notification: InAppNotification): boolean {
  return notification.needsAcknowledgement && notification.acknowledgedAt === null;
}
