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
    /** Shown on `/settings` when the worker is stuck: routes to the diagnostics. */
    pushRowStalled: 'Фоновая служба не запустилась',
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
     * A provider the server cannot start a flow for is misconfigured, not busy.
     * The generic 503 copy («попробуйте через минуту») would send the user into
     * a retry loop that cannot succeed — Telegram answering «Bot domain invalid»
     * because the bot has no BotFather domain is exactly this case, and only the
     * family admin can fix it.
     */
    linkNotConfigured: (provider: string) => `${provider} пока нельзя привязать`,
    linkNotConfiguredHint:
      'Этот способ входа не настроен на сервере. Попросите администратора семьи проверить настройки.',

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

    /* --- coming back from the provider ------------------------------------- */

    /**
     * `GET /api/auth/:provider/callback` is a top-level navigation, so it can
     * never answer with an API error body — it redirects back here instead, and
     * these are the sentences that replace the JSON envelope the user used to
     * see in their address bar.
     *
     * The `?oauth=replayed` case is the one that matters. The callback fired
     * twice for one authorization, the first one did the work and the second
     * found the state already spent; the server cannot tell that apart from a
     * state that never existed, so it claims nothing at all. **This screen can**,
     * because the list of linked providers is right underneath — so the copy is
     * chosen from what the list actually says, not from what we hope happened.
     */
    replayedLinked: (provider: string) => `${provider} привязан`,
    replayedLinkedText:
      'Возвращаться сюда ещё раз не нужно — привязка уже сохранена, она в списке ниже.',
    replayedUnknownTitle: 'Эта ссылка привязки уже использована',
    replayedUnknownText:
      'Ссылка на привязку действует один раз. В списке ниже — то, что привязано сейчас; если нужного способа в нём нет, начните привязку заново.',

    /** Any real failure on the way back: the code carries the Russian sentence. */
    callbackFailedTitle: (provider: string) => `Не удалось привязать ${provider}`,
    callbackFailedTitleGeneric: 'Не удалось завершить привязку',
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

    /**
     * Shown next to a **live** enable button, not instead of one.
     *
     * The point of the sentence is that pressing it is still the right move: a
     * tap that fails produces WebKit's own error, which is diagnosable, whereas
     * the disabled button it replaced produced nothing at all.
     */
    startingTitle: 'Фоновая служба ещё запускается',
    startingText:
      'Так бывает на первом запуске после установки. Нажать «Включить уведомления» можно уже сейчас — если телефон ответит, что рано, мы покажем его ответ дословно.',
    stalledTitle: 'Фоновая служба не запустилась',
    stalledText:
      'Она нужна для уведомлений, и на этом устройстве она не поднялась — ждать дальше смысла нет. Нажмите «Включить уведомления»: телефон назовёт причину, и она попадёт в «Диагностику уведомлений» ниже. Оттуда одним нажатием копируется отчёт, который нам и нужен.',
    stalledDiagnostics: 'Открыть диагностику',

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
    /* Same path as `diagnostics.resetSteps` — one remedy, one wording. iOS
       lists a web app under «Уведомления», next to ordinary apps, once the
       prompt has been answered at least once. */
    deniedSteps: [
      'Откройте «Настройки» на телефоне',
      'Откройте «Уведомления»',
      'Пролистайте список до «Семья»',
      'Включите «Разрешить уведомления»',
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

    /* --- one message per failure, naming cause and remedy -------------------- */

    /**
     * Keyed by `EnableOutcome`. The generic «Не удалось включить уведомления»
     * is what produced a support thread nobody could close: it is true of every
     * failure and actionable for none of them. Every entry here names the thing
     * that went wrong **and** the next thing to do about it, because the person
     * reading it is standing in front of the broken phone and we are not.
     *
     * `enableFailed` above survives only as a toast title.
     */
    failureTitle: {
      denied: 'Телефон запретил уведомления',
      'blocked-in-settings': 'Уведомления выключены в настройках iPhone',
      dismissed: 'Разрешение не выдано',
      unsupported: 'Этот браузер не умеет уведомления',
      'needs-install': 'Сначала установите приложение',
      misconfigured: 'Приложению не выдан ключ уведомлений',
      'not-ready': 'Фоновая служба приложения не запустилась',
      'gesture-lost': 'Телефон не засчитал нажатие',
      'subscribe-rejected': 'Телефон отказался оформить подписку',
      'server-rejected': 'Сервер не принял подписку',
      failed: 'Не удалось включить уведомления',
    },

    failureHint: {
      denied:
        'Разрешение спрашивают один раз, и переспросить его приложение не может. Снимите запрет в настройках телефона, потом вернитесь сюда и нажмите «Включить уведомления».',
      /**
       * WebKit bug 320551. The most useful sentence in this whole file: iOS
       * reports «ещё не спрашивали» in this state, so the app looks willing and
       * the phone silently refuses. Naming the toggle is the entire remedy.
       */
      'blocked-in-settings':
        'Телефон говорит, что разрешение ещё не спрашивали, но окно так и не появилось. Так бывает, когда уведомления для «Семьи» выключены в настройках iPhone: «Настройки» → «Уведомления» → «Семья» → «Разрешить уведомления». Включите — и нажмите здесь ещё раз.',
      dismissed:
        'Запрос закрыли, ничего не выбрав. Ничего не сломалось — нажмите «Включить уведомления» ещё раз.',
      unsupported:
        'Откройте приложение в Safari на iPhone или в Chrome на компьютере — здесь уведомлений просто нет.',
      'needs-install':
        'На iPhone уведомления работают только у приложения, добавленного на экран «Домой»: «Поделиться» → «На экран „Домой“», и не выключайте «Открыть как веб‑приложение». Потом запустите «Семью» с новой иконки.',
      misconfigured:
        'Это сбой на нашей стороне, а не на телефоне: сервер не отдал ключ для подписки. Откройте «Диагностику уведомлений» ниже и пришлите текст — чинить это здесь нечего.',
      /**
       * The message this replaced told the user to wait a few seconds and, if
       * that failed, to close and reopen the app. The owner did both, and then
       * deleted and re-added the icon, and the state did not change — because
       * it never was a timing problem. `navigator.serviceWorker.ready` has no
       * rejection path: a worker that cannot install leaves it pending for
       * ever, and "подождите ещё" is then advice that can never come true.
       *
       * So this says what is actually known, and sends the reader to the one
       * screen that can say *why* — never back round the loop they have
       * already walked.
       */
      'not-ready':
        'Уведомления работают через фоновую службу приложения, и на этом устройстве она не запустилась. Это не «ещё не успела» — перезапуск приложения и переустановка иконки здесь не помогают. Откройте «Диагностику уведомлений» ниже, нажмите «Скопировать» и пришлите нам текст: в нём видно, на каком шаге служба встала. Пока служба не поднимется, подписка невозможна — но проверить стоит две вещи: есть ли на телефоне свободное место и открыто ли приложение по обычной сети (не через режим экономии данных).',
      'gesture-lost':
        'Между нажатием и запросом прошло слишком много времени — у телефона на это пять секунд. Нажмите «Включить уведомления» ещё раз и не переключайтесь на другие приложения.',
      /**
       * Leads with the diagnostics, not with a restart. A restart is a
       * reasonable thing to try *once*; it is not a thing to keep telling
       * somebody who has already tried it, and this app has burnt that trust
       * once already with the `not-ready` copy above.
       */
      'subscribe-rejected':
        'Телефон получил запрос и отклонил его. Точная причина — в «Диагностике уведомлений» ниже: откройте её, нажмите «Скопировать» и пришлите нам текст. Если это первая попытка, имеет смысл нажать «Включить уведомления» ещё раз одним касанием — но если сообщение повторяется, дело не в касании и повторять его незачем.',
      'server-rejected':
        'Телефон подписку оформил, а наш сервер её не принял. Проверьте интернет и попробуйте ещё раз; код ошибки записан в «Диагностике уведомлений» ниже.',
      failed:
        'Точная причина записана в «Диагностике уведомлений» ниже — откройте её, скопируйте текст и пришлите нам.',
    },
  },

  /* ------------------------------------------------------------------------ */
  /* Диагностика — the instrument that lives on the user's device              */
  /* ------------------------------------------------------------------------ */

  /**
   * Copy for the one screen that exists because we cannot reproduce the bug.
   *
   * Every label is a plain question a non-technical person can answer by
   * looking at it, in the order the platform enforces the preconditions. The
   * *values* stay technical on purpose — `NotAllowedError`, an HTTP status, a
   * service-worker scope — because they are meant to be pasted to somebody who
   * can read them.
   */
  diagnostics: {
    title: 'Диагностика уведомлений',
    description: 'Что именно мешает уведомлениям на этом устройстве.',
    show: 'Показать диагностику',
    hide: 'Скрыть диагностику',
    refresh: 'Проверить заново',
    checking: 'Проверяем…',
    copy: 'Скопировать',
    copied: 'Скопировано — можно вставить в переписку',
    copyFailed: 'Скопировать не вышло — выделите текст ниже вручную',

    /** The one-line answer at the top. Everything below is supporting detail. */
    verdictTitle: {
      ok: 'Всё в порядке',
      'not-installed': 'Приложение открыто не как приложение',
      'ios-non-safari': 'Открыто не в Safari',
      unsupported: 'Браузер не поддерживает уведомления',
      denied: 'Уведомления запрещены в настройках телефона',
      'blocked-in-settings': 'Уведомления выключены в настройках iPhone',
      'not-asked': 'Разрешение ещё не запрашивали',
      'no-service-worker': 'Фоновая служба приложения не зарегистрирована',
      'sw-not-active': 'Фоновая служба ещё запускается',
      'sw-stalled': 'Фоновая служба не запускается',
      'no-subscription': 'Подписка на этом устройстве не оформлена',
      'server-unaware': 'Сервер не знает про это устройство',
      misconfigured: 'Приложению не выдан ключ уведомлений',
      unknown: 'Не удалось определить причину',
    },

    verdictHint: {
      ok: 'Устройство подписано, и сервер о нём знает. Если уведомления всё равно не приходят — отправьте тестовое уведомление выше, а потом проверьте «Фокус», «Не беспокоить» и «Сводку по расписанию» на телефоне.',
      /**
       * iOS 26 added an «Открыть как веб‑приложение» switch to the share sheet.
       * Left off, the icon is a bookmark: it looks installed, opens in Safari,
       * and can never receive a push. Naming it is the difference between a
       * fixable problem and a mystery.
       */
      'not-installed':
        'Иконка на экране «Домой» должна открываться как приложение, а не как закладка в Safari. Удалите иконку, добавьте заново через Safari → «Поделиться» → «На экран „Домой“» и не выключайте переключатель «Открыть как веб‑приложение». Потом запустите «Семью» с новой иконки.',
      'ios-non-safari':
        'Chrome, Firefox и Яндекс на iPhone не умеют добавлять приложение на экран «Домой». Откройте этот адрес в Safari.',
      unsupported:
        'Приложение будет работать, но напоминания придут только внутри него. Уведомления есть в Safari на iPhone (после установки) и в Chrome на компьютере.',
      denied:
        'Приложение не может переспросить разрешение — его снимают только в настройках телефона.',
      /**
       * The 320551 state. iOS reports «ещё не спрашивали» while refusing to
       * ask, so the app looks willing and nothing happens. This is the most
       * likely single cause for anyone who has tried and failed before.
       */
      'blocked-in-settings':
        'Телефон отвечает «разрешение ещё не спрашивали», но окно с вопросом так и не появляется. Так ведёт себя iPhone, когда уведомления для «Семьи» уже выключены в его настройках. Включите их по шагам ниже — из приложения это не чинится.',
      'not-asked':
        'Нажмите «Включить уведомления» выше — телефон должен показать окно с вопросом. Если окно не появилось, а надпись не изменилась, значит уведомления выключены в настройках iPhone: смотрите шаги ниже.',
      /**
       * No «закройте и откройте заново» here, and none in `sw-stalled` either.
       * That was the advice the owner had already exhausted twice over before
       * anybody looked at the code, and repeating it is how a support thread
       * becomes unclosable.
       */
      'no-service-worker':
        'Браузер вообще не зарегистрировал фоновую службу для этого адреса. Чаще всего это значит, что приложение открыто не с иконки на экране «Домой», либо сеть подменяет содержимое страницы (корпоративный Wi‑Fi, VPN, режим экономии трафика). Попробуйте другую сеть, а потом скопируйте отчёт кнопкой ниже и пришлите нам — в строке «ошибка регистрации» будет причина.',
      'sw-not-active':
        'Так бывает на первом запуске после установки: служба ставится и через несколько секунд оживает сама. Нажмите «Проверить заново». Кнопку «Включить уведомления» это не блокирует — её можно нажать и сейчас, и телефон сам скажет, если ещё рано.',
      /**
       * The state the gate used to hide behind «подождите несколько секунд».
       * `serviceWorker.ready` never settles when a worker cannot install, so
       * the wait it asked for had no end.
       */
      'sw-stalled':
        'Служба зарегистрирована, но так и не стала активной — заметно дольше, чем это занимает обычно. Ждать дальше смысла нет: в таком состоянии она сама не поднимется. Скопируйте отчёт кнопкой ниже и пришлите нам — строки «installing/waiting/active» и «ошибка регистрации» показывают, где именно она встала. Заодно проверьте свободное место на телефоне: службе нужно закэшировать приложение целиком, и на переполненном диске установка падает молча.',
      'no-subscription':
        'Разрешение есть, но подписка не создана. Нажмите «Включить уведомления» выше — нужно живое касание, само это не починится.',
      'server-unaware':
        'Телефон подписан, но на сервере этого устройства нет. Выключите и снова включите уведомления на этом устройстве.',
      misconfigured:
        'Сбой на нашей стороне: сервер не отдал ключ для подписки. Скопируйте отчёт и пришлите нам.',
      unknown:
        'Скопируйте отчёт кнопкой ниже и пришлите нам — в нём есть всё, что нужно, чтобы разобраться.',
    },

    /* --- row labels --------------------------------------------------------- */

    rows: {
      standalone: 'Запущено как приложение',
      displayMode: 'Режим отображения',
      notificationApi: 'Notification есть в браузере',
      pushManagerApi: 'PushManager есть в браузере',
      serviceWorkerApi: 'Service Worker есть в браузере',
      permission: 'Разрешение на уведомления',
      lastAttempt: 'Чем кончилась последняя попытка',
      serviceWorker: 'Фоновая служба (service worker)',
      serviceWorkerScope: 'Область службы',
      serviceWorkerSlots: 'Ставится / ждёт / работает',
      serviceWorkerActiveState: 'Состояние активной службы',
      serviceWorkerReadyResolved: 'serviceWorker.ready сработал',
      serviceWorkerWaited: 'Ждём активную службу',
      serviceWorkerRegistrationError: 'Ошибка регистрации службы',
      /**
       * Kept, and deliberately marked as neutral wherever it is rendered: on
       * the first launch after an install this is `нет` on a perfectly healthy
       * device. It is here to be *ruled out*, not to be acted on.
       */
      serviceWorkerControlling: 'Служба управляет страницей (controller)',
      registrationPushManager: 'pushManager у службы',
      subscription: 'Подписка в браузере',
      subscriptionOrigin: 'Служба доставки',
      subscriptionFingerprint: 'Отпечаток подписки',
      serverKnows: 'Сервер знает это устройство',
      serverDeviceCount: 'Устройств на сервере',
      vapidKey: 'Ключ для подписки (VAPID)',
      online: 'Сеть',
      timezone: 'Часовой пояс',
      appVersion: 'Версия приложения',
      userAgent: 'Браузер (User-Agent)',
    },

    /* --- values ------------------------------------------------------------- */

    yes: 'да',
    no: 'нет',
    unknown: 'не удалось проверить',
    none: '—',
    online: 'онлайн',
    offline: 'офлайн',
    keyPresent: 'есть',
    keyMissing: 'нет',

    permissionValue: {
      granted: 'разрешено',
      denied: 'запрещено',
      default: 'ещё не спрашивали',
      unsupported: 'недоступно в этом браузере',
    },

    /**
     * Shown under the permission row whenever it reads `default` on iOS.
     *
     * Without it that row is actively misleading: iOS reports the same value
     * for "we have never asked" and for "you turned it off in Settings and I
     * will never ask again" (WebKit bug 320551). A reader who trusts the row
     * concludes the app has simply not got round to asking.
     */
    permissionDefaultCaveat:
      'Осторожно: iPhone показывает «ещё не спрашивали» и тогда, когда уведомления для «Семьи» уже выключены в его настройках. Изнутри приложения эти два случая неразличимы. Если окно с вопросом не появляется — считайте, что дело в настройках телефона.',

    lastAttemptNone: 'в этом сеансе не пробовали',
    lastAttemptValue: {
      enabled: 'подписка оформлена',
      denied: 'пользователь запретил',
      'blocked-in-settings': 'телефон не показал окно (выключено в настройках)',
      dismissed: 'окно закрыли без ответа',
      unsupported: 'браузер не поддерживает',
      'needs-install': 'приложение не установлено',
      misconfigured: 'нет ключа для подписки',
      'not-ready': 'фоновая служба ещё не активна',
      'gesture-lost': 'нажатие не засчитано',
      'subscribe-rejected': 'телефон отклонил подписку',
      'server-rejected': 'сервер отклонил подписку',
      failed: 'ошибка без объяснения',
    },

    swValue: {
      none: 'не зарегистрирована',
      installing: 'устанавливается',
      waiting: 'ждёт обновления',
      active: 'работает',
      unknown: 'не удалось проверить',
    },

    readinessValue: {
      unsupported: 'push недоступен',
      starting: 'запускается',
      stalled: 'застряла',
      ready: 'готова',
    },

    /**
     * Under the `controller` row, because a reader who sees «нет» there will
     * otherwise conclude that is the fault. It is not, and a gate built on that
     * assumption is what produced the bug this screen had to explain.
     */
    controllingCaveat:
      'Строка выше почти всегда «нет» на первом запуске после установки — и это нормально: подписке нужна активная служба, а не управление страницей. Смотрите на строку «Ставится / ждёт / работает».',

    waitedValue: (ms: number) => `${String(Math.round(ms / 100) / 10)} с`,

    /* --- the verbatim error ------------------------------------------------- */

    /**
     * Shown untranslated, and labelled as such, so nobody "helpfully" rewrites
     * `NotAllowedError` into «что-то пошло не так» on the way to us.
     */
    lastErrorTitle: 'Последняя ошибка, дословно',
    lastErrorNone: 'Ошибок при включении не было.',
    lastErrorStage: {
      permission: 'на шаге разрешения',
      registration: 'на шаге фоновой службы',
      subscribe: 'на шаге подписки',
      server: 'на шаге отправки на сервер',
      unsubscribe: 'на шаге отключения',
    },
    lastErrorAt: (at: string) => `Когда: ${at}`,
    lastErrorHttp: (status: number, code?: string) =>
      code ? `HTTP ${String(status)} · ${code}` : `HTTP ${String(status)}`,

    /* --- the iOS reset path, spelled out ------------------------------------ */

    /**
     * The single most useful thing on this screen when the answer is `denied`.
     * iOS never re-asks, and «включите в настройках» without the path is how a
     * family member gives up.
     */
    resetTitle: 'Как включить уведомления в настройках iPhone',
    resetSteps: [
      'Откройте «Настройки» на iPhone',
      'Откройте «Уведомления»',
      'Пролистайте список до «Семья» — приложение стоит там же, где обычные приложения',
      'Включите «Разрешить уведомления»',
      'Заодно проверьте, что включены «Экран блокировки», «Центр уведомлений» и «Баннеры»',
      'Вернитесь в приложение и нажмите «Включить уведомления»',
    ] as readonly string[],
    /**
     * A genuinely useful diagnostic the user can perform with their eyes: iOS
     * lists a web app under Уведомления **only after** the permission prompt
     * has been answered at least once. Its absence therefore distinguishes
     * "never asked" from "asked and then revoked" — the two states
     * `Notification.permission === 'default'` cannot tell apart.
     */
    resetAbsentNote:
      'Если «Семьи» в этом списке нет — телефон ещё ни разу не спрашивал разрешение. Значит дело не в настройках: вернитесь и нажмите «Включить уведомления».',
    resetAndroid:
      'На Android: «Настройки» → «Приложения» → «Семья» → «Уведомления». В браузере на компьютере — значок замка слева от адреса страницы.',

    /** Headless browsers and desktop test runs have none of these APIs. */
    degradedNote:
      'Здесь нет ни Notification, ни PushManager, ни service worker — так выглядит обычная вкладка браузера или тестовая среда. Это не поломка приложения.',
  },
} as const;
