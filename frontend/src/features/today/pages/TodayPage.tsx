import { useCallback } from 'react';
import { ErrorState } from '@/shared/components/ErrorState';
import { SideColumn } from '@/app/layout/SideColumn';
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
 * On a phone that order **is** the visual order; on a wide screen the last four
 * move into the shell's side column (§C4) and the first four keep the main one.
 * The split is the same DOM either way — `SideColumn` portals into `AppShell`'s
 * `<aside>`, which below 1088px is simply the next row of a one-column grid, so
 * the phone reads the priority list top to bottom without a single `order-*`.
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

      <div className="flex flex-col gap-4">
        {dayIsFree ? <FreeDayCard /> : null}

        {showTasks && tasks.overdue.length > 0 ? (
          <OverdueWidget items={tasks.overdue} onComplete={onComplete} />
        ) : null}

        {showTasks && !dayIsFree ? <MyTasksWidget tasks={tasks} onComplete={onComplete} /> : null}

        {showEvents && !dayIsFree ? <EventsWidget events={events} /> : null}
      </div>

      {/*
        §C4 for Сегодня. The order here is the phone order — urgent shopping,
        the savings milestone, the week's split, then approvals — because below
        1088px this column is appended to the one above it verbatim.
      */}
      <SideColumn>
        <div className="flex flex-col gap-4 min-[1088px]:gap-6">
          {shopping && shopping.urgent.length > 0 ? <ShoppingWidget shopping={shopping} /> : null}

          {goals ? <GoalWidget milestone={goals.nearestMilestone} /> : null}

          {fairness ? <LoadWidget fairness={fairness} week={week.data} /> : null}

          {approvals && approvals.length > 0 ? <ApprovalsWidget members={approvals} /> : null}
        </div>
      </SideColumn>
    </>
  );
}
