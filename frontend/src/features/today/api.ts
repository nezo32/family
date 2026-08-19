import type { TaskComplete, TaskOccurrenceResponse } from '@family/shared';
import { api } from '@/shared/api/client';
import type { TodayResponse, WeekResponse } from './types';

/**
 * Fetchers and query keys for the «Сегодня» home screen.
 *
 * The screen is **two** round trips: the day and the week ahead. A home screen
 * that fans out into seven parallel requests renders in seven stages on a phone
 * tethered to a bus-stop 4G cell — the backend aggregates instead
 * (`GET /api/dashboard/today` is one query per section, server-side).
 */

export const todayKeys = {
  all: ['dashboard'] as const,
  today: () => [...todayKeys.all, 'today'] as const,
  weeks: () => [...todayKeys.all, 'week'] as const,
  week: (days: number) => [...todayKeys.weeks(), { days }] as const,
};

/** `GET /api/dashboard/today` — everything the home screen knows about today. */
export const fetchToday = (signal?: AbortSignal): Promise<TodayResponse> =>
  api.get<TodayResponse>('/dashboard/today', signal ? { signal } : {});

/**
 * `GET /api/dashboard/week` — the rolling agenda. The home screen uses only its
 * `totals` (see `LoadWidget`); the day-by-day breakdown belongs to Календарь.
 */
export const fetchWeek = (days = 7, signal?: AbortSignal): Promise<WeekResponse> =>
  api.get<WeekResponse>('/dashboard/week', { query: { days }, ...(signal ? { signal } : {}) });

/**
 * One-tap completion.
 *
 * TODO(contract): the tasks module is not registered yet
 * (`backend/src/modules/index.ts`), so this path follows the naming of the
 * shipped modules (`/goals/:id/...`) and is an assumption. The body is the real
 * `taskCompleteSchema` from `@family/shared`; an empty body means "I did it,
 * just now", which is the only case this screen produces.
 */
export const completeTaskOccurrence = (
  occurrenceId: string,
  body: TaskComplete = {},
): Promise<TaskOccurrenceResponse> =>
  api.post<TaskOccurrenceResponse>(`/tasks/occurrences/${occurrenceId}/complete`, body);
