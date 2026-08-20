import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  Paginated,
  PublicUser,
  SwapCreate,
  SwapRespond,
  SwapResponse,
  TaskComplete,
  TaskOccurrenceResponse,
  TaskSeriesCreate,
  TaskSeriesDelete,
  TaskSeriesResponse,
  TaskSeriesUpdate,
  TaskSkip,
} from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { notify } from '@/shared/lib/toast';
import {
  assignOccurrence,
  cancelSwap,
  claimOccurrence,
  completeOccurrence,
  createSeries,
  createSwap,
  deleteSeries,
  fetchMembers,
  fetchOccurrence,
  fetchOccurrences,
  fetchSeries,
  fetchSwaps,
  respondToSwap,
  skipOccurrence,
  taskKeys,
  uncompleteOccurrence,
  updateSeries,
  type OccurrenceFilters,
  type OccurrencePage,
  type SwapDirection,
} from './api';
import { TASKS_RU } from './locale';

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export function useOccurrences(filters: OccurrenceFilters): UseQueryResult<OccurrencePage> {
  return useQuery({
    queryKey: taskKeys.list(filters),
    queryFn: ({ signal }) => fetchOccurrences(filters, signal),
  });
}

export function useOccurrence(
  occurrenceId: string | undefined,
): UseQueryResult<TaskOccurrenceResponse> {
  return useQuery({
    queryKey: taskKeys.detail(occurrenceId ?? ''),
    queryFn: ({ signal }) => fetchOccurrence(occurrenceId ?? '', signal),
    enabled: Boolean(occurrenceId),
  });
}

export function useSeries(seriesId: string | undefined): UseQueryResult<TaskSeriesResponse> {
  return useQuery({
    queryKey: taskKeys.series(seriesId ?? ''),
    queryFn: ({ signal }) => fetchSeries(seriesId ?? '', signal),
    enabled: Boolean(seriesId),
  });
}

/** The family roster, for assignee pickers and avatars. */
export function useMembers(): UseQueryResult<PublicUser[]> {
  return useQuery({
    queryKey: taskKeys.members(),
    queryFn: ({ signal }) => fetchMembers(signal),
    staleTime: 5 * 60_000,
  });
}

export function useSwaps(direction: SwapDirection): UseQueryResult<Paginated<SwapResponse>> {
  return useQuery({
    queryKey: taskKeys.swaps(direction),
    queryFn: ({ signal }) => fetchSwaps(direction, signal),
  });
}

/* -------------------------------------------------------------------------- */
/* Optimistic occurrence patching                                              */
/* -------------------------------------------------------------------------- */

interface OccurrenceSnapshot {
  lists: [QueryKey, OccurrencePage | undefined][];
  detail: TaskOccurrenceResponse | undefined;
}

type OccurrencePatcher = (occurrence: TaskOccurrenceResponse) => TaskOccurrenceResponse;

/**
 * One-tap completion has to feel instant on a phone, so the cache is patched
 * before the request leaves. Everything needed to undo that is captured in the
 * returned snapshot: on failure the exact previous pages go back, because a
 * checkbox that stays ticked after a failed write is worse than no optimism at
 * all — the family believes the bins went out.
 */
function useOptimisticOccurrence() {
  const queryClient = useQueryClient();

  const apply = async (occurrenceId: string, patch: OccurrencePatcher) => {
    await queryClient.cancelQueries({ queryKey: taskKeys.lists() });
    await queryClient.cancelQueries({ queryKey: taskKeys.detail(occurrenceId) });

    const lists = queryClient.getQueriesData<OccurrencePage>({ queryKey: taskKeys.lists() });
    const detail = queryClient.getQueryData<TaskOccurrenceResponse>(taskKeys.detail(occurrenceId));

    queryClient.setQueriesData<OccurrencePage>({ queryKey: taskKeys.lists() }, (page) =>
      page
        ? {
            ...page,
            items: page.items.map((item) => (item.id === occurrenceId ? patch(item) : item)),
          }
        : page,
    );
    if (detail) queryClient.setQueryData(taskKeys.detail(occurrenceId), patch(detail));

    return { lists, detail } satisfies OccurrenceSnapshot;
  };

  const rollback = (occurrenceId: string, snapshot: OccurrenceSnapshot | undefined) => {
    if (!snapshot) return;
    for (const [key, page] of snapshot.lists) queryClient.setQueryData(key, page);
    if (snapshot.detail) queryClient.setQueryData(taskKeys.detail(occurrenceId), snapshot.detail);
  };

  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: taskKeys.all });
  };

  return { apply, rollback, settle };
}

/* -------------------------------------------------------------------------- */
/* Occurrence mutations                                                        */
/* -------------------------------------------------------------------------- */

export interface CompleteVariables {
  occurrenceId: string;
  body?: TaskComplete;
}

export function useCompleteOccurrence(): UseMutationResult<
  TaskOccurrenceResponse,
  unknown,
  CompleteVariables,
  OccurrenceSnapshot
> {
  const { apply, rollback, settle } = useOptimisticOccurrence();
  const { userId } = useCan();

  return useMutation({
    mutationFn: ({ occurrenceId, body }: CompleteVariables) =>
      completeOccurrence(occurrenceId, body ?? {}),
    onMutate: ({ occurrenceId, body }) =>
      apply(occurrenceId, (occurrence) => ({
        ...occurrence,
        status: 'done',
        // Derived server-side; a done row is never overdue (scheduling.md §4).
        isOverdue: false,
        completedAt: body?.completedAt ?? new Date().toISOString(),
        completedById: body?.completedById ?? userId,
      })),
    onError: (error, variables, snapshot) => {
      rollback(variables.occurrenceId, snapshot);
      notify.error(error);
    },
    onSuccess: () => {
      notify.success(TASKS_RU.toast.completed);
    },
    onSettled: settle,
  });
}

export function useUncompleteOccurrence(): UseMutationResult<
  TaskOccurrenceResponse,
  unknown,
  { occurrenceId: string; reason?: string },
  OccurrenceSnapshot
> {
  const { apply, rollback, settle } = useOptimisticOccurrence();

  return useMutation({
    mutationFn: ({ occurrenceId, reason }: { occurrenceId: string; reason?: string }) =>
      uncompleteOccurrence(occurrenceId, reason),
    onMutate: ({ occurrenceId }) =>
      apply(occurrenceId, (occurrence) => ({
        ...occurrence,
        status: 'scheduled',
        completedAt: null,
        completedById: null,
      })),
    onError: (error, variables, snapshot) => {
      rollback(variables.occurrenceId, snapshot);
      notify.error(error);
    },
    onSuccess: () => {
      notify.success(TASKS_RU.toast.uncompleted);
    },
    onSettled: settle,
  });
}

export function useSkipOccurrence() {
  const { apply, rollback, settle } = useOptimisticOccurrence();
  const { userId } = useCan();

  return useMutation({
    mutationFn: ({ occurrenceId, body }: { occurrenceId: string; body: TaskSkip }) =>
      skipOccurrence(occurrenceId, body),
    onMutate: ({ occurrenceId, body }) =>
      apply(occurrenceId, (occurrence) => ({
        ...occurrence,
        status: 'skipped',
        isOverdue: false,
        skippedById: userId,
        skipReason: body.reason ?? null,
      })),
    onError: (error, variables, snapshot) => {
      rollback(variables.occurrenceId, snapshot);
      notify.error(error);
    },
    onSuccess: () => {
      notify.success(TASKS_RU.skip.done);
    },
    onSettled: settle,
  });
}

export function useAssignOccurrence() {
  const { apply, rollback, settle } = useOptimisticOccurrence();

  return useMutation({
    mutationFn: ({
      occurrenceId,
      assigneeId,
    }: {
      occurrenceId: string;
      assigneeId: string | null;
    }) => assignOccurrence(occurrenceId, { assigneeId }),
    onMutate: ({ occurrenceId, assigneeId }) =>
      apply(occurrenceId, (occurrence) => ({
        ...occurrence,
        assigneeId,
        assignedVia: 'manual',
      })),
    onError: (error, variables, snapshot) => {
      rollback(variables.occurrenceId, snapshot);
      notify.error(error);
    },
    onSuccess: () => {
      notify.success(TASKS_RU.assign.done);
    },
    onSettled: settle,
  });
}

export function useClaimOccurrence() {
  const { apply, rollback, settle } = useOptimisticOccurrence();
  const { userId } = useCan();

  return useMutation({
    mutationFn: ({ occurrenceId }: { occurrenceId: string }) => claimOccurrence(occurrenceId),
    onMutate: ({ occurrenceId }) =>
      apply(occurrenceId, (occurrence) => ({
        ...occurrence,
        assigneeId: userId,
        assignedVia: 'claimed',
      })),
    onError: (error, variables, snapshot) => {
      rollback(variables.occurrenceId, snapshot);
      notify.error(error);
    },
    onSuccess: () => {
      notify.success(TASKS_RU.assign.claimed);
    },
    onSettled: settle,
  });
}

/* -------------------------------------------------------------------------- */
/* Series mutations                                                            */
/* -------------------------------------------------------------------------- */

function useInvalidateTasks(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: taskKeys.all });
  };
}

export function useCreateSeries() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (body: TaskSeriesCreate) => createSeries(body),
    onSuccess: () => {
      notify.success(TASKS_RU.form.created);
      invalidate();
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

export function useUpdateSeries() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ seriesId, body }: { seriesId: string; body: TaskSeriesUpdate }) =>
      updateSeries(seriesId, body),
    onSuccess: () => {
      notify.success(TASKS_RU.form.saved);
      invalidate();
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

export function useDeleteSeries() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ seriesId, body }: { seriesId: string; body: TaskSeriesDelete }) =>
      deleteSeries(seriesId, body),
    onSuccess: () => {
      notify.success(TASKS_RU.form.deleted);
      invalidate();
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Swaps                                                                       */
/* -------------------------------------------------------------------------- */

export function useCreateSwap() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (body: SwapCreate) => createSwap(body),
    onSuccess: () => {
      notify.success(TASKS_RU.swap.sent);
      invalidate();
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

export function useRespondToSwap() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ swapId, body }: { swapId: string; body: SwapRespond }) =>
      respondToSwap(swapId, body),
    onSuccess: (_data, variables) => {
      notify.success(variables.body.accept ? TASKS_RU.swap.accepted : TASKS_RU.swap.declined);
      invalidate();
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

export function useCancelSwap() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ swapId }: { swapId: string }) => cancelSwap(swapId),
    onSuccess: () => {
      notify.success(TASKS_RU.swap.cancelled);
      invalidate();
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}
