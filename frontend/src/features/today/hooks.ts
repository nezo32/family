import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type { TaskOccurrenceResponse } from '@family/shared';
import { notify } from '@/shared/lib/toast';
import { completeTaskOccurrence, fetchToday, fetchWeek, todayKeys } from './api';
import { TODAY_RU } from './locale';
import type { TodayResponse, WeekResponse } from './types';

/**
 * Server state for the home screen. Thin wrappers — the interesting part is the
 * optimistic completion below.
 */

export function useToday(): UseQueryResult<TodayResponse> {
  return useQuery({
    queryKey: todayKeys.today(),
    queryFn: ({ signal }) => fetchToday(signal),
    // This screen is opened, glanced at and closed. The shared defaults (30 s
    // stale + refetch on focus) already make resume-from-background feel live;
    // nothing here needs a tighter window.
  });
}

/**
 * @param enabled the agenda is task and event data, so it is not requested at
 * all by a member who may read neither — a 403 the UI already predicted is a
 * wasted round trip and wasted battery.
 */
export function useWeek(enabled = true, days = 7): UseQueryResult<WeekResponse> {
  return useQuery({
    queryKey: todayKeys.week(days),
    queryFn: ({ signal }) => fetchWeek(days, signal),
    // The week ahead changes when somebody schedules something, i.e. rarely.
    staleTime: 5 * 60_000,
    enabled,
  });
}

interface CompleteContext {
  previous: TodayResponse | undefined;
}

/**
 * One-tap completion with an optimistic update.
 *
 * Why optimistic at all: ticking a chore is the most frequent action in the app
 * and it happens standing in a kitchen. A 400 ms round trip before the row
 * reacts reads as "the tap didn't register", and the user taps again.
 *
 * Why the rollback matters more than the optimism: a tap that silently *looks*
 * done while the request failed is how a family stops trusting the app. On
 * failure the previous payload is restored verbatim and the user gets a Russian
 * toast mapped from the `ErrorCode` — never the server's English `message` (D7).
 */
export function useCompleteTask(): UseMutationResult<
  TaskOccurrenceResponse,
  unknown,
  string,
  CompleteContext
> {
  const queryClient = useQueryClient();

  return useMutation<TaskOccurrenceResponse, unknown, string, CompleteContext>({
    mutationFn: (occurrenceId: string) => completeTaskOccurrence(occurrenceId),

    onMutate: async (occurrenceId) => {
      // A refetch landing mid-flight would overwrite the optimistic payload with
      // a stale server copy, and the row would visibly bounce back.
      await queryClient.cancelQueries({ queryKey: todayKeys.today() });

      const previous = queryClient.getQueryData<TodayResponse>(todayKeys.today());
      if (previous) {
        queryClient.setQueryData<TodayResponse>(
          todayKeys.today(),
          withTaskCompleted(previous, occurrenceId),
        );
      }
      return { previous };
    },

    onError: (error, _occurrenceId, context) => {
      if (context?.previous) {
        queryClient.setQueryData<TodayResponse>(todayKeys.today(), context.previous);
      }
      notify.error(error, TODAY_RU.completeErrorTitle);
    },

    onSettled: () => {
      // Completion also moves the points ledger and the fairness window, both of
      // which live in the same payload.
      void queryClient.invalidateQueries({ queryKey: todayKeys.today() });
      void queryClient.invalidateQueries({ queryKey: todayKeys.weeks() });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Immutably take one occurrence out of the open lists and bump the "сделано
 * сегодня" counter.
 *
 * `DashboardTask` carries no `status` — the dashboard only ever lists *open*
 * work — so completion is a removal, not a state flip. That is also the
 * clearest possible feedback: the row leaves the list and the counter moves.
 *
 * Exported for the test: the rollback guarantee is only worth as much as this
 * function's purity. It must never mutate the cached object, or the snapshot
 * taken in `onMutate` would be the very object we changed.
 */
export function withTaskCompleted(payload: TodayResponse, occurrenceId: string): TodayResponse {
  const { tasks } = payload;
  const isIt = (task: { id: string }): boolean => task.id === occurrenceId;
  const found = tasks.dueToday.some(isIt) || tasks.overdue.some(isIt);
  if (!found) return payload;

  return {
    ...payload,
    tasks: {
      dueToday: tasks.dueToday.filter((task) => !isIt(task)),
      overdue: tasks.overdue.filter((task) => !isIt(task)),
      doneTodayCount: tasks.doneTodayCount + 1,
    },
  };
}

/** `true` when the payload has nothing left to act on — the 🎉 case. */
export function isDayEmpty(payload: TodayResponse | undefined): boolean {
  if (!payload) return false;
  return (
    payload.tasks.dueToday.length === 0 &&
    payload.tasks.overdue.length === 0 &&
    payload.events.today.length === 0 &&
    payload.events.tomorrow.length === 0 &&
    (!payload.shopping || payload.shopping.urgent.length === 0) &&
    (!payload.pendingApprovals || payload.pendingApprovals.length === 0)
  );
}
