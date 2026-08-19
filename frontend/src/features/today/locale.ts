import { pluralize } from '@/shared/lib/i18n';

/**
 * Every user-facing string on the «Сегодня» screen (D7).
 *
 * Tone rules for this file, because this is the screen the family sees dozens
 * of times a day:
 *
 *  - Warm, never corporate. «Сегодня свободно 🎉», not «Нет данных».
 *  - Overdue copy is **urgent, never shaming**: «Просрочено» states a fact;
 *    «Вы не сделали» would assign blame, and a family app that nags is a family
 *    app that gets deleted.
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
  overdueHint: 'Сроки прошли — можно сделать сейчас или перенести.',
  overdueBadge: 'Просрочено',

  /* my tasks ------------------------------------------------------------- */
  tasksTitle: 'Мои дела на сегодня',
  tasksAllDone: 'Все дела на сегодня закрыты',
  tasksAllDoneHint: 'Хороший день. Можно выдохнуть.',
  tasksFree: 'На сегодня дел нет',
  tasksUnassignedTitle: 'Свободные дела',
  tasksUnassignedHint: 'Их пока никто не взял.',
  tasksFamilyDone: 'Семья сегодня закрыла',
  tasksAll: 'Все задачи',
  complete: 'Отметить выполненным',
  completed: 'Выполнено',
  completing: 'Отмечаем…',
  completeErrorTitle: 'Не удалось отметить',
  pointsSuffix: 'б',
  dueAt: 'до',

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
  shoppingPendingPrefix: 'Всего в списке',

  /* goal ----------------------------------------------------------------- */
  goalTitle: 'Ближайшая цель',
  goalRemaining: 'Осталось собрать',
  goalReached: 'Цель достигнута 🎉',
  goalDeadline: 'до',
  goalAll: 'Все копилки',

  /* weekly load ---------------------------------------------------------- */
  loadTitle: 'Ваша неделя',
  loadDone: 'сделано',
  loadPlanned: 'запланировано',
  loadEarned: 'баллов за неделю',
  loadFairShare: 'Ваша доля недели',
  loadEmpty: 'На этой неделе дел за вами не закреплено.',

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
export const memberCount = (n: number): string =>
  pluralize(n, ['участник', 'участника', 'участников']);
export const requestCount = (n: number): string => pluralize(n, ['заявка', 'заявки', 'заявок']);
export const pointCount = (n: number): string => pluralize(n, ['балл', 'балла', 'баллов']);
export const choreCount = (n: number): string => pluralize(n, ['дело', 'дела', 'дел']);
export const dayCount = (n: number): string => pluralize(n, ['день', 'дня', 'дней']);
