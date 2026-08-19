/**
 * Russian numeric agreement — the one implementation.
 *
 * Before this file there were six: `frontend/src/shared/lib/i18n.ts`,
 * `features/shopping/locale.ts`, `features/goals/locale.ts`,
 * `backend/.../notifications/render.ts`, `backend/.../dashboard/digest.service.ts`
 * and `backend/src/core/recurrence/engine.ts`. They agreed on every integer, so
 * nothing was visibly broken — but two of them exported a function called
 * `plural` with **different arities** (`plural(n, one, few, many)` vs
 * `plural(n, [one, few, many])`), which meant a copy-pasted line compiled to
 * nonsense, and the count in front of the word was formatted two different ways
 * («1 000 задач» on screen, «1000 задач» in the same push notification).
 *
 * ## The rule
 *
 * ```
 * 1 задача   — one  : n % 10 === 1 and n % 100 !== 11
 * 2 задачи   — few  : n % 10 in 2..4 and n % 100 not in 12..14
 * 5 задач    — many : everything else (0, 5–20, 11–14, …)
 * ```
 *
 * The 11–14 exception is what naive implementations get wrong: «21 задача» but
 * «11 задач», «22 задачи» but «12 задач».
 *
 * ## Why a tuple and not three arguments
 *
 * Russian numerals **govern the case of the noun they count**, so one word has
 * more than one set of three forms: «21 задача на неделе» but «вы закрыли
 * 21 задачу». A tuple is a value that can be named, stored in {@link RU_PLURALS}
 * once per case, and passed around; three positional strings invite each call
 * site to inline its own and quietly pick the wrong case.
 */

/** `[одна, две, пять]` — the three Russian numeric agreement forms. */
export type PluralForms = readonly [one: string, few: string, many: string];

/**
 * Which of the three forms `n` takes: `0` = one, `1` = few, `2` = many.
 *
 * Fractions are truncated on the absolute value, so `-1.7` agrees like `1`.
 */
export function pluralIndex(n: number): 0 | 1 | 2 {
  const abs = Math.abs(Math.trunc(n));
  const lastTwo = abs % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 2;
  const last = abs % 10;
  if (last === 1) return 0;
  if (last >= 2 && last <= 4) return 1;
  return 2;
}

/** `pluralRu(3, RU_PLURALS.task)` → `'задачи'` — the word alone, no count. */
export function pluralRu(count: number, forms: PluralForms): string {
  return forms[pluralIndex(count)];
}

/**
 * The count itself, grouped the Russian way: `1000` → `1 000` (the separator is
 * U+00A0, so a wrapped line never leaves a lonely «000»).
 *
 * One formatter for every surface. The digest used to interpolate the bare
 * number while the UI ran it through `Intl`, so the same figure read
 * «1 000 задач» on screen and «1000 задач» in the push about it.
 */
export function formatCountRu(count: number): string {
  return new Intl.NumberFormat('ru-RU').format(count);
}

/** `countRu(3, RU_PLURALS.task)` → `'3 задачи'`. */
export function countRu(count: number, forms: PluralForms): string {
  return `${formatCountRu(count)} ${pluralRu(count, forms)}`;
}

/**
 * Ready-made word sets, shared by the API and the PWA.
 *
 * Add a key here rather than inlining a tuple at a call site — that is exactly
 * how «копилка» and «цель» ended up as two spellings of the same noun.
 */
export const RU_PLURALS = {
  /* things you count on a screen ---------------------------------------- */
  task: ['задача', 'задачи', 'задач'],
  /**
   * Accusative — «Вы закрыли 21 задачу», not «21 задача». Russian numerals
   * govern the case of the noun, so a single "task" form cannot serve both
   * «21 задача на неделе» and «закрыли 21 задачу»; conflating them is the
   * second-most-common Russian pluralisation bug after the 11–14 exception.
   */
  taskAccusative: ['задачу', 'задачи', 'задач'],
  chore: ['дело', 'дела', 'дел'],
  event: ['событие', 'события', 'событий'],
  birthday: ['день рождения', 'дня рождения', 'дней рождения'],
  purchase: ['покупка', 'покупки', 'покупок'],
  /** A row on a shopping list. */
  lineItem: ['позиция', 'позиции', 'позиций'],
  /** Accusative — «Добавим 21 позицию». */
  lineItemAccusative: ['позицию', 'позиции', 'позиций'],
  /** Short-form predicate agreement — «1 нужен», «2 нужны», «5 нужно». */
  needed: ['нужен', 'нужны', 'нужно'],
  urgent: ['срочная', 'срочные', 'срочных'],
  item: ['товар', 'товара', 'товаров'],
  change: ['изменение', 'изменения', 'изменений'],
  member: ['участник', 'участника', 'участников'],
  request: ['заявка', 'заявки', 'заявок'],
  point: ['балл', 'балла', 'баллов'],
  announcement: ['объявление', 'объявления', 'объявлений'],
  comment: ['комментарий', 'комментария', 'комментариев'],
  post: ['запись', 'записи', 'записей'],
  /** Indeclinable — all three forms are identical, and that is correct. */
  thanks: ['спасибо', 'спасибо', 'спасибо'],

  /* the moneybox --------------------------------------------------------- */
  /** The savings goal itself, as the family calls it. */
  moneybox: ['копилка', 'копилки', 'копилок'],
  /** The abstract "goal" — headings and counters, not the moneybox noun. */
  goal: ['цель', 'цели', 'целей'],
  rouble: ['рубль', 'рубля', 'рублей'],

  /* time ------------------------------------------------------------------ */
  day: ['день', 'дня', 'дней'],
  week: ['неделя', 'недели', 'недель'],
  /** Accusative — «Каждую 2 неделю» / «Каждые 3 недели». */
  weekAccusative: ['неделю', 'недели', 'недель'],
  month: ['месяц', 'месяца', 'месяцев'],
  hour: ['час', 'часа', 'часов'],
  minute: ['минута', 'минуты', 'минут'],
  year: ['год', 'года', 'лет'],
  /** Occurrences of a repeating thing — «Каждый день, 5 раз». */
  times: ['раз', 'раза', 'раз'],
} as const satisfies Record<string, PluralForms>;
