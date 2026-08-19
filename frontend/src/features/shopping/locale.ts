/**
 * Russian strings for the shopping feature (D7 — every user-facing word lives
 * in the feature's `locale.ts`, never inline in JSX).
 *
 * Nothing here is derived from a server `message`: API failures are rendered by
 * `errorMessageRu(error)` from the shared error map.
 */

export const SHOPPING_RU = {
  title: 'Покупки',
  subtitle: 'Общие списки — видят все, работает без интернета.',

  /* lists ---------------------------------------------------------------- */
  lists: 'Списки',
  newList: 'Новый список',
  createList: 'Создать список',
  listNameLabel: 'Название списка',
  listNamePlaceholder: 'Продукты',
  listsEmptyTitle: 'Списков пока нет',
  listsEmptyDescription: 'Создайте первый список — его увидит вся семья.',
  listCreated: 'Список создан',
  openList: 'Открыть список',
  backToLists: 'К спискам',
  archived: 'В архиве',
  itemsNeeded: (n: number) => `${String(n)} ${plural(n, 'нужен', 'нужны', 'нужно')}`,
  counters: (needed: number, total: number) =>
    `${String(needed)} из ${String(total)} ${plural(total, 'позиция', 'позиции', 'позиций')}`,

  /* items ---------------------------------------------------------------- */
  itemsEmptyTitle: 'Список пуст',
  itemsEmptyDescription: 'Напишите, что купить — по одному товару в строке.',
  bought: 'Куплено',
  needed: 'Нужно',
  urgent: 'Срочно',
  boughtSection: 'Уже куплено',
  noCategory: 'Без категории',
  clearBought: 'Убрать купленное',
  clearBoughtConfirmTitle: 'Убрать купленное?',
  clearBoughtConfirmBody: (n: number) =>
    `Из списка исчезнут ${String(n)} ${plural(n, 'позиция', 'позиции', 'позиций')}. Отменить нельзя.`,
  clearBoughtEmpty: 'Купленного пока нет',
  cleared: 'Купленное убрано',
  deleteItem: 'Удалить позицию',
  markBought: 'Отметить купленным',
  markNeeded: 'Вернуть в список',

  /* quick add ------------------------------------------------------------ */
  quickAddLabel: 'Что купить',
  quickAddPlaceholder: '2 кг картошки\nмолоко 3 шт\nхлеб',
  quickAddHint: 'По одному товару в строке. Можно с количеством: «2 кг картошки».',
  quickAddSubmit: 'Добавить',
  quickAddCount: (n: number) =>
    `Добавим ${String(n)} ${plural(n, 'позицию', 'позиции', 'позиций')}`,
  quickAddNothing: 'Пока нечего добавить',
  frequent: 'Часто покупаем',
  suggestions: 'Подсказки',

  /* offline -------------------------------------------------------------- */
  offlineTitle: 'Нет сети',
  offlineDescription: 'Изменения сохранены на телефоне и уйдут сами, когда появится связь.',
  queuedTitle: 'Ждут отправки',
  queuedDescription: 'Отправим, когда откроете приложение со связью.',
  queuedCount: (n: number) =>
    `${String(n)} ${plural(n, 'изменение', 'изменения', 'изменений')} не отправлено`,
  notSent: 'не отправлено',
  retryNow: 'Отправить сейчас',
  syncing: 'Отправляем…',
  syncFailed: 'Не удалось отправить изменение — оно отменено',

  /* shop mode ------------------------------------------------------------ */
  shopMode: 'Я в магазине',
  shopModeOn: 'Режим магазина включён',
  shopModeOff: 'Обычный режим',
  shopModeHint: 'Крупные кнопки и экран не гаснет.',

  /* permissions ---------------------------------------------------------- */
  noWriteAccess: 'Смотреть можно, добавлять — нет.',
} as const;

/**
 * Russian plural agreement: 1 позиция / 2 позиции / 5 позиций.
 * Exported because several components format their own counts.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/**
 * Store-walk order for the aisle view.
 *
 * The API orders categories alphabetically (it has no idea what a shop looks
 * like); "молочное" before "овощи" is alphabetical but wrong for a person
 * pushing a trolley. This list is the order you actually walk a Russian
 * supermarket: produce at the door, chemicals by the tills. Categories the
 * family invented that are not in this list keep their alphabetical position
 * after the known ones, and uncategorised items always sink to the bottom.
 */
export const AISLE_ORDER: readonly string[] = [
  'овощи',
  'фрукты',
  'зелень',
  'хлеб',
  'выпечка',
  'молочное',
  'сыр',
  'яйца',
  'мясо',
  'птица',
  'рыба',
  'колбаса',
  'заморозка',
  'бакалея',
  'крупы',
  'консервы',
  'соусы',
  'снеки',
  'сладости',
  'напитки',
  'чай и кофе',
  'детское',
  'зоотовары',
  'аптека',
  'гигиена',
  'бытовая химия',
  'дом',
];

/** Human label for a category cell: capitalised, `null` becomes «Без категории». */
export function aisleLabel(category: string | null | undefined): string {
  if (!category || category.trim().length === 0) return SHOPPING_RU.noCategory;
  const trimmed = category.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
