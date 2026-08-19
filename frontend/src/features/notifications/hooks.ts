import { useEffect, useMemo } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { DeliveryAckResponse, InAppNotification, PreferencesResponse } from '@family/shared';
import { ackKey, enqueueAck } from '@/features/settings/push/ack-queue';
import {
  acknowledgeDelivery,
  fetchInbox,
  fetchNotificationChannels,
  fetchReceipts,
  fetchUnreadCount,
  markRead,
  needsAck,
  notificationKeys,
  type InboxPage,
  type NotificationReceipts,
} from './api';

/**
 * TanStack Query wrappers for the bell.
 *
 * The inbox is the one surface in this app that is *about* being out of date:
 * it exists to tell a family member what happened while they were away. So the
 * queries here refetch on focus and keep a short stale window — an installed
 * iOS PWA returns from the background as a cold start (research doc §8), and a
 * bell that shows yesterday's badge is how somebody concludes the app is dead.
 */

/** How long the badge and the list may be trusted without a refetch. */
const INBOX_STALE_TIME = 30_000;

/* -------------------------------------------------------------------------- */
/* the badge                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/notifications/unread-count` — the number on the bell.
 *
 * Also mirrored onto the app icon through the Badging API where it exists
 * (Android/desktop PWAs; iOS ignores it). Feature-detected and wrapped: the call
 * rejects in a non-installed context and a rejected promise here must never
 * surface as an error state on the shell.
 */
export function useUnreadCount(): UseQueryResult<number, Error> {
  const query = useQuery({
    queryKey: notificationKeys.unreadCount(),
    queryFn: ({ signal }) => fetchUnreadCount(signal),
    staleTime: INBOX_STALE_TIME,
    refetchOnWindowFocus: true,
    // A member who cannot read their inbox still has an app bar; the bell just
    // stays badge-less rather than retrying forever.
    retry: 1,
  });

  const unread = query.data;
  useEffect(() => {
    if (unread === undefined) return;
    const navigatorWithBadge = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    try {
      if (unread > 0) void navigatorWithBadge.setAppBadge?.(unread)?.catch(() => undefined);
      else void navigatorWithBadge.clearAppBadge?.()?.catch(() => undefined);
    } catch {
      // Badging is a nicety. Never let it reach a user.
    }
  }, [unread]);

  return query;
}

/* -------------------------------------------------------------------------- */
/* the list                                                                    */
/* -------------------------------------------------------------------------- */

export function useInbox(
  unreadOnly: boolean,
  enabled = true,
): UseInfiniteQueryResult<InfiniteData<InboxPage>, Error> {
  return useInfiniteQuery({
    queryKey: notificationKeys.list(unreadOnly),
    queryFn: ({ pageParam, signal }) => fetchInbox({ cursor: pageParam, unreadOnly }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: INBOX_STALE_TIME,
    refetchOnWindowFocus: true,
    // The panel is closed most of the time; there is no reason to poll the list
    // when nothing is looking at it. The badge query is what stays warm.
    enabled,
  });
}

/** Flatten the cursor pages into the list the panel renders. */
export function inboxItems(data: InfiniteData<InboxPage> | undefined): InAppNotification[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

/**
 * Rows still waiting for a human «Подтвердить».
 *
 * Surfaced separately because these are the only ones with a consequence for
 * somebody else: until one of them is acknowledged, a `critical` intent keeps
 * climbing the escalation ladder (D11).
 */
export function pendingAcknowledgements(items: readonly InAppNotification[]): InAppNotification[] {
  return items.filter(needsAck);
}

/* -------------------------------------------------------------------------- */
/* marking read                                                                */
/* -------------------------------------------------------------------------- */

export interface MarkReadInput {
  /** Specific rows. Mutually exclusive with `all`. */
  ids?: string[];
  /** «Прочитать все». */
  all?: boolean;
}

/**
 * `POST /api/notifications/read`.
 *
 * Optimistic on the badge only. The list rows are patched in place (so the
 * "unread" dot disappears under the finger) but the pages themselves are not
 * reordered — a row jumping out of «только непрочитанные» while the user is
 * still looking at it reads as a bug, so that filter is only re-fetched on
 * settle.
 */
export function useMarkRead(): UseMutationResult<void, Error, MarkReadInput> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: MarkReadInput) =>
      markRead(
        input.all
          ? // `before` pins the sweep to the moment of the tap, so a notification
            // that lands mid-request is not silently marked read too.
            { all: true, before: new Date().toISOString() }
          : { ids: input.ids ?? [] },
      ),

    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: notificationKeys.unreadCount() });
      const previousCount = queryClient.getQueryData<number>(notificationKeys.unreadCount());
      const readAt = new Date().toISOString();

      const affected = input.all ? undefined : new Set(input.ids ?? []);
      let cleared = 0;

      for (const unreadOnly of [false, true]) {
        queryClient.setQueryData<InfiniteData<InboxPage>>(
          notificationKeys.list(unreadOnly),
          (current) => {
            if (!current) return current;
            return {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                items: page.items.map((item) => {
                  if (item.readAt !== null) return item;
                  if (affected && !affected.has(item.id)) return item;
                  // Count once — the same row exists in both filtered lists.
                  if (!unreadOnly) cleared += 1;
                  return { ...item, readAt };
                }),
              })),
            };
          },
        );
      }

      if (previousCount !== undefined) {
        const next = input.all ? 0 : Math.max(0, previousCount - cleared);
        queryClient.setQueryData(notificationKeys.unreadCount(), next);
      }

      return { previousCount };
    },

    onError: (_error, _input, context) => {
      if (context?.previousCount !== undefined) {
        queryClient.setQueryData(notificationKeys.unreadCount(), context.previousCount);
      }
      void queryClient.invalidateQueries({ queryKey: notificationKeys.inbox() });
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* acknowledging (D11)                                                         */
/* -------------------------------------------------------------------------- */

export interface AcknowledgeResult {
  /** `false` when the POST failed and the receipt was parked in IndexedDB. */
  sent: boolean;
}

/**
 * The «Подтвердить» button.
 *
 * This is not "mark read" with extra steps. Per D11 an explicit acknowledgement
 * is the **only** signal that stops a `critical` notification escalating to
 * another family member: arriving on the device is `delivered`, tapping it is
 * `interacted`, and neither of them ends the ladder. If this button is never
 * pressed, every critical intent runs the full chain and wakes somebody else.
 *
 * Which is why a failure does not just show a toast: the receipt is written to
 * the same IndexedDB queue the service worker uses, keyed `${id}:acknowledged`,
 * and flushed by `flushAckQueue()` on the next foreground. A tap made in a
 * lift must not be lost.
 */
export function useAcknowledge(): UseMutationResult<AcknowledgeResult, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (deliveryId: string): Promise<AcknowledgeResult> => {
      const occurredAt = new Date().toISOString();
      try {
        const response: DeliveryAckResponse = await acknowledgeDelivery(deliveryId, occurredAt);
        patchAcknowledged(queryClient, deliveryId, response.acknowledgedAt ?? occurredAt);
        return { sent: true };
      } catch (error) {
        // Durable first, network second — the same order the SW uses. The queue
        // key makes a later replay a no-op both here and server-side.
        await enqueueAck({
          key: ackKey(deliveryId, 'acknowledged'),
          deliveryId,
          kind: 'acknowledged',
          occurredAt,
          queuedAt: occurredAt,
        });
        throw error;
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.inbox() });
    },
  });
}

/** Stamp one row as acknowledged in every cached page that holds it. */
function patchAcknowledged(
  queryClient: ReturnType<typeof useQueryClient>,
  deliveryId: string,
  acknowledgedAt: string,
): void {
  for (const unreadOnly of [false, true]) {
    queryClient.setQueryData<InfiniteData<InboxPage>>(
      notificationKeys.list(unreadOnly),
      (current) => {
        if (!current) return current;
        return {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              item.id === deliveryId
                ? { ...item, acknowledgedAt, needsAcknowledgement: false }
                : item,
            ),
          })),
        };
      },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* channel health (D11)                                                        */
/* -------------------------------------------------------------------------- */

export interface PushHealth {
  /** At least one live push subscription exists for this user. */
  ready: boolean;
  /**
   * `ready && !healthy` is the server's way of saying "a subscription exists
   * but nothing has ever acknowledged a delivery on it" — the device stopped
   * receiving push and nobody noticed. That is the banner.
   */
  healthy: boolean;
  /** True exactly when «Уведомления отключились — включить снова?» applies. */
  needsRepair: boolean;
}

/**
 * The `channels` block of `GET /api/notifications/preferences`.
 *
 * The flag is computed and sent on every request and had no reader at all
 * before this feature: a family could go a month with push quietly dead and the
 * app would look perfectly healthy the whole time.
 */
export function usePushHealth(): PushHealth {
  const query = useQuery({
    queryKey: notificationKeys.preferences,
    queryFn: ({ signal }) => fetchNotificationChannels(signal),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  return useMemo(() => {
    const channels: PreferencesResponse['channels'] | undefined = query.data?.channels;
    const ready = channels?.pushReady ?? false;
    const healthy = channels?.pushHealthy ?? true;
    return { ready, healthy, needsRepair: ready && !healthy };
  }, [query.data]);
}

/* -------------------------------------------------------------------------- */
/* receipts (D11)                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/notifications/intents/:id/receipts` — «Доставлено Ане».
 *
 * Scoped server-side to the sender and the recipients, so a child cannot read
 * the family's read timestamps. Disabled until an intent id is in hand.
 */
export function useDeliveryReceipts(
  intentId: string | null,
): UseQueryResult<NotificationReceipts, Error> {
  return useQuery({
    queryKey: notificationKeys.receipts(intentId ?? 'none'),
    queryFn: ({ signal }) => fetchReceipts(intentId as string, signal),
    enabled: intentId !== null,
    staleTime: 15_000,
  });
}
