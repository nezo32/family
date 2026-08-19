import { useState } from 'react';
import { Archive, PiggyBank, Plus } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/shared/ui/tabs';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { PageHeader } from '@/shared/components/PageHeader';
import { formatMoney } from '@/shared/lib/format';
import { GOALS_RU } from '../locale';
import type { GoalScope } from '../api';
import { useGoalAbilities, useGoals, useRoster } from '../hooks';
import { GoalCard } from '../components/GoalCard';
import { GoalFormDialog } from '../components/GoalFormDialog';

/**
 * «Копилки» — the goal grid.
 *
 * Access is decided entirely by `useCan()` (D4): a child holds no `goal:*`
 * permission and never reaches this route, a teen holds `goal:read` only and so
 * sees every card with no write affordance at all, and an adult gets the create
 * and contribute buttons. Nothing here branches on `role`.
 */
export default function GoalsPage() {
  const [scope, setScope] = useState<GoalScope>('all');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const abilities = useGoalAbilities();
  const { byId: roster } = useRoster();
  const { data, isPending, isError, error, refetch } = useGoals({ scope, includeArchived });

  const goals = data?.items ?? [];
  const totalSaved = goals.reduce((sum, goal) => sum + goal.currentAmount, 0);
  const reachedCount = goals.filter((goal) => goal.status === 'reached').length;
  const activeCount = goals.filter((goal) => goal.status === 'active').length;

  return (
    <>
      <PageHeader
        title={GOALS_RU.title}
        description={GOALS_RU.subtitle}
        actions={
          abilities.canCreate ? (
            <Button
              className="h-11 gap-1.5"
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              <Plus className="size-4" aria-hidden />
              {GOALS_RU.createGoal}
            </Button>
          ) : null
        }
      />

      {/* Summary strip: the family's combined progress, before any single goal. */}
      {goals.length > 0 ? (
        <dl className="mb-5 grid grid-cols-3 gap-3 rounded-2xl border bg-card p-4">
          <div className="min-w-0">
            <dt className="truncate text-xs text-muted-foreground">{GOALS_RU.summarySaved}</dt>
            <dd className="truncate text-lg font-semibold tabular-nums text-primary">
              {formatMoney(totalSaved)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="truncate text-xs text-muted-foreground">{GOALS_RU.summaryGoals}</dt>
            <dd className="text-lg font-semibold tabular-nums">{activeCount}</dd>
          </div>
          <div className="min-w-0">
            <dt className="truncate text-xs text-muted-foreground">{GOALS_RU.summaryReached}</dt>
            <dd className="text-lg font-semibold tabular-nums text-success">{reachedCount}</dd>
          </div>
        </dl>
      ) : null}

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Tabs
          value={scope}
          onValueChange={(value) => {
            setScope(value as GoalScope);
          }}
        >
          <TabsList className="h-11">
            <TabsTrigger value="all" className="min-h-9 px-3">
              {GOALS_RU.scopeAll}
            </TabsTrigger>
            <TabsTrigger value="family" className="min-h-9 px-3">
              {GOALS_RU.scopeFamily}
            </TabsTrigger>
            <TabsTrigger value="mine" className="min-h-9 px-3">
              {GOALS_RU.scopeMine}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <Button
          type="button"
          variant="ghost"
          className="h-11 gap-1.5 text-muted-foreground"
          aria-pressed={includeArchived}
          onClick={() => {
            setIncludeArchived((value) => !value);
          }}
        >
          <Archive className="size-4" aria-hidden />
          {includeArchived ? GOALS_RU.hideArchived : GOALS_RU.showArchived}
        </Button>
      </div>

      {isPending ? (
        <GoalGridSkeleton />
      ) : isError ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void refetch();
          }}
        />
      ) : goals.length === 0 ? (
        <EmptyState
          icon={PiggyBank}
          title={scope === 'all' ? GOALS_RU.emptyTitle : GOALS_RU.emptyFiltered}
          description={
            scope !== 'all'
              ? GOALS_RU.emptyFilteredDescription
              : abilities.canCreate
                ? GOALS_RU.emptyDescription
                : GOALS_RU.emptyReadOnlyDescription
          }
          action={
            abilities.canCreate ? (
              <Button
                className="h-11 gap-1.5"
                onClick={() => {
                  setCreateOpen(true);
                }}
              >
                <Plus className="size-4" aria-hidden />
                {GOALS_RU.createGoal}
              </Button>
            ) : null
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 pb-4 sm:grid-cols-2 xl:grid-cols-3">
          {goals.map((goal) => (
            <li key={goal.id} className="min-w-0">
              <GoalCard goal={goal} roster={roster} canContribute={abilities.canContribute} />
            </li>
          ))}
        </ul>
      )}

      {abilities.canCreate ? (
        <GoalFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
    </>
  );
}

function GoalGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3].map((card) => (
        <div key={card} className="space-y-4 rounded-2xl border p-5">
          <div className="flex items-start gap-4">
            <Skeleton className="size-22 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  );
}
