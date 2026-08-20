import { Check } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { MemberTick } from '@/shared/ui/member-disc';
import { TODAY_RU } from '../locale';
import type { DashboardTask } from '../types';

/**
 * One chore, as a 56px row (§D1).
 *
 * ```
 *  ○ ┃  Разобрать посудомойку
 *    ┃  до 10:00 · Кухня
 * ```
 *
 * The tick is a 44px round target on the leading edge — the thumb lands there
 * without looking, which is the whole point of a home screen. When the user may
 * not complete this row (no `task:complete` scope for it) the control degrades
 * to a static dot rather than a disabled button: a greyed-out button invites a
 * tap and then refuses it.
 *
 * The 3px tick beside it is the assignee's colour (§B4). On an overdue row it
 * is `--destructive` and the meta line **also says «просрочено»** — colour is
 * never the only signal, and four overdue chores must not become four pink
 * boxes (§B4): the rail is tinted, the row's ground is not.
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
  /** «Саша» — who it is on, when that is not obviously the reader. */
  assigneeName?: string | undefined;
}) {
  const { task } = props;

  const meta = [
    props.overdue ? overdueLabel(task.dueTime) : dueLabel(task.dueTime),
    props.assigneeName,
    task.category,
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="block">
      <div className="flex min-h-14 w-full max-w-row-measure items-center gap-3 px-4 py-1.5">
        {props.canComplete ? (
          <button
            type="button"
            onClick={() => {
              props.onComplete(task.id);
            }}
            aria-label={`${TODAY_RU.complete}: ${task.title}`}
            className={cn(
              // 44px target, 28px ring: §F1 wants the target, §D2 wants a tick
              // that does not dominate a 17px title.
              'flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-full',
              'text-transparent transition-colors',
              'hover:text-primary/50 active:bg-muted',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            )}
          >
            <span className="flex size-7 items-center justify-center rounded-full border-2 border-border">
              <Check className="size-4" aria-hidden />
            </span>
          </button>
        ) : (
          <span aria-hidden className="flex size-11 shrink-0 items-center justify-center">
            <span className="size-2.5 rounded-full bg-muted-foreground/30" />
          </span>
        )}

        <MemberTick
          seed={task.assigneeId}
          tone={props.overdue ? 'destructive' : 'member'}
          className="h-9 self-center"
        />

        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] leading-6 font-medium text-foreground">{task.title}</p>
          {meta.length > 0 ? (
            <p
              className={cn(
                'truncate text-[13px] leading-[18px] font-medium',
                props.overdue ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {meta.join(' · ')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function dueLabel(dueTime: string | null): string {
  return dueTime ? `${TODAY_RU.dueAt} ${dueTime}` : TODAY_RU.dueAnyTime;
}

/**
 * «срок был в 08:00» — a fact, not an accusation. Without a time on the task
 * the bare word is all there is to say, and it is enough.
 */
function overdueLabel(dueTime: string | null): string {
  return dueTime ? `${TODAY_RU.overdueDue} ${dueTime}` : TODAY_RU.overdueLongAgo;
}
