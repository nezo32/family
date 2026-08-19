import { useCallback } from 'react';
import { ErrorState } from '@/shared/components/ErrorState';
import { useCan } from '@/shared/auth/use-can';
import { useMe } from '@/shared/auth/use-me';
import { ApprovalsWidget } from '../components/ApprovalsWidget';
import { EventsWidget } from '../components/EventsWidget';
import { FreeDayCard } from '../components/FreeDayCard';
import { GoalWidget } from '../components/GoalWidget';
import { GreetingHeader } from '../components/GreetingHeader';
import { LoadWidget } from '../components/LoadWidget';
import { MyTasksWidget } from '../components/MyTasksWidget';
import { OverdueWidget } from '../components/OverdueWidget';
import { ShoppingWidget } from '../components/ShoppingWidget';
import { TodaySkeleton } from '../components/TodaySkeleton';
import { isDayEmpty, useCompleteTask, useToday, useWeek } from '../hooks';
import { TODAY_RU } from '../locale';

/**
 * «Сегодня» — the home screen.
 *
 * It answers two questions in the three seconds before the phone goes back into
 * a pocket: *did anything change* and *what is on me today*. Everything below is
 * ordered by that, not by how interesting the data is:
 *
 *   overdue → my tasks → events → urgent shopping → savings → my week → approvals
 *
 * On a phone that order **is** the visual order (a single flex column with
 * `order-*`); on a wide screen the same widgets fall into a two-column
 * composition so the page reads as a dashboard rather than a stretched phone
 * column. The column wrappers are `display: contents` on mobile precisely so
 * that both layouts share one DOM and one priority list.
 *
 * Permissions are resolved with `useCan()` and never with `role ===` (D4). The
 * server already sends `null` for a section the caller may not read; the client
 * gate is the second lock on the same door, so a backend regression cannot put
 * a rouble figure in front of a child.
 */
export default function TodayPage() {
  const { can, isReady } = useCan();
  const { data: me } = useMe();

  const canReadTasks = can('task:read');
  const canReadEvents = can('event:read');
  const canReadShopping = can('shopping:read');
  const canReadGoals = can('goal:read');
  const canApproveMembers = can('member:approve');

  const today = useToday();
  const week = useWeek(isReady && (canReadTasks || canReadEvents));
  const complete = useCompleteTask();

  const onComplete = useCallback(
    (occurrenceId: string) => {
      complete.mutate(occurrenceId);
    },
    [complete],
  );

  const data = today.data;

  // `isReady` is part of the loading state on purpose: rendering before
  // `/api/me` resolves would flash widgets that then disappear.
  if (!isReady || (today.isPending && !data)) return <TodaySkeleton />;

  if (!data) {
    return (
      <>
        <GreetingHeader displayName={me?.user.displayName} date={undefined} tasks={0} events={0} />
        <ErrorState
          error={today.error}
          title={TODAY_RU.errorTitle}
          onRetry={() => void today.refetch()}
        />
      </>
    );
  }

  const { tasks, events } = data;
  const showTasks = canReadTasks;
  const showEvents = canReadEvents;
  const goals = canReadGoals ? data.goals : null;
  const shopping = canReadShopping ? data.shopping : null;
  const fairness = canReadTasks ? data.fairness : null;
  const approvals = canApproveMembers ? data.pendingApprovals : null;

  const openTasks = showTasks ? tasks.dueToday.length + tasks.overdue.length : 0;
  const openEvents = showEvents ? events.today.length + events.tomorrow.length : 0;
  const dayIsFree = isDayEmpty(data);

  return (
    <>
      <GreetingHeader
        displayName={me?.user.displayName}
        date={data.today}
        tasks={openTasks}
        events={openEvents}
      />

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start lg:gap-6">
        {/* Primary column on desktop; on mobile these flow into the parent. */}
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          {dayIsFree ? (
            <div className="order-1 lg:order-0">
              <FreeDayCard />
            </div>
          ) : null}

          {showTasks && tasks.overdue.length > 0 ? (
            <div className="order-2 lg:order-0">
              <OverdueWidget items={tasks.overdue} onComplete={onComplete} />
            </div>
          ) : null}

          {showTasks && !dayIsFree ? (
            <div className="order-3 lg:order-0">
              <MyTasksWidget tasks={tasks} onComplete={onComplete} />
            </div>
          ) : null}

          {showEvents && !dayIsFree ? (
            <div className="order-4 lg:order-0">
              <EventsWidget events={events} />
            </div>
          ) : null}
        </div>

        {/* Aside on desktop. */}
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          {approvals && approvals.length > 0 ? (
            <div className="order-8 lg:order-0">
              <ApprovalsWidget members={approvals} />
            </div>
          ) : null}

          {shopping && shopping.urgent.length > 0 ? (
            <div className="order-5 lg:order-0">
              <ShoppingWidget shopping={shopping} />
            </div>
          ) : null}

          {goals ? (
            <div className="order-6 lg:order-0">
              <GoalWidget milestone={goals.nearestMilestone} />
            </div>
          ) : null}

          {fairness ? (
            <div className="order-7 lg:order-0">
              <LoadWidget fairness={fairness} week={week.data} />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
