import { api } from '@/shared/api/client';
import type {
  CreateContribution,
  CreateGoal,
  CreateMilestone,
  CreateWithdrawal,
  GoalLedgerMutationResponse,
  GoalListResponse,
  GoalResponse,
  GoalStatus,
  GoalTransactionListResponse,
  MilestoneResponse,
  PublicUser,
  UpdateGoal,
  UpdateMilestone,
} from '@family/shared';

/**
 * Typed fetchers for the moneybox API (`docs/architecture/household.md` §1).
 *
 * | Method | Path                                | Permission        |
 * |--------|-------------------------------------|-------------------|
 * | GET    | `/goals`                            | `goal:read`       |
 * | POST   | `/goals`                            | `goal:create`     |
 * | GET    | `/goals/:id`                        | `goal:read`       |
 * | PATCH  | `/goals/:id`                        | `goal:update`     |
 * | DELETE | `/goals/:id`                        | `goal:delete`     |
 * | GET    | `/goals/:id/transactions`           | `goal:read`       |
 * | POST   | `/goals/:id/contributions`          | `goal:contribute` |
 * | POST   | `/goals/:id/withdrawals`            | `goal:contribute` |
 * | POST   | `/goals/:id/milestones`             | `goal:update`     |
 * | PATCH  | `/goals/:id/milestones/:milestoneId`| `goal:update`     |
 * | DELETE | `/goals/:id/milestones/:milestoneId`| `goal:update`     |
 *
 * Amounts crossing this boundary are always **integer minor units** (D6); the
 * `money.ts` parser is the only thing allowed to produce them.
 */

export type GoalScope = 'all' | 'family' | 'mine';
export type GoalSort = 'sortOrder' | 'deadline' | 'progress' | 'createdAt';

export interface GoalListParams {
  scope?: GoalScope;
  sort?: GoalSort;
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface GoalTransactionParams {
  limit?: number;
  cursor?: string;
}

export const goalKeys = {
  all: ['goals'] as const,
  lists: () => [...goalKeys.all, 'list'] as const,
  list: (params: GoalListParams) => [...goalKeys.lists(), params] as const,
  details: () => [...goalKeys.all, 'detail'] as const,
  detail: (goalId: string) => [...goalKeys.details(), goalId] as const,
  transactions: (goalId: string, params: GoalTransactionParams = {}) =>
    [...goalKeys.detail(goalId), 'transactions', params] as const,
  /** The member roster, joined client-side onto `ownerId` / `userId` fields. */
  roster: ['members', 'roster'] as const,
};

/* -------------------------------------------------------------------------- */
/* Goals                                                                       */
/* -------------------------------------------------------------------------- */

export function fetchGoals(
  params: GoalListParams,
  signal?: AbortSignal,
): Promise<GoalListResponse> {
  return api.get<GoalListResponse>('/goals', {
    query: {
      scope: params.scope ?? 'all',
      sort: params.sort ?? 'sortOrder',
      includeArchived: params.includeArchived ?? false,
      ...(params.limit === undefined ? {} : { limit: params.limit }),
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    },
    ...(signal ? { signal } : {}),
  });
}

export function fetchGoal(goalId: string, signal?: AbortSignal): Promise<GoalResponse> {
  return api.get<GoalResponse>(`/goals/${goalId}`, signal ? { signal } : {});
}

export function createGoal(body: CreateGoal): Promise<GoalResponse> {
  return api.post<GoalResponse>('/goals', body);
}

export function updateGoal(goalId: string, body: UpdateGoal): Promise<GoalResponse> {
  return api.patch<GoalResponse>(`/goals/${goalId}`, body);
}

export function deleteGoal(goalId: string): Promise<void> {
  return api.del<void>(`/goals/${goalId}`);
}

/* -------------------------------------------------------------------------- */
/* Ledger                                                                      */
/* -------------------------------------------------------------------------- */

export function fetchGoalTransactions(
  goalId: string,
  params: GoalTransactionParams,
  signal?: AbortSignal,
): Promise<GoalTransactionListResponse> {
  return api.get<GoalTransactionListResponse>(`/goals/${goalId}/transactions`, {
    query: {
      limit: params.limit ?? 50,
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    },
    ...(signal ? { signal } : {}),
  });
}

/** Money in. `amount` is a **positive** integer of minor units. */
export function contributeToGoal(
  goalId: string,
  body: CreateContribution,
): Promise<GoalLedgerMutationResponse> {
  return api.post<GoalLedgerMutationResponse>(`/goals/${goalId}/contributions`, body);
}

/**
 * Money out. Also submitted **positive** — the service writes `delta = -amount`
 * so a client bug cannot silently credit a goal (household.md §2.4).
 */
export function withdrawFromGoal(
  goalId: string,
  body: CreateWithdrawal,
): Promise<GoalLedgerMutationResponse> {
  return api.post<GoalLedgerMutationResponse>(`/goals/${goalId}/withdrawals`, body);
}

/* -------------------------------------------------------------------------- */
/* Milestones                                                                  */
/* -------------------------------------------------------------------------- */

export function createMilestone(goalId: string, body: CreateMilestone): Promise<MilestoneResponse> {
  return api.post<MilestoneResponse>(`/goals/${goalId}/milestones`, body);
}

export function updateMilestone(
  goalId: string,
  milestoneId: string,
  body: UpdateMilestone,
): Promise<MilestoneResponse> {
  return api.patch<MilestoneResponse>(`/goals/${goalId}/milestones/${milestoneId}`, body);
}

export function deleteMilestone(goalId: string, milestoneId: string): Promise<void> {
  return api.del<void>(`/goals/${goalId}/milestones/${milestoneId}`);
}

/* -------------------------------------------------------------------------- */
/* Roster                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `GET /members` (identity.md §Routes). Goal responses carry raw user ids, so
 * names and avatars are joined client-side from this one cached list.
 *
 * Typed as the narrow public projection: callers without `member:update:any`
 * get exactly these fields, and the admin serializer is a superset.
 */
export interface RosterResponse {
  items: PublicUser[];
}

export function fetchRoster(signal?: AbortSignal): Promise<RosterResponse> {
  return api.get<RosterResponse>('/members', signal ? { signal } : {});
}

/** Statuses shown by default — archived and cancelled goals are opt-in. */
export const VISIBLE_STATUSES: readonly GoalStatus[] = ['active', 'reached'];
