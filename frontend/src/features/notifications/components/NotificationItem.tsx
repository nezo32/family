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
import { Badge } from '@/shared/ui/badge';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { relativeTime } from '@/shared/lib/i18n';
import { formatDateTime } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { needsAck } from '../api';
import { NOTIFICATIONS_RU, PRIORITY_RU } from '../locale';

/** Type → icon. Purely decorative; the row is readable without it. */
const TYPE_ICONS: Partial<Record<NotificationType, ComponentType<{ className?: string }>>> = {
  task_assigned: ListTodo,
  task_due_soon: ListTodo,
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
 * The «Подтвердить» button is the load-bearing control here. Per D11 it is the
 * only signal that stops a `critical` intent walking up the escalation ladder
 * to the next family member; opening the row is `interacted` and does not count.
 * So it is a real button with its own hit area, never a side effect of the tap
 * that opens the notification.
 */
export function NotificationItem(props: {
  notification: InAppNotification;
  onOpen: (notification: InAppNotification) => void;
  onAcknowledge: (notification: InAppNotification) => void;
  acknowledging: boolean;
}) {
  const { notification } = props;
  const unread = notification.readAt === null;
  const Icon = TYPE_ICONS[notification.type] ?? Bell;
  const typeLabel = NOTIFICATION_TYPE_LABELS_RU[notification.type].label;
  const critical = notification.priority === 'critical';
  const showAck = needsAck(notification);

  return (
    <li
      className={cn(
        'flex gap-3 border-b border-border px-4 py-3 last:border-b-0',
        unread && 'bg-accent/40',
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

        {showAck ? (
          <div className="space-y-1 pt-1">
            <Button
              size="sm"
              variant={critical ? 'default' : 'outline'}
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
            {critical ? (
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
    </li>
  );
}
