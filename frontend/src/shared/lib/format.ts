import { format as formatDate } from 'date-fns';
import { ru } from 'date-fns/locale';

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

/** Parse a user-typed amount ("1 234,56", "1234.5") back into minor units. */
export function parseMoney(input: string): number | null {
  const normalized = input
    // `\s` already covers U+00A0 and U+202F, the separators Intl emits for ru-RU.
    .replace(/\s/g, '')
    .replace(/[^\d.,-]/g, '')
    .replace(',', '.');
  if (normalized === '' || normalized === '-') return null;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  // `Math.round` on the scaled value, never `parseFloat * 100`, which drifts:
  // 19.99 * 100 === 1998.9999999999998.
  return Math.round(value * 100);
}

/** Percentage of a goal reached, clamped to 0–100 and rounded to whole percent. */
export function progressPercent(current: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / target) * 100)));
}

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
