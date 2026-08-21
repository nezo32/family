import { api } from '@/shared/api/client';
import type {
  MemberListResponse,
  Paginated,
  PublicUser,
  SwapCreate,
  SwapRespond,
  SwapResponse,
  TaskAssign,
  TaskComplete,
  TaskOccurrenceResponse,
  TaskSeriesCreate,
  TaskSeriesDelete,
  TaskSeriesResponse,
  TaskSeriesUpdate,
  TaskSkip,
} from '@family/shared';

/**
 * Typed fetchers + query keys for the «Задачи» section.
 *
 * Route table: `docs/architecture/scheduling.md` §8. Everything goes through
 * `@/shared/api/client`, which owns the base URL, the bearer token, the 401
 * refresh dance and the `ErrorCode` typing — never call `fetch` here.
 */

/* -------------------------------------------------------------------------- */
/* Query keys                                                                  */
/* -------------------------------------------------------------------------- */

export interface OccurrenceFilters {
  /** `'me'` is resolved server-side; the client never guesses its own id. */
  assignee?: 'me';
  assigneeId?: string;
  /** One series' instances — how the detail page finds a date after an edit. */
  seriesId?: string;
  unassignedOnly?: boolean;
  category?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface SeriesFilters {
  includeArchived?: boolean;
  category?: string;
  recurring?: boolean;
  limit?: number;
}

/**
 * Occurrence *lists* and occurrence *details* deliberately sit under different
 * prefixes: the optimistic completion patch walks every list cache with
 * `getQueriesData({ queryKey: taskKeys.lists() })`, and a detail entry caught by
 * that prefix would be patched as if it were a paginated page.
 */
export const taskKeys = {
  all: ['tasks'] as const,
  lists: () => [...taskKeys.all, 'occurrences'] as const,
  list: (filters: OccurrenceFilters) => [...taskKeys.lists(), filters] as const,
  detail: (occurrenceId: string) => [...taskKeys.all, 'occurrence', occurrenceId] as const,
  seriesLists: () => [...taskKeys.all, 'series'] as const,
  seriesList: (filters: SeriesFilters) => [...taskKeys.seriesLists(), filters] as const,
  series: (seriesId: string) => [...taskKeys.all, 'series-detail', seriesId] as const,
  /** Namespaced under `tasks` on purpose — the roster is cached per feature so
   *  another feature's differently-shaped `['members']` entry cannot collide. */
  members: () => [...taskKeys.all, 'members'] as const,
  swaps: (direction: SwapDirection) => [...taskKeys.all, 'swaps', direction] as const,
} as const;

export type SwapDirection = 'incoming' | 'outgoing' | 'all';

export type OccurrencePage = Paginated<TaskOccurrenceResponse>;

/* -------------------------------------------------------------------------- */
/* Occurrences                                                                 */
/* -------------------------------------------------------------------------- */

export const fetchOccurrences = (filters: OccurrenceFilters, signal?: AbortSignal) =>
  api.get<OccurrencePage>('/tasks/occurrences', {
    query: {
      assignee: filters.assignee,
      assigneeId: filters.assigneeId,
      seriesId: filters.seriesId,
      unassignedOnly: filters.unassignedOnly,
      category: filters.category,
      from: filters.from,
      to: filters.to,
      limit: filters.limit ?? 100,
    },
    ...(signal ? { signal } : {}),
  });

export const fetchOccurrence = (occurrenceId: string, signal?: AbortSignal) =>
  api.get<TaskOccurrenceResponse>(
    `/tasks/occurrences/${occurrenceId}`,
    signal ? { signal } : undefined,
  );

export const completeOccurrence = (occurrenceId: string, body: TaskComplete = {}) =>
  api.post<TaskOccurrenceResponse>(`/tasks/occurrences/${occurrenceId}/complete`, body);

export const uncompleteOccurrence = (occurrenceId: string, reason?: string) =>
  api.post<TaskOccurrenceResponse>(
    `/tasks/occurrences/${occurrenceId}/uncomplete`,
    reason ? { reason } : {},
  );

export const skipOccurrence = (occurrenceId: string, body: TaskSkip) =>
  api.post<TaskOccurrenceResponse>(`/tasks/occurrences/${occurrenceId}/skip`, body);

export const assignOccurrence = (occurrenceId: string, body: TaskAssign) =>
  api.post<TaskOccurrenceResponse>(`/tasks/occurrences/${occurrenceId}/assign`, body);

export const claimOccurrence = (occurrenceId: string) =>
  api.post<TaskOccurrenceResponse>(`/tasks/occurrences/${occurrenceId}/claim`, {});

/* -------------------------------------------------------------------------- */
/* Series                                                                      */
/* -------------------------------------------------------------------------- */

export const fetchSeries = (seriesId: string, signal?: AbortSignal) =>
  api.get<TaskSeriesResponse>(`/tasks/series/${seriesId}`, signal ? { signal } : undefined);

export const fetchSeriesList = (filters: SeriesFilters, signal?: AbortSignal) =>
  api.get<Paginated<TaskSeriesResponse>>('/tasks/series', {
    query: {
      includeArchived: filters.includeArchived,
      category: filters.category,
      recurring: filters.recurring,
      limit: filters.limit ?? 100,
    },
    ...(signal ? { signal } : {}),
  });

export const createSeries = (body: TaskSeriesCreate) =>
  api.post<TaskSeriesResponse>('/tasks/series', body);

export const updateSeries = (seriesId: string, body: TaskSeriesUpdate) =>
  api.patch<TaskSeriesResponse>(`/tasks/series/${seriesId}`, body);

export const deleteSeries = (seriesId: string, body: TaskSeriesDelete) =>
  api.del<void>(`/tasks/series/${seriesId}`, { body });

/* -------------------------------------------------------------------------- */
/* Chores: roster and swaps                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `GET /members` serves two shapes (identity.md §1.5): admins get
 * `{ items, pendingCount }`, everybody else a bare `PublicUser[]`. Normalising
 * here keeps the branch out of every component.
 */
export async function fetchMembers(signal?: AbortSignal): Promise<PublicUser[]> {
  const raw = await api.get<PublicUser[] | MemberListResponse>(
    '/members',
    signal ? { signal } : undefined,
  );
  const items = Array.isArray(raw) ? raw : raw.items;
  return items.filter((member) => member.status === 'active');
}

export const fetchSwaps = (direction: SwapDirection, signal?: AbortSignal) =>
  api.get<Paginated<SwapResponse>>('/chores/swaps', {
    query: { direction, limit: 50 },
    ...(signal ? { signal } : {}),
  });

export const createSwap = (body: SwapCreate) => api.post<SwapResponse>('/chores/swaps', body);

export const respondToSwap = (swapId: string, body: SwapRespond) =>
  api.post<SwapResponse>(`/chores/swaps/${swapId}/respond`, body);

export const cancelSwap = (swapId: string) =>
  api.post<SwapResponse>(`/chores/swaps/${swapId}/cancel`, {});
