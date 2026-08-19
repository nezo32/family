import type { TaskOccurrenceResponse } from '@family/shared';
import { addDaysToKey } from './recurrence';

/**
 * List grouping.
 *
 * `isOverdue` is derived server-side (`scheduling.md` §4) and is authoritative —
 * the client must not re-derive it from `dueAt`, or a phone with a skewed clock
 * would paint half the family's week red.
 */

export type GroupId = 'overdue' | 'today' | 'week' | 'later' | 'done' | 'skipped';

/** Render order. "Просрочено" first: it is the only group that needs a decision. */
export const GROUP_ORDER: readonly GroupId[] = [
  'overdue',
  'today',
  'week',
  'later',
  'done',
  'skipped',
];

export type TaskGroups = Record<GroupId, TaskOccurrenceResponse[]>;

function emptyGroups(): TaskGroups {
  return { overdue: [], today: [], week: [], later: [], done: [], skipped: [] };
}

function byStartAsc(a: TaskOccurrenceResponse, b: TaskOccurrenceResponse): number {
  return a.startsAt.localeCompare(b.startsAt);
}

function byCompletedDesc(a: TaskOccurrenceResponse, b: TaskOccurrenceResponse): number {
  return (b.completedAt ?? b.startsAt).localeCompare(a.completedAt ?? a.startsAt);
}

/**
 * @param today `YYYY-MM-DD` in the family timezone (not the device's).
 */
export function groupOccurrences(
  occurrences: readonly TaskOccurrenceResponse[],
  today: string,
): TaskGroups {
  const groups = emptyGroups();
  const weekEnd = addDaysToKey(today, 6);

  for (const occurrence of occurrences) {
    if (occurrence.status === 'done') {
      groups.done.push(occurrence);
    } else if (occurrence.status === 'skipped' || occurrence.status === 'cancelled') {
      groups.skipped.push(occurrence);
    } else if (occurrence.isOverdue) {
      groups.overdue.push(occurrence);
    } else if (occurrence.localDate <= today) {
      groups.today.push(occurrence);
    } else if (occurrence.localDate <= weekEnd) {
      groups.week.push(occurrence);
    } else {
      groups.later.push(occurrence);
    }
  }

  groups.overdue.sort(byStartAsc);
  groups.today.sort(byStartAsc);
  groups.week.sort(byStartAsc);
  groups.later.sort(byStartAsc);
  groups.done.sort(byCompletedDesc);
  groups.skipped.sort(byCompletedDesc);

  return groups;
}

/** Unique, sorted category list for the filter row. */
export function collectCategories(occurrences: readonly TaskOccurrenceResponse[]): string[] {
  const seen = new Set<string>();
  for (const occurrence of occurrences) {
    if (occurrence.category) seen.add(occurrence.category);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'ru'));
}
