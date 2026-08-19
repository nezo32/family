import { useState } from 'react';
import { Check, Flag, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { GoalResponse, MilestoneResponse } from '@family/shared';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { formatDateLong, formatMoney } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { GOALS_RU } from '../locale';
import { remainingAmount } from '../money';
import { useDeleteMilestone } from '../hooks';
import { MilestoneDialog } from './MilestoneDialog';

/**
 * Milestone timeline.
 *
 * Reached checkpoints are celebrated rather than ticked off in grey: filled
 * marker, the goal-positive sage colour and the date it happened. The ones
 * ahead show what is still missing, because "осталось 12 000 ₽ до следующего
 * этапа" is a far better prompt than "0 / 5".
 *
 * A milestone counts as reached when the service stamped `reachedAt`; the
 * balance comparison is only a fallback for a goal whose crossing edge has not
 * been processed yet.
 */
export function MilestoneTimeline(props: {
  goal: GoalResponse;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState<MilestoneResponse | undefined>(undefined);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MilestoneResponse | null>(null);
  const remove = useDeleteMilestone(props.goal.id);

  const milestones = [...props.goal.milestones].sort(
    (a, b) => a.targetAmount - b.targetAmount || a.sortOrder - b.sortOrder,
  );

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{GOALS_RU.milestones}</h2>
          <p className="text-sm text-muted-foreground">{GOALS_RU.milestonesDescription}</p>
        </div>
        {props.canManage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 gap-1.5"
            onClick={openCreate}
          >
            <Plus className="size-4" aria-hidden />
            {GOALS_RU.addMilestone}
          </Button>
        ) : null}
      </header>

      {milestones.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          {props.canManage ? GOALS_RU.milestonesEmptyDescription : GOALS_RU.milestonesEmpty}
        </p>
      ) : (
        <ol className="relative space-y-4 pl-8">
          {/* The rail the markers sit on. */}
          <span
            aria-hidden
            className="absolute top-2 bottom-2 left-3 w-px bg-border"
          />
          {milestones.map((milestone) => {
            const reached =
              milestone.reachedAt !== null || props.goal.currentAmount >= milestone.targetAmount;
            const left = remainingAmount(props.goal.currentAmount, milestone.targetAmount);

            return (
              <li key={milestone.id} className="relative">
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-1 -left-8 flex size-6 items-center justify-center rounded-full border-2',
                    reached
                      ? 'border-success bg-success text-success-foreground'
                      : 'border-border bg-background text-muted-foreground',
                  )}
                >
                  {reached ? <Check className="size-3.5" /> : <Flag className="size-3" />}
                </span>

                <div
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border p-3',
                    reached && 'border-success/40 bg-success/5',
                  )}
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 font-medium">
                      {milestone.title}
                      {reached ? (
                        <Sparkles className="size-3.5 text-success" aria-hidden />
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <span className="tabular-nums">{formatMoney(milestone.targetAmount)}</span>
                      {reached ? (
                        <span className="ml-2 font-medium text-success">
                          {GOALS_RU.milestoneReached}
                          {milestone.reachedAt ? ` · ${formatDateLong(milestone.reachedAt)}` : ''}
                        </span>
                      ) : (
                        <span className="ml-2">
                          {GOALS_RU.remaining}:{' '}
                          <span className="tabular-nums">{formatMoney(left)}</span>
                        </span>
                      )}
                    </p>
                  </div>

                  {props.canManage ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-11"
                        aria-label={GOALS_RU.editMilestone}
                        onClick={() => {
                          setEditing(milestone);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="size-4" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-11 text-muted-foreground hover:text-destructive"
                        aria-label={GOALS_RU.milestoneDeleteTitle}
                        onClick={() => {
                          setPendingDelete(milestone);
                        }}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {props.canManage ? (
        <>
          <MilestoneDialog
            goalId={props.goal.id}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            milestone={editing}
          />
          <ConfirmDialog
            open={pendingDelete !== null}
            onOpenChange={(open) => {
              if (!open) setPendingDelete(null);
            }}
            title={GOALS_RU.milestoneDeleteTitle}
            description={GOALS_RU.milestoneDeleteDescription}
            onConfirm={() => {
              if (pendingDelete) remove.mutate(pendingDelete.id);
            }}
          />
        </>
      ) : null}
    </section>
  );
}
