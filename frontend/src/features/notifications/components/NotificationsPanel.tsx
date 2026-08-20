import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellOff, CheckCheck } from 'lucide-react';
import type { InAppNotification } from '@family/shared';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/shared/ui/sheet';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { notify } from '@/shared/lib/toast';
import { ROUTES } from '@/shared/lib/routes';
import { COMMON } from '@/shared/lib/i18n';
import { cn } from '@/shared/lib/utils';
import {
  inboxItems,
  useAcknowledge,
  useInbox,
  useMarkRead,
  useMarkUnread,
  useUnreadCount,
} from '../hooks';
import { NOTIFICATIONS_RU } from '../locale';
import { NotificationItem } from './NotificationItem';
import { PushHealthBanner } from './PushHealthBanner';

/**
 * The bell's inbox.
 *
 * A sheet rather than a route, for two reasons: it is a peek at what happened
 * rather than a destination, and every row that goes anywhere navigates *out* of
 * it — a route would put an extra back step between the notification and the
 * task it is about.
 *
 * Three behaviours here are the point of the whole feature:
 *
 *  1. **The badge is real.** `unread-count` drives it, and «Прочитать все»
 *     clears it optimistically so the number never lags the finger. The swipe's
 *     «Отменить» runs the same write backwards (§G4), so an accidental swipe
 *     costs nothing and the badge climbs straight back.
 *  2. **«Подтвердить» exists.** Per D11 it is the only signal that stops a
 *     `critical` intent escalating to another family member — opening the row
 *     is `interacted` and does not count. A failed tap is queued in IndexedDB
 *     rather than lost, so «в лифте» does not cost somebody a 3 a.m. push.
 *  3. **`pushHealthy === false` is visible.** The server has been reporting a
 *     dead subscription on every request; the banner at the top is the first
 *     thing that reads it.
 *
 * Every failure is rendered through `errorMessageRu` / `ErrorState`, keyed on
 * `ErrorCode`. The server's English `message` never reaches a screen (D7).
 */
export function NotificationsPanel(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const navigate = useNavigate();

  const unreadCount = useUnreadCount();
  // The list is only fetched while the panel is open; the badge query is the
  // one that stays warm in the background.
  const inbox = useInbox(unreadOnly, props.open);
  const markRead = useMarkRead();
  const markUnread = useMarkUnread();
  const acknowledge = useAcknowledge();

  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);

  const items = inboxItems(inbox.data);
  const unread = unreadCount.data ?? 0;

  const close = useCallback(() => {
    props.onOpenChange(false);
  }, [props]);

  const onOpen = useCallback(
    (notification: InAppNotification) => {
      if (notification.readAt === null) {
        markRead.mutate(
          { ids: [notification.id] },
          {
            onError: (error) => {
              notify.error(error, NOTIFICATIONS_RU.markReadFailed);
            },
          },
        );
      }
      if (notification.link) {
        close();
        void navigate(notification.link);
      }
    },
    [close, markRead, navigate],
  );

  /**
   * The swipe's action (§G4): mark read *without* opening. Same mutation the
   * tap uses, so there is one path to "прочитано" and the badge cannot
   * disagree with the list.
   */
  const onMarkRead = useCallback(
    (notification: InAppNotification) => {
      if (notification.readAt !== null) return;
      markRead.mutate(
        { ids: [notification.id] },
        {
          onError: (error) => {
            notify.error(error, NOTIFICATIONS_RU.markReadFailed);
          },
        },
      );
    },
    [markRead],
  );

  /**
   * The swipe's undo (§G4): put the row back to unread, straight from the
   * six-second toast that `SwipeRow` raises.
   *
   * It reverses «Прочитано» and only that. A row that had been acknowledged
   * keeps its acknowledgement and its stopped escalation ladder — the server
   * moves `readAt` and leaves every D11 receipt where it was, which is the one
   * property that made this safe to expose at all.
   */
  const onUnread = useCallback(
    (notification: InAppNotification) => {
      markUnread.mutate([notification.id], {
        onError: (error) => {
          notify.error(error, NOTIFICATIONS_RU.markUnreadFailed);
        },
      });
    },
    [markUnread],
  );

  const onAcknowledge = useCallback(
    (notification: InAppNotification) => {
      setAcknowledgingId(notification.id);
      acknowledge.mutate(notification.id, {
        onSuccess: () => {
          notify.success(NOTIFICATIONS_RU.acknowledged);
        },
        onError: (error) => {
          // The receipt is already in IndexedDB — say so, rather than implying
          // the tap was lost and inviting a second one.
          notify.error(error, NOTIFICATIONS_RU.acknowledgeFailed);
          notify.info(NOTIFICATIONS_RU.acknowledgeQueued);
        },
        onSettled: () => {
          setAcknowledgingId(null);
        },
      });
    },
    [acknowledge],
  );

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      {/*
        No `p-0` here any more. `SheetContent` carries the safe-area padding for
        a full-height side sheet (status bar above, home indicator below), and a
        blanket `p-0` from a screen would flatten it — putting «Уведомления»
        back under the system clock. The base sheet has no padding of its own,
        so dropping it changes nothing else.
      */}
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="gap-1 border-b border-border">
          <SheetTitle>{NOTIFICATIONS_RU.title}</SheetTitle>
          <SheetDescription>{NOTIFICATIONS_RU.description}</SheetDescription>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              aria-pressed={unreadOnly}
              onClick={() => {
                setUnreadOnly((value) => !value);
              }}
            >
              {unreadOnly ? NOTIFICATIONS_RU.showAll : NOTIFICATIONS_RU.onlyUnread}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              disabled={unread === 0 || markRead.isPending}
              onClick={() => {
                markRead.mutate(
                  { all: true },
                  {
                    onError: (error) => {
                      notify.error(error, NOTIFICATIONS_RU.markReadFailed);
                    },
                  },
                );
              }}
            >
              {markRead.isPending ? (
                <>
                  <InlineSpinner />
                  {NOTIFICATIONS_RU.marking}
                </>
              ) : (
                <>
                  <CheckCheck className="size-4" aria-hidden />
                  {NOTIFICATIONS_RU.markAllRead}
                </>
              )}
            </Button>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <PushHealthBanner className="m-4 mb-0" onNavigate={close} />

          {inbox.isPending ? (
            <InboxSkeleton />
          ) : inbox.error ? (
            <ErrorState
              error={inbox.error}
              title={NOTIFICATIONS_RU.loadFailed}
              onRetry={() => {
                void inbox.refetch();
              }}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={BellOff}
              title={unreadOnly ? NOTIFICATIONS_RU.emptyUnreadTitle : NOTIFICATIONS_RU.emptyTitle}
              description={
                unreadOnly ? NOTIFICATIONS_RU.emptyUnreadText : NOTIFICATIONS_RU.emptyText
              }
              /*
                Two different kinds of empty, so two different ways out. "Всё
                прочитано" is the filter's doing and the filter is what to
                undo; a genuinely empty inbox is usually a *настройки* problem
                — nothing was ever subscribed to.
              */
              action={
                unreadOnly ? (
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={() => {
                      setUnreadOnly(false);
                    }}
                  >
                    {NOTIFICATIONS_RU.showAll}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={() => {
                      close();
                      void navigate(ROUTES.settingsNotifications);
                    }}
                  >
                    {NOTIFICATIONS_RU.emptySettingsAction}
                  </Button>
                )
              }
            />
          ) : (
            <>
              <ul className={cn('divide-y divide-border')}>
                {items.map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                    onOpen={onOpen}
                    onMarkRead={onMarkRead}
                    onUnread={onUnread}
                    onAcknowledge={onAcknowledge}
                    acknowledging={acknowledgingId === notification.id}
                  />
                ))}
              </ul>

              {inbox.hasNextPage ? (
                <div className="p-4">
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={inbox.isFetchingNextPage}
                    onClick={() => {
                      void inbox.fetchNextPage();
                    }}
                  >
                    {inbox.isFetchingNextPage
                      ? NOTIFICATIONS_RU.loading
                      : NOTIFICATIONS_RU.loadMore}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="border-t border-border p-3">
          <Button variant="ghost" className="w-full" onClick={close}>
            {COMMON.close}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function InboxSkeleton() {
  return (
    <ul className="divide-y divide-border" aria-busy>
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className="flex gap-3 px-4 py-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-24" />
          </div>
        </li>
      ))}
    </ul>
  );
}
