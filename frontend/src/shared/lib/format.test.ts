import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  parseMoney,
  percentOf,
  ringPercent,
  initials,
  formatDuration,
} from './format';

/**
 * Money.
 *
 * D6: amounts are integer minor units (копейки) end to end. These tests pin the
 * two things that break silently — the minor→major conversion and the Russian
 * number format (comma decimal separator, non-breaking group separator, `₽`
 * after the number).
 *
 * `Intl` emits U+00A0 / U+202F rather than a plain space, so every assertion
 * normalises whitespace before comparing. Comparing against a literal typed
 * space is the classic way these tests pass locally and fail in CI.
 */
const normalize = (value: string): string => value.replace(/[\u00A0\u202F]/g, ' ');

describe('formatMoney', () => {
  it('converts minor units to a Russian amount', () => {
    expect(normalize(formatMoney(123456))).toBe('1 234,56 ₽');
  });

  it('drops the fraction on whole amounts by default', () => {
    expect(normalize(formatMoney(120000))).toBe('1 200 ₽');
    expect(normalize(formatMoney(0))).toBe('0 ₽');
  });

  it('keeps the fraction when asked', () => {
    expect(normalize(formatMoney(120000, { hideZeroFraction: false }))).toBe('1 200,00 ₽');
  });

  it('formats amounts under one rouble', () => {
    expect(normalize(formatMoney(1))).toBe('0,01 ₽');
    expect(normalize(formatMoney(99))).toBe('0,99 ₽');
  });

  it('formats negative amounts', () => {
    expect(normalize(formatMoney(-50000))).toBe('-500 ₽');
  });

  it('adds an explicit plus for signed positive values', () => {
    expect(normalize(formatMoney(25000, { signed: true }))).toBe('+250 ₽');
    expect(normalize(formatMoney(-25000, { signed: true }))).toBe('-250 ₽');
  });

  it('can omit the currency', () => {
    expect(normalize(formatMoney(123456, { withoutCurrency: true }))).toBe('1 234,56');
  });

  it('groups large amounts', () => {
    expect(normalize(formatMoney(123456789))).toBe('1 234 567,89 ₽');
  });

  it('rejects non-integer input in development, because that means a float leaked in', () => {
    expect(() => formatMoney(1234.5)).toThrow(/integer minor units/);
  });
});

describe('parseMoney', () => {
  it('round-trips a formatted amount', () => {
    expect(parseMoney('1 234,56')).toBe(123456);
    expect(parseMoney('1234.56')).toBe(123456);
    expect(parseMoney('250')).toBe(25000);
  });

  it('tolerates currency symbols and spacing', () => {
    expect(parseMoney('1 234,56 ₽')).toBe(123456);
    expect(parseMoney('  99 ')).toBe(9900);
  });

  it('avoids float drift', () => {
    // 19.99 * 100 === 1998.9999999999998 in IEEE 754.
    expect(parseMoney('19,99')).toBe(1999);
    expect(parseMoney('0,07')).toBe(7);
  });

  it('returns null for junk', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('—')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });
  it('rejects more precision than копейки can hold', () => {
    // Silently rounding a typo would put a wrong amount in the family ledger.
    expect(parseMoney('12,345')).toBeNull();
    expect(parseMoney('1.2345')).toBeNull();
  });

  it('never routes the value through a float', () => {
    // Each of these drifts if computed as Number(x) * 100.
    expect(parseMoney('19,99')).toBe(1999);
    expect(parseMoney('70,7')).toBe(7070);
    expect(parseMoney('8,05')).toBe(805);
    expect(parseMoney('0,1')).toBe(10);
  });

  it('rejects rubbish rather than coercing it', () => {
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('1,2,3')).toBeNull();
  });

  /**
   * The reason this helper was consolidated onto the goals module's parser.
   *
   * `parseMoney` used to strip `[^\d.,-]` **before** validating, so each of
   * these produced a plausible amount the user never typed and put it in the
   * family ledger with nothing on screen to show it had happened.
   */
  it.each([
    ['1234 руб', 123400],
    ['1234abc', 123400],
    ['1e5', 1500],
    ['5+5', 5500],
    ['12 июля', 1200],
  ])('no longer silently coerces %s (was %i minor units)', (input) => {
    expect(parseMoney(input)).toBeNull();
  });
});

/**
 * Progress used to be computed four different ways — twice on the server, twice
 * here — with two contradictory contracts. These are the cases where the old
 * implementations disagreed with each other.
 */
describe('percentOf', () => {
  it('is exact integer arithmetic, not `Math.round(c / t * 100)`', () => {
    // `285 / 1000 * 100 === 28.499999999999996` in IEEE 754, so the float route
    // rounded DOWN to 28 while the server's integer identity gave 29. The goals
    // screen and the home screen showed different numbers for the same goal.
    expect(percentOf(285, 1000)).toBe(29);
    expect(percentOf(2_850, 10_000)).toBe(29);
    // The same disagreement, the other way, at the next half-way point.
    expect(percentOf(33_500, 100_000)).toBe(34);
    expect(percentOf(33_333, 100_000)).toBe(33);
  });

  it('does NOT cap at 100 — an over-funded goal reads honestly', () => {
    // `contracts/goals.ts` always said this; `contracts/dashboard.ts` capped it,
    // so the same goal read «112 %» on one screen and «100 %» on another.
    expect(percentOf(112_000, 100_000)).toBe(112);
    expect(percentOf(1_000_000, 100_000)).toBe(1000);
  });

  it('floors at 0 and treats a zero target as no progress', () => {
    expect(percentOf(0, 100_000)).toBe(0);
    expect(percentOf(50_000, 100_000)).toBe(50);
    expect(percentOf(-1_000, 100_000)).toBe(0);
    expect(percentOf(5_000, 0)).toBe(0);
  });

  it('always returns an integer', () => {
    for (const current of [0, 1, 7, 285, 33_333, 99_999, 112_000]) {
      expect(Number.isInteger(percentOf(current, 100_000))).toBe(true);
    }
  });
});

describe('ringPercent', () => {
  it('clamps to 0–100 — and only for drawing the arc', () => {
    expect(ringPercent(percentOf(112_000, 100_000))).toBe(100);
    expect(ringPercent(percentOf(-1_000, 100_000))).toBe(0);
    expect(ringPercent(percentOf(50_000, 100_000))).toBe(50);
  });

  it('leaves the printed number alone', () => {
    // The label and the fill are allowed to differ; that is the whole point of
    // the clamp living in a separate function.
    expect(percentOf(112_000, 100_000)).toBe(112);
    expect(ringPercent(112)).toBe(100);
  });
});

describe('initials', () => {
  it('takes the first letter of the first and last word', () => {
    expect(initials('Анна Иванова')).toBe('АИ');
    expect(initials('Пётр')).toBe('П');
    expect(initials('Мария Петровна Сидорова')).toBe('МС');
  });

  it('survives extra whitespace', () => {
    expect(initials('  Анна   Иванова  ')).toBe('АИ');
    expect(initials('')).toBe('');
  });
});

describe('formatDuration', () => {
  it('renders hours and minutes in Russian shorthand', () => {
    expect(formatDuration(30)).toBe('30 мин');
    expect(formatDuration(60)).toBe('1 ч');
    expect(formatDuration(150)).toBe('2 ч 30 мин');
    expect(formatDuration(0)).toBe('0 мин');
  });
});
