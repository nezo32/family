import type {
  EventOccurrenceResponse,
  RecurrenceEnd,
  RecurrencePreset,
  RecurrenceSpec,
  RecurrenceView,
  Weekday,
} from '@family/shared';
import { formatTime, toLocalDateKey } from '@/shared/lib/format';

/**
 * Pure calendar logic. No React, no network — everything here is unit testable
 * and every date decision the UI makes lives in this file.
 *
 * ## The time rules (D2), restated because this is where they get broken
 *
 * 1. A **local date key** is the string `YYYY-MM-DD`. All grid arithmetic is
 *    done on those strings via UTC-anchored `Date`s, so a DST transition in the
 *    device timezone can never shift a calendar cell by a day.
 * 2. The day an occurrence belongs to is `occurrence.localDate` — the value the
 *    server denormalized in the family timezone. We **never** derive it with
 *    `new Date(startsAt).getDate()`: for an all-day event on 2026-09-07 in
 *    Europe/Moscow the instant is `2026-09-06T21:00:00Z`, and the naive read
 *    puts the birthday on the 6th.
 * 3. An end that lands exactly on local midnight is the *exclusive* boundary of
 *    the previous day, not a day of its own — the other half of the same bug.
 * 4. Times are rendered with `formatTime` from `shared/lib/format`, which is
 *    pinned to the family timezone, never the device one.
 */

/* -------------------------------------------------------------------------- */
/* Local date keys                                                            */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD`. */
export type DateKey = string;
/** `YYYY-MM`. */
export type MonthKey = string;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(value: string): boolean {
  return DATE_KEY_RE.test(value);
}

/** UTC-anchored `Date` for a date key. UTC on purpose: pure calendar maths. */
export function dateKeyToUtc(key: DateKey): Date {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const day = Number(key.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

export function utcToDateKey(date: Date): DateKey {
  return date.toISOString().slice(0, 10);
}

/**
 * A device-local `Date` at **noon** on the given calendar date.
 *
 * Only for feeding `date-fns` formatters that need a `Date` to produce a
 * weekday or month name. Noon, because midnight ± a DST shift or a timezone
 * offset lands on the neighbouring day and the header starts disagreeing with
 * the rows beneath it. `new Date('2026-09-07')` is a UTC instant and has
 * exactly that bug.
 */
export function dateKeyToLocalNoon(key: DateKey): Date {
  return new Date(
    Number(key.slice(0, 4)),
    Number(key.slice(5, 7)) - 1,
    Number(key.slice(8, 10)),
    12,
  );
}

export function addDaysToKey(key: DateKey, days: number): DateKey {
  const date = dateKeyToUtc(key);
  date.setUTCDate(date.getUTCDate() + days);
  return utcToDateKey(date);
}

export function addMonthsToMonthKey(monthKey: MonthKey, months: number): MonthKey {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const date = new Date(Date.UTC(year, month - 1 + months, 1));
  return utcToDateKey(date).slice(0, 7);
}

export function monthKeyOf(key: DateKey): MonthKey {
  return key.slice(0, 7);
}

/** ISO weekday index with Monday = 0 … Sunday = 6. */
export function mondayWeekdayIndex(key: DateKey): number {
  return (dateKeyToUtc(key).getUTCDay() + 6) % 7;
}

/** `Date.getDay()` index (Sunday = 0), for the shared WEEKDAYS_* arrays. */
export function sundayWeekdayIndex(key: DateKey): number {
  return dateKeyToUtc(key).getUTCDay();
}

export function dayOfMonth(key: DateKey): number {
  return Number(key.slice(8, 10));
}

/** Today, in the family timezone — never the device one. */
export function todayKey(timeZone?: string): DateKey {
  return toLocalDateKey(new Date(), timeZone);
}

/**
 * The month grid: weeks of seven local date keys, **starting on Monday**.
 *
 * Trailing weeks that contain no day of the target month are dropped, so a
 * February starting on a Monday renders as 4 rows rather than a ragged 6.
 */
export function buildMonthGrid(monthKey: MonthKey): DateKey[][] {
  const first = `${monthKey}-01`;
  const gridStart = addDaysToKey(first, -mondayWeekdayIndex(first));

  const weeks: DateKey[][] = [];
  let cursor = gridStart;
  for (let week = 0; week < 6; week += 1) {
    const days: DateKey[] = [];
    for (let day = 0; day < 7; day += 1) {
      days.push(cursor);
      cursor = addDaysToKey(cursor, 1);
    }
    const touchesMonth = days.some((d) => monthKeyOf(d) === monthKey);
    if (!touchesMonth && weeks.length > 0) break;
    weeks.push(days);
  }
  return weeks;
}

/** Inclusive `from`/`to` covering the whole rendered grid of a month. */
export function monthGridRange(monthKey: MonthKey): { from: DateKey; to: DateKey } {
  const weeks = buildMonthGrid(monthKey);
  const firstWeek = weeks[0] ?? [`${monthKey}-01`];
  const lastWeek = weeks[weeks.length - 1] ?? firstWeek;
  return {
    from: firstWeek[0] ?? `${monthKey}-01`,
    to: lastWeek[lastWeek.length - 1] ?? `${monthKey}-01`,
  };
}

/* -------------------------------------------------------------------------- */
/* Occurrences on the grid                                                    */
/* -------------------------------------------------------------------------- */

/** Minimal shape the grid needs — keeps helpers testable without a full row. */
export interface DatedOccurrence {
  localDate: string;
  startsLocal: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
}

/**
 * The day an occurrence starts on. This is the server's denormalized
 * `local_date`, resolved in the family timezone — see rule 2 at the top.
 */
export function startDateKey(occurrence: DatedOccurrence): DateKey {
  return occurrence.localDate;
}

/** `HH:mm` of the start, in the family timezone. Empty for all-day events. */
export function startTimeLabel(occurrence: DatedOccurrence, timeZone?: string): string {
  if (occurrence.isAllDay) return '';
  return formatTime(occurrence.startsAt, timeZone);
}

function isLocalMidnight(instant: string, timeZone?: string): boolean {
  const time = formatTime(instant, timeZone);
  return time === '00:00' || time === '24:00';
}

/**
 * The last day an occurrence visually covers.
 *
 * An end at exactly local midnight closes the previous day (rule 3): an all-day
 * event on the 7th ends at the 8th at 00:00 and must not paint the 8th.
 */
export function endDateKey(occurrence: DatedOccurrence, timeZone?: string): DateKey {
  const raw = toLocalDateKey(occurrence.endsAt, timeZone);
  const adjusted = isLocalMidnight(occurrence.endsAt, timeZone) ? addDaysToKey(raw, -1) : raw;
  return adjusted < occurrence.localDate ? occurrence.localDate : adjusted;
}

/** Every local date an occurrence appears on, start day first. Capped at 400. */
export function occurrenceDayKeys(occurrence: DatedOccurrence, timeZone?: string): DateKey[] {
  const last = endDateKey(occurrence, timeZone);
  const keys: DateKey[] = [];
  let cursor = occurrence.localDate;
  while (cursor <= last && keys.length < 400) {
    keys.push(cursor);
    cursor = addDaysToKey(cursor, 1);
  }
  return keys.length > 0 ? keys : [occurrence.localDate];
}

/** All-day first, then by wall-clock start, then by title — a stable order. */
export function compareOccurrences(
  a: Pick<EventOccurrenceResponse, 'isAllDay' | 'startsLocal' | 'title'>,
  b: Pick<EventOccurrenceResponse, 'isAllDay' | 'startsLocal' | 'title'>,
): number {
  if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
  if (a.startsLocal !== b.startsLocal) return a.startsLocal < b.startsLocal ? -1 : 1;
  return a.title.localeCompare(b.title, 'ru');
}

/** `dateKey -> occurrences`, an occurrence repeated on every day it spans. */
export function indexByDay<T extends DatedOccurrence & Pick<EventOccurrenceResponse, 'isAllDay' | 'startsLocal' | 'title'>>(
  occurrences: readonly T[],
  timeZone?: string,
): Map<DateKey, T[]> {
  const index = new Map<DateKey, T[]>();
  for (const occurrence of occurrences) {
    for (const key of occurrenceDayKeys(occurrence, timeZone)) {
      const bucket = index.get(key);
      if (bucket) bucket.push(occurrence);
      else index.set(key, [occurrence]);
    }
  }
  for (const bucket of index.values()) bucket.sort(compareOccurrences);
  return index;
}

export interface DayGroup<T> {
  dateKey: DateKey;
  items: T[];
}

/**
 * Agenda grouping: one entry per day that actually has something, ascending.
 * Days an event merely spans into are included, so a three-day trip shows up
 * on all three days rather than only on the day it started.
 */
export function groupByDay<T extends DatedOccurrence & Pick<EventOccurrenceResponse, 'isAllDay' | 'startsLocal' | 'title'>>(
  occurrences: readonly T[],
  timeZone?: string,
): DayGroup<T>[] {
  const index = indexByDay(occurrences, timeZone);
  return [...index.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([dateKey, items]) => ({ dateKey, items }));
}

/* -------------------------------------------------------------------------- */
/* Birthdays                                                                  */
/* -------------------------------------------------------------------------- */

export function isBirthday(occurrence: Pick<EventOccurrenceResponse, 'sourceKind'>): boolean {
  return occurrence.sourceKind === 'user_birthday';
}

/** Generated series (birthdays, ICS imports) are never editable as events. */
export function isGeneratedOccurrence(
  occurrence: Pick<EventOccurrenceResponse, 'sourceKind'>,
): boolean {
  return occurrence.sourceKind !== 'manual';
}

/**
 * Age turned on a birthday occurrence.
 *
 * The birthday series is anchored at `dtstartLocal` = the **birth year** when
 * the profile carries one, and at the current year when it does not (§6 of
 * `docs/architecture/scheduling.md`). So a non-positive difference means "no
 * birth year on file" and we show no age rather than a wrong one.
 */
export function birthdayAge(occurrenceKey: string, dtstartLocal: string): number | null {
  const birthYear = Number(dtstartLocal.slice(0, 4));
  const year = Number(occurrenceKey.slice(0, 4));
  if (!Number.isFinite(birthYear) || !Number.isFinite(year)) return null;
  const age = year - birthYear;
  return age > 0 ? age : null;
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The chip colour: the event's own colour wins, otherwise a stable hue derived
 * from its category — and failing that from the series id, so every instance of
 * one event is always the same colour for everyone in the family.
 */
export function occurrenceColor(
  occurrence: Pick<EventOccurrenceResponse, 'color' | 'category' | 'seriesId' | 'sourceKind'>,
): string {
  if (occurrence.color) return occurrence.color;
  if (occurrence.sourceKind === 'user_birthday') return BIRTHDAY_COLOR;
  return hueColor(occurrence.category ?? occurrence.seriesId);
}

const BIRTHDAY_COLOR = '#d9a441';

function hueColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360;
  }
  return `oklch(0.62 0.13 ${String(hash)})`;
}

/* -------------------------------------------------------------------------- */
/* The restricted recurrence grammar                                          */
/* -------------------------------------------------------------------------- */

/**
 * The arms the builder offers. Deliberately one more than the preset union:
 * `weekly` and `weekly_interval` both compile to `FREQ=WEEKLY`, but "по дням
 * недели" and "раз в N недель" are two different questions to a human.
 */
export const RECURRENCE_ARMS = [
  'once',
  'daily',
  'weekly',
  'weekly_interval',
  'monthly_day',
  'monthly_last_day',
] as const;
export type RecurrenceArm = (typeof RECURRENCE_ARMS)[number];

export interface RecurrenceBuilderState {
  arm: RecurrenceArm;
  /** "Каждые N дней / недель / месяцев". Ignored by `once`. */
  interval: number;
  weekdays: Weekday[];
  dayOfMonth: number;
  ends: RecurrenceEnd;
}

export const WEEKDAY_ORDER: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** `MO`… for a local date key, so the builder can seed itself from the date. */
export function weekdayCodeOf(key: DateKey): Weekday {
  return WEEKDAY_ORDER[mondayWeekdayIndex(key)] ?? 'MO';
}

export function defaultRecurrenceState(dtstartLocal: string): RecurrenceBuilderState {
  const key = dtstartLocal.slice(0, 10);
  return {
    arm: 'once',
    interval: 1,
    weekdays: [weekdayCodeOf(key)],
    dayOfMonth: dayOfMonth(key),
    ends: { type: 'never' },
  };
}

/** Builder state → the `preset` half of the contract. `null` for a one-off. */
export function buildPreset(state: RecurrenceBuilderState): RecurrencePreset | null {
  const interval = clampInterval(state.interval);
  switch (state.arm) {
    case 'once':
      return null;
    case 'daily':
      return { kind: 'daily', interval };
    case 'weekly':
      // "По дням недели" is weekly with interval 1 — the weekdays carry the rule.
      return { kind: 'weekly', interval: 1, weekdays: normalizeWeekdays(state.weekdays) };
    case 'weekly_interval':
      return { kind: 'weekly', interval, weekdays: normalizeWeekdays(state.weekdays) };
    case 'monthly_day':
      return { kind: 'monthly_day', interval, dayOfMonth: clampDayOfMonth(state.dayOfMonth) };
    case 'monthly_last_day':
      return { kind: 'monthly_last_day', interval };
  }
}

/** Builder state + anchor → the `recurrence` field of the event contract. */
export function buildRecurrenceSpec(
  state: RecurrenceBuilderState,
  anchor: { dtstartLocal: string; timezone: string },
): RecurrenceSpec {
  const preset = buildPreset(state);
  if (!preset) {
    return { mode: 'once', ...anchor, rdatesLocal: [], exdatesLocal: [] };
  }
  return {
    mode: 'preset',
    preset,
    ends: state.ends,
    ...anchor,
    rdatesLocal: [],
    exdatesLocal: [],
  };
}

/**
 * The inverse, for pre-filling the edit form. A rule the backend could not
 * decompile (`preset === null` with a non-null `rrule`) returns `null` — the UI
 * then shows the summary read-only rather than silently rewriting the schedule.
 */
export function recurrenceStateFrom(
  view: Pick<RecurrenceView, 'rrule' | 'preset' | 'ends' | 'dtstartLocal'>,
): RecurrenceBuilderState | null {
  const fallback = defaultRecurrenceState(view.dtstartLocal);
  if (!view.rrule) return fallback;
  if (!view.preset) return null;

  const ends = view.ends ?? { type: 'never' };
  switch (view.preset.kind) {
    case 'daily':
      return { ...fallback, arm: 'daily', interval: view.preset.interval, ends };
    case 'weekly':
      return {
        ...fallback,
        arm: view.preset.interval > 1 ? 'weekly_interval' : 'weekly',
        interval: view.preset.interval,
        weekdays: normalizeWeekdays(view.preset.weekdays),
        ends,
      };
    case 'monthly_day':
      return {
        ...fallback,
        arm: 'monthly_day',
        interval: view.preset.interval,
        dayOfMonth: view.preset.dayOfMonth,
        ends,
      };
    case 'monthly_last_day':
      return { ...fallback, arm: 'monthly_last_day', interval: view.preset.interval, ends };
  }
}

/** Does this series repeat? The one test the edit-scope prompt hangs on. */
export function isRecurring(view: Pick<RecurrenceView, 'rrule'> | null | undefined): boolean {
  return Boolean(view?.rrule);
}

function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(99, Math.max(1, Math.trunc(value)));
}

function clampDayOfMonth(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(31, Math.max(1, Math.trunc(value)));
}

function normalizeWeekdays(weekdays: readonly Weekday[]): Weekday[] {
  const unique = [...new Set(weekdays)];
  const ordered = WEEKDAY_ORDER.filter((code) => unique.includes(code));
  return ordered.length > 0 ? ordered : ['MO'];
}

/* -------------------------------------------------------------------------- */
/* Floating local datetimes                                                   */
/* -------------------------------------------------------------------------- */

/** `('2026-09-07', '09:30')` → `'2026-09-07T09:30:00'` (D2 floating local). */
export function toFloatingLocal(dateKey: DateKey, time: string): string {
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '00:00';
  return `${dateKey}T${hhmm}:00`;
}

export function dateKeyOfFloating(value: string): DateKey {
  return value.slice(0, 10);
}

export function timeOfFloating(value: string): string {
  return value.slice(11, 16);
}
