/**
 * Value shapes for the date & time fields.
 *
 * The API contract (D2) speaks three shapes and none of them is an instant:
 *
 * - a **date key** — `2026-09-07`, a calendar day with no clock and no zone;
 * - a **time of day** — `09:00`, a wall clock with no day;
 * - a **floating local datetime** — `2026-09-07T09:00:00`, no offset, no `Z`.
 *
 * Nothing in this module parses one of those through `Date.parse` (which reads
 * a bare `2026-09-07` as **UTC midnight**) or pushes it through `Intl` with a
 * timezone. Either would move a wall-clock value onto the day before for
 * roughly half the planet — the silent appointment shift D2 exists to prevent.
 * Every `Date` built here is anchored at **local noon**, twelve hours clear of
 * both DST transitions and of the date line, and read back with the local
 * getters it was written with, so `dateKeyToDate → dateToDateKey` is the
 * identity in every timezone.
 *
 * Presentation lives in `shared/lib/format.ts`. This module is shapes only.
 */

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/* -------------------------------------------------------------------------
 * Date keys
 * ---------------------------------------------------------------------- */

/**
 * `2026-09-07` → a `Date` at **local noon** on that day, or `null`.
 *
 * Local noon rather than midnight so the value cannot be dragged into the
 * previous day by a DST transition that happens at 00:00 (Brazil, Chile, Iran
 * have all had one), and so `react-day-picker`'s same-day comparison — which
 * uses the local getters — lands on the day the user actually picked.
 */
export function dateKeyToDate(key: string): Date | null {
  const match = DATE_KEY_PATTERN.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  // Rejects 31 февраля instead of silently becoming 3 марта.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/** A `Date` → `2026-09-07`, read with the same local getters it was built with. */
export function dateToDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Today as a date key, in the **device** timezone. */
export function todayDateKey(now: Date = new Date()): string {
  return dateToDateKey(now);
}

/* -------------------------------------------------------------------------
 * Times of day
 * ---------------------------------------------------------------------- */

/** True for a `HH:mm` inside 00:00–23:59. */
export function isTimeValue(value: string): boolean {
  const match = TIME_PATTERN.exec(value);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/**
 * What the user typed → a canonical `HH:mm`, or `null` when it is not a time.
 *
 * Deliberately forgiving about the separator and the leading zero, because the
 * point of the field is that somebody can type `930` on a phone keyboard and
 * get 09:30. Deliberately **not** forgiving about the minutes: `09:75` is not
 * silently carried into 10:15 — a value nobody typed must never be committed.
 *
 * Accepted: `9`, `09`, `930`, `0930`, `9:30`, `09.30`, `9 30`, `9-30`.
 */
export function parseTimeInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const separated = /^(\d{1,2})\s*[:.\-\s]\s*(\d{1,2})$/.exec(trimmed);
  if (separated) {
    return buildTime(Number(separated[1]), Number(separated[2]));
  }

  const digits = /^\d{1,4}$/.exec(trimmed)?.[0];
  if (digits === undefined) return null;

  // `9` and `09` are an hour; `930` and `0930` are an hour and minutes.
  if (digits.length <= 2) return buildTime(Number(digits), 0);
  const split = digits.length === 3 ? 1 : 2;
  return buildTime(Number(digits.slice(0, split)), Number(digits.slice(split)));
}

function buildTime(hours: number, minutes: number): string | null {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------
 * Floating local datetimes (D2)
 * ---------------------------------------------------------------------- */

/** `2026-09-07T09:00:00` → `{ date: '2026-09-07', time: '09:00' }`. */
export function splitFloating(value: string): { date: string; time: string } {
  const [date = '', rest = ''] = value.split('T');
  return { date, time: rest.slice(0, 5) };
}

/**
 * `('2026-09-07', '09:00')` → `2026-09-07T09:00:00`.
 *
 * Seconds are mandatory in the contract and always `:00` here: no field in this
 * app offers seconds, so appending them is the whole of the normalisation.
 */
export function joinFloating(date: string, time: string): string {
  const normalized = time.length === 5 ? `${time}:00` : time;
  return `${date}T${normalized}`;
}
