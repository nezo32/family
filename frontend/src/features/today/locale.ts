import { plural, pluralize } from '@/shared/lib/i18n';

/**
 * Every user-facing string on the «Сегодня» screen (D7).
 *
 * Tone rules for this file, because this is the screen the family sees dozens
 * of times a day:
 *
 *  - Warm, never corporate. «Сегодня свободно 🎉», not «Нет данных».
 *  - Overdue copy is **urgent, never shaming**: it states how late a chore is
 *    and offers the tick. «Вы не сделали» would assign blame, and a family app
 *    that nags is a family app that gets deleted.
 *  - Load is neutral (D5): «Ваша неделя», never «место в рейтинге».
 */
export const TODAY_RU = {
  /* greeting ------------------------------------------------------------- */
  greetingMorning: 'Доброе утро',
  greetingDay: 'Добрый день',
  greetingEvening: 'Добрый вечер',
  greetingNight: 'Доброй ночи',
  greetingFallback: 'Здравствуйте',

  /* overdue -------------------------------------------------------------- */
  overdueTitle: 'Требует внимания',
  overdueHint: 'Сроки прошли — можно закрыть сейчас или перенести.',
  overdueBy: 'Просрочено на',
  overdueLongAgo: 'Просрочено',

  /* my tasks ------------------------------------------------------------- */
  tasksTitle: 'Мои дела на сегодня',
  tasksAllDone: 'Все дела на сегодня закрыты.',
  tasksAllDoneHint: 'Хороший день. Можно выдохнуть.',
  tasksFree: 'На сегодня дел за вами не закреплено.',
  tasksDoneToday: 'Сегодня закрыто',
  tasksAll: 'Все задачи',
  complete: 'Отметить выполненным',
  completeErrorTitle: 'Не удалось отметить',
  dueAt: 'до',
  dueAnyTime: 'в течение дня',

  /* events --------------------------------------------------------------- */
  eventsTitle: 'События',
  eventsToday: 'Сегодня',
  eventsTomorrow: 'Завтра',
  eventsEmpty: 'Ни одного события на сегодня и завтра.',
  eventsAll: 'Весь календарь',
  allDay: 'Весь день',

  /* shopping ------------------------------------------------------------- */
  shoppingTitle: 'Купить срочно',
  shoppingEmpty: 'Срочных покупок нет.',
  shoppingAll: 'Список покупок',
  shoppingNeededPrefix: 'Всего в списках',

  /* goal ----------------------------------------------------------------- */
  goalTitle: 'Ближайшая цель',
  goalRemaining: 'Осталось собрать',
  goalReached: 'Цель достигнута 🎉',
  goalDeadline: 'до',
  goalAll: 'Все копилки',
  goalEmpty: 'Пока нет активных копилок.',

  /* weekly load ---------------------------------------------------------- */
  loadTitle: 'Ваша неделя',
  loadDone: 'сделано',
  loadShare: 'доля недели',
  weekAhead: 'Впереди на неделе',

  /* approvals ------------------------------------------------------------ */
  approvalsTitle: 'Заявки на вступление',
  approvalsHint: 'Ждут вашего решения.',
  approvalsAction: 'Посмотреть заявки',

  /* empty & error -------------------------------------------------------- */
  emptyTitle: 'Сегодня свободно 🎉',
  emptyDescription: 'Ни дел, ни событий, ни срочных покупок. Проведите день по-своему.',
  errorTitle: 'Не получилось загрузить день',
  loadingLabel: 'Загружаем ваш день',
} as const;

/* -------------------------------------------------------------------------- */
/* Counted phrases                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Russian has three plural forms and the 11–14 exception is what naive code
 * gets wrong: `21 задача` but `11 задач`, `22 задачи` but `12 задач`. Every
 * counted phrase on this screen goes through the shared `pluralize` helper so
 * the exception is handled in exactly one place.
 */
export const taskCount = (n: number): string => pluralize(n, ['задача', 'задачи', 'задач']);
export const eventCount = (n: number): string => pluralize(n, ['событие', 'события', 'событий']);
export const itemCount = (n: number): string => pluralize(n, ['товар', 'товара', 'товаров']);
export const requestCount = (n: number): string => pluralize(n, ['заявка', 'заявки', 'заявок']);
export const pointCount = (n: number): string => pluralize(n, ['балл', 'балла', 'баллов']);
export const choreCount = (n: number): string => pluralize(n, ['дело', 'дела', 'дел']);
/** The bare word, for a figure already rendered next to it. */
export const pointWord = (n: number): string => plural(n, ['балл', 'балла', 'баллов']);
