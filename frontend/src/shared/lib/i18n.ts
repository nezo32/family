import { format, formatDistanceToNowStrict, isToday, isTomorrow, isYesterday } from 'date-fns';
import { ru } from 'date-fns/locale';

/**
 * Cross-cutting Russian strings.
 *
 * D7: each feature owns its own vocabulary in `features/<domain>/locale.ts`.
 * Only genuinely shared terms live here — the words that appear in three
 * different features and would otherwise drift ("Сохранить" vs "Сохранение").
 * If a string is about tasks, or goals, or shopping, it does **not** belong in
 * this file.
 */

export const COMMON = {
  // actions
  save: 'Сохранить',
  cancel: 'Отмена',
  close: 'Закрыть',
  delete: 'Удалить',
  edit: 'Изменить',
  add: 'Добавить',
  create: 'Создать',
  confirm: 'Подтвердить',
  back: 'Назад',
  next: 'Далее',
  done: 'Готово',
  retry: 'Повторить',
  refresh: 'Обновить',
  search: 'Поиск',
  filter: 'Фильтр',
  select: 'Выбрать',
  clear: 'Очистить',
  more: 'Ещё',
  open: 'Открыть',
  copy: 'Скопировать',
  copied: 'Скопировано',
  share: 'Поделиться',
  signIn: 'Войти',
  signOut: 'Выйти',
  settings: 'Настройки',

  // states
  loading: 'Загрузка…',
  saving: 'Сохраняем…',
  nothingHere: 'Пока пусто',
  somethingWentWrong: 'Что-то пошло не так',
  noConnection: 'Нет соединения',
  notFound: 'Страница не найдена',

  // confirmations
  areYouSure: 'Вы уверены?',
  actionCannotBeUndone: 'Это действие нельзя отменить.',

  // generic labels
  today: 'Сегодня',
  tomorrow: 'Завтра',
  yesterday: 'Вчера',
  all: 'Все',
  none: 'Нет',
  optional: 'необязательно',
  required: 'обязательно',
} as const;

/** Bottom-tab / sidebar section names. Kept here because two components share them. */
export const NAV_LABELS = {
  today: 'Сегодня',
  tasks: 'Задачи',
  calendar: 'Календарь',
  goals: 'Копилки',
  shopping: 'Покупки',
  wall: 'Стена',
  family: 'Семья',
  settings: 'Настройки',
  members: 'Участники',
  notifications: 'Уведомления',
  profile: 'Профиль',
  accounts: 'Способы входа',
  more: 'Ещё',
} as const;

/** Nominative case — for headings and standalone use. */
export const WEEKDAYS_FULL = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
] as const;

/** Calendar column headers, indexed by `Date.getDay()`. */
export const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const;

/** Nominative: "Январь 2026". */
export const MONTHS_NOMINATIVE = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
] as const;

/** Genitive: "7 сентября". Russian dates need this form, not the nominative. */
export const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

/** The family week starts on Monday. */
export const WEEK_STARTS_ON = 1 as const;

/* -------------------------------------------------------------------------
 * Pluralization
 * ---------------------------------------------------------------------- */

/**
 * Russian numeric agreement, re-exported from `@family/shared`.
 *
 * The rule itself used to be written out six times — here, in
 * `features/shopping/locale.ts`, in `features/goals/locale.ts`, and three more
 * times on the server. They agreed on every integer, but two of them exported a
 * function called `plural` with a **different arity**
 * (`plural(n, one, few, many)` there, `plural(n, [one, few, many])` here), so
 * moving a line between the two files compiled cleanly and printed nonsense.
 * And the count in front of the word was formatted two ways: `Intl` grouping in
 * the UI, a bare `${n}` in the weekly digest, so the same figure read
 * «1 000 задач» on screen and «1000 задач» in the push about it.
 *
 * One implementation now, one count format. The names below are the ones this
 * app uses; `plural` is the word alone, `pluralize` is count + word.
 */
export {
  pluralIndex as pluralForm,
  pluralRu as plural,
  countRu as pluralize,
  formatCountRu,
} from '@family/shared';
export type { PluralForms } from '@family/shared';

/**
 * Ready-made word sets used across features.
 *
 * This is `RU_PLURALS` from `@family/shared` — the *same* table the digest and
 * the notification renderer read, so a word cannot be spelled one way in a push
 * and another way on the screen it links to. It had zero consumers while six
 * features inlined their own tuples; every counted phrase goes through it now.
 *
 * Add a key rather than inlining a tuple at a call site.
 */
export { RU_PLURALS as PLURALS } from '@family/shared';

/* -------------------------------------------------------------------------
 * Relative time
 * ---------------------------------------------------------------------- */

/** The `date-fns` locale object, re-exported so components import it from one place. */
export const dateLocale = ru;

/** "3 минуты назад", "через 2 дня". */
export function relativeTime(date: Date | string | number): string {
  const value = toDate(date);
  const distance = formatDistanceToNowStrict(value, { locale: ru });
  return value.getTime() <= Date.now() ? `${distance} назад` : `через ${distance}`;
}

/**
 * Human day label: "Сегодня", "Завтра", "Вчера", otherwise "7 сентября"
 * (adding the year when it is not the current one).
 */
export function dayLabel(date: Date | string | number): string {
  const value = toDate(date);
  if (isToday(value)) return COMMON.today;
  if (isTomorrow(value)) return COMMON.tomorrow;
  if (isYesterday(value)) return COMMON.yesterday;
  const sameYear = value.getFullYear() === new Date().getFullYear();
  return format(value, sameYear ? 'd MMMM' : 'd MMMM yyyy', { locale: ru });
}

/** "понедельник, 7 сентября" — for date headers in lists. */
export function longDayLabel(date: Date | string | number): string {
  return format(toDate(date), 'EEEE, d MMMM', { locale: ru });
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}
