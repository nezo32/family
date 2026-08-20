import { useMemo, useState } from 'react';
import { ListTodo, Plus } from 'lucide-react';
import { Can } from '@/shared/auth/Can';
import { SideColumn } from '@/app/layout/SideColumn';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { Button } from '@/shared/ui/button';
import { getFamilyTimeZone } from '@/shared/lib/format';
import { TASKS_RU } from '../locale';
import { addDaysToKey, todayKey } from '../recurrence';
import { collectCategories, groupOccurrences } from '../grouping';
import { useFairness, useMembers, useOccurrences, useSwaps } from '../hooks';
import type { OccurrenceFilters } from '../api';
import { TaskList } from '../components/TaskList';
import { TaskFilters } from '../components/TaskFilters';
import { DEFAULT_FILTERS, type TaskFilterState } from '../filters';
import { TaskEditor } from '../components/TaskEditor';
import { WeeklyLoad } from '../components/WeeklyLoad';
import { SwapInbox } from '../components/SwapPanel';
import { LoadBarSkeleton, TaskListSkeleton } from '../components/Skeletons';

/**
 * «Задачи» — the section index.
 *
 * The read window is deliberately bounded: two weeks back (so overdue chores
 * cannot silently fall off the list) and two months forward (the materialized
 * horizon is 90 days, and nobody plans further than that from a phone).
 */
export default function TasksPage() {
  const [filters, setFilters] = useState<TaskFilterState>(DEFAULT_FILTERS);
  const [creating, setCreating] = useState(false);

  const today = todayKey(getFamilyTimeZone());

  const queryFilters = useMemo<OccurrenceFilters>(
    () => ({
      from: addDaysToKey(today, -14),
      to: addDaysToKey(today, 60),
      ...(filters.assignee.kind === 'me' ? { assignee: 'me' as const } : {}),
      ...(filters.assignee.kind === 'user' ? { assigneeId: filters.assignee.userId } : {}),
      ...(filters.category ? { category: filters.category } : {}),
    }),
    [today, filters],
  );

  const occurrences = useOccurrences(queryFilters);
  const members = useMembers();
  const fairness = useFairness(7);
  const swaps = useSwaps('incoming');

  const items = useMemo(() => occurrences.data?.items ?? [], [occurrences.data]);
  const groups = useMemo(() => groupOccurrences(items, today), [items, today]);
  const categories = useMemo(() => collectCategories(items), [items]);
  const roster = members.data ?? [];

  const visibleGroups = filters.showDone ? groups : { ...groups, done: [], skipped: [] };
  const hasVisible = Object.values(visibleGroups).some((group) => group.length > 0);
  const filtersActive = filters.assignee.kind !== 'all' || filters.category !== null;

  return (
    <>
      <PageHeader
        title={TASKS_RU.title}
        description={TASKS_RU.subtitle}
        actions={
          <Can perm="task:create">
            <Button
              className="min-h-11 w-full sm:w-auto"
              onClick={() => {
                setCreating(true);
              }}
            >
              <Plus className="size-4" aria-hidden />
              {TASKS_RU.actions.create}
            </Button>
          </Can>
        }
      />

      {/*
        No grid here any more: `AppShell` owns the two-column composition (§C1)
        and this page just says which half its content belongs in. The local
        `lg:grid-cols-[1fr_20rem]` this replaces would now be nested inside a
        720px main column and split the task list down to ~376px.
      */}
      <div className="min-w-0 space-y-5">
        <TaskFilters
          value={filters}
          onChange={setFilters}
          members={roster}
          categories={categories}
        />

        {occurrences.isPending ? <TaskListSkeleton /> : null}

        {occurrences.isError ? (
          <ErrorState
            error={occurrences.error}
            title={TASKS_RU.loadError}
            onRetry={() => {
              void occurrences.refetch();
            }}
          />
        ) : null}

        {occurrences.isSuccess && !hasVisible ? (
          <EmptyState
            icon={ListTodo}
            title={filtersActive ? TASKS_RU.emptyFilteredTitle : TASKS_RU.emptyTitle}
            description={
              filtersActive ? TASKS_RU.emptyFilteredDescription : TASKS_RU.emptyDescription
            }
            action={
              filtersActive ? (
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    setFilters(DEFAULT_FILTERS);
                  }}
                >
                  {TASKS_RU.filters.reset}
                </Button>
              ) : (
                <Can perm="task:create">
                  <Button
                    className="min-h-11"
                    onClick={() => {
                      setCreating(true);
                    }}
                  >
                    {TASKS_RU.actions.create}
                  </Button>
                </Can>
              )
            }
          />
        ) : null}

        {occurrences.isSuccess && hasVisible ? (
          <TaskList groups={visibleGroups} members={roster} />
        ) : null}
      </div>

      {/*
        §C4: «Нагрузка за неделю» beside the list on a wide screen, at the
        bottom of it on a phone. Фильтры belong here too, but that move is
        paired with turning them into a «Фильтры · N» sheet row on a phone
        (§D2); moved on their own they would land at the *bottom* of the phone
        screen, below the list they filter.
      */}
      <SideColumn>
        <div className="space-y-4">
          <SwapInbox swaps={swaps.data?.items ?? []} members={roster} />

          {fairness.isPending && fairness.fetchStatus !== 'idle' ? (
            <div className="rounded-2xl border border-border bg-card p-4">
              <LoadBarSkeleton />
            </div>
          ) : null}

          {fairness.isSuccess ? (
            <WeeklyLoad
              members={fairness.data.members}
              roster={roster}
              imbalance={fairness.data.imbalance}
            />
          ) : null}
        </div>
      </SideColumn>

      <TaskEditor open={creating} onOpenChange={setCreating} members={roster} />
    </>
  );
}
