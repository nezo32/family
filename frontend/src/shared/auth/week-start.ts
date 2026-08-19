import type { MeResponse } from '@family/shared';

/**
 * Week-start axis conversion.
 *
 * There are two incompatible conventions in play and exactly one place where
 * they meet, so the conversion lives here rather than inline at a call site:
 *
 *  - **The contract** (`familyContextSchema.weekStartsOn` in `@family/shared`)
 *    is ISO-8601: `1 = понедельник … 7 = воскресенье`. There is no `0`.
 *  - **react-day-picker / date-fns** (`shared/ui/calendar.tsx`) take a 0-based
 *    index: `0 = воскресенье … 6 = суббота`. There is no `7`.
 *
 * The two agree on every value from 1 to 6, which is exactly what makes the bug
 * invisible in testing: a family on the default Monday start works perfectly,
 * and only «неделя начинается с воскресенья» (ISO 7) lands out of range and
 * silently renders a Monday-first grid. Never pass `family.weekStartsOn`
 * straight into `<Calendar weekStartsOn={…}>`.
 */

/** The 0-based index react-day-picker and date-fns expect. */
export type DayPickerWeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * ISO weekday (1–7, Monday first) → react-day-picker index (0–6, Sunday first).
 *
 * Out-of-range input falls back to Monday, which is both the contract default
 * and what every Russian calendar in this app renders.
 */
export function toDayPickerWeekStart(isoWeekStartsOn: number | undefined): DayPickerWeekStart {
  if (isoWeekStartsOn === undefined) return 1;
  if (!Number.isInteger(isoWeekStartsOn) || isoWeekStartsOn < 1 || isoWeekStartsOn > 7) return 1;
  // ISO 7 (воскресенье) is the only value that has to move; 1–6 are identical
  // on both axes.
  return (isoWeekStartsOn === 7 ? 0 : isoWeekStartsOn) as DayPickerWeekStart;
}

/** Convenience for a `/api/me` payload. Safe on `undefined` (still loading). */
export function familyWeekStart(me: MeResponse | undefined): DayPickerWeekStart {
  return toDayPickerWeekStart(me?.family.weekStartsOn);
}
