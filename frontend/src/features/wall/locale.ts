import type { ReactionSummary } from '@family/shared';

/**
 * Russian strings for the family board.
 *
 * Tone rules for anything added here (they are the whole point of this
 * section): warm, «вы», never corporate, never comparative. The board is the
 * one screen people open because they want to, not because something is due.
 *
 * ## The vocabulary is deliberately a *board's*, not a *feed's*
 *
 * «Лента», «Опубликовать», «Отправить», «Показать ещё» are the words of a
 * timeline, and a timeline with a text field at the bottom is a chat. The
 * family already has one. So the nouns here are the nouns of the note surface
 * by the front door: «доска», «повесить», «закреплено», «решаем вместе» — and
 * the one verb that starts everything is «написать», which is what you do with
 * a note, not with a message.
 */
export const WALL_RU = {
  title: 'Стена',
  description: 'Доска дома: объявления, общие решения и спасибо.',

  /* -------------------------------- board -------------------------------- */
  board: {
    /** The stream section's label — everything that is not asking for you. */
    label: 'На доске',
    /** Band 2, when open polls take it. */
    pollsLabel: 'Решаем вместе',
    /** Band 2 or a quiet section, depending on what won the wash (§C2). */
    pinnedLabel: 'Закреплено',
    decidedLabel: 'Что решили',
    empty: 'На доске пусто',
    emptyDescription: 'Повесьте первую записку — её увидят все дома.',
    /** A reader who may not write anything. Guests see the board, not a lie. */
    emptyReadOnly: 'Когда кто-нибудь что-то напишет, это появится здесь.',
    more: 'Что было раньше',
    loadingMore: 'Смотрим…',
    end: 'Это всё, что было',
    systemAuthor: 'Семейный бот',
    unknownAuthor: 'Участник',
    loadError: 'Не удалось открыть доску',
  },

  /* ------------------------------- compose ------------------------------- */
  /**
   * The one door (§D7). Three kinds of note, one button, one place — which is
   * what lets every panel on this screen be stateless and therefore live
   * wherever the layout wants it.
   */
  compose: {
    open: 'Написать',
    menuTitle: 'Что повесим на доску?',
    menuDescription: 'Объявление, опрос или спасибо.',
    post: 'Объявление',
    postHint: 'Новость, о которой надо знать всем дома',
    poll: 'Опрос',
    pollHint: 'Спросить семью и решить вместе',
    kudos: 'Спасибо',
    kudosHint: 'Сказать спасибо кому-то из своих',
  },

  /* ---------------------------- announcements ---------------------------- */
  post: {
    composeTitle: 'Новое объявление',
    composeDescription: 'Коротко и по-человечески — это увидят все дома.',
    fieldTitle: 'Заголовок',
    fieldTitlePlaceholder: 'Необязательно',
    fieldBody: 'Текст',
    fieldBodyPlaceholder: 'Например: в субботу едем к бабушке, выезжаем в 10:00',
    publish: 'Повесить',
    published: 'Объявление на доске',
    pinned: 'Закреплено',
    pinnedUntil: (until: string) => `Закреплено до ${until}`,
    pin: 'Закрепить',
    unpin: 'Открепить',
    pinFor: 'Держать наверху',
    pinNone: 'не закреплять',
    pinDay: 'день',
    pinThreeDays: '3 дня',
    pinWeek: 'неделю',
    pinnedToast: 'Закрепили наверху',
    unpinnedToast: 'Убрали из закреплённых',
    delete: 'Снять с доски',
    /** Screen-reader name of the row's action sheet (§G5). */
    menuTitle: 'Действия с объявлением',
    deleteConfirmTitle: 'Снять объявление с доски?',
    deleteConfirmDescription: 'Оно исчезнет у всех. Вернуть не получится.',
    deleted: 'Сняли с доски',
    more: 'ещё',
    less: 'свернуть',
  },

  /* ------------------------------ comments ------------------------------- */
  comments: {
    toggle: 'Обсудить',
    count: (n: number) => `Обсуждение · ${String(n)}`,
    empty: 'Пока никто не ответил.',
    placeholder: 'Что скажете?',
    send: 'Ответить',
    sending: 'Отправляем…',
    deleteConfirmTitle: 'Удалить комментарий?',
    deleteConfirmDescription: 'Он пропадёт у всех участников.',
    deleted: 'Комментарий удалён',
    loadOlder: 'Что было раньше',
  },

  /* ----------------------------- reactions ------------------------------- */
  reactions: {
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
    send: 'Сказать спасибо',
    sent: 'Спасибо отправлено',
    /**
     * No count, deliberately. A per-person total that grows is a scoreboard
     * whatever the heading says (D5) — «Спасибо» is the one screen that exists
     * to make people feel good, and a smaller number beside a bigger one
     * teaches a child they are losing. The chip says *whether* somebody was
     * thanked this month, and nothing more. This applies to the accessible
     * name too: the chip's text **is** its label, so a screen reader hears the
     * same two words the sighted reader does.
     */
    receivedSome: 'спасибо есть',
    receivedNone: 'пока без спасибо',
    hint: 'Все, по алфавиту. Без счёта, без мест, без рейтингов.',
    nobodyYet: 'В этом месяце ещё никто никого не благодарил.',
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
    closes: 'Ждём ответы',
    closesNever: 'сколько нужно',
    closesDay: 'сутки',
    closesThreeDays: '3 дня',
    closesWeek: 'неделю',
    publish: 'Спросить',
    published: 'Опрос на доске',
    vote: 'Ответить',
    voting: 'Считаем…',
    /** The one line that makes band 2 a question and not a card. */
    needsYou: 'Вас спрашивают',
    answered: 'Вы ответили',
    closedBadge: 'Завершён',
    yourChoice: 'ваш выбор',
    closesIn: (when: string) => `до ${when}`,
    closedAlready: 'Опрос уже завершён — вот результат.',
    close: 'Завершить',
    closeConfirmTitle: 'Завершить опрос?',
    closeConfirmDescription: 'Голоса больше принимать не будем. Вернуть нельзя.',
    closedToast: 'Опрос завершён',
    /** Who has answered so far — discs, never a tally beside a name. */
    answeredBy: 'Ответили',
    noVotesYet: 'Пока никто не ответил',
    /** «Что решили» rows: the option that got the most answers. */
    decidedOn: (label: string) => `Решили: ${label}`,
    decidedTie: 'Без явного большинства',
    resultShare: (percent: number) => `${String(percent)}%`,
  },
} as const;

/** Emoji offered in the reaction picker. Deliberately short and friendly. */
export const REACTION_EMOJI = ['❤️', '\u{1F44D}', '\u{1F389}', '\u{1F602}', '\u{1F64F}'] as const;

/** Emoji offered when giving kudos. */
export const KUDOS_EMOJI = ['\u{1F44F}', '❤️', '\u{1F31F}', '\u{1F917}', '\u{1F4AA}'] as const;

/**
 * Who is behind a reaction chip.
 *
 * The summary contract carries `count` and "did I react", not the reactor ids,
 * so this says exactly as much as is actually known. When the backend starts
 * returning reactor ids, this is the one function that has to change.
 */
export function reactorLabel(summary: ReactionSummary): string {
  if (!summary.reacted) {
    return summary.count > 0 ? WALL_RU.reactions.others(summary.count) : WALL_RU.reactions.nobody;
  }
  const others = summary.count - 1;
  return others > 0 ? WALL_RU.reactions.youAndOthers(others) : WALL_RU.reactions.you;
}
