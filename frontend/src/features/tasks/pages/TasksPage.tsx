import { useMemo, useState } from 'react';
import { ListTodo, Plus } from 'lucide-react';
import { Can } from '@/shared/auth/Can';
import { SideColumn } from '@/app/layout/SideColumn';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { Button } from '@/shared/ui/button';
import { SectionStack } from '@/shared/ui/section';
import { getFamilyTimeZone } from '@/shared/lib/format';
import { TASKS_RU } from '../locale';
import { addDaysToKey, todayKey } from '../recurrence';
import { collectCategories, groupOccurrences } from '../grouping';
import { useFairness, useMembers, useOccurrences, useSwaps } from '../hooks';
import type { OccurrenceFilters } from '../api';
import { TaskList } from '../components/TaskList';
import { TaskFilterPanel, TaskScopeBar } from '../components/TaskFilters';
import { DEFAULT_FILTERS, type TaskFilterState } from '../filters';
import { TaskEditor } from '../components/TaskEditor';
import { WeeklyLoad } from '../components/WeeklyLoad';
import { SwapInbox } from '../components/SwapPanel';
import { LoadBarSkeleton, TaskListSkeleton } from '../components/Skeletons';

/**
 * «Задачи» — the section index (§D2).
 *
 * **What the user came for:** "what is mine, and what is late."
 *
 * **Band 2 is a swap request, and nothing else.** Overdue chores are the
 * screen's first *section*, not a tinted block: on a screen whose whole subject
 * is chores, an attention wash around the first group would tint a third of the
 * page and say nothing. Their hierarchy is carried by order instead —
 * просрочено → сегодня → на неделе → позже, the same hierarchy
 * `grouping.ts` already encodes.
 *
 * What does earn the band is `SwapInbox`: a question somebody asked *you*,
 * which is a different kind of thing from a chore, and which is absent almost
 * every day. It is also what `chore_swap_requested` notifications navigate here
 * for — this panel holds the only «Помогу» / «Не смогу» controls in the app
 * — so it cannot sit in the side column, which on a phone collapses to *below
 * the whole list*.
 *
 * Band 1 (the title and the one primary action, «Новое дело») is hoisted into
 * the app bar from `md` up by `PageHeader`. On a phone that action is the
 * bar's `⊕`; it is no longer a full-width clay button eating the top of the
 * list.
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
        actions={
          <Can perm="task:create">
            <Button
              className="h-11"
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
        No grid here: `AppShell` owns the two-column composition (§C1) and this
        page only says which half its content belongs in. The local
        `lg:grid-cols-[1fr_20rem]` this replaces would now be nested inside a
        720px main column and split the task list down to ~376px.
      */}
      <div className="flex min-w-0 flex-col gap-4">
        {/*
          Band 2 (§C2). Renders `null` unless somebody is waiting on an answer,
          so on an ordinary day this screen still has exactly one loud thing:
          nothing.
        */}
        <SwapInbox swaps={swaps.data?.items ?? []} members={roster} />

        <TaskScopeBar
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
              // Filtered-empty is a different problem from empty, so it gets a
              // different way out (§D2): the fix is the filter, not a new chore.
              filtersActive ? (
                <Button
                  variant="outline"
                  className="h-11"
                  onClick={() => {
                    setFilters(DEFAULT_FILTERS);
                  }}
                >
                  {TASKS_RU.filters.reset}
                </Button>
              ) : (
                <Can perm="task:create">
                  <Button
                    className="h-11"
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
        §C4: Фильтры as a real panel plus «Нагрузка за неделю», beside the list
        on a wide screen. Both hide below 1088px rather than collapsing to the
        bottom of the page — a filter panel *under* the list it filters is worse
        than no panel, and the phone already has the «Фильтры · N» sheet.
      */}
      <SideColumn>
        <SectionStack>
          <TaskFilterPanel
            value={filters}
            onChange={setFilters}
            members={roster}
            categories={categories}
          />

          {fairness.isPending && fairness.fetchStatus !== 'idle' ? (
            <div className="rounded-xl border border-border bg-card p-4">
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
        </SectionStack>
      </SideColumn>

      <TaskEditor open={creating} onOpenChange={setCreating} members={roster} />
    </>
  );
}
