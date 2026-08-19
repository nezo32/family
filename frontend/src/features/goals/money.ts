/**
 * Money parsing for the moneybox feature — D6, and the most important file in
 * it.
 *
 * Every amount in this app is an **integer number of копейки**. `1 234,56 ₽` is
 * the integer `123456`. There is no point in the pipeline — not in a form
 * value, not in a preview, not in a chart datum — where a monetary quantity is
 * a float.
 *
 * The parser below never multiplies and never calls `parseFloat`: it splits the
 * typed string into an integer part and a two-digit fraction part and
 * **concatenates the digits**, so `"1 234,56"` becomes the digit string
 * `"123456"` and then the integer `123456`. `19.99 * 100 === 1998.9999999999998`
 * is a bug that simply cannot be written this way.
 *
 * Display formatting is not done here — it belongs to `formatMoney()` in
 * `@/shared/lib/format`, which is the single place minor units become text.
 */

/** Why a typed amount could not be turned into minor units. */
export type MoneyParseError = 'empty' | 'invalid' | 'precision' | 'tooLarge' | 'notPositive';

export type MoneyParseResult =
  | { readonly ok: true; readonly minorUnits: number }
  | { readonly ok: false; readonly error: MoneyParseError };

/**
 * Whitespace the user (or `Intl.NumberFormat('ru-RU')`) can put between
 * thousands: a plain space, NBSP, narrow NBSP, figure space, plus anything
 * `\s` already covers.
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

/**
 * Progress of a goal in whole percent.
 *
 * Mirrors the server's `progressPercent` (see `contracts/goals.ts`): floored at
 * 0, **not** capped at 100 — an over-funded goal reads `112 %` rather than
 * pretending to be exactly full. Use `ringPercent` for the visual fill.
 */
export function goalProgressPercent(currentAmount: number, targetAmount: number): number {
  if (targetAmount <= 0) return 0;
  return Math.max(0, Math.round((currentAmount / targetAmount) * 100));
}

/** What a progress ring or bar should actually fill: 0–100. */
export function ringPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

/** `targetAmount - currentAmount`, floored at 0 — same rule as the server. */
export function remainingAmount(currentAmount: number, targetAmount: number): number {
  return Math.max(0, targetAmount - currentAmount);
}
