import { toLocalDateKey } from '@/shared/lib/format';

/**
 * Deadline maths for goals.
 *
 * A goal deadline is a **calendar date** (`2026-09-07`), not an instant, so the
 * comparison is done on date keys in the family timezone (D2) rather than by
 * subtracting timestamps — otherwise a family member abroad sees "осталось 0
 * дней" a day early.
 */

const MS_PER_DAY = 86_400_000;

/** Parse `YYYY-MM-DD` as a UTC midnight instant, purely for day arithmetic. */
function dateKeyToUtc(dateKey: string): number | null {
  const parsed = Date.parse(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Whole days from today (family timezone) to `deadline`. Negative when the
 * deadline has passed, `null` when there is no deadline or it is unparseable.
 */
export function daysUntil(
  deadline: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!deadline) return null;
  const target = dateKeyToUtc(deadline);
  const today = dateKeyToUtc(toLocalDateKey(now));
  if (target === null || today === null) return null;
  return Math.round((target - today) / MS_PER_DAY);
}
