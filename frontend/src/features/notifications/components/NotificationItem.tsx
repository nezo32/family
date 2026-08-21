import {
  NOTIFICATION_TYPE_LABELS_RU,
  type InAppNotification,
  type NotificationType,
} from '@family/shared';
import {
  AlertTriangle,
  Bell,
  CalendarDays,
  CheckCheck,
  Gift,
  ListTodo,
  Megaphone,
  PiggyBank,
  ShoppingCart,
  UserPlus,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { Button } from '@/shared/ui/button';
import { SwipeRow, type SwipeAction } from '@/shared/ui/swipe-row';
import { Badge } from '@/shared/ui/badge';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { relativeTime } from '@/shared/lib/i18n';
import { formatDateTime } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { needsAck } from '../api';
import { NOTIFICATION_ACTION_RU, NOTIFICATIONS_RU, PRIORITY_RU } from '../locale';

/** Type → icon. Purely decorative; the row is readable without it. */
const TYPE_ICONS: Partial<Record<NotificationType, ComponentType<{ className?: string }>>> = {
  task_assigned: ListTodo,
  task_due_soon: ListTodo,
  task_started: ListTodo,
  task_overdue: AlertTriangle,
  task_completed: CheckCheck,
  chore_swap_requested: ListTodo,
  chore_swap_answered: ListTodo,
  event_reminder: CalendarDays,
  event_created: CalendarDays,
  birthday_today: Gift,
  goal_contribution: PiggyBank,
  goal_milestone_reached: PiggyBank,
  goal_reached: PiggyBank,
  shopping_urgent_item: ShoppingCart,
  member_pending_approval: UserPlus,
  member_approved: UserPlus,
  announcement_posted: Megaphone,
  kudos_received: Megaphone,
};

/**
 * One row of the inbox.
 *
 * The title and body are **already rendered Russian sentences** from the server
 * — the client lays them out and never re-templates them, which is what keeps
 * the wording identical between the push notification and this list.
 *
 * ## Two buttons, and they must never be confused for each other
 *
 * «Подтвердить получение» is the D11 receipt. Per D11 it is the only signal
 * that stops a `critical` intent walking up the escalation ladder to the next
 * family member; opening the row is `interacted` and does not count. So it is a
 * real button with its own hit area, never a side effect of the tap that opens
 * the notification — but it decides **nothing** about the subject of the
 * notification.
 *
 * That distinction was invisible and it cost a family a working signup. The
 * join-request row («Заявка в семью — дарья кислякова ждёт подтверждения»)
 * offered exactly one button, «Подтвердить», and the owner tapped it. It
 * recorded a delivery receipt, printed «Подтверждено 20 августа в 08:09»
 * underneath, and left the applicant sitting on «ожидание решения» — the
 * approve endpoint was never called, from that day's logs not even once.
 *
 * Two changes keep it from happening again, and both are needed:
 *
 *  1. The receipt button names its object («получение») everywhere, including
 *     the timestamp beneath it. See `locale.ts`.
 *  2. A row that has somewhere actionable to go leads with a **primary**
 *     button that says so (`NOTIFICATION_ACTION_RU`), and the receipt button
 *     drops to `outline` beside it. The eye lands on the real decision, not on
 *     the bookkeeping.
 *
 * ## The swipe, and its undo
 *
 * Swipe left marks the row read (§G4's table). Read is not «подтверждено» — it
 * is the same thing tapping the row already does, which is why it is safe to
 * put on a gesture at all, and why «Подтвердить получение» is emphatically not
 * on one.
 *
 * §G4 also says every swipe raises a 6-second «Отменить», and this one now
 * does. It used to be the single place the spec was not met: the API offered
 * `POST /notifications/read` and nothing that reversed it, so the row shipped a
 * toast that stated what had happened and offered no control rather than one
 * that would fail. `POST /notifications/unread` closed that, and `onUnread`
 * below is what the toast's button calls.
 *
 * The undo is scoped to the bell and nowhere else: it clears `readAt`, and it
 * cannot touch the D11 receipts. Un-reading a row that was acknowledged does
 * **not** restart its escalation — the server keeps `acknowledgedAt` and the
 * status, and only the unread dot comes back. That separation is the same one
 * the two buttons below are about, expressed in the gesture.
 */
export function NotificationItem(props: {
  notification: InAppNotification;
  onOpen: (notification: InAppNotification) => void;
  onAcknowledge: (notification: InAppNotification) => void;
  /** Marks this row read without opening it — the swipe's only action. */
  onMarkRead?: (notification: InAppNotification) => void;
  /**
   * Puts the row back to unread — the toast's «Отменить» (§G4). Its absence
   * costs the toast that button, so it is passed wherever `onMarkRead` is.
   */
  onUnread?: (notification: InAppNotification) => void;
  acknowledging: boolean;
}) {
  const { notification } = props;
  const unread = notification.readAt === null;
  const Icon = TYPE_ICONS[notification.type] ?? Bell;
  const typeLabel = NOTIFICATION_TYPE_LABELS_RU[notification.type].label;
  const critical = notification.priority === 'critical';
  const showAck = needsAck(notification);
  // Only when the row actually goes somewhere: a label promising «Рассмотреть
  // заявку» on a row with `link === null` would be a button that does nothing.
  const actionLabel =
    notification.link === null ? undefined : NOTIFICATION_ACTION_RU[notification.type];

  const onMarkRead = props.onMarkRead;
  const onUnread = props.onUnread;
  /*
   * Only an unread row has anywhere to go. A read row gets `null`, which turns
   * the gesture off — a swipe that lands on a no-op is worse than no swipe,
   * because it teaches that the gesture does nothing.
   */
  const swipe: SwipeAction | null =
    unread && onMarkRead
      ? {
          label: NOTIFICATIONS_RU.swipeRead,
          icon: <CheckCheck />,
          tone: 'secondary',
          onCommit: () => {
            onMarkRead(notification);
          },
          // §G4: six seconds of «Отменить», and it genuinely reverses the
          // commit. `SwipeRow` drops the button when this is absent, so an
          // undo-less row is a claim rather than an oversight — here it is
          // supplied, and the claim no longer needs to be made.
          ...(onUnread
            ? {
                onUndo: () => {
                  onUnread(notification);
                },
              }
            : {}),
        }
      : null;

  return (
    <SwipeRow
      as="li"
      action={swipe}
      // No collapse: a row marked read stays exactly where it is and simply
      // loses its dot. It only leaves the list under «только непрочитанные»,
      // and that filter deliberately does not re-sort while somebody is
      // looking at it (see `useMarkRead`).
      className="border-b border-border last:border-b-0"
      /*
       * The unread wash is `color-mix`ed to an **opaque** colour rather than
       * written as `bg-accent/40`. This layer slides, and a 40 %-alpha layer
       * sliding over the revealed «Прочитано» button would let the button glow
       * through the row that is supposed to be hiding it. The mix is what
       * `--accent` at 40 % over `--background` already resolves to on screen,
       * so nothing about the row's appearance changes.
       *
       * Written out as a literal: Tailwind v4 finds classes by scanning source
       * text, so a class assembled from a variable is never generated at all.
       */
      contentClassName={cn(
        'flex gap-3 px-4 py-3',
        unread ? 'bg-[color-mix(in_oklab,var(--accent)_40%,var(--background))]' : 'bg-background',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full',
          critical ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
        )}
        aria-hidden
      >
        {notification.actor ? (
          <UserAvatar user={notification.actor} size="sm" />
        ) : (
          <Icon className="size-4" />
        )}
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <button
          type="button"
          // The whole text block is the open affordance; `link === null` rows
          // are still clickable because the tap is also what marks them read.
          onClick={() => {
            props.onOpen(notification);
          }}
          className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="flex items-start gap-2">
            <span
              className={cn('min-w-0 flex-1 text-sm', unread ? 'font-semibold' : 'font-medium')}
            >
              {notification.title}
            </span>
            {unread ? (
              <span
                className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
                aria-label="Непрочитано"
              />
            ) : null}
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">{notification.body}</span>
        </button>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <time dateTime={notification.createdAt} title={formatDateTime(notification.createdAt)}>
            {relativeTime(notification.createdAt)}
          </time>
          <span aria-hidden>·</span>
          <span>{typeLabel}</span>
          {critical || notification.priority === 'high' ? (
            <Badge variant={critical ? 'destructive' : 'secondary'}>
              {PRIORITY_RU[notification.priority]}
            </Badge>
          ) : null}
        </div>

        {actionLabel ? (
          <div className="pt-1">
            <Button
              size="sm"
              onClick={() => {
                props.onOpen(notification);
              }}
            >
              {actionLabel}
            </Button>
          </div>
        ) : null}

        {showAck ? (
          <div className="space-y-1 pt-1">
            <Button
              size="sm"
              // Never the primary button on a row that carries a real action —
              // the receipt is bookkeeping and must not out-rank the decision.
              variant={critical && !actionLabel ? 'default' : 'outline'}
              disabled={props.acknowledging}
              onClick={() => {
                props.onAcknowledge(notification);
              }}
            >
              {props.acknowledging ? (
                <>
                  <InlineSpinner />
                  {NOTIFICATIONS_RU.acknowledging}
                </>
              ) : (
                NOTIFICATIONS_RU.acknowledge
              )}
            </Button>
            {/*
              The hint is what says "this button does not decide anything". A
              row carrying its own action needs it more than a plain critical
              one does, not less — that is precisely the row somebody mistakes
              the receipt for a decision on.
            */}
            {critical || actionLabel ? (
              <p className="text-xs text-muted-foreground">{NOTIFICATIONS_RU.acknowledgeHint}</p>
            ) : null}
          </div>
        ) : notification.acknowledgedAt ? (
          <p className="flex items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
            <CheckCheck className="size-3.5" aria-hidden />
            {NOTIFICATIONS_RU.acknowledgedAt(formatDateTime(notification.acknowledgedAt))}
          </p>
        ) : null}
      </div>
    </SwipeRow>
  );
}
