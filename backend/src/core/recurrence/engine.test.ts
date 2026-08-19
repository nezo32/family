import { describe, expect, it } from 'vitest';

import type { RecurrenceEnd, RecurrencePreset } from '@family/shared';

import { DEFAULT_MAX_COUNT, recurrenceEngine as engine, type SeriesRule } from './engine.js';

/**
 * The DST suite (`docs/architecture/scheduling.md` §7).
 *
 * `Europe/Berlin` is the zone under test because Moscow has had **no DST since
 * 2014** — a suite written against Moscow would pass with a hardcoded `+03:00`
 * and prove nothing. The 2013 Moscow case is here for the opposite reason: it
 * is the one test that fails loudly if anybody ever pins an offset, because
 * Russian time law put Moscow at UTC+4 from 2011 to 2014.
 *
 * Berlin 2026 transitions:
 * - spring forward Sun 29 Mar, 02:00 → 03:00 (02:00–02:59 does not exist)
 * - fall back    Sun 25 Oct, 03:00 → 02:00 (02:00–02:59 happens twice)
 */

const BERLIN = 'Europe/Berlin';
const MOSCOW = 'Europe/Moscow';

function rule(overrides: Partial<SeriesRule> & Pick<SeriesRule, 'dtstartLocal'>): SeriesRule {
  return {
    rrule: null,
    timezone: BERLIN,
    rdatesLocal: [],
    exdatesLocal: [],
    ...overrides,
  };
}

/** A UTC instant, written as an instant on purpose — windows are instants. */
const at = (iso: string): Date => new Date(iso);

describe('toInstant — DST disambiguation is "compatible"', () => {
  it('pushes a spring-forward gap time forward', () => {
    // 2026-03-29T02:30 local does not exist in Berlin.
    const instant = engine.toInstant('2026-03-29T02:30:00', BERLIN);

    // 'compatible' resolves a gap by moving forward by the size of the gap:
    // 02:30 (would-be +01:00) becomes 03:30+02:00 = 01:30 UTC.
    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');

    // Sanity: the same wall clock one day earlier is an hour later in UTC.
    expect(engine.toInstant('2026-03-28T02:30:00', BERLIN).toISOString()).toBe(
      '2026-03-28T01:30:00.000Z',
    );
  });

  it('picks the EARLIER instance of an autumn fall-back overlap', () => {
    // 2026-10-25T02:30 local happens twice in Berlin: once at +02:00 (CEST)
    // and again an hour later at +01:00 (CET).
    const instant = engine.toInstant('2026-10-25T02:30:00', BERLIN);

    expect(instant.toISOString()).toBe('2026-10-25T00:30:00.000Z'); // +02:00, the earlier one
    expect(instant.toISOString()).not.toBe('2026-10-25T01:30:00.000Z'); // +01:00, the later one
  });

  it('is a pure function of (wall clock, zone) — never of the process timezone', () => {
    expect(engine.toInstant('2026-07-01T12:00:00', 'UTC').toISOString()).toBe(
      '2026-07-01T12:00:00.000Z',
    );
    expect(engine.toInstant('2026-07-01T12:00:00', BERLIN).toISOString()).toBe(
      '2026-07-01T10:00:00.000Z',
    );
  });
});

describe('expand — a weekly 09:00 series stays 09:00 local across both transitions', () => {
  const weekly = rule({
    rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=SU',
    dtstartLocal: '2026-03-01T09:00:00',
    timezone: BERLIN,
  });

  it('never drifts off 09:00', () => {
    const keys = engine.expand(weekly, {
      from: at('2026-02-28T00:00:00Z'),
      to: at('2026-11-02T00:00:00Z'),
    });

    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) {
      expect(key.slice(11)).toBe('09:00:00');
    }
    // Spans both transitions.
    expect(keys).toContain('2026-03-22T09:00:00');
    expect(keys).toContain('2026-04-05T09:00:00');
    expect(keys).toContain('2026-10-18T09:00:00');
    expect(keys).toContain('2026-11-01T09:00:00');
  });

  it('resolves to a different UTC instant on each side of a transition', () => {
    const beforeSpring = engine.toInstant('2026-03-22T09:00:00', BERLIN);
    const afterSpring = engine.toInstant('2026-04-05T09:00:00', BERLIN);
    expect(beforeSpring.toISOString()).toBe('2026-03-22T08:00:00.000Z'); // +01:00
    expect(afterSpring.toISOString()).toBe('2026-04-05T07:00:00.000Z'); // +02:00

    const beforeAutumn = engine.toInstant('2026-10-18T09:00:00', BERLIN);
    const afterAutumn = engine.toInstant('2026-11-01T09:00:00', BERLIN);
    expect(beforeAutumn.toISOString()).toBe('2026-10-18T07:00:00.000Z'); // +02:00
    expect(afterAutumn.toISOString()).toBe('2026-11-01T08:00:00.000Z'); // +01:00
  });
});

describe('expand — a daily 02:30 series keeps its wall clock through the gap', () => {
  /**
   * This is the regression test for the reason the engine expands in floating
   * space. Expanding directly in `Europe/Berlin` makes `rrule-temporal` chain
   * its cursor through the non-existent hour and emit
   * `02:30, 02:30, 03:30, 03:30, …` — a permanent, window-dependent shift that
   * would make `occurrence_key` unstable and break materializer idempotency.
   */
  const daily = rule({
    rrule: 'FREQ=DAILY;INTERVAL=1',
    dtstartLocal: '2026-03-27T02:30:00',
    timezone: BERLIN,
  });

  it('emits 02:30 on every day, including the day after the gap', () => {
    const keys = engine.expand(daily, {
      from: at('2026-03-26T00:00:00Z'),
      to: at('2026-04-02T00:00:00Z'),
    });

    expect(keys).toEqual([
      '2026-03-27T02:30:00',
      '2026-03-28T02:30:00',
      '2026-03-29T02:30:00',
      '2026-03-30T02:30:00',
      '2026-03-31T02:30:00',
      '2026-04-01T02:30:00',
    ]);
  });

  it('produces the same keys no matter where the query window starts', () => {
    const wide = engine.expand(daily, {
      from: at('2026-03-26T00:00:00Z'),
      to: at('2026-04-02T00:00:00Z'),
    });
    const narrow = engine.expand(daily, {
      from: at('2026-03-30T00:00:00Z'),
      to: at('2026-04-02T00:00:00Z'),
    });
    expect(narrow.every((key) => wide.includes(key))).toBe(true);
    expect(narrow).toEqual(wide.filter((key) => key >= '2026-03-30T00:00:00'));
  });

  it('resolves the gap day forward while its key stays 02:30', () => {
    expect(engine.toInstant('2026-03-29T02:30:00', BERLIN).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });
});

describe('addWallClock — wall-clock arithmetic, never instant + n * 60000', () => {
  it('a 60-minute event starting 23:30 on the spring-forward night ends 00:30 local', () => {
    const { local, instant } = engine.addWallClock('2026-03-28T23:30:00', 60, BERLIN);
    expect(local).toBe('2026-03-29T00:30:00');
    expect(instant.toISOString()).toBe('2026-03-28T23:30:00.000Z');
  });

  it('a 60-minute event starting 23:30 on the fall-back night ends 00:30 local', () => {
    const { local, instant } = engine.addWallClock('2026-10-24T23:30:00', 60, BERLIN);
    expect(local).toBe('2026-10-25T00:30:00');
    // 23:30 is still CEST (+02:00) on the 24th, so the end lands at 22:30Z.
    expect(instant.toISOString()).toBe('2026-10-24T22:30:00.000Z');
  });

  it('anchors on the earlier instance of an ambiguous start before adding', () => {
    // 02:30 (+02:00, the earlier one) + 60 min lands on 02:30 again (+01:00).
    const { local, instant } = engine.addWallClock('2026-10-25T02:30:00', 60, BERLIN);
    expect(local).toBe('2026-10-25T02:30:00');
    expect(instant.toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });

  it('resolves a gap start before adding', () => {
    const { local } = engine.addWallClock('2026-03-29T02:30:00', 60, BERLIN);
    expect(local).toBe('2026-03-29T04:30:00');
  });

  it('handles a zero offset (due at start)', () => {
    expect(engine.addWallClock('2026-09-07T09:00:00', 0, MOSCOW).local).toBe('2026-09-07T09:00:00');
  });

  it('rejects a fractional offset rather than silently truncating', () => {
    expect(() => engine.addWallClock('2026-09-07T09:00:00', 1.5, MOSCOW)).toThrow();
  });
});

describe('expand — BYMONTHDAY=31 silently produces no February occurrence', () => {
  it('skips the months that have no 31st', () => {
    const monthly = rule({
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31',
      dtstartLocal: '2026-01-31T09:00:00',
      timezone: BERLIN,
    });

    const keys = engine.expand(monthly, {
      from: at('2026-01-01T00:00:00Z'),
      to: at('2026-07-01T00:00:00Z'),
    });

    expect(keys).toEqual(['2026-01-31T09:00:00', '2026-03-31T09:00:00', '2026-05-31T09:00:00']);
    expect(keys.some((key) => key.startsWith('2026-02'))).toBe(false);
  });

  it('BYMONTHDAY=-1 is the answer for an end-of-month chore', () => {
    const lastDay = rule({
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1',
      dtstartLocal: '2026-01-31T09:00:00',
      timezone: BERLIN,
    });

    const keys = engine.expand(lastDay, {
      from: at('2026-01-01T00:00:00Z'),
      to: at('2026-05-01T00:00:00Z'),
    });

    expect(keys).toEqual([
      '2026-01-31T09:00:00',
      '2026-02-28T09:00:00',
      '2026-03-31T09:00:00',
      '2026-04-30T09:00:00',
    ]);
  });
});

describe('Europe/Moscow in 2013 resolves at UTC+4, not UTC+3', () => {
  /**
   * Moscow was UTC+4 with no DST from 27 Mar 2011 to 26 Oct 2014, and has been
   * UTC+3 since. Anything that hardcodes `+03:00` — or resolves the offset once
   * and reuses it — fails here.
   */
  it('a single key resolves with the 2013 rules', () => {
    expect(engine.toInstant('2013-06-03T09:00:00', MOSCOW).toISOString()).toBe(
      '2013-06-03T05:00:00.000Z',
    );
  });

  it('the same wall clock today resolves at UTC+3', () => {
    expect(engine.toInstant('2026-06-01T09:00:00', MOSCOW).toISOString()).toBe(
      '2026-06-01T06:00:00.000Z',
    );
  });

  it('a series spanning the 2014 law change resolves each side with its own rules', () => {
    const weekly = rule({
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
      dtstartLocal: '2013-06-03T09:00:00',
      timezone: MOSCOW,
    });

    const keys = engine.expand(weekly, {
      from: at('2013-06-01T00:00:00Z'),
      to: at('2013-06-30T00:00:00Z'),
    });

    expect(keys).toEqual([
      '2013-06-03T09:00:00',
      '2013-06-10T09:00:00',
      '2013-06-17T09:00:00',
      '2013-06-24T09:00:00',
    ]);
    for (const key of keys) {
      expect(engine.toInstant(key, MOSCOW).toISOString()).toMatch(/T05:00:00\.000Z$/);
    }

    // After the 26 Oct 2014 change the very same rule resolves an hour later.
    expect(engine.toInstant('2015-06-01T09:00:00', MOSCOW).toISOString()).toBe(
      '2015-06-01T06:00:00.000Z',
    );
  });
});

describe('expand — determinism, RDATE/EXDATE and the hard cap', () => {
  const base = rule({
    rrule: 'FREQ=DAILY;INTERVAL=1',
    dtstartLocal: '2026-05-01T08:00:00',
    timezone: BERLIN,
    rdatesLocal: ['2026-05-03T19:00:00'],
    exdatesLocal: ['2026-05-04T08:00:00'],
  });

  const window = { from: at('2026-04-30T00:00:00Z'), to: at('2026-05-08T00:00:00Z') };

  it('is deterministic and idempotent: same inputs, identical output, twice', () => {
    const first = engine.expand(base, window);
    const second = engine.expand(base, window);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // And a third run against a freshly built (structurally equal) rule object.
    const third = engine.expand({ ...base, rdatesLocal: [...base.rdatesLocal] }, window);
    expect(third).toEqual(first);
  });

  it('merges RDATEs, removes EXDATEs, de-duplicates and returns ascending', () => {
    const keys = engine.expand(base, window);

    expect(keys).toContain('2026-05-03T19:00:00'); // RDATE merged
    expect(keys).not.toContain('2026-05-04T08:00:00'); // EXDATE removed
    expect(new Set(keys).size).toBe(keys.length); // de-duplicated
    expect([...keys].sort()).toEqual(keys); // ascending
  });

  it('de-duplicates an RDATE that collides with a rule occurrence', () => {
    const collide = engine.expand({ ...base, rdatesLocal: ['2026-05-02T08:00:00'] }, window);
    expect(collide.filter((k) => k === '2026-05-02T08:00:00')).toHaveLength(1);
  });

  it('an EXDATE also removes a colliding RDATE', () => {
    const both = engine.expand(
      { ...base, rdatesLocal: ['2026-05-05T21:00:00'], exdatesLocal: ['2026-05-05T21:00:00'] },
      window,
    );
    expect(both).not.toContain('2026-05-05T21:00:00');
  });

  it('hard-caps at maxCount', () => {
    const uncapped = engine.expand(base, { ...window, maxCount: 1000 });
    const capped = engine.expand(base, { ...window, maxCount: 3 });

    expect(capped).toHaveLength(3);
    expect(capped).toEqual(uncapped.slice(0, 3));
  });

  it('the default cap is 1000 and it truncates a runaway rule', () => {
    const runaway = rule({
      rrule: 'FREQ=MINUTELY;INTERVAL=1',
      dtstartLocal: '2026-05-01T00:00:00',
      timezone: BERLIN,
    });

    const keys = engine.expand(runaway, {
      from: at('2026-04-30T00:00:00Z'),
      to: at('2027-05-01T00:00:00Z'),
    });

    expect(keys).toHaveLength(DEFAULT_MAX_COUNT);
    expect(keys[0]).toBe('2026-05-01T00:00:00');
    // Deterministic even at the cap.
    expect(
      engine.expand(runaway, {
        from: at('2026-04-30T00:00:00Z'),
        to: at('2027-05-01T00:00:00Z'),
      }),
    ).toEqual(keys);
  });

  it('returns nothing for an inverted window', () => {
    expect(
      engine.expand(base, { from: at('2026-06-01T00:00:00Z'), to: at('2026-05-01T00:00:00Z') }),
    ).toEqual([]);
  });

  it('a one-off yields exactly its DTSTART, and only inside the window', () => {
    const once = rule({ dtstartLocal: '2026-09-07T09:00:00', timezone: MOSCOW });
    expect(
      engine.expand(once, { from: at('2026-09-01T00:00:00Z'), to: at('2026-09-30T00:00:00Z') }),
    ).toEqual(['2026-09-07T09:00:00']);
    expect(
      engine.expand(once, { from: at('2026-10-01T00:00:00Z'), to: at('2026-10-30T00:00:00Z') }),
    ).toEqual([]);
  });

  it('does not include DTSTART when the rule does not land on it (RFC 5545)', () => {
    // 2026-09-07 is a Monday; the rule only produces Tuesdays and Thursdays.
    const weekly = rule({
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH',
      dtstartLocal: '2026-09-07T09:00:00',
      timezone: MOSCOW,
    });
    const keys = engine.expand(weekly, {
      from: at('2026-09-01T00:00:00Z'),
      to: at('2026-09-20T00:00:00Z'),
    });
    expect(keys).toEqual([
      '2026-09-08T09:00:00',
      '2026-09-10T09:00:00',
      '2026-09-15T09:00:00',
      '2026-09-17T09:00:00',
    ]);
  });

  it('honours a UTC UNTIL by translating it into the series wall clock', () => {
    // 2026-05-04T21:59:59Z is 2026-05-04T23:59:59 in Berlin (CEST, +02:00),
    // so the 4th is included and the 5th is not.
    const bounded = rule({
      rrule: 'FREQ=DAILY;INTERVAL=1;UNTIL=20260504T215959Z',
      dtstartLocal: '2026-05-01T08:00:00',
      timezone: BERLIN,
    });
    const keys = engine.expand(bounded, {
      from: at('2026-04-30T00:00:00Z'),
      to: at('2026-05-10T00:00:00Z'),
    });
    expect(keys.at(-1)).toBe('2026-05-04T08:00:00');
  });
});

describe('localDateOf', () => {
  it('returns the local calendar date of a key', () => {
    expect(engine.localDateOf('2026-03-29T02:30:00')).toBe('2026-03-29');
    expect(engine.localDateOf('2026-12-31T23:59:59')).toBe('2026-12-31');
  });

  it('rejects an offset-bearing string — those are the bug this model prevents', () => {
    expect(() => engine.localDateOf('2026-03-29T02:30:00Z')).toThrow();
    expect(() => engine.localDateOf('not-a-datetime')).toThrow();
  });
});

describe('seriesEndsAt', () => {
  it('is null for an unbounded rule', () => {
    expect(
      engine.seriesEndsAt(
        rule({ rrule: 'FREQ=DAILY;INTERVAL=1', dtstartLocal: '2026-01-01T09:00:00' }),
      ),
    ).toBeNull();
  });

  it('resolves COUNT to the last occurrence instant', () => {
    const ends = engine.seriesEndsAt(
      rule({
        rrule: 'FREQ=DAILY;INTERVAL=1;COUNT=3',
        dtstartLocal: '2026-01-01T09:00:00',
        timezone: BERLIN,
      }),
    );
    expect(ends?.toISOString()).toBe('2026-01-03T08:00:00.000Z');
  });

  it('resolves UNTIL to the last occurrence at or before it', () => {
    const ends = engine.seriesEndsAt(
      rule({
        rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;UNTIL=20260930T235959Z',
        dtstartLocal: '2026-09-07T09:00:00',
        timezone: MOSCOW,
      }),
    );
    // Mondays in Sept 2026: 7, 14, 21, 28.
    expect(ends?.toISOString()).toBe('2026-09-28T06:00:00.000Z');
  });

  it('a one-off ends at its own DTSTART', () => {
    const ends = engine.seriesEndsAt(
      rule({ dtstartLocal: '2026-09-07T09:00:00', timezone: MOSCOW }),
    );
    expect(ends?.toISOString()).toBe('2026-09-07T06:00:00.000Z');
  });

  it('an RDATE past the last rule occurrence extends the series', () => {
    const ends = engine.seriesEndsAt(
      rule({
        rrule: 'FREQ=DAILY;INTERVAL=1;COUNT=3',
        dtstartLocal: '2026-01-01T09:00:00',
        timezone: BERLIN,
        rdatesLocal: ['2026-02-01T09:00:00'],
      }),
    );
    expect(ends?.toISOString()).toBe('2026-02-01T08:00:00.000Z');
  });

  it('skips a trailing EXDATE', () => {
    const ends = engine.seriesEndsAt(
      rule({
        rrule: 'FREQ=DAILY;INTERVAL=1;COUNT=3',
        dtstartLocal: '2026-01-01T09:00:00',
        timezone: BERLIN,
        exdatesLocal: ['2026-01-03T09:00:00'],
      }),
    );
    expect(ends?.toISOString()).toBe('2026-01-02T08:00:00.000Z');
  });
});

describe('compile / decompile — the restricted grammar', () => {
  const anchor = '2026-09-07T09:00:00';

  const presets: RecurrencePreset[] = [
    { kind: 'daily', interval: 1 },
    { kind: 'daily', interval: 3 },
    { kind: 'weekly', interval: 1, weekdays: ['TU', 'TH'] },
    { kind: 'weekly', interval: 2, weekdays: ['MO'] },
    { kind: 'weekly', interval: 1, weekdays: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] },
    { kind: 'monthly_day', interval: 1, dayOfMonth: 15 },
    { kind: 'monthly_day', interval: 3, dayOfMonth: 31 },
    { kind: 'monthly_last_day', interval: 1 },
    { kind: 'monthly_last_day', interval: 2 },
  ];

  const ends: RecurrenceEnd[] = [
    { type: 'never' },
    { type: 'after', count: 10 },
    { type: 'until', untilLocal: '2026-12-31T23:59:59' },
  ];

  for (const preset of presets) {
    for (const end of ends) {
      it(`round-trips ${preset.kind}/${preset.interval} with ends=${end.type}`, () => {
        const line = engine.compile(preset, end, anchor, MOSCOW);
        const back = engine.decompile(line, MOSCOW);
        expect(back).not.toBeNull();
        expect(back?.preset).toEqual(preset);
        expect(back?.ends).toEqual(end);
        // Compilation is stable: the same input always yields the same text.
        expect(engine.compile(preset, end, anchor, MOSCOW)).toBe(line);
      });
    }
  }

  it('compiles the documented shapes verbatim', () => {
    expect(engine.compile({ kind: 'daily', interval: 2 }, { type: 'never' }, anchor)).toBe(
      'FREQ=DAILY;INTERVAL=2',
    );
    expect(
      engine.compile(
        { kind: 'weekly', interval: 1, weekdays: ['WE', 'MO'] },
        { type: 'never' },
        anchor,
      ),
    ).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE');
    expect(
      engine.compile(
        { kind: 'monthly_day', interval: 1, dayOfMonth: 5 },
        { type: 'never' },
        anchor,
      ),
    ).toBe('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=5');
    expect(
      engine.compile({ kind: 'monthly_last_day', interval: 1 }, { type: 'never' }, anchor),
    ).toBe('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1');
  });

  it('writes UNTIL as a UTC instant resolved through the series timezone', () => {
    const line = engine.compile(
      { kind: 'daily', interval: 1 },
      { type: 'until', untilLocal: '2026-12-31T23:59:59' },
      anchor,
      MOSCOW,
    );
    // 23:59:59 Moscow (UTC+3) on 31 Dec is 20:59:59Z the same day.
    expect(line).toBe('FREQ=DAILY;INTERVAL=1;UNTIL=20261231T205959Z');
  });

  it('rejects an UNTIL at or before DTSTART', () => {
    expect(() =>
      engine.compile(
        { kind: 'daily', interval: 1 },
        { type: 'until', untilLocal: '2026-09-07T09:00:00' },
        anchor,
        MOSCOW,
      ),
    ).toThrow();
  });

  it('returns null for FREQ=YEARLY;BYSETPOS=-1', () => {
    expect(engine.decompile('FREQ=YEARLY;BYSETPOS=-1')).toBeNull();
  });

  it('returns null for everything else outside the grammar', () => {
    const outside = [
      'FREQ=YEARLY',
      'FREQ=HOURLY;INTERVAL=6',
      'FREQ=MONTHLY;BYDAY=1MO',
      'FREQ=WEEKLY;BYDAY=2MO',
      'FREQ=WEEKLY', // no BYDAY: the weekday would have to come from DTSTART
      'FREQ=MONTHLY', // no BYMONTHDAY
      'FREQ=MONTHLY;BYMONTHDAY=1,15',
      'FREQ=MONTHLY;BYMONTHDAY=-2',
      'FREQ=DAILY;BYHOUR=9',
      'FREQ=DAILY;BYMONTH=1',
      'FREQ=WEEKLY;BYDAY=MO;WKST=SU',
      'FREQ=DAILY;COUNT=3;UNTIL=20261231T000000Z',
      'FREQ=DAILY;INTERVAL=0',
      'INTERVAL=2',
      'nonsense',
      '',
    ];
    for (const line of outside) {
      expect(engine.decompile(line), line).toBeNull();
    }
  });

  it('tolerates an RRULE: prefix and a missing INTERVAL', () => {
    expect(engine.decompile('RRULE:FREQ=DAILY')).toEqual({
      preset: { kind: 'daily', interval: 1 },
      ends: { type: 'never' },
    });
  });

  it('decompiles a stored UNTIL back into the series wall clock', () => {
    const back = engine.decompile('FREQ=DAILY;INTERVAL=1;UNTIL=20261231T205959Z', MOSCOW);
    expect(back?.ends).toEqual({ type: 'until', untilLocal: '2026-12-31T23:59:59' });
  });
});

describe('withUntilBefore — the series-split primitive', () => {
  const weekly = rule({
    rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
    dtstartLocal: '2026-09-07T09:00:00',
    timezone: MOSCOW,
  });

  it('sets UNTIL to one second before the anchor key', () => {
    const line = engine.withUntilBefore(weekly, '2026-09-14T09:00:00');
    // 09:00 Moscow = 06:00Z; one second before is 05:59:59Z.
    expect(line).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;UNTIL=20260914T055959Z');
  });

  it('strips COUNT — RFC 5545 forbids COUNT and UNTIL together', () => {
    const counted = { ...weekly, rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=20' };
    const line = engine.withUntilBefore(counted, '2026-09-14T09:00:00');
    expect(line).not.toMatch(/COUNT/);
    expect(line).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;UNTIL=20260914T055959Z');
  });

  it('replaces an existing UNTIL rather than appending a second one', () => {
    const bounded = { ...weekly, rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20271231T000000Z' };
    const line = engine.withUntilBefore(bounded, '2026-09-14T09:00:00');
    expect(line.match(/UNTIL=/g)).toHaveLength(1);
    expect(line).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20260914T055959Z');
  });

  it('the split actually excludes the anchor occurrence', () => {
    const line = engine.withUntilBefore(weekly, '2026-09-14T09:00:00');
    const closed = { ...weekly, rrule: line };
    const keys = engine.expand(closed, {
      from: at('2026-09-01T00:00:00Z'),
      to: at('2026-10-01T00:00:00Z'),
    });
    expect(keys).toEqual(['2026-09-07T09:00:00']);
  });

  it('refuses to split a one-off', () => {
    expect(() =>
      engine.withUntilBefore(rule({ dtstartLocal: '2026-09-07T09:00:00' }), '2026-09-07T09:00:00'),
    ).toThrow();
  });
});

describe('describe — Russian summaries', () => {
  const ru = (rrule: string | null, dtstartLocal = '2026-09-08T09:00:00'): string =>
    engine.describe(rule({ rrule, dtstartLocal, timezone: MOSCOW }));

  it('matches the documented examples', () => {
    expect(ru('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH')).toBe('Каждый вторник и четверг, 09:00');
    expect(ru('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')).toContain('Каждые 2 недели по понедельникам');
    expect(ru('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1')).toContain('В последний день месяца');
  });

  it('gets день/дня/дней right', () => {
    expect(ru('FREQ=DAILY;INTERVAL=1')).toBe('Каждый день, 09:00');
    expect(ru('FREQ=DAILY;INTERVAL=2')).toBe('Каждые 2 дня, 09:00');
    expect(ru('FREQ=DAILY;INTERVAL=4')).toBe('Каждые 4 дня, 09:00');
    expect(ru('FREQ=DAILY;INTERVAL=5')).toBe('Каждые 5 дней, 09:00');
    expect(ru('FREQ=DAILY;INTERVAL=11')).toBe('Каждые 11 дней, 09:00');
    expect(ru('FREQ=DAILY;INTERVAL=21')).toBe('Каждый 21 день, 09:00');
    expect(ru('FREQ=DAILY;INTERVAL=22')).toBe('Каждые 22 дня, 09:00');
  });

  it('gets неделю/недели/недель right', () => {
    expect(ru('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')).toBe('Каждые 2 недели по понедельникам, 09:00');
    expect(ru('FREQ=WEEKLY;INTERVAL=5;BYDAY=MO,WE')).toBe(
      'Каждые 5 недель по понедельникам и средам, 09:00',
    );
    expect(ru('FREQ=WEEKLY;INTERVAL=11;BYDAY=SU')).toBe('Каждые 11 недель по воскресеньям, 09:00');
    expect(ru('FREQ=WEEKLY;INTERVAL=21;BYDAY=SA')).toBe('Каждую 21 неделю по субботам, 09:00');
  });

  it('agrees the determiner with the weekday gender', () => {
    expect(ru('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO')).toBe('Каждый понедельник, 09:00');
    expect(ru('FREQ=WEEKLY;INTERVAL=1;BYDAY=WE')).toBe('Каждую среду, 09:00');
    expect(ru('FREQ=WEEKLY;INTERVAL=1;BYDAY=SU')).toBe('Каждое воскресенье, 09:00');
    expect(ru('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR')).toBe(
      'Каждый понедельник, среду и пятницу, 09:00',
    );
  });

  it('gets месяц/месяца/месяцев right', () => {
    expect(ru('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15')).toBe('Каждый месяц, 15-го числа, 09:00');
    expect(ru('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15')).toBe('Каждые 2 месяца, 15-го числа, 09:00');
    expect(ru('FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=1')).toBe('Каждые 6 месяцев, 1-го числа, 09:00');
    expect(ru('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1')).toBe('В последний день месяца, 09:00');
    expect(ru('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=-1')).toBe(
      'Каждые 3 месяца, в последний день, 09:00',
    );
  });

  it('gets раз/раза/раз right and renders an end date', () => {
    expect(ru('FREQ=DAILY;INTERVAL=1;COUNT=1')).toBe('Каждый день, 09:00, 1 раз');
    expect(ru('FREQ=DAILY;INTERVAL=1;COUNT=3')).toBe('Каждый день, 09:00, 3 раза');
    expect(ru('FREQ=DAILY;INTERVAL=1;COUNT=5')).toBe('Каждый день, 09:00, 5 раз');
    expect(ru('FREQ=DAILY;INTERVAL=1;COUNT=11')).toBe('Каждый день, 09:00, 11 раз');
    expect(ru('FREQ=DAILY;INTERVAL=1;UNTIL=20261231T205959Z')).toBe(
      'Каждый день, 09:00, до 31.12.2026',
    );
  });

  it('describes a one-off', () => {
    expect(ru(null, '2026-09-07T09:00:00')).toBe('Один раз, 7 сентября 2026 г., 09:00');
    expect(ru(null, '2026-01-01T18:45:00')).toBe('Один раз, 1 января 2026 г., 18:45');
  });

  it('falls back to something readable for an imported rule', () => {
    expect(ru('FREQ=YEARLY', '2026-05-19T00:00:00')).toBe('Каждый год, 19 мая, 00:00');
    expect(ru('FREQ=YEARLY;BYSETPOS=-1;BYDAY=MO')).toContain('Каждый год');
    expect(ru('FREQ=MINUTELY;INTERVAL=30')).toBe('Особое расписание, 09:00');
  });
});
