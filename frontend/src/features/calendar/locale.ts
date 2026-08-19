/**
 * Every user-facing string of the Календарь feature (D7).
 *
 * Cross-cutting words (Сохранить, Отмена, weekday names) come from
 * `@/shared/lib/i18n` — this file only owns calendar vocabulary.
 */
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
  emptyAgendaTitle: 'Ближайших событий нет',
  emptyAgendaDescription: 'Здесь появятся встречи, праздники и дни рождения.',
  loadFailed: 'Не удалось загрузить календарь',

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
  age: (n: number) => `исполняется ${String(n)}`,

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
  saveCreate: 'Создать событие',
  saveEdit: 'Сохранить изменения',
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
    endsAfter: 'После N повторений',
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
    editTitle: 'Это повторяющееся событие',
    editDescription: 'Что изменить?',
    deleteTitle: 'Удалить повторяющееся событие',
    deleteDescription: 'Что удалить?',
    this: 'Только это',
    thisAndFuture: 'Это и последующие',
    all: 'Все',
    thisHint: 'Изменится только выбранная дата.',
    thisAndFutureHint: 'Изменятся эта и все следующие даты, прошлые останутся как есть.',
    allHint: 'Изменятся все даты серии, кроме уже изменённых вручную.',
    apply: 'Применить',
    deleteApply: 'Удалить',
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
    iphoneSteps: [
      'Скопируйте ссылку кнопкой выше.',
      'Откройте «Настройки» → «Приложения» → «Календарь» → «Учётные записи».',
      'Нажмите «Добавить учётную запись» → «Другое» → «Подписной календарь».',
      'Вставьте ссылку, нажмите «Далее», затем «Сохранить».',
    ],
    otherTitle: 'Android и компьютер',
    otherSteps:
      'В Google Календаре: «Другие календари» → «Добавить по URL». В Outlook: «Добавить календарь» → «Подписаться из Интернета».',
    refreshNote:
      'Календарь обновляется не мгновенно — телефон проверяет подписку раз в несколько часов.',
  },
} as const;
