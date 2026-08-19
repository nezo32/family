import { Check } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { formatDuration } from '@/shared/lib/format';
import { TODAY_RU, pointCount } from '../locale';
import type { DashboardTask } from '../types';

/**
 * A single chore, with the one-tap completion control.
 *
 * The tick is a 44 px round button on the leading edge — the thumb lands there
 * without looking, which is the whole point of a home screen. When the user may
 * not complete this row (no `task:complete` scope for it) the control degrades
 * to a static dot rather than a disabled button: a greyed-out button invites a
 * tap and then refuses it.
 *
 * `dueTime` arrives as a local `HH:mm` string already resolved in the payload's
 * timezone, so there is nothing to reformat and no chance of the row showing
 * the device's clock instead of the family's (D2).
 */
export function TaskRow(props: {
  task: DashboardTask;
  /** `can('task:complete', task)`, resolved by the parent. */
  canComplete: boolean;
  onComplete: (occurrenceId: string) => void;
  /** Overdue rows lead with how late they are instead of the due time. */
  overdue?: boolean;
}) {
  const { task } = props;

  const when = props.overdue ? overdueLabel(task.overdueByMinutes) : dueLabel(task.dueTime);

  return (
    <li className="flex items-center gap-3 py-1">
      {props.canComplete ? (
        <button
          type="button"
          onClick={() => {
            props.onComplete(task.id);
          }}
          aria-label={`${TODAY_RU.complete}: ${task.title}`}
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-border text-transparent transition-colors',
            'hover:border-primary hover:text-primary/40 active:bg-accent',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          <Check className="size-5" aria-hidden />
        </button>
      ) : (
        <span aria-hidden className="flex size-11 shrink-0 items-center justify-center">
          <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{task.title}</p>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className={cn(props.overdue && 'text-destructive')}>{when}</span>
          {task.points > 0 ? <span>· {pointCount(task.points)}</span> : null}
        </p>
      </div>
    </li>
  );
}

function dueLabel(dueTime: string | null): string {
  return dueTime ? `${TODAY_RU.dueAt} ${dueTime}` : TODAY_RU.dueAnyTime;
}

/**
 * "Просрочено на 2 ч 30 мин" — a fact, not an accusation. Past a day the exact
 * minute count stops being useful and starts being a scolding, so it collapses
 * to the bare word.
 */
function overdueLabel(minutes: number): string {
  if (minutes <= 0) return TODAY_RU.overdueLongAgo;
  if (minutes >= 60 * 24) return TODAY_RU.overdueLongAgo;
  return `${TODAY_RU.overdueBy} ${formatDuration(minutes)}`;
}
