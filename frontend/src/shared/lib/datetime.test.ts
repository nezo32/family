import { afterEach, describe, expect, it } from 'vitest';

import {
  dateKeyToDate,
  dateToDateKey,
  isTimeValue,
  joinFloating,
  parseTimeInput,
  splitFloating,
} from './datetime';
import { formatDateKeyLong, formatDateKeyShort } from './format';

/**
 * The one thing these fields must never do is move a value.
 *
 * `<input type="date">` handed the form a `YYYY-MM-DD` and `<input type="time">`
 * a `HH:mm`; the replacements hand back the same two strings. Everything below
 * pins that down, and the timezone sweep pins down the failure mode that would
 * otherwise ship silently: a family in São Paulo whose 09:00 задача quietly
 * became yesterday's because something parsed a bare date as UTC midnight (D2).
 */

/** Zones either side of UTC, including the two extremes and a DST-at-midnight one. */
const ZONES = [
  'UTC',
  'Europe/Moscow', // +03
  'Pacific/Kiritimati', // +14 — a UTC parse lands a day early here
  'Pacific/Midway', // -11 — and a day late here
  'America/Sao_Paulo', // DST used to start at midnight
  'Asia/Kolkata', // half-hour offset
];

const originalTimeZone = process.env.TZ;

function withTimeZone(zone: string, body: () => void): void {
  process.env.TZ = zone;
  try {
    body();
  } finally {
    process.env.TZ = originalTimeZone;
  }
}

afterEach(() => {
  process.env.TZ = originalTimeZone;
});

describe('date keys survive every timezone', () => {
  const keys = [
    '2026-01-01',
    '2026-03-08',
    '2026-08-20',
    '2026-09-07',
    '2026-10-25',
    '2026-12-31',
    '1988-04-12',
    '2024-02-29',
  ];

  it.each(ZONES)('round-trips key → Date → key in %s', (zone) => {
    withTimeZone(zone, () => {
      for (const key of keys) {
        const date = dateKeyToDate(key);
        expect(date).not.toBeNull();
        expect(dateToDateKey(date as Date)).toBe(key);
      }
    });
  });

  it.each(ZONES)('renders the day the user picked in %s', (zone) => {
    withTimeZone(zone, () => {
      // The two that a UTC parse would shift off the end of a year.
      expect(formatDateKeyLong('2026-01-01')).toBe('1 января 2026 г.');
      expect(formatDateKeyLong('2026-12-31')).toBe('31 декабря 2026 г.');
      expect(formatDateKeyShort('1988-04-12')).toBe('12.04.1988');
    });
  });

  it('beats the naive parse that would have shifted the day', () => {
    withTimeZone('Pacific/Midway', () => {
      // Guards the guard: if `process.env.TZ` ever stops taking effect in the
      // test worker, this line fails and the sweep above is exposed as vacuous
      // instead of quietly asserting nothing.
      expect(new Date('2026-01-01').getDate()).toBe(31);
      expect(dateToDateKey(dateKeyToDate('2026-01-01') as Date)).toBe('2026-01-01');
      expect(formatDateKeyLong('2026-01-01')).toBe('1 января 2026 г.');
    });
  });

  it('is anchored at local noon, clear of any midnight DST jump', () => {
    expect(dateKeyToDate('2026-09-07')?.getHours()).toBe(12);
  });

  it('rejects a day that does not exist instead of rolling it over', () => {
    expect(dateKeyToDate('2026-02-31')).toBeNull();
    expect(dateKeyToDate('2025-02-29')).toBeNull();
    expect(dateKeyToDate('2026-13-01')).toBeNull();
    expect(dateKeyToDate('07.09.2026')).toBeNull();
    expect(dateKeyToDate('')).toBeNull();
    expect(dateKeyToDate('2026-9-7')).toBeNull();
  });

  it('formats an unset value as empty rather than "Invalid Date"', () => {
    expect(formatDateKeyLong('')).toBe('');
    expect(formatDateKeyShort('nonsense')).toBe('');
  });
});

describe('typed times', () => {
  it.each([
    ['9', '09:00'],
    ['09', '09:00'],
    ['930', '09:30'],
    ['0930', '09:30'],
    ['9:30', '09:30'],
    ['09:30', '09:30'],
    ['9.30', '09:30'],
    ['9 30', '09:30'],
    ['23:59', '23:59'],
    ['0', '00:00'],
    ['  7:05  ', '07:05'],
  ])('parses %s as %s', (input, expected) => {
    expect(parseTimeInput(input)).toBe(expected);
  });

  it.each(['', 'девять', '25:00', '09:75', '9:', ':30', '99999', '-1'])(
    'refuses to invent a time from %s',
    (input) => {
      expect(parseTimeInput(input)).toBeNull();
    },
  );

  it('validates canonical values', () => {
    expect(isTimeValue('00:00')).toBe(true);
    expect(isTimeValue('23:59')).toBe(true);
    expect(isTimeValue('24:00')).toBe(false);
    expect(isTimeValue('9:5')).toBe(false);
    expect(isTimeValue('')).toBe(false);
  });
});

describe('floating local datetimes (D2)', () => {
  it('splits and rejoins without touching the value', () => {
    const value = '2026-09-07T09:00:00';
    const { date, time } = splitFloating(value);
    expect(date).toBe('2026-09-07');
    expect(time).toBe('09:00');
    expect(joinFloating(date, time)).toBe(value);
  });

  it('always emits mandatory seconds, never an offset or a Z', () => {
    const joined = joinFloating('2026-09-07', '09:00');
    expect(joined).toBe('2026-09-07T09:00:00');
    expect(joined).not.toMatch(/[Z+]/);
  });

  it.each(ZONES)('is byte-identical after a round trip in %s', (zone) => {
    withTimeZone(zone, () => {
      for (const value of ['2026-01-01T00:00:00', '2026-06-15T23:59:00', '2026-12-31T12:34:00']) {
        const { date, time } = splitFloating(value);
        expect(joinFloating(date, time)).toBe(value);
      }
    });
  });
});
