/**
 * Russian strings for the family wall.
 *
 * Tone rules for anything added here (they are the whole point of this
 * section): warm, first-person-plural, never corporate, never comparative.
 * "Спасибо получили" — not "Рейтинг участников". The wall is the one screen
 * people open because they want to, not because something is due.
 */
export const WALL_RU = {
  title: 'Стена',
  description: 'Объявления, благодарности и общие решения.',

  tabs: {
    feed: 'Лента',
    polls: 'Опросы',
    kudos: 'Спасибо',
  },

  /* ------------------------------- feed --------------------------------- */
  feed: {
    pinnedSection: 'Закреплено',
    empty: 'Здесь пока тихо',
    emptyDescription: 'Напишите первое объявление — его увидит вся семья.',
    loadMore: 'Показать ещё',
    loadingMore: 'Загружаем…',
    end: 'Это всё, что было',
    systemAuthor: 'Семейный бот',
    unknownAuthor: 'Участник',
    activityLabel: 'Событие в семье',
  },

  /* ---------------------------- announcements ---------------------------- */
  post: {
    compose: 'Написать',
    composeTitle: 'Новое объявление',
    composeDescription: 'Коротко и по-человечески — это увидят все дома.',
    fieldTitle: 'Заголовок',
    fieldTitlePlaceholder: 'Необязательно',
    fieldBody: 'Текст',
    fieldBodyPlaceholder: 'Например: в субботу едем к бабушке, выезжаем в 10:00',
    publish: 'Опубликовать',
    publishing: 'Публикуем…',
    published: 'Объявление опубликовано',
    pinned: 'Закреплено',
    pinnedUntil: (until: string) => `Закреплено до ${until}`,
    pin: 'Закрепить',
    unpin: 'Открепить',
    pinFor: 'Закрепить на',
    pinDay: 'день',
    pinThreeDays: '3 дня',
    pinWeek: 'неделю',
    pinNone: 'не закреплять',
    pinnedToast: 'Закрепили наверху',
    unpinnedToast: 'Убрали из закреплённых',
    delete: 'Удалить объявление',
    deleteConfirmTitle: 'Удалить объявление?',
    deleteConfirmDescription: 'Оно исчезнет из ленты у всех. Отменить не получится.',
    deleted: 'Объявление удалено',
    edited: 'изменено',
  },

  /* ------------------------------ comments ------------------------------- */
  comments: {
    toggle: 'Обсудить',
    count: (n: number) => `Комментарии (${String(n)})`,
    empty: 'Пока никто не ответил.',
    placeholder: 'Написать…',
    send: 'Отправить',
    sending: 'Отправляем…',
    deleteConfirmTitle: 'Удалить комментарий?',
    deleteConfirmDescription: 'Он пропадёт у всех участников.',
    deleted: 'Комментарий удалён',
    loadOlder: 'Показать ещё',
    failed: 'Не отправилось',
  },

  /* ----------------------------- reactions ------------------------------- */
  reactions: {
    add: 'Реакция',
    addAria: 'Добавить реакцию',
    you: 'Вы',
    youAndOthers: (others: number) => `Вы и ещё ${String(others)}`,
    others: (n: number) => `${String(n)} — уже отметили`,
    nobody: 'Первым отметить',
  },

  /* ------------------------------- kudos --------------------------------- */
  kudos: {
    title: 'Спасибо',
    subtitle: 'Здесь мы просто говорим друг другу спасибо. Это не соревнование.',
    give: 'Сказать спасибо',
    giveTitle: 'Кому спасибо?',
    giveDescription: 'Можно без повода. Пара слов делает больше, чем кажется.',
    to: 'Кому',
    pickPerson: 'Выберите участника',
    message: 'За что',
    messagePlaceholder: 'Например: спасибо, что забрал Лизу из школы',
    emoji: 'Значок',
    send: 'Отправить спасибо',
    sending: 'Отправляем…',
    sent: 'Спасибо отправлено',
    received: (n: number) => `${String(n)} спасибо`,
    receivedNone: 'пока без спасибо',
    totalsTitle: 'Спасибо за последний месяц',
    totalsHint: 'Показываем всех — по алфавиту, без мест и рейтингов.',
    recentTitle: 'Последние',
    empty: 'Пока никто никого не благодарил.',
    emptyDescription: 'Самое время начать.',
  },

  /* ------------------------------- polls --------------------------------- */
  polls: {
    title: 'Опросы',
    subtitle: 'Решаем вместе — куда едем, что готовим, какой фильм.',
    create: 'Новый опрос',
    createTitle: 'Спросить семью',
    question: 'Вопрос',
    questionPlaceholder: 'Например: куда едем на выходных?',
    options: 'Варианты',
    optionPlaceholder: (n: number) => `Вариант ${String(n)}`,
    addOption: 'Добавить вариант',
    removeOption: 'Убрать вариант',
    allowMultiple: 'Можно выбрать несколько',
    closesAt: 'Голосуем до',
    closesAtHint: 'Необязательно. После этого времени опрос покажет результат.',
    publish: 'Спросить',
    published: 'Опрос опубликован',
    vote: 'Голосовать',
    voting: 'Считаем…',
    voted: 'Ваш голос учтён',
    changeVote: 'Изменить ответ',
    yourChoice: 'ваш выбор',
    open: 'Идёт голосование',
    closed: 'Голосование завершено',
    closesIn: (when: string) => `до ${when}`,
    closedAlready: 'Опрос уже завершён — вот результат.',
    close: 'Завершить',
    closeConfirmTitle: 'Завершить опрос?',
    closeConfirmDescription: 'Голоса больше принимать не будем. Вернуть нельзя.',
    closed_: 'Опрос завершён',
    totalVoters: (n: number) => `Проголосовали: ${String(n)}`,
    noVotesYet: 'Пока никто не проголосовал',
    empty: 'Опросов пока нет',
    emptyDescription: 'Спросите семью о чём-нибудь — это быстрее, чем переписка.',
    filterAll: 'Все',
    filterOpen: 'Открытые',
    filterClosed: 'Завершённые',
    resultShare: (percent: number) => `${String(percent)}%`,
  },
} as const;

/** Emoji offered in the reaction picker. Deliberately short and friendly. */
export const REACTION_EMOJI = ['❤️', '\u{1F44D}', '\u{1F389}', '\u{1F602}', '\u{1F64F}'] as const;

/** Emoji offered when giving kudos. */
export const KUDOS_EMOJI = ['\u{1F44F}', '❤️', '\u{1F31F}', '\u{1F917}', '\u{1F4AA}'] as const;
