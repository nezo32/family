import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Repeat, RotateCcw } from 'lucide-react';
import type { PublicUser, TaskOccurrenceResponse } from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { cn } from '@/shared/lib/utils';
import { formatTime } from '@/shared/lib/format';
import { MemberDisc, MemberTick } from '@/shared/ui/member-disc';
import { SwipeRow, type SwipeAction } from '@/shared/ui/swipe-row';
import { TASKS_RU } from '../locale';
import { taskDetailPath } from '../routes';
import { useCompleteOccurrence, useUncompleteOccurrence } from '../hooks';
import { TaskRowSheet } from './TaskRowSheet';

/**
 * One occurrence, as a **56px row** (§D2).
 *
 * ```
 *  ○ ┃  Вынести мусор                       (С)  ›
 *    ┃  08:00 · Кухня · просрочено
 * ```
 *
 * ## What this replaces
 *
 * A ~96px card with a coloured band glued across its bottom edge holding a
 * floating avatar and a «Возьму на себя» button — a strip that read as an
 * unfinished element rather than a component, and that doubled the height of
 * every row to carry information a 24px disc already carries. Nine chores came
 * to ≈1000px; they now come to ≈520px, and the whole screen fits inside the
 * 1.5-viewport budget (§C5).
 *
 * ## Three colour rules, all from §B4
 *
 * - The 3px rail is the **assignee's** colour, so scanning the left edge tells
 *   you whose day this is before you read a word.
 * - Overdue turns the rail `--destructive` and adds the **word** «просрочено»
 *   to the meta line. It does **not** tint the row's ground: four overdue
 *   chores must not be four pink boxes.
 * - The member disc replaces the green footer band. Same disc, same colour, as
 *   assignee here, attendee in the calendar and author on the wall.
 *
 * ## Gestures (§C-gestures)
 *
 * **Swipe left** for «Сделано» / «Вернули», through `SwipeRow`: left-only, a
 * 32px viewport dead zone, a 6-second undo toast. The row this replaced carried
 * a **right**-swipe, which is precisely the direction §G3 reserves for the iOS
 * system back gesture — do not bring that back.
 *
 * **Long-press** opens `TaskRowSheet`, which is where «Возьму на себя» lives
 * (§D2 took it off the row itself). Nothing in that sheet is reachable only by
 * long press: every entry in it is also a control on the detail screen, which
 * is one tap away because the whole row is a link to it (§G1).
 *
 * The swipe carries **only** the reversible action. «Удалить» and «Пропустить»
 * are not on it at any threshold — a chore skipped by a thumb in a pocket is a
 * line in the family's history that nothing undoes.
 *
 * Neither gesture changes the row's geometry: it is still 56px with a 44px
 * tick, and the tick is still the visible twin that teaches the action.
 */
export function TaskCard(props: {
  occurrence: TaskOccurrenceResponse;
  members: readonly PublicUser[];
}) {
  const { occurrence } = props;
  const { can, userId } = useCan();
  const complete = useCompleteOccurrence();
  const uncomplete = useUncompleteOccurrence();

  const isDone = occurrence.status === 'done';
  const isClosed = occurrence.status === 'skipped' || occurrence.status === 'cancelled';
  const mayComplete = can('task:complete', occurrence);
  const assignee = props.members.find((member) => member.id === occurrence.assigneeId);

  const meta = [
    formatTime(occurrence.startsAt),
    occurrence.category,
    occurrence.isOverdue && !isDone && !isClosed ? TASKS_RU.card.overdue.toLowerCase() : null,
    occurrence.status === 'skipped' ? TASKS_RU.card.skipped.toLowerCase() : null,
    occurrence.status === 'cancelled' ? TASKS_RU.card.cancelled.toLowerCase() : null,
    occurrence.pendingSwapId ? TASKS_RU.card.swapPending.toLowerCase() : null,
  ].filter((part): part is string => Boolean(part));

  const overdue = occurrence.isOverdue && !isDone && !isClosed;

  const [sheetOpen, setSheetOpen] = useState(false);

  /*
   * Exactly one action, and it is always the reversible one (§G4). A closed
   * occurrence (skipped, cancelled) and a row the viewer may not complete get
   * `null`, which turns the gesture off rather than letting it fail at the end.
   */
  const swipe: SwipeAction | null = isClosed
    ? null
    : isDone
      ? {
          label: TASKS_RU.swipe.undone,
          ariaLabel: TASKS_RU.swipe.undoneAria,
          icon: <RotateCcw />,
          tone: 'secondary',
          onCommit: () => {
            uncomplete.mutate({ occurrenceId: occurrence.id });
          },
          onUndo: () => {
            complete.mutate({ occurrenceId: occurrence.id });
          },
        }
      : mayComplete
        ? {
            label: TASKS_RU.swipe.done,
            ariaLabel: TASKS_RU.swipe.doneAria,
            icon: <Check />,
            tone: 'success',
            onCommit: () => {
              complete.mutate({ occurrenceId: occurrence.id });
            },
            onUndo: () => {
              uncomplete.mutate({ occurrenceId: occurrence.id });
            },
          }
        : null;

  return (
    /*
     * The sheet is a **sibling** of `SwipeRow`, not a child of it. A React
     * portal still bubbles its events through the React tree, so a sheet
     * rendered inside the sliding panel would send every tap in it back through
     * that panel's click-capture handler.
     *
     * It contributes no DOM node while it is closed, so the fragment is still
     * one element as far as `Section`'s `[&>*+*]` hairline is concerned.
     */
    <>
      <SwipeRow
        action={swipe}
        collapse
        onLongPress={() => {
          setSheetOpen(true);
        }}
        // `bg-inherit` on both layers: the row sits on a `Section` whose surface
        // is `--card` in an open group and `--surface-calm` in «Выполнено», and
        // the sliding layer has to be whichever of those it is standing on.
        className="bg-inherit"
        contentClassName="bg-inherit"
      >
        <div className="flex min-h-14 w-full max-w-row-measure items-center gap-3 px-4 py-1.5">
          <button
            type="button"
            aria-label={isDone ? TASKS_RU.card.uncomplete : TASKS_RU.card.completeAria}
            disabled={isClosed || (!mayComplete && !isDone)}
            onClick={() => {
              if (isDone) uncomplete.mutate({ occurrenceId: occurrence.id });
              else complete.mutate({ occurrenceId: occurrence.id });
            }}
            className={cn(
              // 44px target around a 28px ring: the row is 56px tall and the tick
              // must not out-shout a 17px title.
              'relative z-10 flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-full',
              'transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            <span
              className={cn(
                'flex size-7 items-center justify-center rounded-full border-2 transition-colors',
                isDone
                  ? 'border-transparent bg-success text-success-foreground'
                  : 'border-border text-transparent hover:border-primary hover:text-primary/50',
              )}
            >
              {isDone ? <RotateCcw className="size-4" /> : <Check className="size-4" />}
            </span>
          </button>

          <MemberTick
            seed={occurrence.assigneeId}
            tone={overdue ? 'destructive' : isDone ? 'success' : 'member'}
            className="h-9"
          />

          <Link
            to={taskDetailPath(occurrence.id)}
            // Stretched hit area: the whole row opens the detail, while the tick
            // stays on its own layer so the two taps never fight.
            className="min-w-0 flex-1 rounded-sm after:absolute after:inset-0 after:content-[''] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span
              className={cn(
                'flex items-center gap-1.5 text-[17px] leading-6 font-medium text-foreground',
                (isDone || isClosed) && 'text-muted-foreground line-through',
              )}
            >
              <span className="truncate">{occurrence.title}</span>
              {occurrence.isException ? (
                <Repeat
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-label={TASKS_RU.card.changed}
                />
              ) : null}
            </span>
            {meta.length > 0 ? (
              <span
                className={cn(
                  'block truncate text-[13px] leading-[18px] font-medium',
                  overdue ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {meta.join(' · ')}
              </span>
            ) : null}
          </Link>

          {assignee ? (
            <MemberDisc
              id={assignee.id}
              displayName={assignee.displayName}
              highlighted={assignee.id === userId}
              labelled
            />
          ) : (
            <span
              className="text-[13px] leading-[18px] font-medium text-muted-foreground"
              title={TASKS_RU.card.noAssignee}
            >
              —
            </span>
          )}

          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </div>
      </SwipeRow>

      <TaskRowSheet occurrence={occurrence} open={sheetOpen} onOpenChange={setSheetOpen} />
    </>
  );
}
