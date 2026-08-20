import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Role } from '@family/shared';

import { buildAuthContext, type AuthContext } from '../../core/auth/context.js';
import { createDbClient, type Db } from '../../core/db.js';
import { recurrenceEngine } from '../../core/recurrence/engine.js';
import type { UserRow } from '../identity/users.schema.js';
import {
  BIRTHDAY_REMINDER_OFFSETS,
  birthdayNeedsUpdate,
  birthdayScheduleMoved,
  birthdayTitle,
  planBirthday,
  syncBirthdays,
} from './birthdays.service.js';
import * as repo from './events.repository.js';
import { EVENT_ROUTE_ACCESS } from './events.routes.js';
import type { EventSeriesRow } from './events.schema.js';
import {
  allDayDurationMinutes,
  authenticateFeedToken,
  buildFeedForUser,
  canViewEvent,
  compileSchedule,
  createSeries,
  getFeedToken,
  getSeries,
  MINUTES_PER_DAY,
  resolveOccurrenceTimes,
  rotateFeedToken,
  toMidnight,
} from './events.service.js';
import {
  buildIcsCalendar,
  CRLF,
  escapeText,
  foldLine,
  formatAlarmTrigger,
  ICS_LINE_OCTETS,
  icsEtag,
  mintFeedToken,
  parseFeedToken,
  uidFor,
  type IcsEvent,
} from './ics.service.js';

/**
 * The calendar's business rules.
 *
 * Everything that can be decided without a database — ICS serialization, octet
 * folding, the all-day date range, wall-clock ends, the birthday rule, feed
 * tokens, the visibility predicate — is tested as pure logic. The handful of
 * rules that genuinely live in Postgres (the SQL visibility filter, birthday
 * upsert idempotency, feed-token revocation) sit behind `TEST_DATABASE_URL` so
 * `pnpm test` stays runnable without Docker.
 */

/* -------------------------------------------------------------------------- */
/* A minimal RFC 5545 reader, so the tests read the output the way a phone does */
/* -------------------------------------------------------------------------- */

/** Undo RFC 5545 folding: a line starting with SP/HTAB continues the previous one. */
function unfold(ics: string): string[] {
  const physical = ics.split(CRLF);
  const logical: string[] = [];
  for (const line of physical) {
    if (line === '') continue;
    if ((line.startsWith(' ') || line.startsWith('\t')) && logical.length > 0) {
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }
  return logical;
}

interface ParsedIcs {
  readonly calendar: Map<string, string>;
  readonly events: Array<Map<string, string>>;
  readonly alarms: Array<Map<string, string>>;
}

/** Splits `NAME;PARAM=x:value` into a `NAME;PARAM=x` key and its raw value. */
function splitProperty(line: string): [string, string] {
  const colon = line.indexOf(':');
  if (colon < 0) return [line, ''];
  return [line.slice(0, colon), line.slice(colon + 1)];
}

function parseIcs(ics: string): ParsedIcs {
  const calendar = new Map<string, string>();
  const events: Array<Map<string, string>> = [];
  const alarms: Array<Map<string, string>> = [];
  let current: Map<string, string> | null = null;
  let alarm: Map<string, string> | null = null;

  for (const line of unfold(ics)) {
    const [key, value] = splitProperty(line);
    if (key === 'BEGIN' && value === 'VEVENT') {
      current = new Map();
      continue;
    }
    if (key === 'END' && value === 'VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (key === 'BEGIN' && value === 'VALARM') {
      alarm = new Map();
      continue;
    }
    if (key === 'END' && value === 'VALARM') {
      if (alarm) alarms.push(alarm);
      alarm = null;
      continue;
    }
    const target = alarm ?? current ?? calendar;
    target.set(key, value);
  }
  return { calendar, events, alarms };
}

/** Undo the TEXT escaping of RFC 5545 §3.3.11. */
function unescapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      out += next === 'n' || next === 'N' ? '\n' : next;
      i += 1;
    } else {
      out += value[i];
    }
  }
  return out;
}

const octets = (s: string): number => Buffer.byteLength(s, 'utf8');

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const MOSCOW = 'Europe/Moscow';
const BERLIN = 'Europe/Berlin';

function seriesRow(overrides: Partial<EventSeriesRow> = {}): EventSeriesRow {
  const now = new Date('2026-08-01T10:00:00.000Z');
  return {
    id: randomUUID(),
    title: 'Ужин',
    description: null,
    location: null,
    visibility: 'household',
    createdById: randomUUID(),
    rrule: null,
    dtstartLocal: '2026-09-07T19:00:00',
    timezone: MOSCOW,
    rdatesLocal: [],
    exdatesLocal: [],
    seriesEndsAt: null,
    materializedThrough: null,
    durationMinutes: 60,
    isAllDay: false,
    reminderOffsets: [],
    color: null,
    category: null,
    sourceKind: 'manual',
    sourceRef: null,
    supersedesSeriesId: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function icsEvent(overrides: Partial<IcsEvent> = {}): IcsEvent {
  const stamp = new Date('2026-08-01T10:00:00.000Z');
  return {
    uid: 'fixture@family.calendar',
    sequence: 0,
    summary: 'Ужин',
    isAllDay: false,
    startLocalDate: '2026-09-07',
    endLocalDateExclusive: '2026-09-08',
    startsAt: new Date('2026-09-07T16:00:00.000Z'),
    endsAt: new Date('2026-09-07T17:00:00.000Z'),
    dtstamp: stamp,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. ICS line folding — octet-correct for Cyrillic                            */
/* -------------------------------------------------------------------------- */

describe('ICS line folding', () => {
  /**
   * The bug this whole suite exists for: Cyrillic is two octets per character
   * in UTF-8, so a folder that counts characters emits lines twice the legal
   * length, and a folder that slices the string at a byte offset cuts a code
   * point in half. Apple Calendar answers the first with a parse error and the
   * second with mojibake — or by dropping the event.
   */
  const CYRILLIC =
    'Родительское собрание в школе у Лизы и разговор с классным руководителем про олимпиаду';

  it('folds at 75 OCTETS, not 75 characters', () => {
    const line = `SUMMARY:${CYRILLIC}`;
    const folded = foldLine(line);

    expect(folded.length).toBeGreaterThan(1);
    for (const physical of folded) {
      expect(octets(physical)).toBeLessThanOrEqual(ICS_LINE_OCTETS);
    }

    // The proof that the budget is in octets: the first physical line is well
    // under 75 *characters* precisely because its characters are two bytes.
    const first = folded[0] ?? '';
    expect(first.length).toBeLessThan(ICS_LINE_OCTETS);
    expect(octets(first)).toBeGreaterThan(first.length);
  });

  it('never splits a multi-byte code point', () => {
    const folded = foldLine(`SUMMARY:${CYRILLIC}`);
    for (const physical of folded) {
      // A cut inside a UTF-8 sequence surfaces as U+FFFD on the round trip.
      expect(physical).not.toContain('�');
      expect(Buffer.from(physical, 'utf8').toString('utf8')).toBe(physical);
    }
  });

  it('round-trips exactly through unfolding', () => {
    const line = `SUMMARY:${escapeText(CYRILLIC)}`;
    const rebuilt = foldLine(line)
      .map((physical, index) => (index === 0 ? physical : physical.slice(1)))
      .join('');
    expect(rebuilt).toBe(line);
    expect(unescapeText(rebuilt.slice('SUMMARY:'.length))).toBe(CYRILLIC);
  });

  it('prefixes every continuation line with a single space', () => {
    const folded = foldLine(`DESCRIPTION:${CYRILLIC} ${CYRILLIC}`);
    for (const physical of folded.slice(1)) {
      expect(physical.startsWith(' ')).toBe(true);
      expect(physical.startsWith('  ')).toBe(false);
    }
  });

  it('leaves a short ASCII line alone', () => {
    expect(foldLine('VERSION:2.0')).toEqual(['VERSION:2.0']);
  });

  it('does not split a backslash escape across the fold', () => {
    // A value engineered so a naive cut can land between `\` and `,`.
    const value = `${'а'.repeat(33)},${'б'.repeat(40)}`;
    const folded = foldLine(`SUMMARY:${escapeText(value)}`);
    for (const physical of folded) {
      const trailing = /\\+$/.exec(physical)?.[0].length ?? 0;
      expect(trailing % 2).toBe(0);
    }
  });
});

describe('ICS text escaping', () => {
  it('escapes backslash, semicolon, comma and newlines — but not the colon', () => {
    expect(escapeText('a\\b')).toBe('a\\\\b');
    expect(escapeText('a;b')).toBe('a\\;b');
    expect(escapeText('a,b')).toBe('a\\,b');
    expect(escapeText('a\r\nb')).toBe('a\\nb');
    expect(escapeText('a\nb')).toBe('a\\nb');
    expect(escapeText('10:00')).toBe('10:00');
  });

  it('escapes the backslash before the characters it introduces', () => {
    // Naive ordering turns `;` into `\;` and then into `\\;` — a literal
    // backslash followed by an unescaped semicolon, i.e. a property parameter.
    expect(unescapeText(escapeText('раз; два\\три, четыре'))).toBe('раз; два\\три, четыре');
  });

  it('drops control characters that would inject a content line', () => {
    // BEL, NUL and DEL would otherwise let a title terminate the content line.
    expect(escapeText('Тест\u0007X')).toBe('ТестX');
    expect(escapeText('A\u0000B')).toBe('AB');
    expect(escapeText('A\u007FB')).toBe('AB');
    // TAB is a legal TEXT character and survives untouched.
    expect(escapeText('A\tB')).toBe('A\tB');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The document parses                                                      */
/* -------------------------------------------------------------------------- */

describe('ICS document', () => {
  const calendar = () =>
    buildIcsCalendar({
      name: 'Календарь — Семья Ивановых',
      description: 'Семейный календарь',
      timezone: MOSCOW,
      events: [
        icsEvent({
          uid: 'a@family.calendar',
          summary: 'Родительское собрание; в 19:00, каб. 12',
          description: 'Не забыть\nдневник',
          location: 'Школа №5',
          reminderOffsets: [1440, 30],
          sequence: 3,
        }),
        icsEvent({
          uid: 'b@family.calendar',
          summary: 'День рождения: Маша',
          isAllDay: true,
          startLocalDate: '2026-09-07',
          endLocalDateExclusive: '2026-09-08',
        }),
      ],
    });

  it('emits a well-formed VCALENDAR with the required properties', () => {
    const parsed = parseIcs(calendar());
    expect(parsed.calendar.get('BEGIN')).toBe('VCALENDAR');
    expect(parsed.calendar.get('VERSION')).toBe('2.0');
    expect(parsed.calendar.get('CALSCALE')).toBe('GREGORIAN');
    expect(parsed.calendar.get('PRODID')).toContain('//');
    expect(parsed.calendar.get('X-WR-TIMEZONE')).toBe(MOSCOW);
    expect(unescapeText(parsed.calendar.get('X-WR-CALNAME') ?? '')).toBe(
      'Календарь — Семья Ивановых',
    );
    expect(parsed.calendar.get('END')).toBe('VCALENDAR');
    expect(parsed.events).toHaveLength(2);
  });

  it('uses CRLF everywhere and terminates the last line', () => {
    const body = calendar();
    expect(body.endsWith(CRLF)).toBe(true);
    // Every LF is preceded by a CR: no bare newline anywhere in the document.
    expect(body.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('keeps every physical line inside 75 octets, Cyrillic included', () => {
    for (const line of calendar().split(CRLF)) {
      expect(octets(line)).toBeLessThanOrEqual(ICS_LINE_OCTETS);
    }
  });

  it('carries SUMMARY, DESCRIPTION, LOCATION and SEQUENCE through unchanged', () => {
    const [event] = parseIcs(calendar()).events;
    expect(event).toBeDefined();
    expect(unescapeText(event?.get('SUMMARY') ?? '')).toBe(
      'Родительское собрание; в 19:00, каб. 12',
    );
    expect(unescapeText(event?.get('DESCRIPTION') ?? '')).toBe('Не забыть\nдневник');
    expect(unescapeText(event?.get('LOCATION') ?? '')).toBe('Школа №5');
    expect(event?.get('SEQUENCE')).toBe('3');
    expect(event?.get('UID')).toBe('a@family.calendar');
    expect(event?.get('DTSTAMP')).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it('emits one VALARM per reminder offset', () => {
    const parsed = parseIcs(calendar());
    expect(parsed.alarms).toHaveLength(2);
    const triggers = parsed.alarms.map((a) => a.get('TRIGGER'));
    expect(triggers).toContain('-P1D');
    expect(triggers).toContain('-PT30M');
    for (const a of parsed.alarms) expect(a.get('ACTION')).toBe('DISPLAY');
  });

  it('formats alarm triggers as readable durations', () => {
    expect(formatAlarmTrigger(0)).toBe('-PT0M');
    expect(formatAlarmTrigger(30)).toBe('-PT30M');
    expect(formatAlarmTrigger(90)).toBe('-PT1H30M');
    expect(formatAlarmTrigger(1440)).toBe('-P1D');
    expect(formatAlarmTrigger(10080)).toBe('-P7D');
  });

  it('derives a UID from the occurrence key, so a re-materialized row keeps it', () => {
    const seriesId = randomUUID();
    expect(uidFor(seriesId, '2026-09-07T19:00:00')).toBe(uidFor(seriesId, '2026-09-07T19:00:00'));
    expect(uidFor(seriesId, '2026-09-07T19:00:00')).not.toBe(
      uidFor(seriesId, '2026-09-14T19:00:00'),
    );
    expect(uidFor(seriesId, '2026-09-07T19:00:00')).toContain('@family.calendar');
  });

  it('produces a stable ETag for identical content', () => {
    expect(icsEtag(calendar())).toBe(icsEtag(calendar()));
    expect(icsEtag(calendar())).not.toBe(icsEtag(`${calendar()}X`));
    expect(icsEtag(calendar())).toMatch(/^W\/"[0-9a-f]{32}"$/);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. All-day events do not shift a day across timezones                       */
/* -------------------------------------------------------------------------- */

describe('all-day events', () => {
  const ZONES = [
    'Pacific/Kiritimati', // UTC+14 — the extreme east
    'Pacific/Niue', //      UTC-11 — the extreme west
    MOSCOW,
    BERLIN,
    'UTC',
  ];

  it('stores the local date of the family, whatever the offset', () => {
    for (const tz of ZONES) {
      const times = resolveOccurrenceTimes('2026-09-07T00:00:00', MINUTES_PER_DAY, tz);
      expect(times.localDate).toBe('2026-09-07');
      expect(times.startsLocal).toBe('2026-09-07T00:00:00');
    }
  });

  it('emits the same DATE range in every timezone — the classic off-by-one', () => {
    for (const tz of ZONES) {
      const times = resolveOccurrenceTimes('2026-09-07T00:00:00', MINUTES_PER_DAY, tz);
      const body = buildIcsCalendar({
        name: 'Тест',
        timezone: tz,
        events: [
          icsEvent({
            isAllDay: true,
            startLocalDate: times.localDate,
            endLocalDateExclusive: '2026-09-08',
            startsAt: times.startsAt,
            endsAt: times.endsAt,
          }),
        ],
      });
      const [event] = parseIcs(body).events;
      expect(event?.get('DTSTART;VALUE=DATE')).toBe('20260907');
      // EXCLUSIVE end: one day is +1, not +0 (which renders as zero-length) and
      // not +2 (which renders as a two-day event).
      expect(event?.get('DTEND;VALUE=DATE')).toBe('20260908');
      // No time-bearing form anywhere — a DATE-TIME here is what shifts the day.
      expect(event?.has('DTSTART')).toBe(false);
    }
  });

  it('would shift a day if the local midnight were emitted as a UTC instant', () => {
    // The bug, demonstrated. Kiritimati is UTC+14, so local midnight on the 7th
    // is 10:00 UTC on the *6th*; formatting that instant in UTC yields 20260906.
    const times = resolveOccurrenceTimes(
      '2026-09-07T00:00:00',
      MINUTES_PER_DAY,
      'Pacific/Kiritimati',
    );
    expect(times.startsAt.toISOString().slice(0, 10)).toBe('2026-09-06');
    // ...which is exactly why the exporter uses `localDate`, not `startsAt`.
    expect(times.localDate).toBe('2026-09-07');
  });

  it('keeps the DATE range right on a DST-transition day', () => {
    // Berlin springs forward on 2026-03-29: that local day is only 23 hours
    // long, so any exporter deriving DTEND from `startsAt + 86 400 000 ms`
    // lands at 23:00 on the 29th and renders a one-day event as two.
    const times = resolveOccurrenceTimes('2026-03-29T00:00:00', MINUTES_PER_DAY, BERLIN);
    expect(times.localDate).toBe('2026-03-29');
    const body = buildIcsCalendar({
      name: 'Тест',
      timezone: BERLIN,
      events: [
        icsEvent({
          isAllDay: true,
          startLocalDate: times.localDate,
          endLocalDateExclusive: '2026-03-30',
          startsAt: times.startsAt,
          endsAt: times.endsAt,
        }),
      ],
    });
    const [event] = parseIcs(body).events;
    expect(event?.get('DTSTART;VALUE=DATE')).toBe('20260329');
    expect(event?.get('DTEND;VALUE=DATE')).toBe('20260330');
  });

  it('normalises a zero-length all-day event to one whole day', () => {
    // `durationMinutes: 0` means "one day", not "zero length": DTEND == DTSTART
    // makes most clients drop the event out of the all-day band entirely.
    expect(allDayDurationMinutes(0)).toBe(MINUTES_PER_DAY);
    expect(allDayDurationMinutes(1)).toBe(MINUTES_PER_DAY);
    expect(allDayDurationMinutes(MINUTES_PER_DAY)).toBe(MINUTES_PER_DAY);
    expect(allDayDurationMinutes(MINUTES_PER_DAY + 1)).toBe(2 * MINUTES_PER_DAY);
  });

  it('anchors an all-day series at local midnight', () => {
    expect(toMidnight('2026-09-07T19:30:00')).toBe('2026-09-07T00:00:00');
    const schedule = compileSchedule(
      {
        mode: 'once',
        dtstartLocal: '2026-09-07T19:30:00',
        timezone: MOSCOW,
        rdatesLocal: [],
        exdatesLocal: [],
      },
      true,
    );
    expect(schedule.dtstartLocal).toBe('2026-09-07T00:00:00');
    expect(schedule.rrule).toBeNull();
  });

  it('passes the series timezone to the rule compiler, so UNTIL is right', () => {
    // UNTIL is serialised as a UTC instant (RFC 5545 §3.3.10). Compiling
    // "до 31 декабря 23:59 по Москве" without the zone would bind the rule to
    // UTC midnight and silently add or drop the final occurrence.
    const schedule = compileSchedule(
      {
        mode: 'preset',
        preset: { kind: 'weekly', interval: 1, weekdays: ['MO'] },
        ends: { type: 'until', untilLocal: '2026-12-31T23:59:00' },
        dtstartLocal: '2026-09-07T09:00:00',
        timezone: MOSCOW,
        rdatesLocal: [],
        exdatesLocal: [],
      },
      false,
    );
    // Moscow is UTC+3, so 23:59 local is 20:59 UTC on the same day.
    expect(schedule.rrule).toContain('UNTIL=20261231T205900Z');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Wall-clock event ends across a DST boundary                              */
/* -------------------------------------------------------------------------- */

describe('wall-clock event ends', () => {
  it('ends a 60-minute event that starts at 23:30 on a DST night at 00:30 local', () => {
    // Berlin falls back on 2026-10-25 (03:00 CEST → 02:00 CET).
    const times = resolveOccurrenceTimes('2026-10-24T23:30:00', 60, BERLIN);
    const endLocal = recurrenceEngine.addWallClock('2026-10-24T23:30:00', 60, BERLIN).local;
    expect(endLocal).toBe('2026-10-25T00:30:00');
    expect(times.startsAt.toISOString()).toBe('2026-10-24T21:30:00.000Z');
    expect(times.endsAt.toISOString()).toBe('2026-10-24T22:30:00.000Z');
  });

  it('skips the spring-forward gap rather than inventing a 02:30', () => {
    // 2026-03-29 02:00 → 03:00 in Berlin: 02:30 does not exist. `compatible`
    // disambiguation pushes forward, so a 01:30 + 60 min event ends at 03:30.
    const end = recurrenceEngine.addWallClock('2026-03-29T01:30:00', 60, BERLIN);
    expect(end.local).toBe('2026-03-29T03:30:00');
    // Only 60 real minutes elapsed — the hour that "vanished" never existed.
    const start = recurrenceEngine.toInstant('2026-03-29T01:30:00', BERLIN);
    expect((end.instant.getTime() - start.getTime()) / 60_000).toBe(60);
  });

  it('resolves a fall-back overlap to the earlier instance', () => {
    // 02:30 happens twice on 2026-10-25; `compatible` takes the first (CEST).
    const first = recurrenceEngine.toInstant('2026-10-25T02:30:00', BERLIN);
    expect(first.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('keeps a weekly 09:00 series at 09:00 local across both transitions', () => {
    const keys = recurrenceEngine.expand(
      {
        rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=SU',
        dtstartLocal: '2026-03-15T09:00:00',
        timezone: BERLIN,
        rdatesLocal: [],
        exdatesLocal: [],
      },
      { from: new Date('2026-03-15T00:00:00Z'), to: new Date('2026-11-05T00:00:00Z') },
    );
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) expect(key.slice(11)).toBe('09:00:00');
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Birthdays                                                                */
/* -------------------------------------------------------------------------- */

describe('birthday generation', () => {
  it('compiles an ordinary birth date to a yearly rule on that day', () => {
    const plan = planBirthday('1990-05-17', 'Маша');
    expect(plan).not.toBeNull();
    expect(plan?.rrule).toBe('FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=17');
    expect(plan?.dtstartLocal).toBe('1990-05-17T00:00:00');
    expect(plan?.title).toBe('День рождения: Маша');
    expect(plan?.isLeapDay).toBe(false);
  });

  /**
   * The 29 February decision, asserted rather than described.
   *
   * A plain `FREQ=YEARLY` anchored at 29 February produces occurrences only in
   * leap years — the app would forget the birthday three years out of four.
   * `BYMONTH=2;BYMONTHDAY=-1` is "the last day of February": the 29th when
   * there is one, the 28th otherwise.
   */
  it('celebrates a 29 February birthday on the last day of February every year', () => {
    const plan = planBirthday('2000-02-29', 'Даша');
    expect(plan?.isLeapDay).toBe(true);
    expect(plan?.rrule).toBe('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1');
    // The anchor keeps the true birth date, so the rendered age stays correct.
    expect(plan?.dtstartLocal).toBe('2000-02-29T00:00:00');

    const keys = recurrenceEngine.expand(
      {
        rrule: plan?.rrule ?? '',
        dtstartLocal: plan?.dtstartLocal ?? '',
        timezone: MOSCOW,
        rdatesLocal: [],
        exdatesLocal: [],
      },
      { from: new Date('2025-01-01T00:00:00Z'), to: new Date('2029-12-31T00:00:00Z') },
    );

    expect(keys).toEqual([
      '2025-02-28T00:00:00',
      '2026-02-28T00:00:00',
      '2027-02-28T00:00:00',
      '2028-02-29T00:00:00', // leap year — the real date
      '2029-02-28T00:00:00',
    ]);
  });

  it('gives «купить подарок» a week and a day of lead time', () => {
    expect(BIRTHDAY_REMINDER_OFFSETS).toEqual([10_080, 1_440]);
    expect(formatAlarmTrigger(BIRTHDAY_REMINDER_OFFSETS[0] ?? 0)).toBe('-P7D');
    expect(formatAlarmTrigger(BIRTHDAY_REMINDER_OFFSETS[1] ?? 0)).toBe('-P1D');
  });

  it('returns no plan for a missing or malformed birth date', () => {
    expect(planBirthday(null, 'Маша')).toBeNull();
    expect(planBirthday('не дата', 'Маша')).toBeNull();
    expect(planBirthday('', 'Маша')).toBeNull();
  });

  it('falls back to a generic title for a blank display name', () => {
    expect(birthdayTitle('   ')).toBe('День рождения');
  });

  it('is a no-op when the stored series already matches the profile', () => {
    const plan = planBirthday('1990-05-17', 'Маша');
    expect(plan).not.toBeNull();
    if (!plan) return;
    const stored = seriesRow({
      title: plan.title,
      rrule: plan.rrule,
      dtstartLocal: plan.dtstartLocal,
      sourceKind: 'user_birthday',
      sourceRef: randomUUID(),
      isAllDay: true,
    });
    expect(birthdayNeedsUpdate(stored, plan)).toBe(false);
    expect(birthdayScheduleMoved(stored, plan)).toBe(false);
  });

  it('detects a changed birth date as an update, not as a new series', () => {
    const stored = seriesRow({
      title: 'День рождения: Маша',
      rrule: 'FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=17',
      dtstartLocal: '1990-05-17T00:00:00',
      sourceKind: 'user_birthday',
    });
    const corrected = planBirthday('1990-05-18', 'Маша');
    expect(corrected).not.toBeNull();
    if (!corrected) return;
    expect(birthdayNeedsUpdate(stored, corrected)).toBe(true);
    expect(birthdayScheduleMoved(stored, corrected)).toBe(true);
  });

  it('treats a rename as an update that does not disturb the schedule', () => {
    const stored = seriesRow({
      title: 'День рождения: Маша',
      rrule: 'FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=17',
      dtstartLocal: '1990-05-17T00:00:00',
    });
    const renamed = planBirthday('1990-05-17', 'Мария');
    expect(renamed).not.toBeNull();
    if (!renamed) return;
    expect(birthdayNeedsUpdate(stored, renamed)).toBe(true);
    // The schedule is unchanged, so no future occurrence is dropped.
    expect(birthdayScheduleMoved(stored, renamed)).toBe(false);
  });

  it('un-archives a series when a cleared birth date comes back', () => {
    const plan = planBirthday('1990-05-17', 'Маша');
    expect(plan).not.toBeNull();
    if (!plan) return;
    const archived = seriesRow({
      title: plan.title,
      rrule: plan.rrule,
      dtstartLocal: plan.dtstartLocal,
      archivedAt: new Date(),
    });
    expect(birthdayNeedsUpdate(archived, plan)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The feed token                                                           */
/* -------------------------------------------------------------------------- */

describe('ICS feed token', () => {
  const userId = '11111111-2222-4333-8444-555555555555';

  it('round-trips the user and the revocation epoch', () => {
    const token = mintFeedToken(userId, 1_700_000_000_000);
    const parsed = parseFeedToken(token);
    expect(parsed?.userId).toBe(userId);
    expect(parsed?.revocationEpochMs).toBe(1_700_000_000_000);
  });

  it('is deterministic, so «показать ссылку» never rotates it by accident', () => {
    expect(mintFeedToken(userId, 0)).toBe(mintFeedToken(userId, 0));
  });

  it('changes completely when the revocation epoch moves', () => {
    const before = mintFeedToken(userId, 0);
    const after = mintFeedToken(userId, 1);
    expect(after).not.toBe(before);
    // The signature covers the epoch, so an old URL cannot be re-signed.
    expect(parseFeedToken(before)?.revocationEpochMs).toBe(0);
    expect(parseFeedToken(after)?.revocationEpochMs).toBe(1);
  });

  it('rejects a tampered or forged token', () => {
    const token = mintFeedToken(userId, 0);
    const [version, compact, epoch, signature] = token.split('.');

    // Swap the user id, keep the signature.
    expect(parseFeedToken(`${version}.${'0'.repeat(32)}.${epoch}.${signature}`)).toBeNull();
    // Claim a different epoch, keep the signature.
    expect(parseFeedToken(`${version}.${compact}.1.${signature}`)).toBeNull();
    // Flip one signature character.
    const flipped = `${signature?.slice(0, -1)}${signature?.endsWith('A') ? 'B' : 'A'}`;
    expect(parseFeedToken(`${version}.${compact}.${epoch}.${flipped}`)).toBeNull();
    // Structural nonsense.
    expect(parseFeedToken('')).toBeNull();
    expect(parseFeedToken('not-a-token')).toBeNull();
    expect(parseFeedToken(`f9.${compact}.${epoch}.${signature}`)).toBeNull();
    expect(parseFeedToken('x'.repeat(600))).toBeNull();
  });

  it('is not, and cannot be confused with, a session token', () => {
    const token = mintFeedToken(userId, 0);
    // A session JWT is three dot-separated segments starting `eyJ`; this is
    // deliberately a different shape signed with a different, derived key.
    expect(token.split('.')).toHaveLength(4);
    expect(token.startsWith('f1.')).toBe(true);
    expect(token).not.toContain('eyJ');
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Visibility                                                               */
/* -------------------------------------------------------------------------- */

describe('visibility', () => {
  const creator = randomUUID();
  const attendee = randomUUID();
  const outsider = randomUUID();

  it('shows a household event to everybody', () => {
    expect(canViewEvent(outsider, { visibility: 'household', createdById: creator }, [])).toBe(
      true,
    );
  });

  it('shows a private event only to its creator', () => {
    const series = { visibility: 'private' as const, createdById: creator };
    expect(canViewEvent(creator, series, [attendee])).toBe(true);
    expect(canViewEvent(attendee, series, [attendee])).toBe(false);
    expect(canViewEvent(outsider, series, [attendee])).toBe(false);
  });

  it('shows a restricted event to the creator and the attendee list only', () => {
    const series = { visibility: 'restricted' as const, createdById: creator };
    expect(canViewEvent(creator, series, [attendee])).toBe(true);
    expect(canViewEvent(attendee, series, [attendee])).toBe(true);
    expect(canViewEvent(outsider, series, [attendee])).toBe(false);
  });

  it('hides a restricted occurrence from somebody invited to a different one', () => {
    // Attendance is per occurrence: "I can make it this Thursday but not next"
    // is the normal case, and so is "you were not invited to that one".
    expect(canViewEvent(attendee, { visibility: 'restricted', createdById: creator }, [])).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Route wiring                                                             */
/* -------------------------------------------------------------------------- */

describe('route registration', () => {
  /**
   * A bare instance carrying only the plugins this suite is about: the access
   * declarations and the error mapping. `buildApp()` already registers the
   * events module through `modules/index.ts`, so registering it again there
   * would collide — and its global rate limiter needs a Redis this suite has no
   * business depending on.
   */
  async function bareApp() {
    const { fastify } = await import('fastify');
    const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
    const { errorHandlerPlugin } = await import('../../core/plugins/error-handler.js');
    const { authPlugin } = await import('../../core/plugins/auth.js');
    const { default: eventsRoutes } = await import('./events.routes.js');

    const app = fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    return { app, eventsRoutes };
  }

  it('is wired into the module registry with no path conflicts', async () => {
    const { buildApp } = await import('../../app.js');

    // `onReady` in core/plugins/auth.ts throws if any registered route declares
    // neither a permission guard nor `public: true` (D4 deny-by-default), and
    // find-my-way throws on a duplicate path — so a clean `ready()` proves both
    // for the whole app, this module included.
    const app = await buildApp();
    await app.ready();

    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/api/events/series');
    expect(routes).toContain('/api/events/calendar');
    expect(routes).toContain('/api/events/today');
    expect(routes).toContain('/api/events/feed.ics');
    await app.close();
  });

  it('declares exactly the guards documented in EVENT_ROUTE_ACCESS', async () => {
    // `onRoute` only fires for routes registered *after* the hook is added, and
    // `buildApp()` has already registered every module by the time it returns.
    // So collect the declarations on a bare instance carrying just this plugin —
    // route registration never runs a handler, so no app plumbing is needed.
    const { fastify } = await import('fastify');
    const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
    const { default: eventsRoutes } = await import('./events.routes.js');

    const probe = fastify({ logger: false });
    probe.setValidatorCompiler(validatorCompiler);
    probe.setSerializerCompiler(serializerCompiler);

    const seen = new Map<string, Record<string, unknown>>();
    probe.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (method === 'HEAD') continue;
        seen.set(`${method} ${route.url}`, (route.config ?? {}) as Record<string, unknown>);
      }
    });

    await probe.register(eventsRoutes);
    await probe.ready();

    for (const [key, expected] of Object.entries(EVENT_ROUTE_ACCESS)) {
      const config = seen.get(key);
      expect(config, `route not registered: ${key}`).toBeDefined();
      for (const [name, value] of Object.entries(expected)) {
        expect(config?.[name], `${key} -> ${name}`).toBe(value);
      }
    }
    // Nothing registered that the table does not document.
    for (const key of seen.keys()) {
      expect(Object.keys(EVENT_ROUTE_ACCESS)).toContain(key);
    }
    await probe.close();
  });

  it('guards every route but the feed, which answers 404 to a bad token', async () => {
    const { app, eventsRoutes } = await bareApp();
    await app.register(eventsRoutes, { prefix: '/api' });
    await app.ready();

    // A guarded route demands a bearer token…
    const guarded = await app.inject({ method: 'GET', url: '/api/events/series' });
    expect(guarded.statusCode).toBe(401);

    // …while the feed reaches its handler with no Authorization header at all,
    // and answers 404 — not 401 — to a forged link, so a scanner learns nothing.
    const feed = await app.inject({
      method: 'GET',
      url: '/api/events/feed.ics?token=obviously-not-a-real-token',
    });
    expect(feed.statusCode).toBe(404);
    expect(JSON.parse(feed.payload)).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Database-backed rules                                                       */
/* -------------------------------------------------------------------------- */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('events (database)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let owner: AuthContext;
  let attendee: AuthContext;
  let outsider: AuthContext;
  const userIds: string[] = [];
  const seriesIds: string[] = [];

  async function makeUser(displayName: string, role: Role, birthDate?: string): Promise<UserRow> {
    const { users } = await import('../identity/users.schema.js');
    const [row] = await db
      .insert(users)
      .values({
        displayName,
        role,
        status: 'active',
        ...(birthDate === undefined ? {} : { birthDate }),
      })
      .returning();
    if (!row) throw new Error('fixture user was not created');
    userIds.push(row.id);
    return row;
  }

  beforeAll(async () => {
    const { sql, db: handle } = createDbClient(TEST_DATABASE_URL);
    db = handle;
    close = async () => {
      await sql.end({ timeout: 5 });
    };

    owner = buildAuthContext(await makeUser('Папа (тест)', 'owner'));
    attendee = buildAuthContext(await makeUser('Мама (тест)', 'adult'));
    outsider = buildAuthContext(await makeUser('Лиза (тест)', 'child'));
  });

  afterAll(async () => {
    if (!db) return;
    const { inArray } = await import('drizzle-orm');
    const { eventSeries } = await import('./events.schema.js');
    const { users } = await import('../identity/users.schema.js');
    const { auditLog } = await import('../identity/identity.schema.js');
    if (seriesIds.length > 0) {
      await db.delete(eventSeries).where(inArray(eventSeries.id, seriesIds));
    }
    if (userIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.targetId, userIds));
      // Generated birthday series reference the user; drop them first.
      await db.delete(eventSeries).where(inArray(eventSeries.createdById, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    if (close) await close();
  });

  it('hides a restricted event from a non-attendee (404, not 403)', async () => {
    const created = await createSeries(db, owner, {
      title: 'Приём у врача',
      description: null,
      location: null,
      visibility: 'restricted',
      durationMinutes: 30,
      isAllDay: false,
      reminderOffsets: [],
      color: null,
      category: null,
      attendeeIds: [attendee.userId],
      recurrence: {
        mode: 'once',
        dtstartLocal: '2026-09-07T11:00:00',
        timezone: MOSCOW,
        rdatesLocal: [],
        exdatesLocal: [],
      },
    });
    seriesIds.push(created.series.id);
    expect(created.attendeeIds).toEqual([attendee.userId]);

    // The creator and the invited attendee both see it.
    await expect(getSeries(db, owner, created.series.id)).resolves.toBeTruthy();
    await expect(getSeries(db, attendee, created.series.id)).resolves.toBeTruthy();

    // The non-attendee gets 404 — never 403, which would confirm it exists.
    await expect(getSeries(db, outsider, created.series.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // …and it is filtered out of the list read in SQL, not after the fact.
    const invisible = await repo.listSeries(db, outsider.userId, {
      limit: 100,
      includeArchived: true,
    });
    expect(invisible.items.map((s) => s.id)).not.toContain(created.series.id);

    const mine = await repo.listSeries(db, attendee.userId, {
      limit: 100,
      includeArchived: true,
    });
    expect(mine.items.map((s) => s.id)).toContain(created.series.id);
  });

  it('keeps a restricted event out of a non-attendee ICS feed', async () => {
    const created = await createSeries(db, owner, {
      title: 'Разговор с психологом',
      description: null,
      location: null,
      visibility: 'restricted',
      durationMinutes: 60,
      isAllDay: false,
      reminderOffsets: [],
      color: null,
      category: null,
      attendeeIds: [attendee.userId],
      recurrence: {
        mode: 'once',
        dtstartLocal: '2026-09-09T18:00:00',
        timezone: MOSCOW,
        rdatesLocal: [],
        exdatesLocal: [],
      },
    });
    seriesIds.push(created.series.id);

    const now = new Date('2026-09-01T09:00:00.000Z');
    const insider = await buildFeedForUser(db, attendee.userId, now);
    const stranger = await buildFeedForUser(db, outsider.userId, now);

    expect(insider.body).toContain('психологом');
    expect(stranger.body).not.toContain('психологом');
  });

  it('revokes every feed URL when the token is rotated', async () => {
    const original = await getFeedToken(db, owner.userId);
    expect(await authenticateFeedToken(db, original)).toBe(owner.userId);

    const rotated = await rotateFeedToken(db, owner, owner.userId);
    expect(rotated).not.toBe(original);

    // The old link stops working the instant the epoch moves…
    expect(await authenticateFeedToken(db, original)).toBeNull();
    // …and the new one works.
    expect(await authenticateFeedToken(db, rotated)).toBe(owner.userId);
    // Asking again returns the same link rather than accumulating live tokens.
    expect(await getFeedToken(db, owner.userId)).toBe(rotated);

    // Rotating twice inside one millisecond must still invalidate the first.
    const third = await rotateFeedToken(db, owner, owner.userId);
    expect(third).not.toBe(rotated);
    expect(await authenticateFeedToken(db, rotated)).toBeNull();
  });

  it('serves a parseable feed for a real user', async () => {
    const created = await createSeries(db, owner, {
      title: 'Родительское собрание в школе у Лизы',
      description: 'Не забыть дневник',
      location: 'Школа №5',
      visibility: 'household',
      durationMinutes: 90,
      isAllDay: false,
      reminderOffsets: [1440],
      color: null,
      category: 'school',
      attendeeIds: [],
      recurrence: {
        mode: 'once',
        dtstartLocal: '2026-09-10T19:00:00',
        timezone: MOSCOW,
        rdatesLocal: [],
        exdatesLocal: [],
      },
    });
    seriesIds.push(created.series.id);

    const feed = await buildFeedForUser(db, owner.userId, new Date('2026-09-01T09:00:00.000Z'));
    const parsed = parseIcs(feed.body);
    expect(parsed.calendar.get('VERSION')).toBe('2.0');

    const event = parsed.events.find(
      (e) => unescapeText(e.get('SUMMARY') ?? '') === 'Родительское собрание в школе у Лизы',
    );
    expect(event).toBeDefined();
    expect(event?.get('DTSTART')).toBe('20260910T160000Z'); // 19:00 MSK
    expect(event?.get('DTEND')).toBe('20260910T173000Z'); // +90 wall-clock minutes

    for (const line of feed.body.split(CRLF)) {
      expect(octets(line)).toBeLessThanOrEqual(ICS_LINE_OCTETS);
    }
  });


  it('finds a due reminder against a real database', async () => {
    // Regression: every `Date` in this query reached postgres.js raw, and
    // `drizzle-orm/postgres-js` nulls that driver's timestamp serialisers — so
    // the query threw at *bind* time, every fifteen minutes, in production:
    //
    //   TypeError: The "string" argument must be of type string … Received an
    //   instance of Date
    //
    // No event reminder had ever fired. Nothing caught it because
    // `listDueReminders` had no test at all, and the failure is invisible from
    // the outside: the job simply logs and retries forever.
    const created = await createSeries(db, owner, {
      title: 'Приём у стоматолога',
      description: null,
      location: null,
      visibility: 'household',
      durationMinutes: 60,
      isAllDay: false,
      reminderOffsets: [30],
      color: null,
      category: 'appointment',
      attendeeIds: [],
      recurrence: {
        mode: 'once',
        dtstartLocal: '2026-09-10T19:00:00',
        timezone: MOSCOW,
        rdatesLocal: [],
        exdatesLocal: [],
      },
    });
    seriesIds.push(created.series.id);

    // 19:00 MSK is 16:00Z; a 30-minute lead makes the reminder due at 15:30Z.
    const due = await repo.listDueReminders(db, {
      now: new Date('2026-09-10T15:30:00.000Z'),
      lookbackMinutes: 15,
      limit: 50,
    });

    const mine = due.filter((r) => r.seriesId === created.series.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.offsetMinutes).toBe(30);
    expect(mine[0]?.title).toBe('Приём у стоматолога');

    // Outside the lookback window it must not fire again — that lower bound is
    // what stops a worker that was down all day waking everyone at once.
    const stale = await repo.listDueReminders(db, {
      now: new Date('2026-09-10T15:50:00.000Z'),
      lookbackMinutes: 15,
      limit: 50,
    });
    expect(stale.filter((r) => r.seriesId === created.series.id)).toHaveLength(0);
  });
  it('syncs birthdays idempotently and updates rather than duplicating', async () => {
    const { and, eq } = await import('drizzle-orm');
    const { eventSeries } = await import('./events.schema.js');
    const { users } = await import('../identity/users.schema.js');

    const birthdayUser = await makeUser('Даша (тест)', 'child', '2000-02-29');

    const findGenerated = () =>
      db
        .select()
        .from(eventSeries)
        .where(
          and(
            eq(eventSeries.sourceKind, 'user_birthday'),
            eq(eventSeries.sourceRef, birthdayUser.id),
          ),
        );

    await syncBirthdays(db);
    let rows = await findGenerated();
    expect(rows).toHaveLength(1);
    const first = rows[0];
    expect(first?.rrule).toBe('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1');
    expect(first?.isAllDay).toBe(true);
    expect(first?.title).toBe('День рождения: Даша (тест)');
    expect(first?.reminderOffsets).toEqual(BIRTHDAY_REMINDER_OFFSETS);

    // Re-running changes nothing: the partial unique index plus the "does it
    // already match?" check make the whole job a no-op.
    const second = await syncBirthdays(db);
    rows = await findGenerated();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first?.id);
    expect(second.created).toBe(0);

    // A corrected birth date UPDATES the one row — it never adds a second.
    await db.update(users).set({ birthDate: '2000-03-15' }).where(eq(users.id, birthdayUser.id));
    await syncBirthdays(db);

    rows = await findGenerated();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first?.id);
    expect(rows[0]?.rrule).toBe('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15');
    expect(rows[0]?.dtstartLocal).toBe('2000-03-15T00:00:00');

    // Clearing the date archives the series instead of deleting the history.
    await db.update(users).set({ birthDate: null }).where(eq(users.id, birthdayUser.id));
    await syncBirthdays(db);
    rows = await findGenerated();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.archivedAt).not.toBeNull();
  });
});
