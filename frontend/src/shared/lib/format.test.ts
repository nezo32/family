import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney, progressPercent, initials, formatDuration } from './format';

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

});

describe('progressPercent', () => {
  it('clamps to 0–100', () => {
    expect(progressPercent(0, 100000)).toBe(0);
    expect(progressPercent(50000, 100000)).toBe(50);
    expect(progressPercent(150000, 100000)).toBe(100);
    expect(progressPercent(-1000, 100000)).toBe(0);
  });

  it('treats a zero target as no progress rather than dividing by zero', () => {
    expect(progressPercent(5000, 0)).toBe(0);
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
