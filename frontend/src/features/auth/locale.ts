/**
 * Every user-facing string of the auth feature (D7 — all UI copy is Russian and
 * lives in the feature's `locale.ts`; code and comments stay English).
 *
 * Tone rules that matter here more than anywhere else in the app:
 *  - the pending screen must read like "вы почти внутри", never like an error;
 *  - nothing on these screens may leak a server `message` — the API layer maps
 *    `ErrorCode` through `shared/api/errors-ru.ts` instead.
 */
export const AUTH_RU = {
  appName: 'Семья',

  login: {
    title: 'С возвращением',
    subtitle: 'Войдите, чтобы увидеть общие дела, календарь и покупки.',

    // The provider labels are also asserted by the shell smoke test — keep them.
    providerGoogle: 'Войти через Google',
    providerTelegram: 'Войти через Telegram',
    providersHint: 'Быстрее всего — через аккаунт, который у вас уже есть.',

    divider: 'или по почте',

    emailLabel: 'Почта',
    emailPlaceholder: 'anya@example.com',
    passwordLabel: 'Пароль',
    passwordPlaceholder: 'Ваш пароль',
    showPassword: 'Показать пароль',
    hidePassword: 'Скрыть пароль',

    submit: 'Войти',
    submitting: 'Входим…',

    noAccountQuestion: 'Ещё нет доступа к семье?',
    registerLink: 'Отправить заявку',

    approvalNote: 'Новый участник? Доступ подтверждает администратор семьи.',
  },

  register: {
    title: 'Заявка на вступление',
    subtitle: 'Расскажите, как вас зовут, и придумайте пароль.',

    /** The one sentence this screen exists for. */
    approvalBannerTitle: 'Доступ открывает администратор',
    approvalBannerText:
      'Заявка уйдёт на подтверждение — вы получите уведомление, когда её одобрят.',

    nameLabel: 'Как вас зовут',
    namePlaceholder: 'Аня',
    nameHint: 'Это имя увидят все в семье.',
    emailLabel: 'Почта',
    emailPlaceholder: 'anya@example.com',
    passwordLabel: 'Пароль',
    passwordPlaceholder: 'Не короче 12 символов',
    passwordHint: 'Минимум 12 символов, заглавная и строчная буквы и цифра.',

    submit: 'Отправить заявку',
    submitting: 'Отправляем…',

    haveAccountQuestion: 'Уже есть доступ?',
    loginLink: 'Войти',

    providersHint: 'Можно и без пароля — заявку примут и через Google или Telegram.',
  },

  status: {
    greeting: (name: string) => `Привет, ${name}!`,

    pendingTitle: 'Почти готово',
    pendingDescription:
      'Заявка отправлена — администратор семьи уже получил уведомление и скоро откроет доступ.',
    pendingHint:
      'Эту страницу можно закрыть: мы сообщим, как только заявку одобрят. Обычно это занимает несколько минут.',
    pendingSubmittedAt: (when: string) => `Заявка отправлена ${when}.`,
    pendingCheck: 'Проверить статус',
    pendingChecking: 'Проверяем…',
    pendingStillWaiting: 'Пока без изменений — заявка ещё на рассмотрении.',
    pendingApproved: 'Заявку одобрили! Можно входить.',

    rejectedTitle: 'Заявка отклонена',
    rejectedDescription: 'Администратор семьи не подтвердил доступ к этому пространству.',
    rejectedHint:
      'Если это недоразумение — попросите кого-нибудь из семьи отправить приглашение заново.',

    suspendedTitle: 'Доступ приостановлен',
    suspendedDescription: 'Администратор временно закрыл доступ к семье.',
    suspendedHint: 'Все данные на месте — доступ вернётся сразу после снятия ограничения.',

    reasonLabel: 'Причина',
    backToLogin: 'Вернуться ко входу',
    tryAnotherWay: 'Войти другим способом',
  },

  install: {
    cardTitle: 'Добавьте «Семью» на экран «Домой»',
    cardText:
      'Так приложение открывается в одно касание, а напоминания приходят на телефон — без установки уведомления на iPhone не работают.',
    cardAction: 'Как установить',
    cardInstall: 'Установить',
    cardLater: 'Позже',
    dismissLabel: 'Скрыть подсказку',

    sheetTitle: 'Установка на iPhone',
    sheetTitleIpad: 'Установка на iPad',
    sheetTitleDesktop: 'Установка приложения',
    sheetDescription: 'Три шага — и «Семья» будет открываться как обычное приложение.',

    stepShareIphone: 'Нажмите «Поделиться» на нижней панели Safari',
    stepShareIpad: 'Нажмите «Поделиться» на верхней панели Safari',
    stepAddToHome: 'Пролистайте список и выберите «На экран „Домой“»',
    stepConfirm: 'Нажмите «Добавить» в правом верхнем углу',
    stepDone: 'Готово — запускайте «Семью» с иконки на экране.',

    shareGlyphHint: 'Это та самая иконка — квадрат со стрелкой вверх.',

    safariOnlyTitle: 'Откройте страницу в Safari',
    safariOnlyText:
      'На iPhone и iPad добавить приложение на экран «Домой» умеет только Safari. Скопируйте адрес и откройте его в Safari — дальше всё как обычно.',
    copyLink: 'Скопировать адрес',
    copiedLink: 'Адрес скопирован',

    desktopText:
      'Нажмите значок установки в адресной строке браузера — или кнопку ниже, если она доступна.',

    close: 'Понятно',
  },

  errors: {
    /** Shown above the form; the text itself always comes from `errors-ru.ts`. */
    formTitle: 'Не удалось войти',
    registerFormTitle: 'Не удалось отправить заявку',
    statusUnavailable: 'Не удалось проверить статус заявки. Попробуйте чуть позже.',

    /**
     * Bare provider names, for sentences that talk *about* a provider.
     * `login.providerGoogle` is a button label («Войти через Google») and reads
     * wrong inside one.
     */
    providerNames: {
      google: 'Google',
      telegram: 'Telegram',
    },

    /**
     * A provider that is configured wrong is not a blip, and «попробуйте через
     * минуту» — the generic 503 copy — sends the user into a retry loop that
     * cannot succeed. This says what actually happened and what to do instead.
     *
     * The live example: the Telegram bot had no domain registered with
     * BotFather, so `oauth.telegram.org` answered every request with a bare
     * «Bot domain invalid» page. Nobody but the family admin can fix that.
     */
    providerUnavailableTitle: (provider: string) => `Вход через ${provider} сейчас недоступен`,
    providerUnavailableText: (provider: string) =>
      `Вход через ${provider} не настроен на сервере. Войдите другим способом — или попросите администратора семьи проверить настройки.`,
  },
} as const;
