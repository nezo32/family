import { ROUTES } from '@/shared/lib/routes';

/**
 * Paths owned by this feature.
 *
 * Detail views are paths **under** the section (`/tasks/:taskId`), never a new
 * top-level segment — see the route contract in `app/router.tsx`. `:taskId` is
 * an **occurrence** id: the list renders occurrences, and an occurrence is the
 * thing a user points at when they say "эта задача".
 */
export const taskDetailPath = (occurrenceId: string): string => `${ROUTES.tasks}/${occurrenceId}`;

/** Route pattern the shell registers as a child of `/tasks`. */
export const TASK_DETAIL_PATTERN = ':taskId';
