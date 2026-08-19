import { useCallback, useMemo } from 'react';
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
import type { DashboardTodayResponse } from '../types';

/**
 * «Сегодня» — the home screen.
 *
 * It answers two questions in the three seconds before the phone goes back in a
 * pocket: *did anything change* and *what is on me today*. Everything below is
 * ordered by that, not by how interesting the data is:
 *
 *   overdue → my tasks → events → urgent shopping → savings → my week → approvals
 *
 * On a phone that order **is** the DOM order (a single flex column with
 * `order-*`); on a wide screen the same widgets fall into a two-column
 * composition so the page reads as a dashboard rather than a stretched phone
 * column. The column wrappers are `display: contents` on mobile precisely so
 * the two layouts share one DOM and one priority list.
 *
 * Permissions are resolved with `useCan()` and never with `role ===` (D4). A
 * child holds no `goal:*` permission, so the finance widget does not exist for
 * them — client-side here, and `null` from the server as well.
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
  const week = useWeek(isReady && canReadTasks);
  const complete = useCompleteTask();

  const onComplete = useCallback(
    (occurrenceId: string) => {
      complete.mutate(occurrenceId);
    },
    [complete],
  );

  /**
   * The payload with everything the caller may not read stripped out. Doing it
   * once here means no widget has to remember its own gate, and the emptiness
   * check below sees exactly what the user sees.
   */
  const visible = useMemo<DashboardTodayResponse | undefined>(() => {
    const data = today.data;
    if (!data) return undefined;
    return {
      ...data,
      tasks: canReadTasks ? data.tasks : null,
      events: canReadEvents ? data.events : null,
      shopping: canReadShopping ? data.shopping : null,
      goal: canReadGoals ? data.goal : null,
      approvals: canApproveMembers ? data.approvals : null,
    };
  }, [today.data, canReadTasks, canReadEvents, canReadShopping, canReadGoals, canApproveMembers]);

  // `isReady` is part of the loading state on purpose: rendering the screen
  // before `/api/me` resolves would flash widgets that then disappear.
  if (!isReady || (today.isPending && !visible)) return <TodaySkeleton />;

  if (today.isError && !visible) {
    return (
      <>
        <GreetingHeader
          displayName={me?.displayName}
          date={undefined}
          taskCount={0}
          eventCount={0}
        />
        <ErrorState
          error={today.error}
          title={TODAY_RU.errorTitle}
          onRetry={() => void today.refetch()}
        />
      </>
    );
  }

  if (!visible) return <TodaySkeleton />;

  const tasks = visible.tasks;
  const events = visible.events;
  const openTaskCount = tasks
    ? tasks.mine.filter((occurrence) => occurrence.status !== 'done').length +
      tasks.overdue.filter((occurrence) => occurrence.status !== 'done').length
    : 0;
  const eventTotal = events ? events.today.length + events.tomorrow.length : 0;
  const dayIsFree = isDayEmpty(visible);

  return (
    <>
      <GreetingHeader
        displayName={me?.displayName}
        date={visible.date}
        taskCount={openTaskCount}
        eventCount={eventTotal}
      />

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start lg:gap-6">
        {/* Primary column on desktop; on mobile these flow into the parent. */}
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          {dayIsFree ? (
            <div className="order-1 lg:order-0">
              <FreeDayCard />
            </div>
          ) : null}

          {tasks && tasks.overdue.length > 0 ? (
            <div className="order-2 lg:order-0">
              <OverdueWidget items={tasks.overdue} onComplete={onComplete} />
            </div>
          ) : null}

          {tasks && !dayIsFree ? (
            <div className="order-3 lg:order-0">
              <MyTasksWidget tasks={tasks} onComplete={onComplete} />
            </div>
          ) : null}

          {events && !dayIsFree ? (
            <div className="order-4 lg:order-0">
              <EventsWidget events={events} />
            </div>
          ) : null}
        </div>

        {/* Aside on desktop. */}
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          {visible.approvals && visible.approvals.pendingCount > 0 ? (
            <div className="order-8 lg:order-0">
              <ApprovalsWidget approvals={visible.approvals} />
            </div>
          ) : null}

          {visible.shopping && visible.shopping.urgent.length > 0 ? (
            <div className="order-5 lg:order-0">
              <ShoppingWidget shopping={visible.shopping} />
            </div>
          ) : null}

          {visible.goal ? (
            <div className="order-6 lg:order-0">
              <GoalWidget goal={visible.goal} />
            </div>
          ) : null}

          {canReadTasks && week.data ? (
            <div className="order-7 lg:order-0">
              <LoadWidget week={week.data} />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
