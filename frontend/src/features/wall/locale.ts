import { LIKE_EMOJI, type PublicUser, type ReactionSummary } from '@family/shared';

/**
 * Russian strings for Стена.
 *
 * Tone rules for anything added here (they are the whole point of this
 * section): warm, «вы», never corporate, never comparative. Стена is the one
 * screen people open because they want to, not because something is due.
 *
 * ## The vocabulary is still a *board's*, even though the shape is a feed's
 *
 * §D7 turned the board into one continuous stream, and D13 records why. What
 * it did **not** change is the language: «Лента», «Опубликовать» and
 * «Отправить» are the words of a messenger, and a stream with a message box at
 * the bottom is a chat. The family already has one. So the nouns here stay the
 * nouns of the note surface by the front door — «доска», «повесить»,
 * «закреплено» — and the one verb that starts everything is «написать», which
 * is what you do with a note, not with a message.
 *
 * «Показать ещё» is the one word from that old list the redesign takes back:
 * §D7.9 gives the feed a bounded auto-load that stops and *asks*, and asking
 * needs a verb. It is the opposite of infinite scroll, not an instance of it.
 *
 * ## No section headers live here any more
 *
 * The board's «Решаем вместе» / «Закреплено» / «На доске» labels are gone as
 * headings (§D7.0). What is left of them are **eyebrow lines a card says about
 * itself** — «Вас спрашивают», «Открытый опрос», «Закреплено до 25 августа» —
 * because colour is never the only signal (§B4) and a head card has to be
 * legible in greyscale and to a screen reader taking the cards in order.
 */
export const WALL_RU = {
  title: 'Стена',
  description: 'Доска дома: объявления, общие решения и спасибо.',

  /* --------------------------------- feed -------------------------------- */
  feed: {
    /** The compose row's own text. It is a button, never a field (§D7.5). */
    composePlaceholder: 'Что повесить на доску?',
    /** A reader who may write: the row *is* the invitation, so this is a line, not a state. */
    emptyInvite: 'Повесьте первую записку — её увидят все дома.',
    /**
     * A reader who may not write (a `guest`). Not an `EmptyState`: §E made
     * `action` required, and there is no honest action to offer somebody whose
     * every write would 403.
     */
    emptyReadOnly: 'Когда кто-нибудь что-то напишет, это появится здесь.',
    /** The feed ends, visibly, and this is what it says (§D7.9). */
    end: 'Это всё, что было',
    /** After four auto-loaded pages the feed stops and asks. */
    more: 'Показать ещё',
    loadingMore: 'Смотрим…',
    /** New items arrived while the reader was scrolled down. No count, ever. */
    newItems: 'Новое на стене',
    systemAuthor: 'Семейный бот',
    unknownAuthor: 'Участник',
    loadError: 'Не удалось открыть стену',
    /** A later page failed. Quiet, never `role="alert"` (§D7.12). */
    moreError: 'Не получилось загрузить дальше',
    /** The activity digest's expander — the items are already on the page. */
    andMore: (n: number) => `и ещё ${String(n)}`,
    collapse: 'свернуть',
  },

  /* ------------------------------- compose ------------------------------- */
  /**
   * The one door (§D7.5). Three kinds of note, one button, one place — which
   * is what lets every panel on this screen be stateless and therefore live
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
    /**
     * The one count Стена is allowed to draw (§D7.2, §D7.8): it describes the
     * object you are about to open, it is not attached to a person, and
     * nothing sorts by it. Without it every card looks identical and a live
     * conversation is invisible.
     */
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
    /** Somebody reacted but the roster has not resolved their name. */
    someone: 'кто-то из своих',
    /**
     * The accessible name of the **always-drawn** ❤️ chip while nobody has used
     * it (§D7.7a).
     *
     * Once somebody has, the name becomes `reactorLabel()`'s «❤️ — Мама, Лиза»
     * — the emoji and the people, which is exactly what is drawn. This string
     * covers the other case, because a screen reader given a bare «❤️» as an
     * accessible name announces "красное сердце", which is a description of a
     * glyph rather than of a control.
     *
     * There is no digit in either form and there must never be one. Not here,
     * not in a `title`, not on hover.
     */
    like: 'Нравится',
  },

  /* ------------------------------- media --------------------------------- */
  /**
   * Вложения (§D7.14).
   *
   * Two rules govern everything in this block.
   *
   * **Every refusal names the way out.** «Снимите покороче», «Выберите из
   * галереи», «Попробуйте другое». A refusal without a next step is where a
   * family member stops using a feature — and on a board where the alternative
   * is a paper note on the fridge, they stop for good.
   *
   * **Every number in a sentence comes from the contract**, interpolated by the
   * caller from `MEDIA_LIMITS`. A client that says 8 MB while the server
   * enforces 10 is the classic version of this bug and it is free to avoid.
   */
  media: {
    /** The composer's attach control. Not a fourth door — it lives *inside* a composer. */
    add: 'Добавить фото или видео',
    addShort: 'Фото или видео',
    /** The 📎 on the comment composer. */
    attach: 'Прикрепить фото',
    remove: 'Убрать',
    retry: 'Ещё раз',
    uploading: 'Загружаем…',
    /**
     * The sheet's footer while a tile is in flight. «Повесить» is disabled, and
     * the footer says why in words rather than presenting a dead button.
     */
    uploadingFooter: 'Загружаем фото…',
    uploadFailed: 'Не получилось загрузить. Попробуйте ещё раз.',
    /** §D7.14.7 — attaching needs the network; the note itself does not. */
    offline: 'Фото можно добавить, когда появится интернет.',

    /* --- refusals, all answered before a byte moves ----------------------- */
    /** Four is `MAX_PER_POST`: what the grid holds without a «+2» tile (§D7.14.2). */
    tooMany: 'Больше четырёх не поместится.',
    /** One per comment is the line between a reply and a post (§D7.8b). */
    onlyOne: 'К одному сообщению можно приложить одно вложение.',
    mixedKinds: 'В одной записке — либо фото, либо видео, либо запись голоса.',
    tooHeavy: (kind: 'image' | 'video' | 'audio', limit: string): string =>
      kind === 'image'
        ? `Фото тяжелее ${limit}. Выберите другое или уменьшите его.`
        : kind === 'video'
          ? `Это видео тяжелее ${limit}. Выберите его из галереи — так оно станет легче.`
          : `Запись тяжелее ${limit}. Выберите другую.`,
    tooLong: (kind: 'video' | 'audio', limit: string): string =>
      kind === 'video'
        ? `Видео длиннее, чем ${limit}. Снимите покороче — так его посмотрят все, даже бабушка.`
        : `Запись длиннее, чем ${limit}. Скажите главное — так её точно дослушают.`,
    cannotOpenPhoto: 'Не получилось открыть это фото. Попробуйте другое.',

    /* --- playback --------------------------------------------------------- */
    play: 'Смотреть',
    playAudio: 'Слушать',
    pause: 'Пауза',
    /** The bytes would not come. Quiet, in place of the box — never a toast. */
    unavailable: 'Вложение не открылось',

    /* --- the viewer ------------------------------------------------------- */
    open: 'Открыть во весь экран',
    close: 'Закрыть',
    previous: 'Предыдущее фото',
    next: 'Следующее фото',

    /**
     * Accessible names, built from what we know (§D7.14.8).
     *
     * Never left empty and never «изображение» — which is what a screen reader
     * announces on its own anyway. `alt=""` means *decorative*, and a photo that
     * is the content of a post is not decorative.
     *
     * The duration in `videoFrom` and `audioFrom` is **the one number allowed
     * into an `aria-label` anywhere on this screen** (§D7.7b). It passes for
     * the same reason the pill does: a clip's length is not sayable any other
     * way, it is not attached to a person, and nothing sorts by it.
     *
     * There is no `alt` on the wire — see the note in `MediaBlock.tsx` — so
     * these are the whole of the accessible layer today.
     *
     * ## «— Мама», not «от Мамы», and the reason is grammar
     *
     * §D7.14.8 writes «Фото от Мамы», «Видео от Павла». Both are genitive, and
     * a display name is a free-text field: producing the genitive of an
     * arbitrary Russian name needs the fleeting-vowel rule (Павел → **Павла**,
     * not «Павела»), the velar rule (Бабушка → Бабушки, not «Бабушкы») and a
     * judgement about indeclinables. A naive `+а` gets the family's own names
     * wrong, and a screen reader saying «Фото от Павела» is worse than one
     * saying nothing clever at all.
     *
     * So the name uses the **em-dash pattern this screen already speaks** —
     * `reactorLabel()` produces «❤️ — Мама, Лиза» — which needs no case at all
     * and reads consistently across the whole foot line. Deliberate deviation
     * from the design's wording; the meaning is identical.
     */
    photoFrom: (author: string): string => `Фото — ${author}`,
    photoFromNumbered: (author: string, index: number, total: number): string =>
      `Фото ${String(index)} из ${String(total)} — ${author}`,
    videoFrom: (author: string, duration: string | null): string =>
      duration ? `Видео — ${author}, ${duration}` : `Видео — ${author}`,
    audioFrom: (author: string, duration: string | null): string =>
      duration ? `Голосовая запись — ${author}, ${duration}` : `Голосовая запись — ${author}`,
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
    /** The card's eyebrow. Verb-free on purpose — see `KudosCard`. */
    cardEyebrow: 'Спасибо',
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
    /** The eyebrow on the one card that takes the attention wash (§D7.4). */
    needsYou: 'Вас спрашивают',
    /** The eyebrow on every other open poll in the head. */
    openEyebrow: 'Открытый опрос',
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
    decidedLabel: 'Что решили',
    decidedOn: (label: string) => `Решили: ${label}`,
    decidedTie: 'Без явного большинства',
    resultShare: (percent: number) => `${String(percent)}%`,
  },

  /* -------------------------- «Очистить доску» --------------------------- */
  /**
   * A horizon, not a delete (§D7.11). The dialog names what happens **and what
   * stays**, and it carries no row count: «Уберём 247 записей» makes the action
   * feel bigger or smaller than it is, and it is not a number the reader can
   * act on.
   */
  clear: {
    action: 'Очистить доску',
    /** The app bar's `⋯`, for a screen reader. */
    menuAria: 'Ещё действия со стеной',
    confirmTitle: 'Очистить доску?',
    confirmDescription:
      'Со стены исчезнет всё, что на ней сейчас, — у всех. Открытые опросы останутся: на них ещё никто не ответил. Ничего не удаляется навсегда.',
    confirmLabel: 'Очистить',
    done: 'Доска очищена',
    undo: 'Вернуть',
    restored: 'Вернули как было',
  },
} as const;

/**
 * Emoji offered in the reaction picker. Deliberately short and friendly.
 *
 * **The first entry is load-bearing rather than incidental:** `REACTION_EMOJI[0]`
 * *is* the like (§D7.7a), and the contract's `LIKE_EMOJI` is the value the
 * server, a future digest and any future notification rule agree on. The
 * `satisfies` below is what makes a reorder fail at compile time instead of
 * silently drawing a promoted heart that toggles a different row from the one
 * the picker's ❤️ toggles.
 *
 * Note the code points: `❤️` is `U+2764 U+FE0F`. A bare `U+2764` would be a
 * different reaction as far as the database is concerned.
 */
export const REACTION_EMOJI = [
  LIKE_EMOJI,
  '\u{1F44D}',
  '\u{1F389}',
  '\u{1F602}',
  '\u{1F64F}',
] as const satisfies readonly [typeof LIKE_EMOJI, ...string[]];

/** Emoji offered when giving kudos. */
export const KUDOS_EMOJI = ['\u{1F44F}', '❤️', '\u{1F31F}', '\u{1F917}', '\u{1F4AA}'] as const;

/**
 * The accessible name of a reaction chip: **exactly what is drawn**.
 *
 * A reaction renders as its emoji plus the discs of the people who used it
 * (§D7.7), so the name is «❤️ — Мама, Лиза» and there is no digit in it. That
 * is not a stylistic preference: a screen-reader-only count is precisely how
 * the scoreboard crept back last time — a load bar on Семья read «40 % (своя
 * доля 33 %)» aloud while drawing no numbers at all.
 *
 * `userIds` arrived with the contract (§D7.13 gap 4), so this now says who.
 * When a name is missing from the roster the chip says «кто-то из своих»
 * rather than falling back to a quantity.
 */
export function reactorLabel(
  summary: ReactionSummary,
  nameOf: (id: string) => string | undefined,
): string {
  const names = summary.userIds.map((id) => nameOf(id) ?? WALL_RU.reactions.someone);
  if (names.length === 0) return summary.emoji;
  return `${summary.emoji} — ${names.join(', ')}`;
}

/** The reactors of one chip, as the shape `MemberDiscGroup` wants. */
export function reactorMembers(
  summary: ReactionSummary,
  roster: { byId: ReadonlyMap<string, PublicUser>; nameOf: (id: string) => string },
): { id: string; displayName: string; avatarUrl: string | null }[] {
  return summary.userIds.map((id) => ({
    id,
    displayName: roster.nameOf(id),
    avatarUrl: roster.byId.get(id)?.avatarUrl ?? null,
  }));
}
