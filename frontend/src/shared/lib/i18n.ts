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
 * Russian has three plural forms and picking the wrong one is the single most
 * visible "this was translated by a machine" tell:
 *
 *   1 задача   — `one`   : n % 10 === 1 and n % 100 !== 11
 *   2 задачи   — `few`   : n % 10 in 2..4 and n % 100 not in 12..14
 *   5 задач    — `many`  : everything else (0, 5–20, 11–14, …)
 *
 * The 11–14 exception is what naive implementations get wrong: 21 задача but
 * 11 задач, 22 задачи but 12 задач.
 *
 * @param n     the count (fractions are floored on the absolute value)
 * @param forms `[one, few, many]`, e.g. `['задача', 'задачи', 'задач']`
 */
export function pluralForm(n: number): 0 | 1 | 2 {
  const abs = Math.floor(Math.abs(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return 0;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
  return 2;
}

export function plural(n: number, forms: readonly [string, string, string]): string {
  return forms[pluralForm(n)];
}

/** `pluralize(5, ['задача','задачи','задач'])` → `'5 задач'`. */
export function pluralize(n: number, forms: readonly [string, string, string]): string {
  return `${formatCount(n)} ${plural(n, forms)}`;
}

function formatCount(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(n);
}

/** Ready-made word sets used across features. */
export const PLURALS = {
  task: ['задача', 'задачи', 'задач'] as const,
  event: ['событие', 'события', 'событий'] as const,
  member: ['участник', 'участника', 'участников'] as const,
  item: ['товар', 'товара', 'товаров'] as const,
  goal: ['цель', 'цели', 'целей'] as const,
  day: ['день', 'дня', 'дней'] as const,
  hour: ['час', 'часа', 'часов'] as const,
  minute: ['минута', 'минуты', 'минут'] as const,
  point: ['балл', 'балла', 'баллов'] as const,
  comment: ['комментарий', 'комментария', 'комментариев'] as const,
  post: ['запись', 'записи', 'записей'] as const,
  rouble: ['рубль', 'рубля', 'рублей'] as const,
} satisfies Record<string, readonly [string, string, string]>;

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
