/**
 * Every user-facing string of the Настройки feature (D7 — Russian copy lives in
 * the feature's `locale.ts`; code and comments stay English).
 *
 * Two conventions this file must keep:
 *
 * 1. **No imports.** `PUSH_SW_RU` below is pulled into the *service worker*
 *    bundle by `src/sw.ts`, and a dependency-free module is what lets Rollup
 *    tree-shake `SETTINGS_RU` back out of it.
 * 2. **Never render a server `message`.** Anything that comes back from the API
 *    is translated through `shared/api/errors-ru.ts` by `ErrorCode`; the strings
 *    here are the ones we author.
 */

/* -------------------------------------------------------------------------- */
/* Service-worker copy                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The only strings the service worker can show.
 *
 * `showNotification()` is mandatory on **every** push (iOS revokes the
 * subscription after ~3 silent ones), so a payload we cannot parse must still
 * produce a real notification. These are that last resort.
 */
export const PUSH_SW_RU = {
  fallbackTitle: 'Семья',
  fallbackBody: 'Новое уведомление — откройте приложение.',
} as const;

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export const SETTINGS_RU = {
  hub: {
    title: 'Настройки',
    description: 'Профиль, уведомления и способы входа.',
    signOut: 'Выйти из аккаунта',
    signOutConfirmTitle: 'Выйти из приложения?',
    signOutConfirmText: 'Придётся войти заново — данные семьи останутся на месте.',
  },

  profile: {
    title: 'Профиль',
    description: 'Как вас видят остальные и в каком времени вы живёте.',

    displayNameLabel: 'Имя',
    displayNamePlaceholder: 'Аня',
    displayNameHint: 'Это имя видят все в семье.',

    avatarLabel: 'Ссылка на аватар',
    avatarPlaceholder: 'https://…',
    avatarHint: 'Необязательно. Пока загрузки файлов нет — подойдёт прямая ссылка на картинку.',
    avatarClear: 'Убрать аватар',

    birthDateLabel: 'День рождения',
    birthDateHint: 'Семья получит напоминание утром этого дня.',

    colorLabel: 'Цвет',
    colorHint: 'Им подсвечиваются ваши задачи и события в календаре.',

    timezoneLabel: 'Часовой пояс',
    timezoneHint: 'Напоминания и тихие часы считаются по вашему времени, а не по серверному.',
    timezoneInherit: (zone: string) => `Как у семьи (${zone})`,
    timezoneDetected: (zone: string) => `На этом устройстве сейчас ${zone}.`,
    timezoneUseDetected: 'Взять с устройства',

    roleLabel: 'Роль в семье',
    emailLabel: 'Почта',
    emailEmpty: 'Не указана — вход через Telegram почту не передаёт.',

    save: 'Сохранить',
    saving: 'Сохраняем…',
    saved: 'Профиль обновлён',
    nothingToSave: 'Изменений нет',
    loadFailed: 'Не удалось загрузить профиль',
  },

  accounts: {
    title: 'Способы входа',
    description: 'Через что можно войти в этот аккаунт.',

    linkedTitle: 'Привязанные',
    availableTitle: 'Можно добавить',
    linkedAt: (when: string) => `Привязан ${when}`,
    primaryBadge: 'Текущий вход',

    providerGoogle: 'Google',
    providerTelegram: 'Telegram',
    providerPassword: 'Почта и пароль',

    link: 'Привязать',
    linking: 'Открываем…',
    unlink: 'Отвязать',
    unlinking: 'Отвязываем…',

    unlinkConfirmTitle: (provider: string) => `Отвязать ${provider}?`,
    unlinkConfirmText: (provider: string) =>
      `Войти через ${provider} больше не получится. Остальные способы входа останутся.`,
    unlinked: 'Способ входа отвязан',
    linkFailed: 'Не удалось начать привязку',

    /**
     * The point of this screen: explain `LAST_LOGIN_METHOD` **before** the user
     * taps, not as an error afterwards.
     */
    lastMethodTitle: 'Это единственный способ войти',
    lastMethodText:
      'Если отвязать его, войти в аккаунт будет нечем — и вернуть доступ сможет только администратор семьи. Сначала добавьте второй способ входа, а потом отвязывайте этот.',
    lastMethodBadge: 'Нельзя отвязать',
    lastMethodAction: 'Сначала добавьте второй способ',

    addSecondHint:
      'Держите привязанными хотя бы два способа: если потеряется доступ к одному, останется второй.',

    neverAutoLinkHint:
      'Аккаунт с такой же почтой не привязывается автоматически — привязку всегда подтверждаете вы сами, отсюда.',

    empty: 'Пока ничего не привязано.',
    loadFailed: 'Не удалось загрузить способы входа',
  },

  notifications: {
    title: 'Уведомления',
    description: 'Что присылать, куда и когда молчать.',

    loadFailed: 'Не удалось загрузить настройки уведомлений',

    /* --- channels ---------------------------------------------------------- */

    matrixTitle: 'Что присылать',
    matrixHint: 'Выключенный тип не придёт никуда, даже в приложение.',
    columnType: 'Событие',
    enabledLabel: 'Присылать',

    channelUnavailablePush: 'Push выключен — включите уведомления на этом устройстве.',
    channelUnavailableTelegram: 'Telegram не привязан — добавьте его в «Способах входа».',

    save: 'Сохранить',
    saving: 'Сохраняем…',
    saved: 'Настройки сохранены',
    resetDefaults: 'Вернуть по умолчанию',

    /* --- quiet hours -------------------------------------------------------- */

    quietTitle: 'Тихие часы',
    quietDescription:
      'В это время телефон молчит. Уведомление не пропадёт — оно придёт, когда тишина закончится.',
    quietAdd: 'Добавить интервал',
    quietRemove: 'Убрать интервал',
    quietEmpty: 'Тихих часов нет — уведомления приходят в любое время суток.',
    quietFrom: 'С',
    quietTo: 'До',
    quietDay: 'Дни',
    quietEveryDay: 'Каждый день',
    quietMode: 'Что делать',
    quietOvernightHint: 'Интервал переходит через полночь — это нормально.',
    quietSameTimeError: 'Начало и конец не могут совпадать.',
    quietSaved: 'Тихие часы сохранены',
    quietWeekdays: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as readonly string[],

    /* --- devices ------------------------------------------------------------ */

    devicesTitle: 'Устройства',
    devicesDescription: 'Каждое устройство подписывается отдельно.',
    devicesEmpty: 'Ни одного устройства не подписано на push.',
    deviceCurrent: 'Это устройство',
    deviceStandalone: 'Установлено на экран «Домой»',
    deviceLastSeen: (when: string) => `Последняя доставка ${when}`,
    deviceNeverDelivered: 'Доставок ещё не было',
    deviceUnhealthy: 'Не отвечает — похоже, подписка умерла',
    deviceRemove: 'Удалить',
    deviceRemoveConfirmTitle: 'Удалить устройство?',
    deviceRemoveConfirmText: 'На него перестанут приходить уведомления. Подписаться можно заново.',
    deviceRemoved: 'Устройство удалено',

    /* --- test push ---------------------------------------------------------- */

    testTitle: 'Проверка',
    testDescription:
      'На iPhone это единственный способ убедиться, что уведомления действительно доходят.',
    testSend: 'Отправить тестовое уведомление',
    testSending: 'Отправляем…',
    testQueued: 'Отправили — уведомление должно прийти в течение минуты',
    testNoTargets: 'Отправлять некуда: ни одного подписанного устройства.',
    testFailedSome: 'Часть устройств не приняла уведомление — проверьте список ниже.',
    testResultOk: 'Принято',
    testResultFailed: 'Не принято',
    testHint:
      'Если уведомление не пришло за минуту — выключите и включите уведомления на этом устройстве заново.',
  },

  push: {
    sectionTitle: 'Уведомления на этом устройстве',

    /* --- states ------------------------------------------------------------- */

    statusOn: 'Включены',
    statusOff: 'Выключены',
    /** Not «в настройках телефона»: this same screen runs in Chrome on a desktop. */
    statusDenied: 'Запрещены в настройках устройства',
    statusUnsupported: 'Недоступны в этом браузере',
    statusNotInstalled: 'Нужно установить приложение',

    enable: 'Включить уведомления',
    enabling: 'Включаем…',
    disable: 'Выключить на этом устройстве',
    disabling: 'Выключаем…',
    enabled: 'Уведомления включены',
    disabled: 'Уведомления выключены на этом устройстве',
    enableFailed: 'Не удалось включить уведомления',

    /* --- the soft pre-prompt ------------------------------------------------ */

    /**
     * The OS prompt can be shown **once ever**. This dialog is the retryable one,
     * and it exists so that «Разрешить» is the only realistic answer to the
     * system prompt that follows.
     */
    promptTitle: 'Напоминать о делах?',
    promptText:
      'Уведомления приходят, когда вам поручили дело, приближается событие или кто-то ждёт ответа. Ночью телефон молчит — тихие часы настраиваются здесь же.',
    promptWarning:
      'Дальше телефон спросит разрешение. Это единственный раз, когда он спрашивает: если нажать «Не разрешать», вернуть уведомления можно будет только через настройки iPhone.',
    promptAccept: 'Разрешить',
    promptDecline: 'Не сейчас',

    /* --- denied recovery ---------------------------------------------------- */

    deniedTitle: 'Уведомления запрещены',
    deniedText:
      'Разрешение спрашивают один раз, и здесь его уже не переспросить — снять запрет можно только в настройках устройства.',
    deniedStepsTitle: 'Как вернуть на iPhone',
    deniedSteps: [
      'Откройте «Настройки» на телефоне',
      'Пролистайте вниз до приложения «Семья»',
      'Откройте «Уведомления» и включите «Допуск уведомлений»',
      'Вернитесь сюда и нажмите «Включить уведомления»',
    ] as readonly string[],
    deniedStepsAndroid:
      'На Android: «Настройки» → «Приложения» → «Семья» → «Уведомления». В браузере — значок замка слева от адреса.',
    /* Not «Я разрешил» — half the family would say «разрешила». */
    deniedRetry: 'Готово, проверить снова',

    /* --- the reconcile / re-enable card ------------------------------------- */

    /** iOS never fires `pushsubscriptionchange`; this card is the only repair. */
    reEnableTitle: 'Уведомления отключились — включить снова?',
    reEnableText:
      'Похоже, телефон отменил подписку — так бывает после переустановки приложения или долгого перерыва. Одно нажатие всё вернёт.',
    reEnableAction: 'Включить снова',

    /* --- install hint -------------------------------------------------------- */

    installTitle: 'Сначала установите приложение',
    installText:
      'На iPhone и iPad уведомления работают только у приложения, добавленного на экран «Домой». В обычной вкладке Safari браузер их просто не умеет — кнопки «Включить» здесь не будет, пока приложение не установлено.',
    installSteps: [
      'Нажмите «Поделиться» на панели Safari',
      'Выберите «На экран „Домой“»',
      'Запустите «Семью» с новой иконки и вернитесь сюда',
    ] as readonly string[],
    installSafariOnly:
      'Chrome, Firefox и Яндекс на iPhone добавлять на экран «Домой» не умеют — откройте адрес в Safari.',

    unsupportedText:
      'Этот браузер не поддерживает push-уведомления. Приложение будет работать, но напоминания придут только внутри него.',

    /* --- misc --------------------------------------------------------------- */

    deviceLabelHint: 'Устройство определится само — переименовать его можно в списке ниже.',
  },
} as const;
