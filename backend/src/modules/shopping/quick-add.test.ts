import { describe, expect, it } from 'vitest';

import {
  canonicalUnit,
  catalogKeyFor,
  lemmatizeProductName,
  normalizeProductName,
  parseQuickAddLine,
  parseQuickAddText,
  type CanonicalUnit,
} from '@family/shared';

/**
 * The parser is the most-typed-into code path in the app and it runs in two
 * places — the server and the offline PWA. These are the cases the family will
 * actually type, in Russian, on a phone, one-handed, in a shop.
 *
 * The corpus now runs against `@family/shared`, which is the **only**
 * implementation. It used to be duplicated in the client, minus the
 * `IRREGULAR_GENITIVES` table, and 51 of the 66 assertions below produced a
 * different `product_catalog` key there. See the regression block at the end of
 * the file for the exact words that used to diverge.
 */

interface Case {
  /** What the user typed. */
  input: string;
  quantity: number | null;
  unit: CanonicalUnit | null;
  /** Display name — the user's own words. */
  name: string;
  /** `product_catalog` key. */
  key: string;
  urgent?: boolean;
}

const CASES: Case[] = [
  /* --- the four from the brief --------------------------------------- */
  { input: '2 кг картошки', quantity: 2, unit: 'кг', name: 'картошки', key: 'картошка' },
  { input: 'молоко 3 шт', quantity: 3, unit: 'шт', name: 'молоко', key: 'молоко' },
  { input: 'хлеб', quantity: null, unit: null, name: 'хлеб', key: 'хлеб' },
  { input: '5 яблок', quantity: 5, unit: null, name: 'яблок', key: 'яблоко' },

  /* --- units, both orders, glued and spaced --------------------------- */
  { input: '500 г сыра', quantity: 500, unit: 'г', name: 'сыра', key: 'сыр' },
  { input: '2кг картошки', quantity: 2, unit: 'кг', name: 'картошки', key: 'картошка' },
  { input: '500гр муки', quantity: 500, unit: 'г', name: 'муки', key: 'мука' },
  { input: 'помидоров 3 кг', quantity: 3, unit: 'кг', name: 'помидоров', key: 'помидор' },
  { input: '3 пачки масла', quantity: 3, unit: 'пач', name: 'масла', key: 'масло' },
  { input: '2 бутылки воды', quantity: 2, unit: 'бут', name: 'воды', key: 'вода' },
  { input: '10 упаковок сока', quantity: 10, unit: 'уп', name: 'сока', key: 'сок' },
  { input: '2 шт. молока', quantity: 2, unit: 'шт', name: 'молока', key: 'молоко' },
  { input: '250 мл сливок', quantity: 250, unit: 'мл', name: 'сливок', key: 'сливок' },
  { input: 'яйца 10 шт', quantity: 10, unit: 'шт', name: 'яйца', key: 'яйцо' },

  /* --- decimals ------------------------------------------------------- */
  { input: '1.5 л молока', quantity: 1.5, unit: 'л', name: 'молока', key: 'молоко' },
  { input: '1,5 л молока', quantity: 1.5, unit: 'л', name: 'молока', key: 'молоко' },
  { input: '0,5 кг гречки', quantity: 0.5, unit: 'кг', name: 'гречки', key: 'гречка' },

  /* --- no quantity ---------------------------------------------------- */
  {
    input: 'хлеб бородинский',
    quantity: null,
    unit: null,
    name: 'хлеб бородинский',
    key: 'хлеб бородинский',
  },
  {
    input: 'бумага туалетная',
    quantity: null,
    unit: null,
    name: 'бумага туалетная',
    key: 'бумага туалетная',
  },

  /* --- quantity in the middle ----------------------------------------- */
  {
    input: 'картошка 2 кг молодая',
    quantity: 2,
    unit: 'кг',
    name: 'картошка молодая',
    key: 'картошка молодая',
  },
  { input: 'молоко 2', quantity: 2, unit: null, name: 'молоко', key: 'молоко' },

  /* --- unknown unit stays part of the name ---------------------------- */
  {
    input: '2 ведра картошки',
    quantity: 2,
    unit: null,
    name: 'ведра картошки',
    key: 'ведра картошки',
  },
  {
    input: '3 банки тушёнки',
    quantity: 3,
    unit: null,
    name: 'банки тушёнки',
    key: 'банки тушенки',
  },

  /* --- mixed case and stray whitespace -------------------------------- */
  { input: 'Молоко 2 Л', quantity: 2, unit: 'л', name: 'Молоко', key: 'молоко' },
  { input: 'КАРТОШКА', quantity: null, unit: null, name: 'КАРТОШКА', key: 'картошка' },
  { input: '   молоко   3   шт  ', quantity: 3, unit: 'шт', name: 'молоко', key: 'молоко' },

  /* --- ё folds onto е so both spellings hit one catalogue row --------- */
  { input: 'мёд', quantity: null, unit: null, name: 'мёд', key: 'мед' },
  { input: '2 кг мёда', quantity: 2, unit: 'кг', name: 'мёда', key: 'мед' },

  /* --- urgency marker -------------------------------------------------- */
  { input: '!молоко', quantity: null, unit: null, name: 'молоко', key: 'молоко', urgent: true },
  { input: 'хлеб!', quantity: null, unit: null, name: 'хлеб', key: 'хлеб', urgent: true },
  {
    input: '! 2 кг картошки',
    quantity: 2,
    unit: 'кг',
    name: 'картошки',
    key: 'картошка',
    urgent: true,
  },

  /* --- bullets people paste from notes apps --------------------------- */
  { input: '- молоко', quantity: null, unit: null, name: 'молоко', key: 'молоко' },
  { input: '• 2 л кефира', quantity: 2, unit: 'л', name: 'кефира', key: 'кефир' },

  /* --- numbers that are NOT quantities --------------------------------- */
  // Fat content, not three-point-two of anything.
  { input: 'молоко 3,2%', quantity: null, unit: null, name: 'молоко 3,2%', key: 'молоко 3,2%' },
  // Zero and absurd counts are words, not amounts — `quantitySchema` caps at 100000.
  { input: '0 молоко', quantity: null, unit: null, name: '0 молоко', key: '0 молоко' },
  {
    input: '200000 шт хлеба',
    quantity: null,
    unit: null,
    name: '200000 шт хлеба',
    key: '200000 шт хлеба',
  },

  /* --- third declension must survive the -и rule ----------------------- */
  { input: '3 кг соли', quantity: 3, unit: 'кг', name: 'соли', key: 'соль' },
  { input: 'соль 1 кг', quantity: 1, unit: 'кг', name: 'соль', key: 'соль' },
  { input: '1 кг моркови', quantity: 1, unit: 'кг', name: 'моркови', key: 'морковь' },
];

describe('parseQuickAddLine', () => {
  for (const testCase of CASES) {
    it(`«${testCase.input}»`, () => {
      const parsed = parseQuickAddLine(testCase.input);
      expect(parsed, 'line should parse').not.toBeNull();
      expect({
        quantity: parsed?.quantity ?? null,
        unit: parsed?.unit ?? null,
        name: parsed?.name,
        key: parsed?.normalizedName,
        urgent: parsed?.isUrgent,
      }).toEqual({
        quantity: testCase.quantity,
        unit: testCase.unit,
        name: testCase.name,
        key: testCase.key,
        urgent: testCase.urgent ?? false,
      });
    });
  }

  it.each([
    ['empty string', ''],
    ['only whitespace', '   \t  '],
    ['only a bullet', '-'],
    ['quantity with no noun', '2 кг'],
    ['unit with no noun', '3 шт'],
    ['only punctuation', '...'],
  ])('returns null for %s', (_label, input) => {
    expect(parseQuickAddLine(input)).toBeNull();
  });

  it('keeps the user’s original wording in `raw`', () => {
    const parsed = parseQuickAddLine('  2 КГ   Картошки  ');
    expect(parsed?.raw).toBe('2 КГ Картошки');
    expect(parsed?.name).toBe('Картошки');
    expect(parsed?.normalizedName).toBe('картошка');
  });

  it('collapses «картошка» and «2 кг картошки» onto one catalogue key', () => {
    expect(parseQuickAddLine('картошка')?.normalizedName).toBe(
      parseQuickAddLine('2 кг картошки')?.normalizedName,
    );
  });

  it('rounds a quantity to the 3 decimals the column stores', () => {
    expect(parseQuickAddLine('1,5 кг сыра')?.quantity).toBe(1.5);
    expect(parseQuickAddLine('0,125 кг сыра')?.quantity).toBe(0.125);
  });
});

describe('parseQuickAddText', () => {
  it('splits on newlines', () => {
    const items = parseQuickAddText('молоко\n2 кг картошки\nхлеб');
    expect(items.map((i) => i.name)).toEqual(['молоко', 'картошки', 'хлеб']);
  });

  it('splits on commas and semicolons', () => {
    const items = parseQuickAddText('молоко, хлеб; сыр');
    expect(items.map((i) => i.name)).toEqual(['молоко', 'хлеб', 'сыр']);
  });

  it('does not split a decimal comma', () => {
    const items = parseQuickAddText('1,5 кг сыра, молоко');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ quantity: 1.5, unit: 'кг', name: 'сыра' });
    expect(items[1]?.name).toBe('молоко');
  });

  it('drops blank and unparseable fragments instead of adding empty rows', () => {
    const items = parseQuickAddText('молоко\n\n   \n- \nхлеб');
    expect(items.map((i) => i.name)).toEqual(['молоко', 'хлеб']);
  });

  it('respects the limit', () => {
    const items = parseQuickAddText('a\nb\nc\nd', { limit: 2 });
    expect(items).toHaveLength(2);
  });

  it('parses a realistic shopping note in one go', () => {
    const items = parseQuickAddText(
      ['- 2 кг картошки', '- молоко 3 шт', '- !хлеб', '- 500 г сыра'].join('\n'),
    );
    expect(items).toHaveLength(4);
    expect(items.map((i) => [i.normalizedName, i.quantity, i.unit, i.isUrgent])).toEqual([
      ['картошка', 2, 'кг', false],
      ['молоко', 3, 'шт', false],
      ['хлеб', null, null, true],
      ['сыр', 500, 'г', false],
    ]);
  });
});

describe('canonicalUnit', () => {
  it.each([
    ['кг', 'кг'],
    ['Кг', 'кг'],
    ['килограмм', 'кг'],
    ['кило', 'кг'],
    ['гр', 'г'],
    ['грамм', 'г'],
    ['г.', 'г'],
    ['л', 'л'],
    ['литра', 'л'],
    ['мл', 'мл'],
    ['шт', 'шт'],
    ['штук', 'шт'],
    ['упаковок', 'уп'],
    ['пачки', 'пач'],
    ['бутылок', 'бут'],
  ])('folds %s into %s', (input, expected) => {
    expect(canonicalUnit(input)).toBe(expected);
  });

  it.each(['ведро', 'банка', 'молоко', 'штучек', ''])('leaves %s alone', (input) => {
    expect(canonicalUnit(input)).toBeNull();
  });
});

describe('normalizeProductName', () => {
  it.each([
    ['  Молоко  ', 'молоко'],
    ['МОЛОКО', 'молоко'],
    ['мёд', 'мед'],
    ['молоко   домашнее', 'молоко домашнее'],
    ['молоко.', 'молоко'],
    ['«молоко»', 'молоко'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeProductName(input)).toBe(expected);
  });
});

describe('lemmatizeProductName', () => {
  it.each([
    ['картошки', 'картошка'],
    ['муки', 'мука'],
    ['воды', 'вода'],
    ['колбасы', 'колбаса'],
    ['бананов', 'банан'],
    ['огурцов', 'огурец'],
    ['яиц', 'яйцо'],
    ['хлеба', 'хлеб'],
  ])('%s -> %s', (input, expected) => {
    expect(lemmatizeProductName(input)).toBe(expected);
  });

  it.each(['хлеб', 'молоко', 'соль', 'морковь', 'плов', 'чай'])('leaves %s alone', (word) => {
    expect(lemmatizeProductName(word)).toBe(word);
  });
});

describe('catalogKeyFor', () => {
  it('only de-inflects when a quantity or unit made the noun genitive', () => {
    expect(catalogKeyFor('картошки', true)).toBe('картошка');
    // No number in the line: the user wrote a nominative and meant it.
    expect(catalogKeyFor('картошки', false)).toBe('картошки');
  });

  it('leaves multi-word names alone — the head noun is ambiguous', () => {
    expect(catalogKeyFor('красной икры', true)).toBe('красной икры');
  });
});

/**
 * The words the deleted client-side copy got wrong.
 *
 * It had no `IRREGULAR_GENITIVES` table, so «молока» keyed as `молока` and the
 * server keyed the same word as `молоко` — an offline add created a second
 * `product_catalog` row for a product the family already had. Worse, the bare
 * suffix rules actively mangled words the table protected: «огурцов» became
 * `огурц`, «яиц» stayed `яиц`, «соли» became `сола`.
 *
 * There is one implementation now, so these can only ever be one answer; the
 * block exists to pin down *which* answer, and to fail loudly if somebody ever
 * re-adds a copy that drops the table.
 */
describe('irregular genitives (the divergence that made this module shared)', () => {
  it.each([
    // masculine/neuter genitive singular in -а/-я, indistinguishable from a
    // feminine nominative without the table
    ['2 л молока', 'молоко'],
    ['500 г масла', 'масло'],
    ['1 кг сахара', 'сахар'],
    ['300 г сыра', 'сыр'],
    ['2 кг мяса', 'мясо'],
    ['1 л сока', 'сок'],
    ['200 г творога', 'творог'],
    ['1 кг картофеля', 'картофель'],
    // fleeting vowels — the suffix rule alone produces «огурц»
    ['1 кг огурцов', 'огурец'],
    // suppletive stems
    ['10 шт яиц', 'яйцо'],
    ['5 яблок', 'яблоко'],
    // third declension — the -и rule alone produces «сола» / «морковя»
    ['1 кг соли', 'соль'],
    ['1 кг моркови', 'морковь'],
    // plural-only nouns
    ['2 уп макарон', 'макароны'],
    ['1 кг фруктов', 'фрукты'],
  ])('«%s» keys as %s on both sides', (input, key) => {
    expect(parseQuickAddLine(input)?.normalizedName).toBe(key);
  });

  it('never truncates a word the table protects', () => {
    // What the table-less copy did: slice off the last two characters.
    expect(lemmatizeProductName('огурцов')).not.toBe('огурц');
    expect(lemmatizeProductName('овощей')).not.toBe('овощ');
  });
});
