import { PLURALS, pluralize } from '@/shared/lib/i18n';
import type { MoneyParseError } from './money';

/**
 * Russian strings for the moneybox ("Копилки") feature.
 *
 * D7: every user-facing string in this feature lives here. Cross-cutting words
 * ("Сохранить", "Отмена") come from `@/shared/lib/i18n`, and error text is
 * never the server's `message` — it is mapped from the `ErrorCode` by
 * `errorMessageRu`.
 */
export const GOALS_RU = {
  title: 'Копилки',
  subtitle: 'Общие цели семьи и личные накопления.',

  // ---- list -------------------------------------------------------------
  createGoal: 'Новая копилка',
  emptyTitle: 'Копилок пока нет',
  emptyDescription:
    'Заведите первую цель — на отпуск, велосипед или новый диван. Копить вместе интереснее.',
  emptyReadOnlyDescription: 'Здесь появятся семейные цели, когда взрослые их создадут.',
  emptyFiltered: 'По этому фильтру ничего нет',
  emptyFilteredDescription: 'Попробуйте другой раздел или снимите фильтры.',

  scopeAll: 'Все',
  scopeFamily: 'Семейные',
  scopeMine: 'Мои',
  showArchived: 'Показать архив',
  hideArchived: 'Скрыть архив',

  summarySaved: 'Накоплено',
  summaryGoals: 'Целей в работе',
  summaryReached: 'Достигнуто',

  // ---- card / detail ----------------------------------------------------
  of: 'из',
  collected: 'Собрано',
  target: 'Цель',
  remaining: 'Осталось собрать',
  remainingDone: 'Цель закрыта',
  overTarget: 'Сверх цели',
  progressLabel: 'Прогресс',
  sharedGoal: 'Семейная',
  personalGoal: 'Личная',
  privateGoal: 'Только для меня',
  contributors: 'Кто уже вложился',
  noContributors: 'Пока никто не пополнял',
  contributorsCount: 'участников',
  youSuffix: '(вы)',
  openGoal: 'Открыть копилку',
  backToGoals: 'К копилкам',

  deadline: 'Срок',
  noDeadline: 'Без срока',
  daysLeft: 'Осталось дней',
  deadlinePassed: 'Срок прошёл',
  deadlineToday: 'Последний день',

  statusActive: 'Копим',
  statusReached: 'Цель достигнута',
  statusArchived: 'В архиве',
  statusCancelled: 'Отменена',

  reachedBanner: 'Цель достигнута!',
  reachedBannerDescription: 'Вы собрали всю сумму. Можно тратить — или поставить новую планку.',
  almostThere: 'Совсем немного осталось!',

  // ---- ledger -----------------------------------------------------------
  contribute: 'Пополнить',
  withdraw: 'Снять',
  contributeTitle: 'Пополнить копилку',
  withdrawTitle: 'Снять из копилки',
  contributeDescription: 'Сумма прибавится к накоплениям. Историю видит вся семья.',
  withdrawDescription:
    'Сумма спишется с накоплений. Запись останется в истории — её нельзя стереть.',
  amount: 'Сумма',
  amountPlaceholder: '1 000',
  amountHint: 'Можно с копейками: 1 234,56',
  note: 'Комментарий',
  notePlaceholder: 'На что или откуда — необязательно',
  previewTitle: 'Будет в копилке',
  previewBalance: 'Новый баланс',
  previewProgress: 'Новый прогресс',
  previewReaches: 'Этот взнос закрывает цель!',
  previewOverdraft: 'Это больше, чем сейчас в копилке — баланс уйдёт в минус.',
  contributeSuccess: 'Копилка пополнена',
  withdrawSuccess: 'Сумма снята',

  history: 'История пополнений',
  historyEmpty: 'Пока ни одного взноса',
  historyEmptyDescription: 'Первое пополнение появится здесь сразу после сохранения.',
  loadMore: 'Показать ещё',
  chartTitle: 'Как росли накопления',
  chartEmpty: 'График появится после первого пополнения.',
  chartSaved: 'Накоплено',
  chartTarget: 'Цель',

  kindContribution: 'Пополнение',
  kindWithdrawal: 'Снятие',
  kindCorrection: 'Коррекция',
  kindInterest: 'Проценты',

  // ---- milestones -------------------------------------------------------
  milestones: 'Этапы',
  milestonesDescription: 'Маленькие победы по дороге к большой цели.',
  milestonesEmpty: 'Этапов пока нет',
  milestonesEmptyDescription: 'Разбейте цель на шаги — так виден прогресс, а не только финиш.',
  addMilestone: 'Добавить этап',
  editMilestone: 'Изменить этап',
  milestoneTitle: 'Название этапа',
  milestoneTitlePlaceholder: 'Например: половина пути',
  milestoneAmount: 'Сумма этапа',
  milestoneReached: 'Пройден',
  milestoneReachedAt: 'Пройден',
  milestoneAhead: 'Впереди',
  milestoneDeleteTitle: 'Удалить этап?',
  milestoneDeleteDescription: 'Этап исчезнет из списка. На накопления это не влияет.',
  milestoneSaved: 'Этап сохранён',
  milestoneDeleted: 'Этап удалён',

  // ---- form -------------------------------------------------------------
  newGoalTitle: 'Новая копилка',
  editGoalTitle: 'Изменить копилку',
  formName: 'Название',
  formNamePlaceholder: 'Например: отпуск на море',
  formDescription: 'Описание',
  formDescriptionPlaceholder: 'Зачем копим и что получится в итоге',
  formTarget: 'Цель, ₽',
  formDeadline: 'Срок',
  formDeadlineHint: 'Необязательно — но с датой копится бодрее.',
  formColor: 'Цвет',
  formIcon: 'Значок',
  formKind: 'Кому принадлежит',
  formKindShared: 'Семейная — копим вместе',
  formKindPersonal: 'Личная — только моя',
  formPrivate: 'Скрыть от остальных',
  formPrivateHint: 'Личную копилку увидите только вы.',
  goalCreated: 'Копилка создана',
  goalUpdated: 'Изменения сохранены',
  goalDeleted: 'Копилка удалена',
  deleteGoal: 'Удалить копилку',
  deleteGoalTitle: 'Удалить копилку?',
  deleteGoalDescription: 'История пополнений тоже перестанет отображаться. Действие необратимо.',

  // ---- validation -------------------------------------------------------
  errorAmountEmpty: 'Укажите сумму',
  errorAmountInvalid: 'Только цифры, пробелы и запятая: 1 234,56',
  errorAmountPrecision: 'Не больше двух знаков после запятой',
  errorAmountTooLarge: 'Слишком большая сумма',
  errorAmountNotPositive: 'Сумма должна быть больше нуля',
  errorTitleRequired: 'Придумайте название',
  errorDeadlineInvalid: 'Дата в формате ГГГГ-ММ-ДД',
  errorColorInvalid: 'Выберите цвет из списка',

  notFound: 'Копилка не найдена',
  notFoundDescription: 'Возможно, её удалили или у вас нет к ней доступа.',
} as const;

/** Why an amount could not be parsed → what the user is told. */
export const MONEY_ERROR_RU: Record<MoneyParseError, string> = {
  empty: GOALS_RU.errorAmountEmpty,
  invalid: GOALS_RU.errorAmountInvalid,
  precision: GOALS_RU.errorAmountPrecision,
  tooLarge: GOALS_RU.errorAmountTooLarge,
  notPositive: GOALS_RU.errorAmountNotPositive,
};

/** Ledger `kind` → Russian label. */
export const GOAL_TXN_KIND_RU = {
  contribution: GOALS_RU.kindContribution,
  withdrawal: GOALS_RU.kindWithdrawal,
  correction: GOALS_RU.kindCorrection,
  interest: GOALS_RU.kindInterest,
} as const;

/** Goal `status` → Russian label. */
export const GOAL_STATUS_RU = {
  active: GOALS_RU.statusActive,
  reached: GOALS_RU.statusReached,
  archived: GOALS_RU.statusArchived,
  cancelled: GOALS_RU.statusCancelled,
} as const;

/**
 * "5 дней" — one Russian plural rule for the whole app, in `@family/shared`.
 *
 * This file used to carry its own `pluralRu(count, one, few, many)`, which was
 * the same rule as `@/shared/lib/i18n`'s `plural(n, forms)` written with a
 * different arity, and it interpolated the count bare while the rest of the UI
 * grouped it. `pluralize` does both, once.
 */
export function daysLeftLabel(days: number): string {
  if (days === 0) return GOALS_RU.deadlineToday;
  if (days < 0) return GOALS_RU.deadlinePassed;
  return pluralize(days, PLURALS.day);
}

export function contributorsLabel(count: number): string {
  return pluralize(count, PLURALS.member);
}
