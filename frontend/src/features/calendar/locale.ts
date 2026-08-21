/**
 * Every user-facing string of the Календарь feature (D7).
 *
 * Cross-cutting words (Сохранить, Отмена, weekday names) come from
 * `@/shared/lib/i18n` — this file only owns calendar vocabulary.
 */
import { PLURALS, pluralize } from '@/shared/lib/i18n';

export const CALENDAR_RU = {
  title: 'Календарь',
  description: 'Общие события, встречи, праздники и дни рождения.',

  /* ---- views ---------------------------------------------------------- */
  viewMonth: 'Месяц',
  viewAgenda: 'Список',
  viewLabel: 'Вид календаря',
  today: 'Сегодня',
  prevMonth: 'Предыдущий месяц',
  nextMonth: 'Следующий месяц',
  moreEvents: (n: number) => `Ещё ${String(n)}`,
  allDay: 'Весь день',

  /* ---- lists ---------------------------------------------------------- */
  emptyMonthTitle: 'В этом месяце пусто',
  emptyMonthDescription: 'Добавьте событие — его увидят все в семье.',
  /** The *selected day* in the month view — not the month, which may be full. */
  emptyDayTitle: 'В этот день ничего не запланировано',
  emptyDayDescription: 'Выберите другой день или добавьте событие.',
  emptyAgendaTitle: 'Ближайших событий нет',
  emptyAgendaDescription:
    'Здесь появятся встречи, праздники и дни рождения. Соседние месяцы — стрелками выше.',
  loadFailed: 'Не удалось загрузить календарь',
  /**
   * `/calendar/:eventId` answering a 404. A notification is the only way into
   * that screen, and a push outlives the row it names, so this is the ordinary
   * outcome of an old reminder rather than a failure. D4 makes a deletion and a
   * permission denial indistinguishable from here — the wording claims neither.
   */
  notFoundTitle: 'Событие не найдено',
  notFoundDescription:
    'Возможно, оно уже прошло, было удалено или доступно только другим участникам.',
  /** «Напоминание: 21 августа 2026 г.» — which date sent the reader here. */
  remindedAbout: (date: string) => `Напоминание: ${date}`,
  /**
   * Same date, after an edit took it out of the schedule. Matches the tasks
   * side's wording (`TASKS_RU.rescheduledTitle`) on purpose: it is the same
   * sentence about the same kind of event, and two spellings of it would drift.
   */
  remindedDateGone: 'Этой даты больше нет в расписании',

  /* ---- actions -------------------------------------------------------- */
  createEvent: 'Новое событие',
  createEventShort: 'Событие',
  editEvent: 'Изменить событие',
  deleteEvent: 'Удалить событие',
  openEvent: 'Открыть событие',
  backToCalendar: 'К календарю',

  /* ---- event card ----------------------------------------------------- */
  location: 'Место',
  attendees: 'Участники',
  noAttendees: 'Никого не приглашали — событие для всей семьи.',
  reminders: 'Напоминания',
  noReminders: 'Без напоминаний',
  repeats: 'Повторение',
  noRepeat: 'Не повторяется',
  changedThisTime: 'Изменено',
  cancelled: 'Отменено',
  upcomingOccurrences: 'Ближайшие даты',
  seriesReadOnly: 'Это событие создаётся автоматически и меняется в профиле участника.',
  scheduleNotEditable:
    'Расписание задано вручную и не разбирается конструктором. Его можно только заменить целиком.',

  /* ---- birthdays ------------------------------------------------------ */
  birthday: 'День рождения',
  birthdayNotEditable: 'День рождения нельзя изменить здесь',
  birthdayHint: 'Дата рождения меняется в профиле участника.',
  /** «исполняется 36 лет» — the bare number read as an unfinished sentence. */
  age: (n: number) => `исполняется ${pluralize(n, PLURALS.year)}`,

  /* ---- RSVP ----------------------------------------------------------- */
  rsvpQuestion: 'Вы придёте?',
  rsvpYes: 'Приду',
  rsvpNo: 'Не приду',
  rsvpMaybe: 'Возможно',
  rsvpPending: 'Не ответил',
  rsvpSaved: 'Ответ сохранён',

  /* ---- form ----------------------------------------------------------- */
  formCreateTitle: 'Новое событие',
  formEditTitle: 'Изменение события',
  formCreateDescription: 'Событие появится у всех в семье и в подписке на календарь.',
  formEditDescription: 'Изменения увидят все участники.',
  fieldTitle: 'Название',
  fieldTitlePlaceholder: 'Например, ужин у бабушки',
  fieldLocation: 'Место',
  fieldLocationPlaceholder: 'Адрес или комната',
  fieldDescription: 'Описание',
  fieldDescriptionPlaceholder: 'Что нужно знать участникам',
  fieldAllDay: 'Весь день',
  fieldDate: 'Дата',
  fieldTime: 'Начало',
  fieldDuration: 'Длительность',
  fieldColor: 'Цвет',
  fieldColorAuto: 'Автоматически',
  fieldCategory: 'Категория',
  fieldCategoryPlaceholder: 'Например, школа',
  fieldVisibility: 'Кто видит',
  fieldAttendees: 'Участники',
  fieldReminders: 'Напоминания',
  remindersHint: 'Не больше пяти напоминаний.',
  saveCreate: 'Создать',
  saveEdit: 'Сохранить',

  /* ---- the §D-forms sheet --------------------------------------------- */
  /** Section label above everything that is optional by construction (§F7). */
  formDetails: 'Подробнее',
  /** The disclosure that reveals the rarely-touched rows. */
  formMore: 'Ещё',
  formAttendeesNobody: 'Вся семья',
  formRemindersNone: 'Без напоминаний',
  formRemindersCount: (n: number) => `${String(n)} шт.`,
  formColorAutoShort: 'Авто',
  formLoading: 'Загружаем событие…',
  /**
   * The chip that stays under the sheet header once the scope is chosen (§F6).
   */
  scopeChip: {
    prefix: 'Меняем',
    // Lower-cased because the label lands mid-sentence: «Меняем: только
    // сегодня», not «Меняем: только Сегодня».
    this: (date: string) => `только ${date.toLocaleLowerCase('ru')}`,
    thisAndFuture: (date: string) => `${date.toLocaleLowerCase('ru')} и все следующие`,
    all: 'всю серию',
    change: 'сменить',
  },
  createdToast: 'Событие создано',
  updatedToast: 'Событие обновлено',
  deletedToast: 'Событие удалено',

  visibility: {
    household: 'Вся семья',
    private: 'Только я',
    restricted: 'Только участники',
  },

  durations: [
    { minutes: 15, label: '15 минут' },
    { minutes: 30, label: '30 минут' },
    { minutes: 45, label: '45 минут' },
    { minutes: 60, label: '1 час' },
    { minutes: 90, label: '1,5 часа' },
    { minutes: 120, label: '2 часа' },
    { minutes: 180, label: '3 часа' },
    { minutes: 240, label: '4 часа' },
    { minutes: 480, label: '8 часов' },
  ],

  reminderOptions: [
    { minutes: 0, label: 'В момент начала' },
    { minutes: 10, label: 'За 10 минут' },
    { minutes: 30, label: 'За 30 минут' },
    { minutes: 60, label: 'За час' },
    { minutes: 120, label: 'За 2 часа' },
    { minutes: 1440, label: 'За день' },
    { minutes: 10080, label: 'За неделю' },
  ],

  colors: [
    { value: '#c2643c', label: 'Глина' },
    { value: '#5b8c6e', label: 'Шалфей' },
    { value: '#d9a441', label: 'Мёд' },
    { value: '#8e6ba8', label: 'Слива' },
    { value: '#4c86b8', label: 'Небо' },
    { value: '#b5453a', label: 'Кирпич' },
    { value: '#6b6560', label: 'Графит' },
  ],

  /* ---- recurrence builder --------------------------------------------- */
  recurrence: {
    legend: 'Повторение',
    once: 'Не повторяется',
    daily: 'Ежедневно',
    weekly: 'По дням недели',
    weeklyInterval: 'Раз в N недель',
    monthlyDay: 'N-е число месяца',
    monthlyLastDay: 'Последний день месяца',

    everyN: 'Каждые',
    days: 'дн.',
    weeks: 'нед.',
    months: 'мес.',
    weekdays: 'Дни недели',
    weekdaysRequired: 'Выберите хотя бы один день недели',
    dayOfMonth: 'Число',
    dayOfMonthHint:
      'В коротком месяце такого числа может не быть — для конца месяца выберите «Последний день месяца».',

    endsLegend: 'Заканчивается',
    endsNever: 'Никогда',
    /** Short: it sits in a three-way segmented row that must never wrap. */
    endsAfter: 'После',
    endsUntil: 'До даты',
    endsAfterUnit: 'раз',
    endsUntilLabel: 'Последняя дата',
  },

  weekdayCodes: [
    { code: 'MO', short: 'пн', label: 'понедельник' },
    { code: 'TU', short: 'вт', label: 'вторник' },
    { code: 'WE', short: 'ср', label: 'среда' },
    { code: 'TH', short: 'чт', label: 'четверг' },
    { code: 'FR', short: 'пт', label: 'пятница' },
    { code: 'SA', short: 'сб', label: 'суббота' },
    { code: 'SU', short: 'вс', label: 'воскресенье' },
  ],

  /* ---- edit scope ------------------------------------------------------ */
  scope: {
    // Title is the question, description is the context — the same order as
    // `TASKS_RU.scope`. The two tables used to have these the other way round,
    // so the shared dialog would have read one screen's title as the other's
    // description. Keys match `EditScopeStrings` in `@/shared/components`.
    editTitle: 'Что изменить?',
    editDescription: 'Это повторяющееся событие. Выберите, на что подействуют изменения.',
    deleteTitle: 'Что удалить?',
    deleteDescription: 'Это повторяющееся событие. Выберите, что именно удалить.',
    this: 'Только это',
    thisAndFuture: 'Это и последующие',
    all: 'Все',
    thisHint: 'Изменится только выбранная дата.',
    thisAndFutureHint: 'Изменятся эта и все следующие даты, прошлые останутся как есть.',
    allHint: 'Изменятся все даты серии, кроме уже изменённых вручную.',
    confirm: 'Применить',
    deleteConfirm: 'Удалить',
  },

  deleteConfirmTitle: 'Удалить событие?',
  deleteConfirmDescription: 'Событие исчезнет у всех участников и из подписки на календарь.',

  /* ---- ICS subscription ------------------------------------------------ */
  subscribe: {
    title: 'Подписаться в Календаре',
    short: 'Подписаться',
    lead: 'Добавьте семейный календарь в приложение «Календарь» — события будут видны без открытия этого приложения.',
    urlLabel: 'Ссылка на календарь',
    copy: 'Скопировать ссылку',
    copied: 'Ссылка скопирована',
    copyFailed: 'Не удалось скопировать — выделите ссылку и скопируйте вручную.',
    openInCalendar: 'Открыть в Календаре',
    privacy: 'Ссылка личная: у каждого участника своя. Не пересылайте её посторонним.',
    loadFailed: 'Не удалось получить ссылку на календарь',
    iphoneTitle: 'Как добавить на iPhone',
    /**
     * The last step is not decoration. iOS copies the feed's refresh interval
     * into the subscription record **at subscribe time**, so shortening it
     * server-side does nothing for anyone who is already subscribed — including
     * whoever set the family up. Without this step they keep the old interval
     * for good.
     */
    iphoneSteps: [
      'Скопируйте ссылку кнопкой выше.',
      'Откройте «Настройки» → «Приложения» → «Календарь» → «Учётные записи».',
      'Нажмите «Добавить учётную запись» → «Другое» → «Подписной календарь».',
      'Вставьте ссылку, нажмите «Далее», затем «Сохранить».',
      'Откройте этот календарь ещё раз и выберите «Обновление» → «Каждые 15 мин.».',
    ],
    otherTitle: 'Android и компьютер',
    otherSteps:
      'В Google Календаре: «Другие календари» → «Добавить по URL». В Outlook: «Добавить календарь» → «Подписаться из Интернета».',
    /**
     * States a capability rather than apologising for one. The feed now
     * advertises 15 minutes and answers `If-Modified-Since`, which is the only
     * conditional header iOS `dataaccessd` ever sends.
     */
    refreshNote:
      'Телефон проверяет подписку примерно раз в 15 минут. Если событие нужно увидеть сразу — потяните календарь вниз, чтобы обновить.',
  },
} as const;

/** «3 события» — the count beside a day's label in the agenda (§C3). */
export const eventCount = (n: number): string => pluralize(n, PLURALS.event);
