import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Repeat, RotateCcw } from 'lucide-react';
import type { PublicUser, TaskOccurrenceResponse } from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { cn } from '@/shared/lib/utils';
import { formatTime } from '@/shared/lib/format';
import { TASKS_RU } from '../locale';
import { taskDetailPath } from '../routes';
import { useClaimOccurrence, useCompleteOccurrence, useUncompleteOccurrence } from '../hooks';
import { AssigneeControl } from './AssigneeControl';

/** Distance in px past which a swipe counts as "done". */
const SWIPE_THRESHOLD = 96;

/**
 * One occurrence.
 *
 * Completion is reachable two ways because a phone in one hand and a desktop
 * with a mouse want different things: a 44 px circular target that is always
 * visible, and a right-swipe across the whole row. Both fire the same optimistic
 * mutation.
 */
export function TaskCard(props: {
  occurrence: TaskOccurrenceResponse;
  members: readonly PublicUser[];
}) {
  const { occurrence } = props;
  const { can } = useCan();
  const complete = useCompleteOccurrence();
  const uncomplete = useUncompleteOccurrence();

  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number; tracking: boolean } | null>(null);

  const isDone = occurrence.status === 'done';
  const isClosed = occurrence.status === 'skipped' || occurrence.status === 'cancelled';
  const mayComplete = can('task:complete', occurrence);
  const swipeable = !isDone && !isClosed && mayComplete;

  const fireComplete = () => {
    complete.mutate({ occurrenceId: occurrence.id });
  };

  const endSwipe = () => {
    if (offset >= SWIPE_THRESHOLD) fireComplete();
    setOffset(0);
    start.current = null;
  };

  return (
    <li className="relative overflow-hidden rounded-xl border border-border bg-card">
      {/* Revealed under the row as it slides. Purely decorative. */}
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 flex w-full items-center gap-2 bg-accent px-4 text-accent-foreground"
      >
        <Check className="size-5" />
        <span className="text-sm font-medium">{TASKS_RU.card.complete}</span>
      </div>

      <div
        className="relative flex items-start gap-3 bg-card p-3 transition-transform"
        style={{
          transform: `translateX(${String(offset)}px)`,
          touchAction: 'pan-y',
          transitionDuration: offset === 0 ? '150ms' : '0ms',
        }}
        onPointerDown={(event) => {
          if (!swipeable || event.pointerType === 'mouse') return;
          start.current = { x: event.clientX, y: event.clientY, tracking: false };
        }}
        onPointerMove={(event) => {
          const origin = start.current;
          if (!origin) return;
          const dx = event.clientX - origin.x;
          const dy = event.clientY - origin.y;
          // Let the page scroll win until the gesture is unambiguously sideways.
          if (!origin.tracking) {
            if (Math.abs(dx) < 12 || Math.abs(dx) <= Math.abs(dy)) return;
            origin.tracking = true;
          }
          setOffset(Math.max(0, Math.min(dx, SWIPE_THRESHOLD * 1.5)));
        }}
        onPointerUp={endSwipe}
        onPointerCancel={endSwipe}
      >
        <button
          type="button"
          aria-label={isDone ? TASKS_RU.card.uncomplete : TASKS_RU.card.completeAria}
          disabled={isClosed || (!mayComplete && !isDone)}
          onClick={() => {
            if (isDone) uncomplete.mutate({ occurrenceId: occurrence.id });
            else fireComplete();
          }}
          className={cn(
            'mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            'disabled:pointer-events-none disabled:opacity-40',
            isDone
              ? 'border-transparent bg-accent text-accent-foreground'
              : 'border-border text-muted-foreground hover:border-primary hover:text-primary',
          )}
        >
          {isDone ? <RotateCcw className="size-5" /> : <Check className="size-5" />}
        </button>

        <Link
          to={taskDetailPath(occurrence.id)}
          className="min-w-0 flex-1 rounded-lg focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="flex items-start justify-between gap-2">
            <span
              className={cn(
                'text-base font-medium text-balance text-foreground',
                (isDone || isClosed) && 'text-muted-foreground line-through',
              )}
            >
              {occurrence.title}
            </span>
            <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground/60" aria-hidden />
          </span>

          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{formatTime(occurrence.startsAt)}</span>
            {occurrence.category ? <span>{occurrence.category}</span> : null}
          </span>

          <span className="mt-2 flex flex-wrap items-center gap-2">
            {occurrence.isOverdue ? (
              <Badge variant="destructive">{TASKS_RU.card.overdue}</Badge>
            ) : null}
            {occurrence.status === 'skipped' ? (
              <Badge variant="secondary">{TASKS_RU.card.skipped}</Badge>
            ) : null}
            {occurrence.status === 'cancelled' ? (
              <Badge variant="secondary">{TASKS_RU.card.cancelled}</Badge>
            ) : null}
            {occurrence.isException ? (
              <Badge variant="outline">
                <Repeat className="size-3" aria-hidden />
                {TASKS_RU.card.changed}
              </Badge>
            ) : null}
            {occurrence.pendingSwapId ? (
              <Badge variant="outline">{TASKS_RU.card.swapPending}</Badge>
            ) : null}
          </span>
        </Link>

        <div className="hidden shrink-0 sm:block">
          <AssigneeControl occurrence={occurrence} members={props.members} compact />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2 sm:hidden">
        <AssigneeControl occurrence={occurrence} members={props.members} compact />
        {!isDone && !isClosed && occurrence.assigneeId === null && can('task:complete') ? (
          <ClaimButton occurrenceId={occurrence.id} />
        ) : null}
      </div>
    </li>
  );
}

function ClaimButton(props: { occurrenceId: string }) {
  const claim = useClaimOccurrence();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="min-h-9"
      disabled={claim.isPending}
      onClick={() => {
        claim.mutate({ occurrenceId: props.occurrenceId });
      }}
    >
      {TASKS_RU.card.claim}
    </Button>
  );
}
