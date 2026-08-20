import { PLURALS, pluralize } from '@/shared/lib/i18n';

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
 *  - Nothing here counts a person. There is no score, no streak and no
 *    per-member total anywhere in this file, and there must never be (D5).
 *
 * Section labels are written in sentence case and uppercased by CSS
 * (`Section` renders them at `label` type, §B2). Keeping the source string
 * readable is what lets a test assert on the same constant the screen shows.
 */
export const TODAY_RU = {
  /* greeting ------------------------------------------------------------- */
  greetingMorning: 'Доброе утро',
  greetingDay: 'Добрый день',
  greetingEvening: 'Добрый вечер',
  greetingNight: 'Доброй ночи',
  greetingFallback: 'Здравствуйте',

  /* the one attention block (§C2 band 2) --------------------------------- */
  attentionLabel: 'Требует внимания',
  overdueTitle: 'Просрочено',
  overdueBy: 'срок был',
  overdueLongAgo: 'Просрочено',
  overdueDue: 'срок был в',

  /* my tasks ------------------------------------------------------------- */
  tasksTitle: 'Мои дела',
  tasksFree: 'На сегодня дел за вами не закреплено.',
  tasksAllDone: 'Все дела на сегодня закрыты. Можно выдохнуть.',
  tasksDoneToday: (n: number): string => `Сегодня в семье закрыли ${pluralize(n, PLURALS.chore)}.`,
  complete: 'Отметить выполненным',
  completeErrorTitle: 'Не удалось отметить',
  dueAt: 'до',
  dueAnyTime: 'в течение дня',

  /* events --------------------------------------------------------------- */
  eventsTitle: 'Сегодня и завтра',
  eventsToday: 'Сегодня',
  eventsTomorrow: 'Завтра',
  eventsEmpty: 'Ни одного события на сегодня и завтра.',
  allDay: 'весь день',

  /* shopping ------------------------------------------------------------- */
  shoppingTitle: 'Надо купить',
  shoppingUrgent: 'срочно',

  /* goal ----------------------------------------------------------------- */
  goalTitle: 'Копилка',
  goalRemaining: 'осталось',
  goalReached: 'Собрано 🎉',
  goalOf: 'из',

  /* the week ahead (side column, ≥ 1088) --------------------------------- */
  weekTitle: 'Неделя',
  weekEmpty: 'На неделе пока пусто.',
  weekNothing: 'свободно',

  /* approvals ------------------------------------------------------------ */
  approvalsTitle: 'Заявки',
  approvalsHint: 'Ждут вашего решения.',
  approvalsAction: 'Открыть',

  /* the one link per section (§A3) --------------------------------------- */
  linkAll: 'все',
  linkEverything: 'всё',

  /* empty & error -------------------------------------------------------- */
  emptyTitle: 'Сегодня свободно 🎉',
  emptyDescription: 'Ни дел, ни событий, ни срочных покупок. Проведите день по-своему.',
  emptyAddTask: 'Добавить дело',
  emptyAddEvent: 'Записать событие',
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
export const taskCount = (n: number): string => pluralize(n, PLURALS.task);
export const eventCount = (n: number): string => pluralize(n, PLURALS.event);
export const itemCount = (n: number): string => pluralize(n, PLURALS.item);
export const requestCount = (n: number): string => pluralize(n, PLURALS.request);
export const choreCount = (n: number): string => pluralize(n, PLURALS.chore);
