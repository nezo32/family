import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from 'temporal-polyfill';

import { pluralRu, RU_PLURALS } from '@family/shared';
import type { RecurrenceEnd, RecurrencePreset, Weekday } from '@family/shared';

import { AppError } from '../errors.js';

/**
 * The recurrence adapter (D2 / `docs/architecture/scheduling.md` §7).
 *
 * **This is the only module in the repo allowed to import `rrule-temporal` or
 * `temporal-polyfill`.** Everything else takes the `RecurrenceEngine`
 * interface. All datetimes crossing that interface are floating local strings
 * (`YYYY-MM-DDTHH:mm:ss`) or explicit `{ instant, timezone }` pairs — never a
 * bare `Date` used as a wall-clock carrier.
 *
 * ## Why expansion happens in "floating space"
 *
 * A rule is a statement about the **wall clock**: "every day at 02:30" means
 * 02:30 forever, including on the morning the clocks jump. So the expansion is
 * run against a `DTSTART` pinned to `UTC` carrying the *local* wall-clock
 * digits. UTC has no transitions, so the expansion is pure calendar arithmetic
 * and produces exactly the floating local keys the rule means.
 *
 * This is not a stylistic choice. Expanding directly in the target zone makes
 * `rrule-temporal` chain its cursor **through** the gap: a daily 02:30 series
 * across the Berlin spring-forward yields
 * `02:30, 02:30, 03:30, 03:30, 03:30, …` — the time of day is permanently
 * shifted, and worse, the shift depends on where the query window started. That
 * would make `occurrence_key` unstable, and an unstable key destroys the entire
 * `ON CONFLICT (series_id, occurrence_key) DO NOTHING` idempotency guarantee:
 * every horizon extension would resurrect phantom duplicates.
 *
 * With floating expansion the keys are window-independent and byte-identical on
 * every run, and DST is resolved exactly once — in {@link toInstant}, with
 * `disambiguation: 'compatible'` (gap ⇒ push forward, overlap ⇒ take the
 * earlier instance), which is what Google Calendar does.
 */

/** `YYYY-MM-DDTHH:mm:ss`, no offset, no Z. */
export type FloatingDateTime = string;

/** IANA id, e.g. 'Europe/Moscow'. */
export type TimeZoneId = string;

export interface SeriesRule {
  /** RRULE line WITHOUT DTSTART, or null for a one-off. */
  rrule: string | null;
  dtstartLocal: FloatingDateTime;
  timezone: TimeZoneId;
  rdatesLocal: FloatingDateTime[];
  exdatesLocal: FloatingDateTime[];
}

export interface ExpandWindow {
  from: Date;
  to: Date;
  maxCount?: number;
}

export interface RecurrenceEngine {
  expand(rule: SeriesRule, window: ExpandWindow): FloatingDateTime[];
  toInstant(local: FloatingDateTime, tz: TimeZoneId): Date;
  addWallClock(
    local: FloatingDateTime,
    minutes: number,
    tz: TimeZoneId,
  ): { local: FloatingDateTime; instant: Date };
  localDateOf(local: FloatingDateTime): string;
  seriesEndsAt(rule: SeriesRule): Date | null;
  compile(
    preset: RecurrencePreset,
    ends: RecurrenceEnd,
    dtstartLocal: FloatingDateTime,
    timezone?: TimeZoneId,
  ): string;
  decompile(
    rrule: string,
    timezone?: TimeZoneId,
  ): { preset: RecurrencePreset; ends: RecurrenceEnd } | null;
  describe(rule: SeriesRule): string;
  withUntilBefore(rule: SeriesRule, key: FloatingDateTime): string;
}

/** Default hard cap on how many keys one `expand()` call may return. */
export const DEFAULT_MAX_COUNT = 1000;

/**
 * How many raw occurrences the library may generate for a single `expand()`
 * before we give up on it. A malformed ICS import (`FREQ=SECONDLY`) must
 * degrade to a truncated series, never to a hung BullMQ worker.
 */
const SCAN_LIMIT = 50_000;

/** The zone the expansion runs in. Deliberately transition-free — see above. */
const FLOATING_ZONE = 'UTC';

const FLOATING_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

function invalid(message: string, context?: Record<string, unknown>): AppError {
  return new AppError('BAD_REQUEST', message, context ? { context } : undefined);
}

/**
 * Canonicalise a floating local datetime to `YYYY-MM-DDTHH:mm:ss`.
 *
 * Canonical form matters for more than tidiness: keys are compared, sorted and
 * de-duplicated as **strings**, and an ISO local datetime only sorts
 * chronologically when every field is zero-padded and the seconds are present.
 */
function normalizeLocal(local: FloatingDateTime): FloatingDateTime {
  let parsed: Temporal.PlainDateTime;
  try {
    parsed = Temporal.PlainDateTime.from(local);
  } catch (cause) {
    throw invalid(`Invalid floating local datetime: ${String(local)}`, { cause: String(cause) });
  }
  const text = parsed.toString({ smallestUnit: 'second' });
  if (!FLOATING_RE.test(text)) {
    throw invalid(`Invalid floating local datetime: ${String(local)}`);
  }
  return text;
}

/**
 * Validated zone ids. A materializer pass resolves the same handful of zones
 * thousands of times, and validation is the only per-call cost worth avoiding —
 * the *rules* are never cached, because caching an offset is precisely the bug
 * D2 exists to prevent.
 */
const validatedZones = new Set<string>();

function assertTimeZone(tz: TimeZoneId): TimeZoneId {
  if (typeof tz !== 'string' || tz.length === 0) throw invalid('Timezone is required');
  if (validatedZones.has(tz)) return tz;
  try {
    Temporal.ZonedDateTime.from(`2026-01-01T00:00:00[${tz}]`);
  } catch (cause) {
    throw invalid(`Unknown IANA timezone: ${tz}`, { cause: String(cause) });
  }
  validatedZones.add(tz);
  return tz;
}

function zonedFromLocal(local: FloatingDateTime, tz: TimeZoneId): Temporal.ZonedDateTime {
  return Temporal.PlainDateTime.from(normalizeLocal(local)).toZonedDateTime(assertTimeZone(tz), {
    // 'compatible': spring-forward gap pushes forward, fall-back overlap takes
    // the EARLIER instance. Matches Google Calendar and RFC 5545 §3.3.5.
    disambiguation: 'compatible',
  });
}

function localOfInstant(instant: Date, tz: TimeZoneId): FloatingDateTime {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) throw invalid('Invalid Date passed to the recurrence engine');
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(assertTimeZone(tz))
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' });
}

/** `20261231T235959Z` — the RFC 5545 basic UTC form used by `UNTIL`. */
function toIcsUtc(instant: Date): string {
  return Temporal.Instant.fromEpochMilliseconds(instant.getTime())
    .toZonedDateTimeISO('UTC')
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
    .replace(/[-:]/g, '')
    .concat('Z');
}

/* -------------------------------------------------------------------------- */
/* RRULE text handling                                                         */
/* -------------------------------------------------------------------------- */

type RuleParts = Map<string, string>;

function parseParts(rrule: string): RuleParts {
  const line = rrule.trim().replace(/^RRULE:/i, '');
  const parts: RuleParts = new Map();
  for (const chunk of line.split(';')) {
    if (chunk.trim() === '') continue;
    const eq = chunk.indexOf('=');
    if (eq <= 0) throw invalid(`Malformed RRULE part: ${chunk}`);
    parts.set(chunk.slice(0, eq).trim().toUpperCase(), chunk.slice(eq + 1).trim());
  }
  if (!parts.has('FREQ')) throw invalid('RRULE must contain FREQ=');
  return parts;
}

function stringifyParts(parts: RuleParts): string {
  return [...parts.entries()].map(([k, v]) => `${k}=${v}`).join(';');
}

/**
 * Parse an `UNTIL` value into a floating local datetime **in the series zone**.
 *
 * `UNTIL` is stored per RFC 5545 as a UTC instant (`…Z`). The expansion runs in
 * floating space, so the bound has to be translated into the same space — with
 * the series timezone, using the tzdb rules in force on that date. This is the
 * step that a naive implementation gets wrong by treating the digits as local.
 */
function untilToLocal(raw: string, tz: TimeZoneId): FloatingDateTime {
  const value = raw.trim().toUpperCase();

  // Date-only form (`UNTIL=20261231`): inclusive end of that day, floating.
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T23:59:59`;
  }

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!dateTime) throw invalid(`Malformed UNTIL value: ${raw}`);
  const [, y, mo, d, h, mi, s, zulu] = dateTime;
  const wall = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  // A floating UNTIL (no `Z`) is already in the series' wall clock.
  if (zulu !== 'Z') return normalizeLocal(wall);
  return localOfInstant(
    new Date(Temporal.ZonedDateTime.from(`${wall}[UTC]`).epochMilliseconds),
    tz,
  );
}

/**
 * Rewrite the rule so it is expressible in floating space: `UNTIL` is
 * translated from its UTC instant into the series wall clock. The `Z` suffix is
 * kept because the synthetic `DTSTART` is zoned (`[UTC]`) and RFC 5545 requires
 * a UTC `UNTIL` in that case — and in floating space "UTC" *is* the wall clock.
 */
function toFloatingRule(rrule: string, tz: TimeZoneId): string {
  const parts = parseParts(rrule);
  const until = parts.get('UNTIL');
  if (until !== undefined) {
    parts.set('UNTIL', `${untilToLocal(until, tz).replace(/[-:]/g, '')}Z`);
  }
  return stringifyParts(parts);
}

function buildRule(
  rrule: string,
  dtstartLocal: FloatingDateTime,
  tz: TimeZoneId,
  maxIterations: number,
): RRuleTemporal<Temporal.ZonedDateTime> {
  return new RRuleTemporal<Temporal.ZonedDateTime>({
    rruleString: toFloatingRule(rrule, tz),
    dtstart: Temporal.ZonedDateTime.from(`${normalizeLocal(dtstartLocal)}[${FLOATING_ZONE}]`),
    // Hand the library our polyfill namespace so every value it returns is a
    // `Temporal.ZonedDateTime` from the same implementation we use here.
    temporal: Temporal,
    maxIterations,
  });
}

function keyOf(zdt: Temporal.ZonedDateTime): FloatingDateTime {
  return zdt.toPlainDateTime().toString({ smallestUnit: 'second' });
}

/**
 * Expand `rrule` into floating local keys inside `[fromLocal, toLocal]`.
 *
 * `between()` is the fast path — `rrule-temporal@2` phase-aligns `DTSTART` to
 * the window start, so a series that began in 2015 costs a handful of
 * iterations rather than a decade of them. If the rule is dense enough that the
 * library trips its own `maxIterations` guard, we fall back to a scan that is
 * hard-bounded by the same budget, so the worst case is a truncated series
 * rather than a stalled worker.
 */
function expandRule(
  rrule: string,
  dtstartLocal: FloatingDateTime,
  tz: TimeZoneId,
  fromLocal: FloatingDateTime,
  toLocal: FloatingDateTime,
  maxCount: number,
): FloatingDateTime[] {
  const after = Temporal.ZonedDateTime.from(`${fromLocal}[${FLOATING_ZONE}]`);
  const before = Temporal.ZonedDateTime.from(`${toLocal}[${FLOATING_ZONE}]`);

  try {
    const rule = buildRule(rrule, dtstartLocal, tz, SCAN_LIMIT);
    return rule.between(after, before, true).slice(0, maxCount).map(keyOf);
  } catch {
    // Pathological rule (or a library iteration guard): degrade gracefully.
    const rule = buildRule(rrule, dtstartLocal, tz, SCAN_LIMIT * 2);
    const out: FloatingDateTime[] = [];
    let scanned = 0;
    rule.all((zdt) => {
      scanned += 1;
      if (scanned > SCAN_LIMIT) return false;
      const key = keyOf(zdt);
      if (key > toLocal) return false;
      if (key >= fromLocal) {
        out.push(key);
        if (out.length >= maxCount) return false;
      }
      return true;
    });
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* Russian formatting                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 1 день / 2 дня / 5 дней — `pluralRu` from `@family/shared`.
 *
 * This was the sixth hand-written copy of the same rule. The `RU_PLURALS`
 * entries it needs carry the case the sentence puts them in: «Каждые 3
 * **недели**» is accusative, so it reads `weekAccusative`, not `week`.
 */

/** True when `n` takes the singular determiner: 1, 21, 31 — but not 11. */
function takesSingularDeterminer(n: number): boolean {
  const abs = Math.abs(n);
  return abs % 10 === 1 && abs % 100 !== 11;
}

function everyDays(n: number): string {
  if (n === 1) return 'Каждый день';
  const det = takesSingularDeterminer(n) ? 'Каждый' : 'Каждые';
  return `${det} ${n} ${pluralRu(n, RU_PLURALS.day)}`;
}

function everyWeeks(n: number): string {
  if (n === 1) return 'Каждую неделю';
  const det = takesSingularDeterminer(n) ? 'Каждую' : 'Каждые';
  return `${det} ${n} ${pluralRu(n, RU_PLURALS.weekAccusative)}`;
}

function everyMonths(n: number): string {
  if (n === 1) return 'Каждый месяц';
  const det = takesSingularDeterminer(n) ? 'Каждый' : 'Каждые';
  return `${det} ${n} ${pluralRu(n, RU_PLURALS.month)}`;
}

interface WeekdayForms {
  /** Accusative — the case that follows «Каждый/Каждую/Каждое». */
  readonly accusative: string;
  /** Dative plural — the case that follows «по». */
  readonly dative: string;
  /** The determiner agreeing with this weekday's gender. */
  readonly determiner: string;
}

const WEEKDAYS: Record<Weekday, WeekdayForms> = {
  MO: { accusative: 'понедельник', dative: 'понедельникам', determiner: 'Каждый' },
  TU: { accusative: 'вторник', dative: 'вторникам', determiner: 'Каждый' },
  WE: { accusative: 'среду', dative: 'средам', determiner: 'Каждую' },
  TH: { accusative: 'четверг', dative: 'четвергам', determiner: 'Каждый' },
  FR: { accusative: 'пятницу', dative: 'пятницам', determiner: 'Каждую' },
  SA: { accusative: 'субботу', dative: 'субботам', determiner: 'Каждую' },
  SU: { accusative: 'воскресенье', dative: 'воскресеньям', determiner: 'Каждое' },
};

/** RFC 5545 / ISO week order, so a compiled BYDAY list is always canonical. */
const WEEKDAY_ORDER: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

/** «а, б и в» */
function joinRu(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  const head = items.slice(0, -1).join(', ');
  return `${head} и ${items[items.length - 1] ?? ''}`;
}

function timeOf(local: FloatingDateTime): string {
  return normalizeLocal(local).slice(11, 16);
}

function dateOfRu(local: FloatingDateTime): string {
  const pdt = Temporal.PlainDateTime.from(normalizeLocal(local));
  return `${pdt.day} ${MONTHS_GENITIVE[pdt.month - 1] ?? ''} ${pdt.year} г.`;
}

function shortDateRu(local: FloatingDateTime): string {
  const pdt = Temporal.PlainDateTime.from(normalizeLocal(local));
  const dd = String(pdt.day).padStart(2, '0');
  const mm = String(pdt.month).padStart(2, '0');
  return `${dd}.${mm}.${pdt.year}`;
}

function sortWeekdays(days: readonly Weekday[]): Weekday[] {
  return [...new Set(days)].sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b));
}

/* -------------------------------------------------------------------------- */
/* Preset compilation                                                          */
/* -------------------------------------------------------------------------- */

function isWeekday(value: string): value is Weekday {
  return (WEEKDAY_ORDER as readonly string[]).includes(value);
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  return n > 0 ? n : null;
}

/** Parts a decompilable rule is allowed to carry. Anything else ⇒ read-only. */
const ALLOWED_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'BYDAY',
  'BYMONTHDAY',
  'COUNT',
  'UNTIL',
  'WKST',
]);

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

export const recurrenceEngine: RecurrenceEngine = {
  expand(rule: SeriesRule, window: ExpandWindow): FloatingDateTime[] {
    const maxCount = window.maxCount ?? DEFAULT_MAX_COUNT;
    if (!Number.isInteger(maxCount) || maxCount <= 0) return [];

    const tz = assertTimeZone(rule.timezone);
    const fromLocal = localOfInstant(window.from, tz);
    const toLocal = localOfInstant(window.to, tz);
    if (fromLocal > toLocal) return [];

    const keys = new Set<FloatingDateTime>();

    if (rule.rrule !== null && rule.rrule.trim() !== '') {
      for (const key of expandRule(
        rule.rrule,
        rule.dtstartLocal,
        tz,
        fromLocal,
        toLocal,
        maxCount,
      )) {
        keys.add(key);
      }
    } else {
      // A one-off is the same shape with a single occurrence at DTSTART.
      const only = normalizeLocal(rule.dtstartLocal);
      if (only >= fromLocal && only <= toLocal) keys.add(only);
    }

    // RFC 5545 order: RRULE ∪ RDATE, then subtract EXDATE.
    for (const rdate of rule.rdatesLocal) {
      const key = normalizeLocal(rdate);
      if (key >= fromLocal && key <= toLocal) keys.add(key);
    }
    const excluded = new Set(rule.exdatesLocal.map(normalizeLocal));

    return [...keys]
      .filter((key) => !excluded.has(key))
      .sort()
      .slice(0, maxCount);
  },

  toInstant(local: FloatingDateTime, tz: TimeZoneId): Date {
    return new Date(zonedFromLocal(local, tz).epochMilliseconds);
  },

  addWallClock(
    local: FloatingDateTime,
    minutes: number,
    tz: TimeZoneId,
  ): { local: FloatingDateTime; instant: Date } {
    if (!Number.isInteger(minutes)) throw invalid('addWallClock expects whole minutes');
    // `zdt.add({ minutes })`, NEVER `instant + n * 60000`: the anchor has to be
    // resolved with DST disambiguation first, and the result has to come back
    // out as a wall clock in the same zone.
    const moved = zonedFromLocal(local, tz).add({ minutes });
    return {
      local: moved.toPlainDateTime().toString({ smallestUnit: 'second' }),
      instant: new Date(moved.epochMilliseconds),
    };
  },

  localDateOf(local: FloatingDateTime): string {
    return normalizeLocal(local).slice(0, 10);
  },

  seriesEndsAt(rule: SeriesRule): Date | null {
    const tz = assertTimeZone(rule.timezone);
    const excluded = new Set(rule.exdatesLocal.map(normalizeLocal));
    const rdates = rule.rdatesLocal.map(normalizeLocal).filter((k) => !excluded.has(k));
    const lastRdate = rdates.length > 0 ? rdates.sort().at(-1) : undefined;

    const maxOf = (a: FloatingDateTime | undefined, b: FloatingDateTime | undefined) =>
      a === undefined ? b : b === undefined ? a : a > b ? a : b;

    if (rule.rrule === null || rule.rrule.trim() === '') {
      const only = normalizeLocal(rule.dtstartLocal);
      const last = maxOf(excluded.has(only) ? undefined : only, lastRdate);
      return last === undefined ? null : this.toInstant(last, tz);
    }

    const parts = parseParts(rule.rrule);
    const count = parsePositiveInt(parts.get('COUNT'));
    const until = parts.get('UNTIL');

    // No COUNT and no UNTIL ⇒ the rule runs forever; an RDATE cannot bound it.
    if (count === null && until === undefined) return null;

    let lastRuleKey: FloatingDateTime | undefined;

    if (count !== null) {
      const built = buildRule(rule.rrule, rule.dtstartLocal, tz, SCAN_LIMIT);
      const all = built
        .all()
        .map(keyOf)
        .filter((k) => !excluded.has(k));
      lastRuleKey = all.at(-1);
    } else if (until !== undefined) {
      const untilLocal = untilToLocal(until, tz);
      const built = buildRule(rule.rrule, rule.dtstartLocal, tz, SCAN_LIMIT);
      let cursor = Temporal.ZonedDateTime.from(`${untilLocal}[${FLOATING_ZONE}]`);
      // Walk back past EXDATEs. Bounded so a series whose tail is entirely
      // excluded cannot spin.
      for (let i = 0; i < 500; i += 1) {
        const previous = built.previous(cursor, true);
        if (previous === null) break;
        const key = keyOf(previous);
        if (!excluded.has(key)) {
          lastRuleKey = key;
          break;
        }
        cursor = previous.subtract({ seconds: 1 });
      }
    }

    const last = maxOf(lastRuleKey, lastRdate);
    return last === undefined ? null : this.toInstant(last, tz);
  },

  compile(
    preset: RecurrencePreset,
    ends: RecurrenceEnd,
    dtstartLocal: FloatingDateTime,
    timezone: TimeZoneId = FLOATING_ZONE,
  ): string {
    const anchor = normalizeLocal(dtstartLocal);
    const parts: string[] = [];

    switch (preset.kind) {
      case 'daily':
        parts.push('FREQ=DAILY', `INTERVAL=${preset.interval}`);
        break;
      case 'weekly': {
        const days = sortWeekdays(preset.weekdays);
        if (days.length === 0) throw invalid('weekly preset requires at least one weekday');
        parts.push('FREQ=WEEKLY', `INTERVAL=${preset.interval}`, `BYDAY=${days.join(',')}`);
        break;
      }
      case 'monthly_day':
        parts.push(
          'FREQ=MONTHLY',
          `INTERVAL=${preset.interval}`,
          `BYMONTHDAY=${preset.dayOfMonth}`,
        );
        break;
      case 'monthly_last_day':
        parts.push('FREQ=MONTHLY', `INTERVAL=${preset.interval}`, 'BYMONTHDAY=-1');
        break;
    }

    // RFC 5545 §3.3.10: COUNT and UNTIL are mutually exclusive. The union type
    // makes that structurally impossible here, which is the point of it.
    switch (ends.type) {
      case 'never':
        break;
      case 'after':
        parts.push(`COUNT=${ends.count}`);
        break;
      case 'until': {
        const untilLocal = normalizeLocal(ends.untilLocal);
        if (untilLocal <= anchor) {
          throw invalid('Дата окончания повторения должна быть позже начала', {
            dtstartLocal: anchor,
            untilLocal,
          });
        }
        parts.push(`UNTIL=${toIcsUtc(this.toInstant(untilLocal, timezone))}`);
        break;
      }
    }

    return parts.join(';');
  },

  decompile(
    rrule: string,
    timezone: TimeZoneId = FLOATING_ZONE,
  ): { preset: RecurrencePreset; ends: RecurrenceEnd } | null {
    let parts: RuleParts;
    try {
      parts = parseParts(rrule);
    } catch {
      return null;
    }

    for (const name of parts.keys()) {
      if (!ALLOWED_PARTS.has(name)) return null;
    }
    // A non-Monday week start changes which occurrences a WEEKLY;INTERVAL>1
    // rule produces, so it is outside the grammar the builder can express.
    const wkst = parts.get('WKST');
    if (wkst !== undefined && wkst.toUpperCase() !== 'MO') return null;

    const count = parts.get('COUNT');
    const until = parts.get('UNTIL');
    if (count !== undefined && until !== undefined) return null;

    let ends: RecurrenceEnd = { type: 'never' };
    if (count !== undefined) {
      const parsed = parsePositiveInt(count);
      if (parsed === null || parsed > 1000) return null;
      ends = { type: 'after', count: parsed };
    } else if (until !== undefined) {
      try {
        ends = { type: 'until', untilLocal: untilToLocal(until, timezone) };
      } catch {
        return null;
      }
    }

    const intervalRaw = parts.get('INTERVAL');
    const interval = intervalRaw === undefined ? 1 : parsePositiveInt(intervalRaw);
    if (interval === null || interval > 99) return null;

    const freq = (parts.get('FREQ') ?? '').toUpperCase();
    const byDay = parts.get('BYDAY');
    const byMonthDay = parts.get('BYMONTHDAY');

    if (freq === 'DAILY') {
      if (byDay !== undefined || byMonthDay !== undefined) return null;
      return { preset: { kind: 'daily', interval }, ends };
    }

    if (freq === 'WEEKLY') {
      if (byMonthDay !== undefined || byDay === undefined) return null;
      const tokens = byDay.split(',').map((t) => t.trim().toUpperCase());
      if (tokens.length === 0 || tokens.length > 7) return null;
      // An ordinal token (`2MO`) is a different rule shape than the builder has.
      if (!tokens.every(isWeekday)) return null;
      const weekdays = sortWeekdays(tokens);
      if (weekdays.length !== tokens.length) return null;
      return { preset: { kind: 'weekly', interval, weekdays }, ends };
    }

    if (freq === 'MONTHLY') {
      if (byDay !== undefined || byMonthDay === undefined) return null;
      const values = byMonthDay.split(',').map((v) => v.trim());
      if (values.length !== 1) return null;
      const raw = values[0] ?? '';
      if (raw === '-1') return { preset: { kind: 'monthly_last_day', interval }, ends };
      const day = parsePositiveInt(raw);
      if (day === null || day > 31) return null;
      return { preset: { kind: 'monthly_day', interval, dayOfMonth: day }, ends };
    }

    return null;
  },

  describe(rule: SeriesRule): string {
    const anchor = normalizeLocal(rule.dtstartLocal);
    const time = timeOf(anchor);

    if (rule.rrule === null || rule.rrule.trim() === '') {
      return `Один раз, ${dateOfRu(anchor)}, ${time}`;
    }

    const decompiled = this.decompile(rule.rrule, rule.timezone);
    let head: string;

    if (decompiled === null) {
      head = describeUnsupported(rule.rrule, anchor);
      return `${head}, ${time}`;
    }

    const { preset, ends } = decompiled;
    switch (preset.kind) {
      case 'daily':
        head = everyDays(preset.interval);
        break;
      case 'weekly': {
        const days = sortWeekdays(preset.weekdays);
        if (preset.interval === 1) {
          const first = days[0];
          const determiner = first === undefined ? 'Каждый' : WEEKDAYS[first].determiner;
          head = `${determiner} ${joinRu(days.map((d) => WEEKDAYS[d].accusative))}`;
        } else {
          head = `${everyWeeks(preset.interval)} по ${joinRu(days.map((d) => WEEKDAYS[d].dative))}`;
        }
        break;
      }
      case 'monthly_day':
        head =
          preset.interval === 1
            ? `Каждый месяц, ${preset.dayOfMonth}-го числа`
            : `${everyMonths(preset.interval)}, ${preset.dayOfMonth}-го числа`;
        break;
      case 'monthly_last_day':
        head =
          preset.interval === 1
            ? 'В последний день месяца'
            : `${everyMonths(preset.interval)}, в последний день`;
        break;
    }

    let tail = '';
    if (ends.type === 'after') {
      tail = `, ${ends.count} ${pluralRu(ends.count, RU_PLURALS.times)}`;
    } else if (ends.type === 'until') {
      tail = `, до ${shortDateRu(ends.untilLocal)}`;
    }

    return `${head}, ${time}${tail}`;
  },

  withUntilBefore(rule: SeriesRule, key: FloatingDateTime): string {
    if (rule.rrule === null || rule.rrule.trim() === '') {
      throw invalid('Одиночную задачу нельзя разделить на серии', {
        dtstartLocal: rule.dtstartLocal,
      });
    }
    const anchorInstant = this.toInstant(key, rule.timezone);
    const until = new Date(anchorInstant.getTime() - 1000);

    const parts = parseParts(rule.rrule);
    // RFC 5545 §3.3.10: COUNT and UNTIL must not both appear. Splitting a
    // COUNT-limited series therefore *drops* the count — the old half keeps
    // whatever it already materialized and the successor series carries on.
    parts.delete('COUNT');
    parts.delete('UNTIL');
    parts.set('UNTIL', toIcsUtc(until));
    return stringifyParts(parts);
  },
};

/**
 * Best-effort Russian for a rule outside the restricted grammar (an ICS
 * import). The UI shows these read-only, so the summary only has to be
 * recognisable, not editable.
 */
function describeUnsupported(rrule: string, anchor: FloatingDateTime): string {
  let freq: string;
  try {
    freq = (parseParts(rrule).get('FREQ') ?? '').toUpperCase();
  } catch {
    return 'Особое расписание';
  }
  const pdt = Temporal.PlainDateTime.from(anchor);
  switch (freq) {
    case 'YEARLY':
      return `Каждый год, ${pdt.day} ${MONTHS_GENITIVE[pdt.month - 1] ?? ''}`;
    case 'MONTHLY':
      return 'Каждый месяц';
    case 'WEEKLY':
      return 'Каждую неделю';
    case 'DAILY':
      return 'Каждый день';
    case 'HOURLY':
      return 'Каждый час';
    default:
      return 'Особое расписание';
  }
}

export default recurrenceEngine;
