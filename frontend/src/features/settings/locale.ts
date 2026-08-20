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

    /* Section labels. Three destinations in one undifferentiated list read as a
       placeholder; grouped under what they are *for*, they read as a screen. */
    groupAccount: 'Аккаунт',
    groupNotifications: 'Уведомления',
    groupApp: 'Приложение',

    /**
     * One line per destination, saying what is behind it.
     *
     * Keyed by route rather than by index: `SETTINGS_NAV` is filtered through
     * `useCan()`, so positions shift and a parallel array would silently pair
     * «Способы входа» with the profile's subtitle.
     */
    subtitles: {
      profile: 'Имя, аватар, день рождения и часовой пояс',
      notifications: 'Что присылать, куда и когда молчать',
      accounts: 'Google, Telegram и пароль',
    },

    /* The identity block at the top. */
    roleInFamily: (role: string, family: string) => `${role} · ${family}`,

    /*
     * The push row is an affordance, not a caption: every state leads somewhere.
     *
     * Its own title is «На этом устройстве» rather than the section's
     * «Уведомления на этом устройстве» — under a «УВЕДОМЛЕНИЯ» header, next to a
     * row already called «Уведомления», the long form put the word on screen
     * three times in four lines and truncated to «Уведомления на этом уст…» at
     * 390px.
     */
    pushRowTitle: 'На этом устройстве',
    pushEnableShort: 'Включить',
    pushFix: 'Настроить',
    pushOpen: 'Открыть',

    /* --- «Приложение» ------------------------------------------------------- */

    themeLabel: 'Оформление',
    themeHint: 'Тёмная тема бережёт глаза вечером.',

    /**
     * Short forms, for the segmented control only.
     *
     * `THEME_LABELS_RU.system` is «Как в системе», which is the right words in
     * the avatar menu and two characters too many in a third of a 390px row —
     * it truncated to «Как в си…» next to its own icon. The menu keeps the long
     * form; this control gets one that fits.
     */
    themeOptions: {
      light: 'Светлая',
      dark: 'Тёмная',
      system: 'Системная',
    },

    calendarFeedLabel: 'Календарь на телефоне',
    calendarFeedSubtitle: 'Семейные события в приложении «Календарь»',

    /** Support always starts with «а какая у вас версия?». */
    version: (version: string) => `Версия ${version}`,

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

    /**
     * Аватар.
     *
     * Тон «вы», как во всём приложении. Формулировки нарочно объясняют, что
     * происходит с фотографией: «уменьшим прямо здесь» снимает главный вопрос
     * человека с мобильным интернетом — не улетит ли в сеть снимок на 6 МБ.
     */
    avatarLabel: 'Фотография',
    avatarHint: 'JPEG, PNG или WebP. Мы обрежем и уменьшим фото прямо здесь, на вашем устройстве.',
    avatarAdd: 'Загрузить фото',
    avatarReplace: 'Заменить фото',
    avatarRemove: 'Убрать фото',
    avatarRemoving: 'Убираем…',
    avatarEmpty: 'Пока без фотографии — семья видит ваши инициалы.',
    avatarRemoved: 'Фотография убрана',
    avatarSaved: 'Фотография обновлена',
    /** Явное «слишком большой файл» вместо молчаливого отказа выбрать файл. */
    avatarTooLarge: 'Файл слишком большой. Выберите фотографию поменьше.',
    avatarNotAnImage: 'Не удалось открыть файл как изображение. Подойдут JPEG, PNG и WebP.',
    avatarProcessFailed: 'Не удалось подготовить фотографию. Попробуйте другой файл.',

    cropper: {
      title: 'Как обрезать фото',
      description: 'Двигайте фотографию и меняйте масштаб — в круг попадёт то, что видно.',
      surfaceLabel: 'Область обрезки фотографии',
      hint: 'Перетащите фотографию, чтобы выбрать кадр. Масштаб — колесом мыши, щипком или ползунком ниже.',
      zoomLabel: 'Масштаб фотографии',
      reset: 'Вернуть как было',
      cancel: 'Отмена',
      save: 'Сохранить',
      preparing: 'Готовим фото…',
      uploading: 'Загружаем…',
      previewLabel: 'Так это будет выглядеть',
    },

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
    /**
     * The card the shell raises by itself once, shortly after a first sign-in.
     * It spends nothing: its button opens the dialog below, and only *that*
     * button reaches the one-shot OS prompt.
     */
    offerTitle: 'Напоминать о делах?',
    offerText:
      'Приложение подскажет, когда вам поручили дело, приближается событие или кто-то ждёт ответа. Ночью телефон молчит.',
    offerAccept: 'Включить напоминания',
    offerLater: 'Не сейчас',
    offerDismissLabel: 'Скрыть предложение',

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
