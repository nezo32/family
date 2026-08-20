import { format as formatDate } from 'date-fns';
import { ru } from 'date-fns/locale';

import { dateKeyToDate } from './datetime';

/**
 * Formatting helpers.
 *
 * Two invariants worth stating loudly:
 *
 * 1. **Money is integer minor units** (копейки) everywhere — D6. Nothing in this
 *    app ever holds a monetary float. `formatMoney(123456)` → `1 234,56 ₽`.
 *    The conversion to a decimal happens here, at the very last moment, and
 *    nowhere else.
 *
 * 2. **Dates are rendered in the family timezone**, not the device timezone.
 *    A parent in Bangkok looking at "ужин в 19:00" must see the time the family
 *    at home will sit down, not their own local clock (D2). The timezone comes
 *    from `family_settings` via `/api/me`; `setFamilyTimeZone()` installs it at
 *    app start and every formatter below honours it.
 */

/* -------------------------------------------------------------------------
 * Timezone
 * ---------------------------------------------------------------------- */

const FALLBACK_TIME_ZONE = 'Europe/Moscow';

let familyTimeZone: string = FALLBACK_TIME_ZONE;

/** Called once from the shell after `/api/me` resolves. */
export function setFamilyTimeZone(timeZone: string | null | undefined): void {
  familyTimeZone = timeZone && timeZone.length > 0 ? timeZone : FALLBACK_TIME_ZONE;
}

export function getFamilyTimeZone(): string {
  return familyTimeZone;
}

/** The device timezone, for the "ваш часовой пояс отличается" hint in settings. */
export function getDeviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/* -------------------------------------------------------------------------
 * Money
 * ---------------------------------------------------------------------- */

const DEFAULT_CURRENCY = 'RUB';

/**
 * Integer minor units → a Russian-formatted amount.
 *
 * `123456` → `1 234,56 ₽`   (non-breaking spaces, comma decimal separator)
 * `120000` → `1 200 ₽`      when `hideZeroFraction` (the default) is on
 *
 * The value must already be an integer; passing a float is a bug upstream and
 * throws in development so it is caught immediately.
 */
export function formatMoney(
  minorUnits: number,
  options: {
    currency?: string;
    /** Drop `,00` on whole amounts. Default `true` — prices are usually round. */
    hideZeroFraction?: boolean;
    /** Render `+` for positive values (ledger entries). Default `false`. */
    signed?: boolean;
    /** Omit the currency symbol entirely. */
    withoutCurrency?: boolean;
  } = {},
): string {
  if (!Number.isInteger(minorUnits)) {
    if (import.meta.env.DEV) {
      throw new Error(
        `formatMoney expects integer minor units (D6), received ${String(minorUnits)}`,
      );
    }
    minorUnits = Math.round(minorUnits);
  }

  const {
    currency = DEFAULT_CURRENCY,
    hideZeroFraction = true,
    signed = false,
    withoutCurrency = false,
  } = options;

  const isWhole = minorUnits % 100 === 0;
  const fractionDigits = hideZeroFraction && isWhole ? 0 : 2;

  const formatter = new Intl.NumberFormat('ru-RU', {
    ...(withoutCurrency ? {} : { style: 'currency' as const, currency }),
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });

  const text = formatter.format(minorUnits / 100);
  if (signed && minorUnits > 0) return `+${text}`;
  return text;
}

/* -------------------------------------------------------------------------
 * Parsing money the user typed
 *
 * This used to be two implementations, and the *shared* one was the dangerous
 * one. It stripped `[^\d.,-]` **before** validating, so `"1234 руб"` became
 * 1234 ₽, `"1234abc"` became 1234 ₽, `"1e5"` became 15 ₽ and `"5+5"` became
 * 55 ₽ — every one of them a plausible-looking number the user never typed,
 * landing in the family's ledger with nothing on screen to show it happened.
 * `features/goals/money.ts` had a stricter parser that rejected all four and
 * returned a typed reason the forms already display.
 *
 * The strict one won and moved here. There is one parser now; nothing coerces.
 * ---------------------------------------------------------------------- */

/** Why a typed amount could not be turned into minor units. */
export type MoneyParseError = 'empty' | 'invalid' | 'precision' | 'tooLarge' | 'notPositive';

export type MoneyParseResult =
  | { readonly ok: true; readonly minorUnits: number }
  | { readonly ok: false; readonly error: MoneyParseError };

/**
 * Whitespace the user (or `Intl.NumberFormat('ru-RU')`) can put between
 * thousands: a plain space, NBSP, narrow NBSP, figure space — plus the rouble
 * sign, because the value round-trips through `formatMoney`.
 *
 * Note what is **not** here: letters, `+`, `e`, and every other character the
 * old `parseMoney` quietly deleted.
 */
const IGNORED_CHARS = /[\s\u00A0\u202F\u2007\u2009\u20BD]/g;

/** `-1 234,56` → sign, integer digits, optional decimal separator + fraction. */
const AMOUNT_PATTERN = /^([+-]?)(\d*)(?:[.,](\d*))?$/;

/**
 * Widest amount we accept: 15 digits of копейки ≈ 10 trillion ₽, comfortably
 * inside `Number.MAX_SAFE_INTEGER` so every later addition stays exact.
 */
const MAX_MINOR_DIGITS = 15;

/**
 * Parse a user-typed amount into **integer minor units**, with a reason when
 * it cannot be done.
 *
 * Never multiplies and never calls `parseFloat`: it splits the typed string
 * into an integer part and a two-digit fraction part and **concatenates the
 * digits**, so `"1 234,56"` becomes the digit string `"123456"` and then the
 * integer `123456`. `19.99 * 100 === 1998.9999999999998` is a bug that simply
 * cannot be written this way (D6).
 *
 * Accepted: `1234`, `1 234`, `1 234,56`, `1234.5`, `1234.50`, `,50`, `-100`.
 * Rejected: empty input, letters, several separators, more than two decimals
 * (silently rounding somebody's money is not this function's job), and amounts
 * beyond the safe-integer range.
 */
export function parseAmount(input: string): MoneyParseResult {
  const cleaned = input.replace(IGNORED_CHARS, '');
  if (cleaned === '') return { ok: false, error: 'empty' };

  const match = AMOUNT_PATTERN.exec(cleaned);
  if (!match) return { ok: false, error: 'invalid' };

  const [, sign = '', wholePart = '', fractionPart] = match;

  // `-`, `,` or `-,` on their own carry no digits at all.
  if (wholePart === '' && (fractionPart === undefined || fractionPart === '')) {
    return { ok: false, error: 'invalid' };
  }
  if (fractionPart !== undefined && fractionPart.length > 2) {
    return { ok: false, error: 'precision' };
  }

  // The whole point: build the minor-unit *digit string*, never a product.
  const kopeks = (fractionPart ?? '').padEnd(2, '0');
  const digits = `${wholePart}${kopeks}`.replace(/^0+(?=\d)/, '');

  if (digits.length > MAX_MINOR_DIGITS) return { ok: false, error: 'tooLarge' };

  const magnitude = Number(digits);
  if (!Number.isSafeInteger(magnitude)) return { ok: false, error: 'tooLarge' };

  return { ok: true, minorUnits: sign === '-' ? -magnitude : magnitude };
}

/** `parseAmount` for callers that only care whether it worked. */
export function parseMinorUnits(input: string): number | null {
  const result = parseAmount(input);
  return result.ok ? result.minorUnits : null;
}

/** Same as `parseAmount`, but a zero or negative amount is an error too. */
export function parsePositiveAmount(input: string): MoneyParseResult {
  const result = parseAmount(input);
  if (!result.ok) return result;
  if (result.minorUnits <= 0) return { ok: false, error: 'notPositive' };
  return result;
}

/**
 * The old name, kept so no call site has to care — but it is now exactly
 * {@link parseMinorUnits}, i.e. the strict parser. `parseMoney('1234 руб')` is
 * `null` where it used to be `123400`.
 */
export const parseMoney = parseMinorUnits;

/**
 * Minor units → the text an editable field should start with.
 *
 * Deliberately ungrouped (`1234,56`, not `1 234,56`): the value goes back into
 * an `<input>` the user will edit, and grouping separators there fight the
 * caret. `,00` is dropped on whole amounts.
 */
export function formatMinorUnitsForInput(minorUnits: number): string {
  if (!Number.isInteger(minorUnits)) return '';
  const sign = minorUnits < 0 ? '-' : '';
  const magnitude = Math.abs(minorUnits);
  const whole = Math.floor(magnitude / 100);
  const kopeks = magnitude % 100;
  if (kopeks === 0) return `${sign}${String(whole)}`;
  return `${sign}${String(whole)},${String(kopeks).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------
 * Progress
 * ---------------------------------------------------------------------- */

/**
 * `percentOf` is the server's own exact-integer progress formula and
 * `ringPercent` is the 0–100 **visual** bound for an arc that cannot render
 * past full. Re-exported from `@family/shared` rather than re-implemented:
 * this file used to carry a third `Math.round(c / t * 100)` clamped at 100,
 * which read «100 %» for a goal the goals screen honestly reported as «112 %»,
 * and rounded `285/1000` to 28 where the API said 29.
 */
export { percentOf, ringPercent } from '@family/shared';

/* -------------------------------------------------------------------------
 * Numbers
 * ---------------------------------------------------------------------- */

export function formatNumber(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/* -------------------------------------------------------------------------
 * Dates & times, in the family timezone
 * ---------------------------------------------------------------------- */

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function intl(options: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timeZone ?? familyTimeZone, ...options });
}

/** `19:00` — 24-hour, as Russian users expect. */
export function formatTime(value: Date | string | number, timeZone?: string): string {
  return intl({ hour: '2-digit', minute: '2-digit', hour12: false }, timeZone).format(
    toDate(value),
  );
}

/** `07.09.2026` */
export function formatDateShort(value: Date | string | number, timeZone?: string): string {
  return intl({ day: '2-digit', month: '2-digit', year: 'numeric' }, timeZone).format(
    toDate(value),
  );
}

/** `7 сентября 2026 г.` */
export function formatDateLong(value: Date | string | number, timeZone?: string): string {
  return intl({ day: 'numeric', month: 'long', year: 'numeric' }, timeZone).format(toDate(value));
}

/**
 * `25 августа` — day and month, no year and no clock.
 *
 * For a date whose *day* is the whole point and whose minute is noise: a pin's
 * expiry («закреплено до 25 августа»), a deadline a family reads at a glance.
 * `formatDateTime` would add «, 13:44» — a number nobody set, nobody reads and
 * nobody can act on — and `formatDateLong` would add «2026 г.» to something
 * that is at most a week away.
 */
export function formatDayMonth(value: Date | string | number, timeZone?: string): string {
  return intl({ day: 'numeric', month: 'long' }, timeZone).format(toDate(value));
}

/** `7 сентября, 19:00` */
export function formatDateTime(value: Date | string | number, timeZone?: string): string {
  return intl(
    { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false },
    timeZone,
  ).format(toDate(value));
}

/** `19:00 – 20:30`, collapsing the date when both ends share one. */
export function formatTimeRange(
  start: Date | string | number,
  end: Date | string | number,
  timeZone?: string,
): string {
  return `${formatTime(start, timeZone)} – ${formatTime(end, timeZone)}`;
}

/**
 * Format a **floating local wall-clock string** (`2026-09-07T09:00:00`, no
 * offset — the shape series rows use per D2). These carry no instant, so they
 * are rendered verbatim rather than converted.
 */
export function formatFloatingLocal(value: string, pattern = 'd MMMM, HH:mm'): string {
  const [datePart = '', timePart = '00:00:00'] = value.split('T');
  const [y = '1970', m = '01', d = '01'] = datePart.split('-');
  const [hh = '00', mm = '00'] = timePart.split(':');
  const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm));
  return formatDate(date, pattern, { locale: ru });
}

/* -------------------------------------------------------------------------
 * Date keys — `2026-09-07`, a calendar day with no instant behind it
 *
 * A birthday, a goal deadline and the day half of a floating local datetime are
 * all days, not moments. Sending one through `new Date('2026-09-07')` parses it
 * as **UTC midnight**, and rendering that in a timezone west of Greenwich shows
 * «6 сентября». These render the key from its own digits instead, so nothing
 * can move it. `shared/lib/datetime.ts` holds the matching value helpers.
 * ---------------------------------------------------------------------- */

/** `2026-09-07` → `7 сентября 2026 г.` — the app's long date, everywhere. */
export function formatDateKeyLong(key: string): string {
  const date = dateKeyToDate(key);
  if (!date) return '';
  return `${formatDate(date, 'd MMMM yyyy', { locale: ru })} г.`;
}

/** `2026-09-07` → `07.09.2026`. */
export function formatDateKeyShort(key: string): string {
  const date = dateKeyToDate(key);
  if (!date) return '';
  return formatDate(date, 'dd.MM.yyyy', { locale: ru });
}

/** `2026-09-07` in the family timezone — the key calendar grids are built on. */
export function toLocalDateKey(value: Date | string | number, timeZone?: string): string {
  const parts = intl({ year: 'numeric', month: '2-digit', day: '2-digit' }, timeZone).formatToParts(
    toDate(value),
  );
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** `2 ч 30 мин` from a minute count. */
export function formatDuration(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)} мин`;
  if (rest === 0) return `${String(hours)} ч`;
  return `${String(hours)} ч ${String(rest)} мин`;
}

/** Initials for a fallback avatar: "Анна Иванова" → "АИ". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}

/** Truncate on a word boundary, adding an ellipsis. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
