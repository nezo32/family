/**
 * Every user-facing string of the «Задачи» section (D7).
 *
 * Code and comments are English; the values here are the only Russian in the
 * feature. Cross-cutting words («Сохранить», «Отмена», weekday names) come from
 * `@/shared/lib/i18n` and must not be duplicated here.
 */
export const TASKS_RU = {
  title: 'Задачи',
  subtitle: 'Семейные дела: разовые и повторяющиеся.',

  /* ---- list groups ---- */
  groups: {
    overdue: 'Просрочено',
    today: 'Сегодня',
    week: 'На неделе',
    later: 'Позже',
    done: 'Выполнено',
    skipped: 'Пропущено',
  },
  groupHint: {
    overdue: 'Срок уже прошёл — сделайте или перенесите.',
    today: 'Дела на сегодня.',
    week: 'Ближайшие семь дней.',
    later: 'Дальше по расписанию.',
    done: 'Спасибо — эти дела закрыты.',
    skipped: 'Эти дела решили не делать.',
  },

  /* ---- filters ---- */
  filters: {
    title: 'Фильтры',
    apply: 'Показать',
    assignee: 'Кто делает',
    everyone: 'Все',
    mine: 'Мои',
    unassigned: 'Ничьи',
    category: 'Категория',
    allCategories: 'Любая',
    withoutCategory: 'Без категории',
    showDone: 'Показывать выполненные',
    reset: 'Сбросить фильтры',
  },

  /* ---- occurrence card ---- */
  card: {
    complete: 'Выполнено',
    completeAria: 'Отметить выполненным',
    uncomplete: 'Вернуть в работу',
    overdue: 'Просрочено',
    doneBy: 'Сделал',
    changed: 'Изменено',
    swapPending: 'Ждёт подмены',
    noAssignee: 'Никто не назначен',
    claim: 'Возьму на себя',
    open: 'Подробнее',
    skipped: 'Пропущено',
    cancelled: 'Отменено',
  },

  /**
   * Gestures (§C-gestures). One word on the revealed swipe button, one line in
   * the undo toast. Deliberately shorter than `card.complete` / `card.uncomplete`:
   * an 88px button and a toast have room for a word, not for a sentence, and the
   * long forms still carry the full meaning on the visible controls.
   *
   * There is no «проведите, чтобы…» hint anywhere and there must not be one —
   * §G1 makes gestures silent on purpose, because the visible tick is what
   * teaches the action.
   */
  swipe: {
    done: 'Сделано',
    undone: 'Вернули',
    /** Screen-reader name for the revealed button. */
    doneAria: 'Отметить выполненным',
    undoneAria: 'Вернуть в работу',
  },

  /** The long-press / «ещё» sheet on a row (§G5, §D2). */
  rowSheet: {
    description: 'Действия с делом',
    open: 'Открыть дело',
  },

  /* ---- states ---- */
  emptyTitle: 'Дел пока нет',
  emptyDescription: 'Добавьте первое дело — его увидит вся семья.',
  emptyFilteredTitle: 'Ничего не нашлось',
  emptyFilteredDescription: 'Попробуйте выбрать другого исполнителя или категорию.',
  emptyDoneTitle: 'Пока ничего не выполнено',
  emptyDoneDescription: 'Как только кто-то отметит дело, оно появится здесь.',
  loadError: 'Не удалось загрузить задачи',
  notFoundTitle: 'Задача не найдена',
  notFoundDescription: 'Возможно, её удалили или у вас нет к ней доступа.',
  backToList: 'Ко всем задачам',

  /* ---- actions ---- */
  actions: {
    create: 'Новое дело',
    edit: 'Изменить',
    delete: 'Удалить',
    skip: 'Пропустить',
    assign: 'Назначить',
    reassign: 'Сменить исполнителя',
    unassign: 'Снять исполнителя',
    swap: 'Попросить подмениться',
    more: 'Ещё действия',
  },

  /* ---- create / edit form ---- */
  form: {
    createTitle: 'Новое дело',
    editTitle: 'Изменить дело',
    createSubmit: 'Создать',
    editSubmit: 'Сохранить',
    name: 'Что нужно сделать',
    namePlaceholder: 'Например: вынести мусор',
    notes: 'Заметка',
    notesPlaceholder: 'Детали, которые важно не забыть',
    category: 'Категория',
    categoryPlaceholder: 'Кухня, уборка, школа…',
    assignee: 'Исполнитель по умолчанию',
    assigneeNobody: 'Никто — возьмёт любой',
    date: 'Дата',
    time: 'Время',
    due: 'Срок',
    dueOptions: {
      atStart: 'К началу',
      hour: 'Через час',
      evening: 'До конца дня',
      nextDay: 'До завтра',
      week: 'До конца недели',
    },
    saved: 'Дело сохранено',
    created: 'Дело добавлено',
    deleted: 'Дело удалено',

    /* ---- the §D-forms sheet ---- */
    /** Section label above everything that is optional by construction (§F7). */
    details: 'Подробнее',
    /** The disclosure that reveals the rarely-touched rows. */
    more: 'Ещё',
    when: 'Когда',
    who: 'Кто',
    whoAnyone: 'Любой',
    /** «Срок» in the row sense: how long after the start it stops being on time. */
    dueSheetTitle: 'Когда истекает срок',
    dueHints: {
      atStart: 'Просрочится сразу после начала.',
      hour: 'Есть час после начала.',
      nextDay: 'Есть время до конца следующего дня.',
      week: 'Есть неделя.',
    },
    visibility: 'Кто видит',
    categorySheetTitle: 'Категория',
    notesSheetTitle: 'Заметка',
    whoSheetTitle: 'Кто это сделает',

    /* ---- напоминания (§F5: «Напоминания → ValueRow → sheet») ---- */
    reminders: 'Напоминание',
    remindersSheetTitle: 'Напоминания',
    /**
     * What the row says when nothing was chosen. It states what *will* happen,
     * not what is missing: «—» would read as "no reminder at all", and the
     * at-start one is never off.
     */
    remindersNone: 'В момент начала',
    /** The sheet's fixed first row. Not a toggle — it has no off state. */
    remindersAlwaysLabel: 'В момент начала',
    remindersAlwaysValue: 'Всегда',
    remindersAlwaysHint:
      'Приходит для каждого дела. Выключить можно только в настройках уведомлений.',
    remindersAheadLabel: 'Заранее',
    remindersLimitHint: 'Не больше пяти напоминаний на одно дело.',
    /** Two leads read as one phrase: «За день и за час». */
    remindersJoin: ' и ',
    /** Three or more stop being a phrase and become a count. */
    remindersManyValue: (n: number) => `Напоминаний: ${String(n)}`,
    /**
     * What the sheet offers, in minutes before the start — «за час (или
     * несколько часов)» and «за день (или несколько дней)», which is what was
     * asked for, and nothing else. A picker a thumb has to scroll is one nobody
     * reads to the end of.
     */
    remindersOptions: [
      { minutes: 30, label: 'За 30 минут' },
      { minutes: 60, label: 'За час' },
      { minutes: 120, label: 'За 2 часа' },
      { minutes: 180, label: 'За 3 часа' },
      { minutes: 360, label: 'За 6 часов' },
      { minutes: 1440, label: 'За день' },
      { minutes: 2880, label: 'За 2 дня' },
      { minutes: 10080, label: 'За неделю' },
    ],
  },

  /** Who can see the chore. Same vocabulary as the calendar, by design. */
  visibility: {
    household: 'Вся семья',
    restricted: 'Только участники',
    private: 'Только я',
  },

  /* ---- recurrence builder ---- */
  recurrence: {
    legend: 'Повторение',
    once: 'Не повторяется',
    daily: 'Ежедневно',
    weekly: 'По дням недели',
    monthlyDay: 'Число месяца',
    monthlyLastDay: 'Последний день месяца',
    everyNDays: 'Каждые',
    days: 'дн.',
    everyNWeeks: 'Каждые',
    weeks: 'нед.',
    everyNMonths: 'Каждые',
    months: 'мес.',
    weekdays: 'Дни недели',
    weekdaysRequired: 'Выберите хотя бы один день недели',
    dayOfMonth: 'Число',
    dayOfMonthHint: 'Если в месяце нет такого числа, дело в этот месяц не появится.',
    lastDayHint: 'Подходит для дел «в конце месяца» — работает и в феврале.',
    ends: 'Заканчивается',
    endsNever: 'Никогда',
    endsAfter: 'После',
    endsAfterUnit: 'раз',
    endsUntil: 'До даты',
    summaryLabel: 'Расписание',
    customTitle: 'Нестандартное расписание',
    customDescription:
      'Это расписание пришло из импорта и его нельзя собрать в конструкторе. Его можно только заменить целиком.',
    replace: 'Заменить расписание',
    keepCustom: 'Оставить как есть',
  },

  /**
   * Pieces the client-side schedule preview is assembled from. The saved
   * series always shows the server's `recurrence.summary`; this is only for the
   * sentence under the builder while the user is still choosing.
   */
  summary: {
    once: 'Один раз',
    daily: 'Каждый день',
    everyDays: 'Каждые %n дн.',
    weeklyBy: 'Каждую неделю: %d',
    weeklyEveryBy: 'Каждые %n нед.: %d',
    monthlyDay: 'Каждый месяц, %d-е число',
    monthlyEveryDay: 'Каждые %n мес., %d-е число',
    monthlyLastDay: 'Каждый месяц, в последний день',
    monthlyEveryLastDay: 'Каждые %n мес., в последний день',
    at: 'в %t',
    endsAfter: 'всего %n раз',
    endsUntil: 'до %d',
  },

  /* ---- edit scope prompt ---- */
  scope: {
    // Keys named to match `EditScopeStrings` in `@/shared/components`, so the
    // shared dialog cannot be handed a title where it expects a description —
    // which is exactly how this table and the calendar's ended up swapped.
    editTitle: 'Что изменить?',
    editDescription: 'Это повторяющееся дело. Выберите, на что подействуют изменения.',
    deleteTitle: 'Что удалить?',
    deleteDescription: 'Это повторяющееся дело. Выберите, что именно удалить.',
    this: 'Только это',
    thisHint: 'Изменится один этот раз. Расписание останется прежним.',
    thisDeleteHint: 'Удалится только этот раз. Остальные повторы останутся.',
    thisAndFuture: 'Это и последующие',
    thisAndFutureHint: 'Прошлые разы останутся как были, изменится этот и все следующие.',
    thisAndFutureDeleteHint: 'Прошлые разы останутся, а этот и все следующие исчезнут.',
    all: 'Все',
    allHint: 'Изменится вся серия. Уже выполненные разы не трогаем.',
    allDeleteHint: 'Серия закроется целиком. История выполненных дел сохранится.',
    confirm: 'Продолжить',
  },

  /**
   * The chip that stays under the sheet header once the scope is chosen (§F6).
   * One decision, taken when it is cheap, visible the whole time, changeable in
   * one tap.
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

  /* ---- skip ---- */
  skip: {
    title: 'Пропустить это дело?',
    description: 'Дело останется в истории как пропущенное.',
    confirm: 'Пропустить',
    done: 'Дело пропущено',
  },

  /* ---- delete ---- */
  delete: {
    title: 'Удалить дело?',
    description: 'Выполненные разы останутся в истории семьи.',
  },

  /* ---- assignment ---- */
  assign: {
    title: 'Кто это сделает',
    nobody: 'Никто — возьмёт любой',
    done: 'Исполнитель обновлён',
    claimed: 'Дело теперь ваше',
    readOnlyHint: 'Исполнителя назначают взрослые.',
  },

  /* ---- swaps ---- */
  swap: {
    title: 'Подмена',
    /** The §C2 band-2 eyebrow, shared wording with Сегодня's attention block. */
    attentionLabel: 'Требует внимания',
    incoming: 'Просят подменить',
    outgoing: 'Вы просили подменить',
    ask: 'Попросить подмениться',
    askTitle: 'Попросить подмениться',
    askDescription: 'Кто-то из семьи возьмёт это дело на себя — просто попросите.',
    toAnyone: 'Любому, кто откликнется',
    toPerson: 'Кому предложить',
    message: 'Сообщение',
    messagePlaceholder: 'Например: у меня тренировка до восьми',
    send: 'Отправить просьбу',
    sent: 'Просьба отправлена',
    accept: 'Помогу',
    decline: 'Не смогу',
    cancel: 'Отменить просьбу',
    accepted: 'Спасибо, дело теперь ваше',
    declined: 'Ответ отправлен',
    cancelled: 'Просьба отменена',
    empty: 'Никто не просит о подмене.',
    from: 'От кого',
    dueAt: 'Срок',
  },

  /* ---- detail page ---- */
  detail: {
    schedule: 'Расписание',
    starts: 'Начало',
    due: 'Срок',
    assignee: 'Исполнитель',
    category: 'Категория',
    notes: 'Заметка',
    status: 'Статус',
    statusScheduled: 'Запланировано',
    statusDone: 'Выполнено',
    statusSkipped: 'Пропущено',
    statusCancelled: 'Отменено',
    completedAt: 'Отмечено',
    seriesOnce: 'Разовое дело',
    exception: 'Этот раз изменён вручную',
  },

  /**
   * Field-level validation copy. The shared zod schemas carry English default
   * messages for the generic constraints, and D7 forbids showing the user a
   * string that was not written for them — so issue codes are mapped here.
   */
  validation: {
    required: 'Заполните это поле',
    tooLong: 'Слишком длинное значение',
    tooShort: 'Слишком короткое значение',
    invalid: 'Проверьте это поле',
  },

  /* ---- toasts ---- */
  toast: {
    completed: 'Отмечено выполненным',
    uncompleted: 'Дело снова в работе',
  },
} as const;

/** Short weekday labels for the recurrence builder, ISO order (Mon → Sun). */
export const WEEKDAY_OPTIONS_RU = [
  { value: 'MO', short: 'пн', long: 'понедельник' },
  { value: 'TU', short: 'вт', long: 'вторник' },
  { value: 'WE', short: 'ср', long: 'среда' },
  { value: 'TH', short: 'чт', long: 'четверг' },
  { value: 'FR', short: 'пт', long: 'пятница' },
  { value: 'SA', short: 'сб', long: 'суббота' },
  { value: 'SU', short: 'вс', long: 'воскресенье' },
] as const;
