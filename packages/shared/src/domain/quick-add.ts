/**
 * Quick-add parser — «2 кг картошки» -> `{ quantity: 2, unit: 'кг', name: 'картошка' }`.
 *
 * This is the single most-used code path in the app: adding to the shopping
 * list is one field and one tap, and the family types whatever it types.
 *
 * **One implementation, two runtimes.** This module used to exist twice — once
 * in `backend/src/modules/shopping/quick-add.ts` and once, minus the
 * `IRREGULAR_GENITIVES` table below, in `frontend/src/features/shopping/quick-add.ts`.
 * The two disagreed on the catalogue key for most realistic inputs
 * («молока» -> `молока` on the client, `молоко` on the server), so an offline add
 * created a second `product_catalog` row for a product the family already had.
 * It lives here now and both sides import it.
 *
 * Two hard constraints shape this file:
 *
 * 1. **Pure.** No database, no clock, no config. The identical function runs on
 *    the server (`POST …/items/bulk` with raw `text`) and in the PWA while the
 *    phone has no signal, so the optimistic row the user sees offline is byte
 *    for byte the row the server later creates (`docs/architecture/household.md` §4).
 * 2. **The user's words are never destroyed.** `name` keeps the original
 *    casing and wording for display; `normalizedName` is a separate, lossy key
 *    used only to match `product_catalog`. A bad normalisation therefore costs
 *    a missed autocomplete suggestion, never a wrong shopping list.
 *
 * ## Grammar
 *
 * ```
 * line        := bullet? urgent? part+ urgent?
 * part        := quantity | unit | word
 * quantity    := digits ([.,] digits)?          "2", "1.5", "1,5"
 *              | digits unit                    "2кг", "500г"
 * unit        := one of the aliases below, canonicalised to кг|г|л|мл|шт|уп|пач|бут
 * bullet      := "-" | "–" | "—" | "•" | "*"
 * urgent      := "!"+
 * ```
 *
 * The first number-looking token wins; the unit is taken from the token itself
 * (`2кг`), else from the token to its right (`2 кг`), else from the token to
 * its left (`картошка кг 2`). Everything left over, in its original order, is
 * the name — which is why a quantity in the middle («картошка 2 кг молодая»)
 * parses the same as one at either end.
 */

/* -------------------------------------------------------------------------- */
/* Units                                                                       */
/* -------------------------------------------------------------------------- */

/** The canonical unit set. Anything the family types is folded into one of these. */
export const CANONICAL_UNITS = ['кг', 'г', 'л', 'мл', 'шт', 'уп', 'пач', 'бут'] as const;

export type CanonicalUnit = (typeof CANONICAL_UNITS)[number];

/**
 * Alias -> canonical unit. Keys are already normalised (lowercase, `ё` -> `е`,
 * no trailing dot), which is exactly what {@link canonicalUnit} feeds them.
 *
 * Russian nouns after a numeral decline, so every unit needs its genitive
 * singular and plural forms too — "2 пачки", "5 пачек", "10 упаковок".
 */
const UNIT_ALIASES: Readonly<Record<string, CanonicalUnit>> = {
  // килограммы
  кг: 'кг',
  kg: 'кг',
  кило: 'кг',
  килограмм: 'кг',
  килограмма: 'кг',
  килограммов: 'кг',
  // граммы
  г: 'г',
  гр: 'г',
  g: 'г',
  грамм: 'г',
  грамма: 'г',
  граммов: 'г',
  // литры
  л: 'л',
  l: 'л',
  литр: 'л',
  литра: 'л',
  литров: 'л',
  // миллилитры
  мл: 'мл',
  ml: 'мл',
  миллилитр: 'мл',
  миллилитра: 'мл',
  миллилитров: 'мл',
  // штуки
  шт: 'шт',
  штук: 'шт',
  штука: 'шт',
  штуки: 'шт',
  штуку: 'шт',
  штучка: 'шт',
  pcs: 'шт',
  pc: 'шт',
  // упаковки
  уп: 'уп',
  упак: 'уп',
  упаковка: 'уп',
  упаковки: 'уп',
  упаковку: 'уп',
  упаковок: 'уп',
  // пачки
  пач: 'пач',
  пачка: 'пач',
  пачки: 'пач',
  пачку: 'пач',
  пачек: 'пач',
  // бутылки
  бут: 'бут',
  бутыл: 'бут',
  бутылка: 'бут',
  бутылки: 'бут',
  бутылку: 'бут',
  бутылок: 'бут',
};

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/** Whitespace of any kind, in any quantity, is one space. */
export function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

const EDGE_PUNCTUATION = /^[\s"'«»„“”().,;:!?\-–—*•]+|[\s"'«»„“”().,;:!?\-–—*•]+$/g;

/**
 * The catalogue key half of the job: lowercase, `ё` -> `е`, collapse
 * whitespace, drop punctuation hugging either end.
 *
 * `ё` is folded because half the family types «мед» and the other half «мёд»,
 * and they are unquestionably the same product.
 */
export function normalizeProductName(value: string): string {
  return collapseWhitespace(value.toLowerCase().replace(/ё/g, 'е')).replace(EDGE_PUNCTUATION, '');
}

/**
 * Irregular genitives worth spelling out.
 *
 * This is morphology, not a product database: it is a fixed list of Russian
 * word forms, it never grows from the outside, and `product_catalog` still
 * learns exclusively from what this family types (D9 rejects imported product
 * data). Suffix rules below handle the regular cases; these are the ones where
 * a rule would guess wrong — fleeting vowels («огурцов» -> «огуре*ц*»),
 * suppletive stems («яиц» -> «яйцо») and masculine/neuter genitives in `-а`,
 * which are indistinguishable from an ordinary feminine nominative.
 */
const IRREGULAR_GENITIVES: Readonly<Record<string, string>> = {
  // masculine / neuter genitive singular in -а/-я — the mass nouns you buy by weight
  хлеба: 'хлеб',
  молока: 'молоко',
  масла: 'масло',
  сахара: 'сахар',
  риса: 'рис',
  сыра: 'сыр',
  мяса: 'мясо',
  сока: 'сок',
  чая: 'чай',
  творога: 'творог',
  кефира: 'кефир',
  йогурта: 'йогурт',
  лука: 'лук',
  чеснока: 'чеснок',
  перца: 'перец',
  картофеля: 'картофель',
  меда: 'мед',
  фарша: 'фарш',
  сала: 'сало',
  теста: 'тесто',
  уксуса: 'уксус',
  майонеза: 'майонез',
  кетчупа: 'кетчуп',
  шоколада: 'шоколад',
  печенья: 'печенье',
  варенья: 'варенье',
  пива: 'пиво',
  вина: 'вино',
  кваса: 'квас',
  мороженого: 'мороженое',
  // third declension — the -и rule below must not touch these
  соли: 'соль',
  моркови: 'морковь',
  зелени: 'зелень',
  // suppletive / fleeting-vowel genitive plurals
  яиц: 'яйцо',
  яйца: 'яйцо',
  яблок: 'яблоко',
  яблоки: 'яблоко',
  огурцов: 'огурец',
  конфет: 'конфета',
  котлет: 'котлета',
  булок: 'булка',
  сосисок: 'сосиска',
  салфеток: 'салфетка',
  макарон: 'макароны',
  пельменей: 'пельмени',
  чипсов: 'чипсы',
  орехов: 'орехи',
  овощей: 'овощи',
  фруктов: 'фрукты',
  ягод: 'ягоды',
};

/** Stems after which Russian spelling forbids `ы`, so a final `и` is really `а`. */
const HUSHING_AND_VELAR = new Set(['к', 'г', 'х', 'ж', 'ч', 'ш', 'щ']);

/**
 * Best-effort genitive -> nominative for a **single** normalised word.
 *
 * Only ever applied when the line carried a quantity or a unit, because that is
 * precisely the grammatical context that puts the noun into the genitive
 * («2 кг картошк**и**», «5 яблок»). A bare «картошка» is already nominative and
 * is left alone — which is what makes both spellings collapse onto one
 * catalogue key.
 *
 * Deliberately conservative. Rules that would be right half the time are worse
 * than no rule: the cost of leaving a word inflected is one duplicate
 * catalogue entry, while the cost of mangling a nominative is every future
 * lookup missing.
 */
export function lemmatizeProductName(normalized: string): string {
  const irregular = IRREGULAR_GENITIVES[normalized];
  if (irregular) return irregular;

  // Genitive plural of masculine nouns: помидоров -> помидор, бананов -> банан.
  // Guarded on length so short words that simply end in -ов survive intact.
  if (normalized.length >= 6 && (normalized.endsWith('ов') || normalized.endsWith('ев'))) {
    return normalized.slice(0, -2);
  }

  // Genitive singular of hard-stem feminines: воды -> вода, колбасы -> колбаса.
  if (normalized.length >= 4 && normalized.endsWith('ы')) {
    return `${normalized.slice(0, -1)}а`;
  }

  // The same ending spelled -и because the stem ends in a velar or a hushing
  // consonant: картошки -> картошка, муки -> мука, гречки -> гречка.
  if (normalized.length >= 4 && normalized.endsWith('и')) {
    const stemFinal = normalized.at(-2);
    if (stemFinal !== undefined && HUSHING_AND_VELAR.has(stemFinal)) {
      return `${normalized.slice(0, -1)}а`;
    }
  }

  return normalized;
}

/**
 * The key `product_catalog` is upserted by.
 *
 * `hasQuantity` must be true whenever the caller knows a number or a unit
 * accompanied the name — that is the signal that the noun is probably in the
 * genitive. The service passes it for client-parsed `items[]` too, so an
 * offline client and the server agree on the key.
 */
export function catalogKeyFor(name: string, hasQuantity: boolean): string {
  const normalized = normalizeProductName(name);
  if (!hasQuantity) return normalized;
  if (normalized.includes(' ')) return normalized; // multi-word: head noun is ambiguous
  return lemmatizeProductName(normalized);
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

/** Mirrors `quantitySchema` in `@family/shared` so the parser never emits an invalid value. */
const MAX_QUANTITY = 100_000;
/** `shopping_items.quantity` is `numeric(10, 3)`. */
const QUANTITY_DECIMALS = 3;

const NUMBER_TOKEN = /^(\d{1,6})(?:[.,](\d{1,3}))?$/;
const GLUED_TOKEN = /^(\d{1,6}(?:[.,]\d{1,3})?)([a-zа-я]{1,12})\.?$/;

function fold(token: string): string {
  return token.toLowerCase().replace(/ё/g, 'е');
}

/**
 * Resolves a token to a canonical unit, or `null` if it is an ordinary word.
 * Tolerates the abbreviating dot people type — "500 гр." and "2 шт.".
 */
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
  /** Set only when the unit was glued to the digits ("2кг"). */
  unit: CanonicalUnit | null;
}

/**
 * A token is a quantity only if it is *entirely* a number, or a number glued to
 * a **known** unit. "3,2%" and "250ml-bottle" are words, and a word they stay:
 * silently swallowing «молоко 3,2%» into `quantity: 3.2` would be a lie the
 * user cannot see until they are standing in the aisle.
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

/* -------------------------------------------------------------------------- */
/* Line parsing                                                                */
/* -------------------------------------------------------------------------- */

export interface ParsedQuickAddItem {
  /** The user's line, whitespace-collapsed and otherwise untouched. */
  raw: string;
  /** Display name: the user's own words and casing, minus quantity and unit. */
  name: string;
  /** Lossy lookup key for `product_catalog`. Never shown to anyone. */
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
 * a stray bullet, or a quantity with no noun attached ("2 кг").
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
      // "2 кг картошки" — the unit sits to the right of the number.
      const next = tokens[i + 1];
      const nextUnit = next === undefined ? null : canonicalUnit(next);
      if (nextUnit) {
        unit = nextUnit;
        consumed.add(i + 1);
      } else {
        // "картошка кг 2" — rarer, but people do type it.
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
 * separator, so «1,5 кг сыра» stays one item. Unparseable fragments are
 * dropped rather than turned into an empty row.
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
