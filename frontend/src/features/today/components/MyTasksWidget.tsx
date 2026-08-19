import { ListTodo, PartyPopper } from 'lucide-react';
import { useCan } from '@/shared/auth/use-can';
import { ROUTES } from '@/shared/lib/routes';
import { TODAY_RU, choreCount, taskCount } from '../locale';
import type { TodayTasksSection } from '../types';
import { TaskRow } from './TaskRow';
import { WidgetCard } from './WidgetCard';

/**
 * My chores for today, plus the ones nobody has claimed.
 *
 * The unassigned block sits inside this card rather than in its own: "что на
 * мне" and "что свободно" are one decision, and a second card would push the
 * calendar below the fold on a phone.
 */
export function MyTasksWidget(props: {
  tasks: TodayTasksSection;
  onComplete: (occurrenceId: string) => void;
}) {
  const { can } = useCan();
  const { tasks } = props;
  const open = tasks.mine.filter((occurrence) => occurrence.status !== 'done');
  const allDone = tasks.mine.length > 0 && open.length === 0;

  return (
    <WidgetCard
      title={TODAY_RU.tasksTitle}
      icon={ListTodo}
      meta={open.length > 0 ? taskCount(open.length) : undefined}
      linkTo={ROUTES.tasks}
      linkLabel={TODAY_RU.tasksAll}
    >
      {tasks.mine.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{TODAY_RU.tasksFree}</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {tasks.mine.map((occurrence) => (
            <TaskRow
              key={occurrence.id}
              occurrence={occurrence}
              canComplete={can('task:complete', occurrence)}
              onComplete={props.onComplete}
            />
          ))}
        </ul>
      )}

      {allDone ? (
        <div className="flex items-center gap-2 pt-3">
          <PartyPopper className="size-4 shrink-0 text-success" aria-hidden />
          <p className="text-sm font-medium text-success">
            {TODAY_RU.tasksAllDone}{' '}
            <span className="font-normal text-muted-foreground">{TODAY_RU.tasksAllDoneHint}</span>
          </p>
        </div>
      ) : null}

      {tasks.unassigned.length > 0 ? (
        <div className="mt-3 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-muted-foreground">
            {TODAY_RU.tasksUnassignedTitle} · {TODAY_RU.tasksUnassignedHint}
          </p>
          <ul className="divide-y divide-border/60">
            {tasks.unassigned.slice(0, 3).map((occurrence) => (
              <TaskRow
                key={occurrence.id}
                occurrence={occurrence}
                canComplete={can('task:complete', occurrence)}
                onComplete={props.onComplete}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {tasks.familyDoneToday > 0 ? (
        <p className="pt-3 text-xs text-muted-foreground">
          {TODAY_RU.tasksFamilyDone} {choreCount(tasks.familyDoneToday)}.
        </p>
      ) : null}
    </WidgetCard>
  );
}
