import { PLURALS, formatCountRu, plural, pluralize } from '@/shared/lib/i18n';

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
  itemsNeeded: (n: number) => `${formatCountRu(n)} ${plural(n, PLURALS.needed)}`,
  counters: (needed: number, total: number) =>
    `${formatCountRu(needed)} из ${pluralize(total, PLURALS.lineItem)}`,

  /* list management ------------------------------------------------------ */
  listActions: 'Действия со списком',
  editList: 'Изменить список',
  editListDescription: 'Название, значок и цвет видит вся семья.',
  listIconLabel: 'Значок',
  listColorLabel: 'Цвет',
  listUpdated: 'Изменения сохранены',
  archiveList: 'Убрать в архив',
  unarchiveList: 'Вернуть из архива',
  listArchivedToast: 'Список убран в архив',
  listUnarchivedToast: 'Список снова в работе',
  showArchived: 'Показать архив',
  hideArchived: 'Скрыть архив',
  archiveEmpty: 'В архиве пока пусто — списки, которые вы уберёте туда, будут ждать здесь.',
  deleteList: 'Удалить список',
  deleteListTitle: (name: string) => `Удалить «${name}»?`,
  /**
   * The count is the whole point of this sentence.
   *
   * `DELETE /shopping/lists/:id` answers `{ ok: true }`, takes no `confirm`
   * flag and reports nothing — unlike `clear-bought`, which does both. So the
   * number the user is warned about is the list's own `totalCount`, the same
   * figure the card already shows, and the warning has to be shown *before* the
   * request, because the server will not stop us.
   */
  deleteListBody: (n: number) =>
    n === 0
      ? 'Список пуст — удалить его насовсем? Отменить нельзя.'
      : `В списке ${pluralize(n, PLURALS.lineItem)}. Удалить вместе со списком? Отменить нельзя.`,
  deleteListArchiveHint: 'Если список ещё пригодится — уберите его в архив, он никуда не денется.',
  listDeleted: 'Список удалён',

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
    `Из списка исчезнут ${pluralize(n, PLURALS.lineItem)}. Отменить нельзя.`,
  clearBoughtEmpty: 'Купленного пока нет',
  cleared: 'Купленное убрано',
  deleteItem: 'Удалить позицию',
  itemActions: 'Действия с позицией',
  editItem: 'Изменить позицию',
  editItemDescription: 'Что именно купить, сколько и в каком отделе искать.',
  itemNameLabel: 'Название',
  itemQuantityLabel: 'Сколько',
  itemUnitLabel: 'Единица',
  itemUnitPlaceholder: 'шт, кг, л',
  itemCategoryLabel: 'Отдел',
  itemCategoryPlaceholder: 'молочное',
  itemCategoryHint: 'По отделам список выстраивается в порядке обхода магазина.',
  itemNoteLabel: 'Заметка',
  itemNotePlaceholder: 'Какой именно',
  itemUrgentLabel: 'Срочно',
  itemUrgentHint: 'Поднимем позицию наверх списка.',
  itemUpdated: 'Позиция изменена',
  itemQuantityInvalid: 'Количество — число больше нуля.',
  markBought: 'Отметить купленным',
  markNeeded: 'Вернуть в список',

  /* quick add ------------------------------------------------------------ */
  quickAddLabel: 'Что купить',
  /*
   * One line, and short enough to fit on one line at 320px.
   *
   * This used to be a three-line example («2 кг картошки» / «молоко 3 шт» /
   * «хлеб») in a box that sizes itself to its *content* — and an empty field
   * has no content. The third line was sliced in half by the bottom edge on the
   * device, and because a placeholder renders at the same size as a typed item
   * it read as a broken list rather than as a hint. The multi-line example
   * lives in `quickAddHint` below, where it cannot be mistaken for data.
   */
  quickAddPlaceholder: 'Например, 2 кг картошки',
  quickAddHint: 'По одному товару в строке. Можно с количеством: «2 кг картошки».',
  quickAddSubmit: 'Добавить',
  quickAddCount: (n: number) => `Добавим ${pluralize(n, PLURALS.lineItemAccusative)}`,
  quickAddNothing: 'Пока нечего добавить',
  frequent: 'Часто покупаем',
  suggestions: 'Подсказки',

  /* offline -------------------------------------------------------------- */
  offlineTitle: 'Нет сети',
  offlineDescription: 'Изменения сохранены на телефоне и уйдут сами, когда появится связь.',
  queuedTitle: 'Ждут отправки',
  queuedDescription: 'Отправим, когда откроете приложение со связью.',
  queuedCount: (n: number) => `${pluralize(n, PLURALS.change)} не отправлено`,
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
 * Russian plural agreement lives in `@family/shared` now — see `PLURALS` and
 * `plural`/`pluralize` in `@/shared/lib/i18n`.
 *
 * This file used to export its own `plural(n, one, few, many)`, which
 * **shadowed** the shared `plural(n, forms)` with a different arity: an import
 * swapped between the two files compiled cleanly and printed the wrong word.
 * Components that used to import `plural` from here import it from
 * `@/shared/lib/i18n` instead.
 */

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
