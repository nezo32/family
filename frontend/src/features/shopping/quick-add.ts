/**
 * Client-side quick-add parser — «2 кг картошки» → `{ quantity: 2, unit: 'кг', name: 'картошка' }`.
 *
 * Why this exists twice. `POST …/items/bulk` accepts the raw `text` and parses
 * it server-side, which is what we send when there is a connection. With no
 * connection the client has to render the optimistic rows *now*, so it parses
 * the same lines locally and sends `items[]` instead. The grammar below is a
 * port of `backend/src/modules/shopping/quick-add.ts` and must stay in step
 * with it.
 *
 * → For the lead: the honest home for this module is `@family/shared`, so that
 *   one implementation serves both sides. Moving it is out of scope for this
 *   agent (packages/shared is off limits), so it is duplicated here instead.
 *
 * Two invariants carried over from the server version:
 *
 * 1. **Pure.** No clock, no storage, no network. The same line always parses to
 *    the same row, which is what makes the offline row match the row the server
 *    later creates.
 * 2. **The user's words are never destroyed.** `name` keeps the original
 *    wording and casing; `normalizedName` is a separate lossy key used only to
 *    match a locally cached product for its default unit/aisle. A bad
 *    normalisation costs a missed default, never a wrong shopping list.
 */

/** The canonical unit set — mirrors `CANONICAL_UNITS` on the server. */
export const CANONICAL_UNITS = ['кг', 'г', 'л', 'мл', 'шт', 'уп', 'пач', 'бут'] as const;

export type CanonicalUnit = (typeof CANONICAL_UNITS)[number];

/**
 * Alias → canonical unit. Russian nouns decline after a numeral, so every unit
 * needs its genitive singular and plural too («2 пачки», «5 пачек»).
 */
const UNIT_ALIASES: Readonly<Record<string, CanonicalUnit>> = {
  кг: 'кг',
  kg: 'кг',
  кило: 'кг',
  килограмм: 'кг',
  килограмма: 'кг',
  килограммов: 'кг',
  г: 'г',
  гр: 'г',
  g: 'г',
  грамм: 'г',
  грамма: 'г',
  граммов: 'г',
  л: 'л',
  l: 'л',
  литр: 'л',
  литра: 'л',
  литров: 'л',
  мл: 'мл',
  ml: 'мл',
  миллилитр: 'мл',
  миллилитра: 'мл',
  миллилитров: 'мл',
  шт: 'шт',
  штук: 'шт',
  штука: 'шт',
  штуки: 'шт',
  штуку: 'шт',
  штучка: 'шт',
  pcs: 'шт',
  pc: 'шт',
  уп: 'уп',
  упак: 'уп',
  упаковка: 'уп',
  упаковки: 'уп',
  упаковку: 'уп',
  упаковок: 'уп',
  пач: 'пач',
  пачка: 'пач',
  пачки: 'пач',
  пачку: 'пач',
  пачек: 'пач',
  бут: 'бут',
  бутыл: 'бут',
  бутылка: 'бут',
  бутылки: 'бут',
  бутылку: 'бут',
  бутылок: 'бут',
};

/** Whitespace of any kind, in any quantity, is one space. */
export function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

const EDGE_PUNCTUATION = /^[\s"'«»„“”().,;:!?\-–—*•]+|[\s"'«»„“”().,;:!?\-–—*•]+$/g;

/**
 * Lookup key half of the job: lowercase, `ё` → `е`, collapse whitespace, drop
 * punctuation hugging either end. `ё` is folded because half the family types
 * «мед» and the other half «мёд», and it is the same jar.
 */
export function normalizeProductName(value: string): string {
  return collapseWhitespace(value.toLowerCase().replace(/ё/g, 'е')).replace(EDGE_PUNCTUATION, '');
}

const HUSHING_AND_VELAR = new Set(['к', 'г', 'х', 'ж', 'ч', 'ш', 'щ']);

/**
 * Best-effort genitive → nominative, applied only when the line carried a
 * quantity or a unit — that is the grammatical context that puts the noun in
 * the genitive («2 кг картошк**и**»). Deliberately conservative: this key is
 * only ever used to look up a *local* suggestion, and the server owns the real
 * catalogue key, so a miss costs one missing default unit.
 */
export function lemmatizeProductName(normalized: string): string {
  if (normalized.length >= 6 && (normalized.endsWith('ов') || normalized.endsWith('ев'))) {
    return normalized.slice(0, -2);
  }
  if (normalized.length >= 4 && normalized.endsWith('ы')) {
    return `${normalized.slice(0, -1)}а`;
  }
  if (normalized.length >= 4 && normalized.endsWith('и')) {
    const stemFinal = normalized.at(-2);
    if (stemFinal !== undefined && HUSHING_AND_VELAR.has(stemFinal)) {
      return `${normalized.slice(0, -1)}а`;
    }
  }
  return normalized;
}

/** The key a locally cached product is matched by. */
export function catalogKeyFor(name: string, hasQuantity: boolean): string {
  const normalized = normalizeProductName(name);
  if (!hasQuantity) return normalized;
  if (normalized.includes(' ')) return normalized;
  return lemmatizeProductName(normalized);
}

/** Mirrors `quantitySchema` in `@family/shared`, so we never emit an invalid value. */
const MAX_QUANTITY = 100_000;
/** `shopping_items.quantity` is `numeric(10, 3)`. */
const QUANTITY_DECIMALS = 3;

const NUMBER_TOKEN = /^(\d{1,6})(?:[.,](\d{1,3}))?$/;
const GLUED_TOKEN = /^(\d{1,6}(?:[.,]\d{1,3})?)([a-zа-я]{1,12})\.?$/;

function fold(token: string): string {
  return token.toLowerCase().replace(/ё/g, 'е');
}

/** Resolves a token to a canonical unit, or `null` for an ordinary word. */
export function canonicalUnit(token: string): CanonicalUnit | null {
  const key = fold(token).replace(EDGE_PUNCTUATION, '');
  return UNIT_ALIASES[key] ?? null;
}

function parseNumber(token: string): number | null {
  const match = NUMBER_TOKEN.exec(token);
  if (!match) return null;
  const value = Number(`${match[1] ?? '0'}.${match[2] ?? '0'}`);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_QUANTITY) return null;
  const factor = 10 ** QUANTITY_DECIMALS;
  return Math.round(value * factor) / factor;
}

interface QuantityToken {
  value: number;
  /** Set only when the unit was glued to the digits («2кг»). */
  unit: CanonicalUnit | null;
}

/**
 * A token is a quantity only if it is entirely a number, or a number glued to a
 * **known** unit. «3,2%» and «250ml-bottle» are words, and words they stay:
 * swallowing «молоко 3,2%» into `quantity: 3.2` is a lie the user only notices
 * standing in the aisle.
 */
function parseQuantityToken(token: string): QuantityToken | null {
  const folded = fold(token);

  const bare = parseNumber(folded);
  if (bare !== null) return { value: bare, unit: null };

  const glued = GLUED_TOKEN.exec(folded);
  if (!glued) return null;
  const value = parseNumber(glued[1] ?? '');
  if (value === null) return null;
  const unit = canonicalUnit(glued[2] ?? '');
  if (!unit) return null;
  return { value, unit };
}

export interface ParsedQuickAddItem {
  /** The user's line, whitespace-collapsed and otherwise untouched. */
  raw: string;
  /** Display name: the user's own words and casing, minus quantity and unit. */
  name: string;
  /** Lossy lookup key. Never shown to anyone. */
  normalizedName: string;
  quantity: number | null;
  unit: CanonicalUnit | null;
  /** The line was marked with `!` — «!молоко» or «молоко!». */
  isUrgent: boolean;
}

const LEADING_BULLET = /^[-–—•*]+\s*/;
const LEADING_URGENT = /^!+\s*/;
const TRAILING_URGENT = /\s*!+$/;

/**
 * Parses one line. Returns `null` when there is nothing to add — a blank line,
 * a stray bullet, or a quantity with no noun attached («2 кг»).
 */
export function parseQuickAddLine(line: string): ParsedQuickAddItem | null {
  const raw = collapseWhitespace(line);
  if (raw.length === 0) return null;

  let working = raw.replace(LEADING_BULLET, '');

  const isUrgent = LEADING_URGENT.test(working) || TRAILING_URGENT.test(working);
  if (isUrgent) {
    working = working.replace(LEADING_URGENT, '').replace(TRAILING_URGENT, '');
  }

  working = collapseWhitespace(working);
  if (working.length === 0) return null;

  const tokens = working.split(' ');
  const consumed = new Set<number>();
  let quantity: number | null = null;
  let unit: CanonicalUnit | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    const parsed = parseQuantityToken(token);
    if (!parsed) continue;

    quantity = parsed.value;
    unit = parsed.unit;
    consumed.add(i);

    if (unit === null) {
      // «2 кг картошки» — the unit sits to the right of the number.
      const next = tokens[i + 1];
      const nextUnit = next === undefined ? null : canonicalUnit(next);
      if (nextUnit) {
        unit = nextUnit;
        consumed.add(i + 1);
      } else {
        // «картошка кг 2» — rarer, but people do type it.
        const previous = i > 0 ? tokens[i - 1] : undefined;
        const previousUnit = previous === undefined ? null : canonicalUnit(previous);
        if (previousUnit) {
          unit = previousUnit;
          consumed.add(i - 1);
        }
      }
    }
    break;
  }

  const name = collapseWhitespace(tokens.filter((_, i) => !consumed.has(i)).join(' '));
  if (name.length === 0) return null;

  const normalizedName = catalogKeyFor(name, quantity !== null || unit !== null);
  if (normalizedName.length === 0) return null;

  return { raw, name, normalizedName, quantity, unit, isUrgent };
}

/**
 * Splits the quick-entry box into lines and parses each one.
 *
 * Newlines, semicolons and commas all separate items — «молоко, хлеб, 2 кг
 * картошки» is three items — but a comma **between digits** is a decimal
 * separator, so «1,5 кг сыра» stays one. Unparseable fragments are dropped
 * rather than turned into an empty row.
 */
export function parseQuickAddText(
  text: string,
  options: { limit?: number } = {},
): ParsedQuickAddItem[] {
  const limit = options.limit ?? 100;
  const items: ParsedQuickAddItem[] = [];

  for (const chunk of text.split(/\r?\n|;|,(?![0-9])/)) {
    if (items.length >= limit) break;
    const parsed = parseQuickAddLine(chunk);
    if (parsed) items.push(parsed);
  }

  return items;
}
