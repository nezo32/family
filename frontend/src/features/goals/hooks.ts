import { useMemo } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  CreateContribution,
  CreateGoal,
  CreateMilestone,
  CreateWithdrawal,
  GoalLedgerMutationResponse,
  GoalListResponse,
  GoalResponse,
  GoalTransactionListResponse,
  MilestoneResponse,
  PublicUser,
  UpdateGoal,
  UpdateMilestone,
} from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { notify } from '@/shared/lib/toast';
import { GOALS_RU } from './locale';
import {
  contributeToGoal,
  createGoal,
  createMilestone,
  deleteGoal,
  deleteMilestone,
  fetchGoal,
  fetchGoalTransactions,
  fetchGoals,
  fetchRoster,
  goalKeys,
  updateGoal,
  updateMilestone,
  withdrawFromGoal,
  type GoalListParams,
} from './api';

/**
 * TanStack Query wrappers for the moneybox.
 *
 * Every mutation ends with the same two moves: seed the detail cache from the
 * server's fresh `goal` (contribute/withdraw return the recomputed goal, so the
 * balance on screen is the server's `SUM(delta)` and never a client-side sum),
 * then invalidate the lists. Errors surface through `notify.error`, which maps
 * the `ErrorCode` to Russian — the server `message` is never rendered (D7).
 */

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

export function useGoals(params: GoalListParams = {}): UseQueryResult<GoalListResponse> {
  const { can, isReady } = useCan();
  return useQuery({
    queryKey: goalKeys.list(params),
    queryFn: ({ signal }) => fetchGoals(params, signal),
    // A child holds no `goal:*` permission at all and must never fire this
    // request; the route guard already hides the section, this is the belt.
    enabled: isReady && can('goal:read'),
    /*
      `scope` and `includeArchived` are part of the key, so changing either
      starts a *different* query — and without this the screen answered
      «Показать архив» by replacing the whole list, «Накоплено» included, with
      a skeleton for as long as the round trip took. The design's own loading
      rule (§D preamble) is that a refetch keeps the old data on screen, and
      widening a filter is that, not a first load. `isPlaceholderData` is what
      the page reads to know the answer is not settled yet.
    */
    placeholderData: keepPreviousData,
  });
}

export function useGoal(goalId: string | undefined): UseQueryResult<GoalResponse> {
  const { can, isReady } = useCan();
  return useQuery({
    queryKey: goalKeys.detail(goalId ?? 'unknown'),
    queryFn: ({ signal }) => fetchGoal(goalId ?? '', signal),
    enabled: Boolean(goalId) && isReady && can('goal:read'),
  });
}

export function useGoalTransactions(goalId: string | undefined, limit = 50) {
  const { can, isReady } = useCan();
  return useInfiniteQuery({
    queryKey: goalKeys.transactions(goalId ?? 'unknown', { limit }),
    queryFn: ({ pageParam, signal }) =>
      fetchGoalTransactions(
        goalId ?? '',
        { limit, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: GoalTransactionListResponse) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(goalId) && isReady && can('goal:read'),
  });
}

/**
 * The family roster, as a lookup by user id.
 *
 * Goal responses carry raw ids by design (see `contracts/goals.ts`), so this is
 * where names and avatars come from. It is a plain `Map`, and every consumer
 * must tolerate a miss: the roster may still be loading, or a member may have
 * been removed while their ledger rows live on.
 */
export function useRoster(): { byId: Map<string, PublicUser>; isPending: boolean } {
  const { can, isReady } = useCan();
  const query = useQuery({
    queryKey: goalKeys.roster,
    queryFn: ({ signal }) => fetchRoster(signal),
    enabled: isReady && can('member:read'),
    staleTime: 5 * 60_000,
  });

  const byId = useMemo(() => {
    const map = new Map<string, PublicUser>();
    for (const member of query.data?.items ?? []) map.set(member.id, member);
    return map;
  }, [query.data]);

  return { byId, isPending: query.isPending };
}

/* -------------------------------------------------------------------------- */
/* Goal mutations                                                              */
/* -------------------------------------------------------------------------- */

export function useCreateGoal(): UseMutationResult<GoalResponse, Error, CreateGoal> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateGoal) => createGoal(body),
    onSuccess: (goal) => {
      queryClient.setQueryData(goalKeys.detail(goal.id), goal);
      void queryClient.invalidateQueries({ queryKey: goalKeys.lists() });
      notify.success(GOALS_RU.goalCreated);
    },
    onError: (error: Error) => {
      notify.error(error);
    },
  });
}

export function useUpdateGoal(goalId: string): UseMutationResult<GoalResponse, Error, UpdateGoal> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateGoal) => updateGoal(goalId, body),
    onSuccess: (goal) => {
      queryClient.setQueryData(goalKeys.detail(goal.id), goal);
      void queryClient.invalidateQueries({ queryKey: goalKeys.lists() });
      notify.success(GOALS_RU.goalUpdated);
    },
    onError: (error: Error) => {
      notify.error(error);
    },
  });
}

export function useDeleteGoal(goalId: string): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteGoal(goalId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: goalKeys.detail(goalId) });
      void queryClient.invalidateQueries({ queryKey: goalKeys.lists() });
      notify.success(GOALS_RU.goalDeleted);
    },
    onError: (error: Error) => {
      notify.error(error);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Ledger mutations                                                            */
/* -------------------------------------------------------------------------- */

function useLedgerMutation<TBody>(
  goalId: string,
  submit: (body: TBody) => Promise<GoalLedgerMutationResponse>,
  successMessage: string,
): UseMutationResult<GoalLedgerMutationResponse, Error, TBody> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: submit,
    onSuccess: (result) => {
      // The server recomputed `SUM(delta)`; trust that, never a local sum.
      queryClient.setQueryData(goalKeys.detail(goalId), result.goal);
      void queryClient.invalidateQueries({ queryKey: goalKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: goalKeys.detail(goalId) });
      notify.success(successMessage);
    },
    onError: (error: Error) => {
      notify.error(error);
    },
  });
}

export function useContribute(
  goalId: string,
): UseMutationResult<GoalLedgerMutationResponse, Error, CreateContribution> {
  return useLedgerMutation<CreateContribution>(
    goalId,
    (body) => contributeToGoal(goalId, body),
    GOALS_RU.contributeSuccess,
  );
}

export function useWithdraw(
  goalId: string,
): UseMutationResult<GoalLedgerMutationResponse, Error, CreateWithdrawal> {
  return useLedgerMutation<CreateWithdrawal>(
    goalId,
    (body) => withdrawFromGoal(goalId, body),
    GOALS_RU.withdrawSuccess,
  );
}

/* -------------------------------------------------------------------------- */
/* Milestone mutations                                                         */
/* -------------------------------------------------------------------------- */

function useMilestoneInvalidation(goalId: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: goalKeys.detail(goalId) });
    void queryClient.invalidateQueries({ queryKey: goalKeys.lists() });
  };
}

export function useCreateMilestone(
  goalId: string,
): UseMutationResult<MilestoneResponse, Error, CreateMilestone> {
  const invalidate = useMilestoneInvalidation(goalId);
  return useMutation({
    mutationFn: (body: CreateMilestone) => createMilestone(goalId, body),
    onSuccess: () => {
      invalidate();
      notify.success(GOALS_RU.milestoneSaved);
    },
    onError: (error: Error) => {
      notify.error(error);
    },
  });
}

export function useUpdateMilestone(
  goalId: string,
): UseMutationResult<MilestoneResponse, Error, { milestoneId: string; body: UpdateMilestone }> {
  const invalidate = useMilestoneInvalidation(goalId);
  return useMutation({
    mutationFn: ({ milestoneId, body }: { milestoneId: string; body: UpdateMilestone }) =>
      updateMilestone(goalId, milestoneId, body),
    onSuccess: () => {
      invalidate();
      notify.success(GOALS_RU.milestoneSaved);
    },
    onError: (error: Error) => {
      notify.error(error);
    },
  });
}

export function useDeleteMilestone(goalId: string): UseMutationResult<void, Error, string> {
  const invalidate = useMilestoneInvalidation(goalId);
  return useMutation({
    mutationFn: (milestoneId: string) => deleteMilestone(goalId, milestoneId),
    onSuccess: () => {
      invalidate();
      notify.success(GOALS_RU.milestoneDeleted);
    },
    onError: (error: Error) => {
      notify.error(error);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

export interface GoalAbilities {
  canRead: boolean;
  canCreate: boolean;
  canContribute: boolean;
  canManage: boolean;
  canDelete: boolean;
  isReady: boolean;
  userId: string | null;
}

/**
 * The one place this feature asks about permissions.
 *
 * D4: never `role === 'teen'`. A teen holds `goal:read` and nothing else, so
 * every write affordance below simply resolves to `false` for them — and a
 * child, holding no `goal:*` at all, never gets this far because the route
 * guard already refuses `/goals`.
 */
export function useGoalAbilities(): GoalAbilities {
  const { can, isReady, userId } = useCan();
  return {
    canRead: can('goal:read'),
    canCreate: can('goal:create'),
    canContribute: can('goal:contribute'),
    canManage: can('goal:update'),
    canDelete: can('goal:delete'),
    isReady,
    userId,
  };
}
