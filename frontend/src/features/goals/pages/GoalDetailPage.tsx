import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowDownLeft,
  ArrowLeft,
  CalendarDays,
  PartyPopper,
  Pencil,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { ErrorState } from '@/shared/components/ErrorState';
import { PageHeader } from '@/shared/components/PageHeader';
import { formatDateLong, formatMoney } from '@/shared/lib/format';
import { displayEmoji } from '@/shared/lib/emoji';
import { COMMON } from '@/shared/lib/i18n';
import { ROUTES } from '@/shared/lib/routes';
import { cn } from '@/shared/lib/utils';
import { GOALS_RU, GOAL_STATUS_RU, daysLeftLabel } from '../locale';
import { goalProgressPercent, remainingAmount } from '../money';
import { daysUntil } from '../dates';
import { useDeleteGoal, useGoal, useGoalAbilities, useGoalTransactions, useRoster } from '../hooks';
import { ContributeDialog, type LedgerMode } from '../components/ContributeDialog';
import { ContributionChart } from '../components/ContributionChart';
import { ContributionHistory } from '../components/ContributionHistory';
import { ContributorBreakdown } from '../components/ContributorAvatars';
import { GoalFormDialog } from '../components/GoalFormDialog';
import { MilestoneTimeline } from '../components/MilestoneTimeline';
import { ProgressRing } from '../components/ProgressRing';

/**
 * One goal in full: progress, milestones, the whole ledger and the curve it
 * draws.
 *
 * Route: `/goals/:goalId` — registered as a child of `/goals` in
 * `app/router.tsx`, which this feature does not own.
 *
 * Every write affordance is behind `useGoalAbilities()`, so a teen (read-only,
 * D4) sees the same story with no buttons on it.
 */
export default function GoalDetailPage() {
  const params = useParams<{ goalId: string }>();
  const goalId = params.goalId;
  const navigate = useNavigate();

  const abilities = useGoalAbilities();
  const { byId: roster } = useRoster();
  const { data: goal, isPending, isError, error, refetch } = useGoal(goalId);
  const transactions = useGoalTransactions(goalId);

  const [ledgerMode, setLedgerMode] = useState<LedgerMode | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const removeGoal = useDeleteGoal(goalId ?? '');

  if (isPending) return <GoalDetailSkeleton />;

  if (isError) {
    return (
      <ErrorState
        error={error}
        title={GOALS_RU.notFound}
        description={GOALS_RU.notFoundDescription}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  const percent = goalProgressPercent(goal.currentAmount, goal.targetAmount);
  const remaining = remainingAmount(goal.currentAmount, goal.targetAmount);
  const reached = goal.status === 'reached' || goal.currentAmount >= goal.targetAmount;
  const days = daysUntil(goal.deadline);
  const accent = goal.color ?? 'var(--primary)';
  const goalEmoji = displayEmoji(goal.icon);
  const rows = transactions.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader
        eyebrow={
          <Link
            to={ROUTES.goals}
            className="inline-flex min-h-11 items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {GOALS_RU.backToGoals}
          </Link>
        }
        title={
          <span className="flex items-center gap-2">
            {goalEmoji ? <span aria-hidden>{goalEmoji}</span> : null}
            {goal.title}
          </span>
        }
        description={goal.description}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {abilities.canManage ? (
              <Button
                variant="outline"
                className="h-11 gap-1.5"
                onClick={() => {
                  setEditOpen(true);
                }}
              >
                <Pencil className="size-4" aria-hidden />
                {COMMON.edit}
              </Button>
            ) : null}
            {abilities.canDelete ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-11 text-muted-foreground hover:text-destructive"
                aria-label={GOALS_RU.deleteGoal}
                onClick={() => {
                  setDeleteOpen(true);
                }}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-5 pb-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          {/* ---- hero ------------------------------------------------- */}
          <Card className="overflow-hidden">
            <CardContent className="flex flex-col items-center gap-5 pt-6 text-center sm:flex-row sm:text-left">
              <ProgressRing
                percent={percent}
                size={140}
                thickness={12}
                color={accent}
                caption={reached ? GOALS_RU.statusReached : GOALS_RU.progressLabel}
              />
              <div className="min-w-0 flex-1 space-y-3">
                <p className="flex flex-wrap items-baseline justify-center gap-x-2 sm:justify-start">
                  <span
                    className="text-3xl font-semibold tabular-nums"
                    style={{ color: accent }}
                    data-testid="goal-current-amount"
                  >
                    {formatMoney(goal.currentAmount)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {GOALS_RU.of} {formatMoney(goal.targetAmount)}
                  </span>
                </p>

                <p className="text-sm text-muted-foreground">
                  {reached ? (
                    GOALS_RU.remainingDone
                  ) : (
                    <>
                      {GOALS_RU.remaining}:{' '}
                      <span className="font-medium tabular-nums text-foreground">
                        {formatMoney(remaining)}
                      </span>
                    </>
                  )}
                </p>

                <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                  <Badge variant="secondary" className="gap-1 font-normal">
                    <Users className="size-3" aria-hidden />
                    {goal.ownerId === null ? GOALS_RU.sharedGoal : GOALS_RU.personalGoal}
                  </Badge>
                  {goal.visibility === 'private' ? (
                    <Badge variant="outline" className="font-normal">
                      {GOALS_RU.privateGoal}
                    </Badge>
                  ) : null}
                  <Badge variant="outline" className="font-normal">
                    {GOAL_STATUS_RU[goal.status]}
                  </Badge>
                  <Badge variant="outline" className="gap-1 font-normal">
                    <CalendarDays className="size-3" aria-hidden />
                    {goal.deadline
                      ? `${formatDateLong(`${goal.deadline}T00:00:00.000Z`)}${
                          days === null ? '' : ` · ${daysLeftLabel(days)}`
                        }`
                      : GOALS_RU.noDeadline}
                  </Badge>
                </div>

                {abilities.canContribute ? (
                  <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                    <Button
                      className="h-11 flex-1 gap-1.5 sm:flex-none"
                      onClick={() => {
                        setLedgerMode('contribute');
                      }}
                    >
                      <Plus className="size-4" aria-hidden />
                      {GOALS_RU.contribute}
                    </Button>
                    <Button
                      variant="outline"
                      className="h-11 flex-1 gap-1.5 sm:flex-none"
                      onClick={() => {
                        setLedgerMode('withdraw');
                      }}
                    >
                      <ArrowDownLeft className="size-4" aria-hidden />
                      {GOALS_RU.withdraw}
                    </Button>
                  </div>
                ) : null}
              </div>
            </CardContent>

            {reached ? (
              <div
                className={cn(
                  'flex items-center gap-3 border-t border-success/30 bg-success/10 px-6 py-4',
                )}
              >
                <PartyPopper className="size-5 shrink-0 text-success" aria-hidden />
                <div>
                  <p className="font-medium text-success">{GOALS_RU.reachedBanner}</p>
                  <p className="text-sm text-muted-foreground">
                    {GOALS_RU.reachedBannerDescription}
                  </p>
                </div>
              </div>
            ) : null}
          </Card>

          {/* ---- milestones -------------------------------------------- */}
          <Card>
            <CardContent className="pt-6">
              <MilestoneTimeline goal={goal} canManage={abilities.canManage} />
            </CardContent>
          </Card>

          {/* ---- chart -------------------------------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{GOALS_RU.chartTitle}</CardTitle>
            </CardHeader>
            <CardContent>
              {transactions.isPending ? (
                <Skeleton className="h-48 w-full" />
              ) : (
                <ContributionChart goal={goal} transactions={rows} />
              )}
            </CardContent>
          </Card>
        </div>

        {/* ---- side column --------------------------------------------- */}
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{GOALS_RU.contributors}</CardTitle>
            </CardHeader>
            <CardContent>
              <ContributorBreakdown
                contributors={goal.contributors}
                roster={roster}
                currentUserId={abilities.userId}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{GOALS_RU.history}</CardTitle>
            </CardHeader>
            <CardContent>
              <ContributionHistory
                transactions={rows}
                roster={roster}
                currentUserId={abilities.userId}
                isLoading={transactions.isPending}
                hasMore={transactions.hasNextPage}
                isLoadingMore={transactions.isFetchingNextPage}
                onLoadMore={() => {
                  void transactions.fetchNextPage();
                }}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      {abilities.canContribute && ledgerMode !== null ? (
        <ContributeDialog
          goal={goal}
          mode={ledgerMode}
          open
          onOpenChange={(open) => {
            if (!open) setLedgerMode(null);
          }}
        />
      ) : null}

      {abilities.canManage ? (
        <GoalFormDialog open={editOpen} onOpenChange={setEditOpen} goal={goal} />
      ) : null}

      {abilities.canDelete ? (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={GOALS_RU.deleteGoalTitle}
          description={GOALS_RU.deleteGoalDescription}
          confirmLabel={COMMON.delete}
          onConfirm={() => {
            removeGoal.mutate(undefined, {
              onSuccess: () => {
                void navigate(ROUTES.goals, { replace: true });
              },
            });
          }}
        />
      ) : null}
    </>
  );
}

function GoalDetailSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-56 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}
