import { ListTodo, PartyPopper } from 'lucide-react';
import { useCan } from '@/shared/auth/use-can';
import { ROUTES } from '@/shared/lib/routes';
import { TODAY_RU, choreCount, taskCount } from '../locale';
import type { DashboardTasks } from '../types';
import { TaskRow } from './TaskRow';
import { WidgetCard } from './WidgetCard';

/**
 * What is on me today.
 *
 * Overdue work has its own card above this one, so this list stays exactly what
 * its title promises — today's open chores — and never mixes in yesterday's.
 */
export function MyTasksWidget(props: {
  tasks: DashboardTasks;
  onComplete: (occurrenceId: string) => void;
}) {
  const { can } = useCan();
  const { tasks } = props;

  return (
    <WidgetCard
      title={TODAY_RU.tasksTitle}
      icon={ListTodo}
      meta={tasks.dueToday.length > 0 ? taskCount(tasks.dueToday.length) : undefined}
      linkTo={ROUTES.tasks}
      linkLabel={TODAY_RU.tasksAll}
    >
      {tasks.dueToday.length === 0 ? (
        <div className="flex items-start gap-2 py-1">
          {tasks.doneTodayCount > 0 ? (
            <PartyPopper className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          ) : null}
          <p className="text-sm text-muted-foreground">
            {tasks.doneTodayCount > 0 ? (
              <>
                <span className="font-medium text-success">{TODAY_RU.tasksAllDone}</span>{' '}
                {TODAY_RU.tasksAllDoneHint}
              </>
            ) : (
              TODAY_RU.tasksFree
            )}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {tasks.dueToday.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              canComplete={can('task:complete', task)}
              onComplete={props.onComplete}
            />
          ))}
        </ul>
      )}

      {tasks.doneTodayCount > 0 ? (
        <p className="pt-3 text-xs text-muted-foreground">
          {TODAY_RU.tasksDoneToday} {choreCount(tasks.doneTodayCount)}.
        </p>
      ) : null}
    </WidgetCard>
  );
}
