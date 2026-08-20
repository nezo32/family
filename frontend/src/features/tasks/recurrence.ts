import type {
  RecurrenceEnd,
  RecurrencePreset,
  RecurrenceSpec,
  RecurrenceView,
  Weekday,
} from '@family/shared';
import { joinFloating, splitFloating } from '@/shared/lib/datetime';
import { TASKS_RU, WEEKDAY_OPTIONS_RU } from './locale';

/**
 * Client side of the **restricted recurrence grammar** (D2,
 * `docs/architecture/scheduling.md` §7).
 *
 * The UI may only ever author `recurrencePresetSchema` values — never RRULE
 * text. The backend compiles a preset to a rule and decompiles it back; when a
 * stored rule falls outside the grammar (an ICS import), the server sends
 * `preset: null` and the UI shows the rule read-only with its Russian summary.
 *
 * Everything in this module is pure so the builder can be unit tested without
 * rendering a form.
 */

/** The arms the builder exposes. `weekly` covers both "по дням недели" and
 *  "раз в N недель"; `monthly_day` covers "N-е число" and "раз в N месяцев". */
export type ScheduleKind = 'once' | 'daily' | 'weekly' | 'monthly_day' | 'monthly_last_day';

export type ScheduleValue =
  { mode: 'once' } | { mode: 'preset'; preset: RecurrencePreset; ends: RecurrenceEnd };

export const ONCE: ScheduleValue = { mode: 'once' };

export const WEEKDAY_ORDER: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/* -------------------------------------------------------------------------- */
/* Floating local datetime helpers (D2: no offset, no Z, seconds mandatory)     */
/* -------------------------------------------------------------------------- */

/**
 * `splitFloating` / `joinFloating` moved to `shared/lib/datetime.ts` when the
 * date & time field components were built on them: the same two functions had
 * to exist on both sides of the `shared` boundary, and two copies of "how a
 * floating local datetime is taken apart" is exactly the kind of duplication
 * D2 cannot afford. Re-exported here so no call site in this feature moved.
 */
export { joinFloating, splitFloating };

/** Today's local calendar date in the family timezone, as `YYYY-MM-DD`. */
export function todayKey(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** Calendar arithmetic on a `YYYY-MM-DD` key. UTC maths, so DST cannot bite. */
export function addDaysToKey(key: string, days: number): string {
  const time = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(time)) return key;
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

/** ISO weekday code of a `YYYY-MM-DD` key, for seeding the weekly arm. */
export function weekdayOfKey(key: string): Weekday {
  const time = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(time)) return 'MO';
  // `getUTCDay()` is 0=Sunday; WEEKDAY_ORDER is Monday-first.
  const index = (new Date(time).getUTCDay() + 6) % 7;
  return WEEKDAY_ORDER[index] ?? 'MO';
}

/** Day-of-month of a `YYYY-MM-DD` key, clamped into the schema's 1..31. */
export function dayOfMonthOfKey(key: string): number {
  const day = Number(key.slice(8, 10));
  return Number.isFinite(day) && day >= 1 && day <= 31 ? day : 1;
}

/* -------------------------------------------------------------------------- */
/* Grammar helpers                                                             */
/* -------------------------------------------------------------------------- */

export function kindOf(value: ScheduleValue): ScheduleKind {
  return value.mode === 'once' ? 'once' : value.preset.kind;
}

/**
 * A sensible preset for a freshly picked arm, anchored on the start date so
 * "по дням недели" pre-selects the weekday the user already chose.
 */
export function presetForKind(
  kind: Exclude<ScheduleKind, 'once'>,
  dtstartLocal: string,
): RecurrencePreset {
  const { date } = splitFloating(dtstartLocal);
  switch (kind) {
    case 'daily':
      return { kind: 'daily', interval: 1 };
    case 'weekly':
      return { kind: 'weekly', interval: 1, weekdays: [weekdayOfKey(date)] };
    case 'monthly_day':
      return { kind: 'monthly_day', interval: 1, dayOfMonth: dayOfMonthOfKey(date) };
    case 'monthly_last_day':
      return { kind: 'monthly_last_day', interval: 1 };
  }
}

/** Switch arms while keeping whatever the user already configured. */
export function scheduleForKind(
  kind: ScheduleKind,
  dtstartLocal: string,
  previous: ScheduleValue,
): ScheduleValue {
  if (kind === 'once') return ONCE;
  const ends: RecurrenceEnd = previous.mode === 'preset' ? previous.ends : { type: 'never' };
  if (previous.mode === 'preset' && previous.preset.kind === kind) return previous;
  return { mode: 'preset', preset: presetForKind(kind, dtstartLocal), ends };
}

/** Toggle a weekday in the `weekly` arm, refusing to empty the set (min 1). */
export function toggleWeekday(weekdays: readonly Weekday[], day: Weekday): Weekday[] {
  const has = weekdays.includes(day);
  const next = has ? weekdays.filter((d) => d !== day) : [...weekdays, day];
  const sorted = WEEKDAY_ORDER.filter((d) => next.includes(d));
  return sorted.length > 0 ? sorted : [day];
}

/** Bounds from `recurrenceIntervalSchema` (1..99). */
export function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(99, Math.max(1, Math.trunc(value)));
}

export function clampDayOfMonth(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(31, Math.max(1, Math.trunc(value)));
}

export function clampCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1000, Math.max(1, Math.trunc(value)));
}

/* -------------------------------------------------------------------------- */
/* Contract <-> UI conversion                                                  */
/* -------------------------------------------------------------------------- */

/** Build the wire shape. The anchor is always `dtstartLocal` + `timezone`. */
export function toRecurrenceSpec(
  value: ScheduleValue,
  dtstartLocal: string,
  timezone: string,
): RecurrenceSpec {
  const anchor = { dtstartLocal, timezone, rdatesLocal: [], exdatesLocal: [] };
  if (value.mode === 'once') return { mode: 'once', ...anchor };
  return { mode: 'preset', preset: value.preset, ends: value.ends, ...anchor };
}

/**
 * Pre-fill the builder from a saved series.
 *
 * Returns `null` when the stored rule is outside the grammar — that is the
 * signal to render the schedule read-only and offer «Заменить расписание».
 */
export function scheduleFromView(view: RecurrenceView): ScheduleValue | null {
  if (view.rrule === null) return ONCE;
  if (view.preset === null) return null;
  return { mode: 'preset', preset: view.preset, ends: view.ends ?? { type: 'never' } };
}

/** `true` when the series repeats — the trigger for the edit-scope prompt. */
export function isRecurring(view: Pick<RecurrenceView, 'rrule'>): boolean {
  return view.rrule !== null;
}

/* -------------------------------------------------------------------------- */
/* Russian preview                                                             */
/* -------------------------------------------------------------------------- */

function weekdayNames(weekdays: readonly Weekday[]): string {
  return WEEKDAY_ORDER.filter((day) => weekdays.includes(day))
    .map((day) => WEEKDAY_OPTIONS_RU.find((option) => option.value === day)?.long ?? day)
    .join(', ');
}

function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [token, value]) => text.split(token).join(value),
    template,
  );
}

/**
 * A human sentence for the schedule the user is currently building. Saved
 * series render `recurrence.summary` from the server instead — this exists so
 * the builder can be honest before anything is written.
 */
export function describeSchedule(value: ScheduleValue, dtstartLocal: string): string {
  const s = TASKS_RU.summary;
  const { time } = splitFloating(dtstartLocal);
  const at = fill(s.at, { '%t': time });

  if (value.mode === 'once') return `${s.once}, ${at}`;

  const { preset, ends } = value;
  let head: string;
  switch (preset.kind) {
    case 'daily':
      head = preset.interval === 1 ? s.daily : fill(s.everyDays, { '%n': String(preset.interval) });
      break;
    case 'weekly': {
      const days = weekdayNames(preset.weekdays);
      head =
        preset.interval === 1
          ? fill(s.weeklyBy, { '%d': days })
          : fill(s.weeklyEveryBy, { '%n': String(preset.interval), '%d': days });
      break;
    }
    case 'monthly_day':
      head =
        preset.interval === 1
          ? fill(s.monthlyDay, { '%d': String(preset.dayOfMonth) })
          : fill(s.monthlyEveryDay, {
              '%n': String(preset.interval),
              '%d': String(preset.dayOfMonth),
            });
      break;
    case 'monthly_last_day':
      head =
        preset.interval === 1
          ? s.monthlyLastDay
          : fill(s.monthlyEveryLastDay, { '%n': String(preset.interval) });
      break;
  }

  const tail =
    ends.type === 'after'
      ? `, ${fill(s.endsAfter, { '%n': String(ends.count) })}`
      : ends.type === 'until'
        ? `, ${fill(s.endsUntil, { '%d': splitFloating(ends.untilLocal).date })}`
        : '';

  return `${head}, ${at}${tail}`;
}
