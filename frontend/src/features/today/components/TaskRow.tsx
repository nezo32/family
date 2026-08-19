import { Check } from 'lucide-react';
import type { TaskOccurrenceResponse } from '@family/shared';
import { cn } from '@/shared/lib/utils';
import { formatTime } from '@/shared/lib/format';
import { dayLabel } from '@/shared/lib/i18n';
import { TODAY_RU, pointCount } from '../locale';

/**
 * A single chore, with the one-tap completion control.
 *
 * The tick is a 44 px round button on the leading edge — the thumb lands there
 * without looking, which is the whole point of a home screen. When the user may
 * not complete this row (no `task:complete` scope for it) the control degrades
 * to a static dot rather than a disabled button: a greyed-out button invites a
 * tap and then refuses it.
 */
export function TaskRow(props: {
  occurrence: TaskOccurrenceResponse;
  /** `useCan('task:complete', occurrence)`, resolved by the parent. */
  canComplete: boolean;
  onComplete: (occurrenceId: string) => void;
  /** Overdue rows lead with the day they were due instead of the time. */
  overdue?: boolean;
}) {
  const { occurrence } = props;
  const isDone = occurrence.status === 'done';

  const when = props.overdue
    ? `${dayLabel(occurrence.dueAt)}, ${formatTime(occurrence.dueAt)}`
    : `${TODAY_RU.dueAt} ${formatTime(occurrence.dueAt)}`;

  return (
    <li className="flex items-center gap-3 py-1">
      {props.canComplete ? (
        <button
          type="button"
          onClick={() => {
            props.onComplete(occurrence.id);
          }}
          disabled={isDone}
          aria-pressed={isDone}
          aria-label={isDone ? TODAY_RU.completed : `${TODAY_RU.complete}: ${occurrence.title}`}
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            isDone
              ? 'border-transparent bg-success text-success-foreground'
              : 'border-border text-transparent active:bg-accent hover:border-primary hover:text-primary/40',
          )}
        >
          <Check className="size-5" aria-hidden />
        </button>
      ) : (
        <span
          aria-hidden
          className={cn(
            'flex size-11 shrink-0 items-center justify-center',
            isDone && 'text-success',
          )}
        >
          <span
            className={cn(
              'size-2.5 rounded-full',
              isDone ? 'bg-success' : 'bg-muted-foreground/30',
            )}
          />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-sm font-medium text-foreground',
            isDone && 'text-muted-foreground line-through',
          )}
        >
          {occurrence.title}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className={cn(props.overdue && !isDone && 'text-destructive')}>{when}</span>
          {occurrence.points > 0 ? <span>· {pointCount(occurrence.points)}</span> : null}
        </p>
      </div>
    </li>
  );
}
