import { RU_PLURALS, countRu } from '@family/shared';
import type {
  DeliveryStatus,
  EscalationState,
  NotificationPriority,
  NotificationType,
} from '@family/shared';

/**
 * Every user-facing string of the «Уведомления» inbox (D7 — Russian copy lives
 * in the feature's `locale.ts`; code and comments stay English).
 *
 * Nothing here is a server string. Failures are rendered through
 * `shared/api/errors-ru.ts`, keyed on the machine-readable `ErrorCode`; the
 * server's English `message` field is never shown.
 *
 * Type labels are **not** duplicated here on purpose:
 * `NOTIFICATION_TYPE_LABELS_RU` in `@family/shared` is the one catalog both the
 * backend fan-out and the preferences matrix read, and a second copy would
 * drift from the enum within a release.
 */

export const NOTIFICATIONS_RU = {
  title: 'Уведомления',
  description: 'Что произошло в семье, пока вас не было.',

  /* --- the panel ---------------------------------------------------------- */

  openAria: 'Открыть уведомления',
  unreadAria: (count: number) => `Уведомления: ${String(count)} непрочитанных`,
  markAllRead: 'Прочитать все',
  marking: 'Отмечаем…',

  /**
   * The swipe (§C-gestures/G4). One word for an 88px button and for the toast.
   *
   * The toast carries «Отменить» like every other gesture's does. It did not
   * used to: the API offered `POST /notifications/read` and nothing that
   * reversed it, so the row shipped with a toast that stated what had happened
   * and offered no control — the honest reading of §G4 rather than a button
   * that would 404. `POST /notifications/unread` is the counterpart, and the
   * undo label is `COMMON.undo`, the same word the shopping and task rows use.
   */
  swipeRead: 'Прочитано',
  onlyUnread: 'Только непрочитанные',
  showAll: 'Показать все',
  loadMore: 'Показать ещё',
  loading: 'Загружаем…',

  /* --- states ------------------------------------------------------------- */

  emptyTitle: 'Пока пусто',
  emptyText: 'Здесь появятся напоминания о задачах, событиях и делах семьи.',
  emptyUnreadTitle: 'Всё прочитано',
  emptyUnreadText: 'Непрочитанных уведомлений нет.',
  /** An inbox that has never had anything in it is a settings question. */
  emptySettingsAction: 'Настроить уведомления',
  loadFailed: 'Не удалось загрузить уведомления',
  markReadFailed: 'Не удалось отметить прочитанным',
  /**
   * The undo failed. Deliberately says what is now true rather than "попробуйте
   * ещё раз": the six-second toast is gone by the time this appears, so there
   * is no control left to retry with, and the row is about to show its real
   * state again anyway.
   */
  markUnreadFailed: 'Не удалось вернуть в непрочитанные',

  /* --- «Очистить» --------------------------------------------------------- */

  /**
   * Clearing the inbox. Two scopes, and the wording carries the whole safety
   * argument, so it is worth being precise about each sentence.
   *
   * - The **title is a question**, and the dialog states a real count before
   *   anything happens — the shape shopping's `clear-bought` established
   *   («В списке 3 позиции…»). A destructive action that does not say what it
   *   will destroy is a trap however many confirmations it has.
   * - «Прочитанные» is preselected. «Все» is one deliberate tap further, and
   *   its own line says what makes it different — that unread notifications go
   *   too, unseen.
   * - Every scope's line ends with the same promise: **отчёты о доставке
   *   останутся**. That is not reassurance, it is the truth about what the
   *   server does (`cleared_at` and nothing else), and it is what makes
   *   «дошло ли до Ани» still answerable afterwards (D11).
   * - `keptNeedsAck` gets a sentence of its own rather than silence. A member
   *   who clears everything and still sees two rows must be told **why** they
   *   are there, or the clear reads as broken — and the reason is the one thing
   *   on this screen with real consequences: nobody has confirmed receipt yet,
   *   so the reminder is still on its way to somebody else.
   */
  clear: 'Очистить',
  clearTitle: 'Что убрать из списка?',
  clearScopeRead: 'Прочитанные',
  clearScopeAll: 'Все уведомления',
  clearCount: (n: number) =>
    n === 0 ? 'убирать нечего' : `исчезнут ${countRu(n, RU_PLURALS.notification)}`,
  /** Under the «Все» option — the one thing that makes it the deliberate choice. */
  clearScopeAllWarning: 'Непрочитанные тоже исчезнут — вы их так и не увидите.',
  clearReceiptsNote: 'Отметки о доставке останутся: кому дошло, всегда можно посмотреть.',
  /**
   * Phrased as «Не уберём N уведомлений», not «N уведомлений останется».
   *
   * Russian numerals govern the case of the noun *and* the agreement of the
   * verb, and «останется» is only right for the many-form: «2 уведомления
   * останется» is wrong, «останутся» is. Putting the count in the **accusative
   * object** of a first-person verb sidesteps the agreement entirely —
   * уведомление is neuter inanimate, so its accusative forms are its nominative
   * ones and `RU_PLURALS.notification` is correct for 1, 2 and 5 alike.
   */
  clearKeptNeedsAck: (n: number) =>
    `Не уберём ${countRu(n, RU_PLURALS.notification)}: ` +
    'их получение ещё никто не подтвердил, и пока это не сделано, напоминание идёт дальше.',
  clearConfirm: 'Убрать',
  clearing: 'Убираем…',
  clearNothing: 'Убирать нечего',
  cleared: (n: number) => `Убрали ${countRu(n, RU_PLURALS.notification)}`,
  clearFailed: 'Не удалось очистить список',
  /** The list is empty because the member emptied it, not because nothing ever came. */
  emptyClearedTitle: 'Список пуст',
  emptyClearedText: 'Вы убрали всё из списка. Новые уведомления будут приходить сюда как обычно.',

  /* --- acknowledgement (D11) ---------------------------------------------- */

  /**
   * The only signal that stops a `critical` intent walking up the escalation
   * ladder to another family member. Everything else — arriving on the device,
   * being tapped — counts as `delivered`/`interacted` and does not stop it.
   *
   * **Every string here names its object: «получение».** The bare verb was an
   * incident. On «Заявка в семью — дарья ждёт подтверждения» the row's only
   * button read «Подтвердить» and the receipt beneath it «Подтверждено 20
   * августа в 08:09» — so the owner tapped it, read the receipt as "заявка
   * подтверждена", and told the applicant she was in. Nothing had happened to
   * her account: the tap confirmed that the *notification* had reached a human,
   * which is all this control has ever meant. A delivery receipt must never be
   * readable as a decision about the thing the notification is about.
   */
  acknowledge: 'Подтвердить получение',
  acknowledging: 'Подтверждаем получение…',
  acknowledged: 'Получение подтверждено',
  acknowledgeHint:
    'Это отметка «я увидел» — она ничего не решает по существу, а только останавливает ' +
    'напоминание. Пока никто не подтвердил получение, уведомление уйдёт следующему в семье.',
  acknowledgeFailed: 'Не удалось подтвердить получение',
  acknowledgeQueued: 'Подтверждение получения сохранено — отправим, как появится сеть.',
  acknowledgedAt: (when: string) => `Получение подтверждено ${when}`,

  /* --- the pushHealthy === false banner ----------------------------------- */

  /**
   * Server-side D11 signal: a subscription exists, but nothing on it has
   * acknowledged a delivery — the device has silently stopped receiving push.
   * Same sentence as the settings repair card on purpose: it is the same
   * problem, found from the other end.
   */
  pushUnhealthyTitle: 'Уведомления отключились — включить снова?',
  pushUnhealthyText:
    'Подписка на этом устройстве есть, но уведомления до неё не доходят — так бывает после переустановки или долгого перерыва. Проверьте настройки уведомлений.',
  pushUnhealthyAction: 'Открыть настройки уведомлений',

  /* --- receipts (D11) ----------------------------------------------------- */

  receiptsTitle: 'Кому доставлено',
  receiptsLoadFailed: 'Не удалось загрузить статусы доставки',
  receiptsEmpty: 'Пока никому не отправлено.',
  escalation: 'Эскалация',
} as const;

/**
 * What a notification's *own* action is, when it has one.
 *
 * A `high`/`critical` row already carries the D11 «Подтвердить получение»
 * button, and for a while that was the only button on the card. On a join
 * request that is a trap: the one thing an owner wants to do from
 * «Заявка в семью» is decide it, and the only control offered confirmed
 * delivery instead. So a row whose `link` goes somewhere actionable gets a
 * **primary** button that says what is actually waiting there, and the receipt
 * button is demoted beside it.
 *
 * Keyed by type rather than derived from `link`, because the label has to name
 * the destination — «Открыть» would be no clearer than the tappable body text
 * that already exists. Types absent from this map render no action button, so
 * a type is added here only once its `navigate` target has been checked against
 * the router; promising «Открыть обмен» and landing on a 404 is the same bug
 * one screen further along.
 */
export const NOTIFICATION_ACTION_RU: Partial<Record<NotificationType, string>> = {
  member_pending_approval: 'Рассмотреть заявку',
};

/** `DeliveryStatus` → what the receipts list shows next to a member. */
export const DELIVERY_STATUS_RU: Record<DeliveryStatus, string> = {
  pending: 'В очереди',
  scheduled: 'Запланировано',
  sent: 'Отправлено',
  failed: 'Не доставлено',
  suppressed: 'Не отправлено (тишина)',
  read: 'Прочитано',
  delivered: 'Доставлено',
  interacted: 'Открыто',
  acknowledged: 'Получение подтверждено',
};

/** `EscalationState` → a short Russian phrase for the receipts header. */
export const ESCALATION_STATE_RU: Record<EscalationState, string> = {
  none: 'Без эскалации',
  redelivered: 'Отправлено повторно',
  channel_fallback: 'Отправлено другим способом',
  person_escalated: 'Передано другому участнику',
  exhausted: 'Никто не подтвердил получение',
};

/** Priority → the tone of the row. Only `high`/`critical` are ever labelled. */
export const PRIORITY_RU: Record<NotificationPriority, string> = {
  low: 'Не срочно',
  normal: 'Обычное',
  high: 'Важное',
  critical: 'Срочное',
};
