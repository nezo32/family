import type { TaskComplete, TaskOccurrenceResponse } from '@family/shared';
import { api } from '@/shared/api/client';
import type { DashboardTodayResponse, DashboardWeekResponse } from './types';

/**
 * Fetchers and query keys for the «Сегодня» home screen.
 *
 * The whole screen is **two** round trips: the day and the week. A home screen
 * that fans out into seven parallel requests is a home screen that renders in
 * seven stages on a phone tethered to a bus-stop 4G cell — the backend
 * aggregates instead (`docs/architecture/frontend.md`, "one round trip for the
 * home screen").
 */

export const todayKeys = {
  all: ['dashboard'] as const,
  today: () => [...todayKeys.all, 'today'] as const,
  week: () => [...todayKeys.all, 'week'] as const,
};

/** `GET /api/dashboard/today` — everything the home screen shows about today. */
export const fetchToday = (signal?: AbortSignal): Promise<DashboardTodayResponse> =>
  api.get<DashboardTodayResponse>('/dashboard/today', signal ? { signal } : {});

/** `GET /api/dashboard/week` — my own load for the current week (D5). */
export const fetchWeek = (signal?: AbortSignal): Promise<DashboardWeekResponse> =>
  api.get<DashboardWeekResponse>('/dashboard/week', signal ? { signal } : {});

/**
 * One-tap completion.
 *
 * TODO(contract): the tasks module is not registered yet
 * (`backend/src/modules/index.ts`), so this path is an assumption that follows
 * the naming of the shipped modules (`/goals/:id/...`). The body is the real
 * `taskCompleteSchema` from `@family/shared`; an empty body means "I did it,
 * just now", which is the only case this screen produces.
 */
export const completeTaskOccurrence = (
  occurrenceId: string,
  body: TaskComplete = {},
): Promise<TaskOccurrenceResponse> =>
  api.post<TaskOccurrenceResponse>(`/tasks/occurrences/${occurrenceId}/complete`, body);
