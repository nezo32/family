import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type { TaskOccurrenceResponse } from '@family/shared';
import { useMe } from '@/shared/auth/use-me';
import { notify } from '@/shared/lib/toast';
import { completeTaskOccurrence, fetchToday, fetchWeek, todayKeys } from './api';
import { TODAY_RU } from './locale';
import type { DashboardTodayResponse, DashboardWeekResponse } from './types';

/**
 * Server state for the home screen. Thin wrappers — the interesting part is the
 * optimistic completion below.
 */

export function useToday(): UseQueryResult<DashboardTodayResponse> {
  return useQuery({
    queryKey: todayKeys.today(),
    queryFn: ({ signal }) => fetchToday(signal),
    // This screen is opened, glanced at and closed. The shared default (30 s)
    // plus `refetchOnWindowFocus` already makes resume-from-background feel
    // live; nothing here needs a tighter window.
  });
}

export function useWeek(): UseQueryResult<DashboardWeekResponse> {
  return useQuery({
    queryKey: todayKeys.week(),
    queryFn: ({ signal }) => fetchWeek(signal),
    // The week's load moves once a chore is closed, i.e. rarely.
    staleTime: 5 * 60_000,
  });
}

interface CompleteContext {
  previous: DashboardTodayResponse | undefined;
}

/**
 * One-tap completion with an optimistic update.
 *
 * Why optimistic at all: ticking a chore is the single most frequent action in
 * the app and it is done standing in a kitchen. A 400 ms round trip before the
 * row reacts reads as "the tap didn't register", and the user taps again.
 *
 * Why the rollback matters more than the optimism: an offline tap that silently
 * *looks* done is how a family stops trusting the app. On failure the previous
 * payload is restored verbatim and the user gets a Russian toast mapped from
 * the `ErrorCode` — never the server's English `message` (D7).
 */
export function useCompleteTask(): UseMutationResult<
  TaskOccurrenceResponse,
  unknown,
  string,
  CompleteContext
> {
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const myId = me?.id ?? null;

  return useMutation<TaskOccurrenceResponse, unknown, string, CompleteContext>({
    mutationFn: (occurrenceId: string) => completeTaskOccurrence(occurrenceId),

    onMutate: async (occurrenceId) => {
      // A refetch landing mid-flight would overwrite the optimistic row with a
      // stale server copy, and the tick would visibly bounce back.
      await queryClient.cancelQueries({ queryKey: todayKeys.today() });

      const previous = queryClient.getQueryData<DashboardTodayResponse>(todayKeys.today());
      if (previous) {
        queryClient.setQueryData<DashboardTodayResponse>(
          todayKeys.today(),
          markCompleted(previous, occurrenceId, myId),
        );
      }
      return { previous };
    },

    onError: (error, _occurrenceId, context) => {
      if (context && context.previous) {
        queryClient.setQueryData<DashboardTodayResponse>(todayKeys.today(), context.previous);
      }
      notify.error(error, TODAY_RU.completeErrorTitle);
    },

    onSettled: () => {
      // Completion moves points and the fairness window too, so both keys go.
      void queryClient.invalidateQueries({ queryKey: todayKeys.today() });
      void queryClient.invalidateQueries({ queryKey: todayKeys.week() });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Immutably mark one occurrence done across every list it can appear in.
 *
 * Exported for the unit test: the rollback guarantee is only worth as much as
 * the purity of this function — it must never mutate the cached object, or the
 * snapshot taken in `onMutate` would be the very object we changed.
 */
export function markCompleted(
  payload: DashboardTodayResponse,
  occurrenceId: string,
  completedById: string | null,
): DashboardTodayResponse {
  if (!payload.tasks) return payload;

  let hit = false;
  const complete = (occurrence: TaskOccurrenceResponse): TaskOccurrenceResponse => {
    if (occurrence.id !== occurrenceId || occurrence.status === 'done') return occurrence;
    hit = true;
    return {
      ...occurrence,
      status: 'done',
      isOverdue: false,
      completedById: completedById ?? occurrence.assigneeId,
      completedAt: new Date().toISOString(),
    };
  };

  const tasks = {
    ...payload.tasks,
    mine: payload.tasks.mine.map(complete),
    overdue: payload.tasks.overdue.map(complete),
    unassigned: payload.tasks.unassigned.map(complete),
  };
  if (!hit) return payload;

  return {
    ...payload,
    tasks: { ...tasks, familyDoneToday: tasks.familyDoneToday + 1 },
  };
}

/** `true` when the whole payload has nothing worth showing — the 🎉 case. */
export function isDayEmpty(payload: DashboardTodayResponse | undefined): boolean {
  if (!payload) return false;
  const tasks = payload.tasks;
  const events = payload.events;
  return (
    (!tasks ||
      (tasks.mine.length === 0 &&
        tasks.overdue.length === 0 &&
        tasks.unassigned.length === 0)) &&
    (!events || (events.today.length === 0 && events.tomorrow.length === 0)) &&
    (!payload.shopping || payload.shopping.urgent.length === 0) &&
    (!payload.approvals || payload.approvals.pendingCount === 0)
  );
}
