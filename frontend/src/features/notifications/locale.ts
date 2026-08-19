import type { DeliveryStatus, EscalationState, NotificationPriority } from '@family/shared';

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
  onlyUnread: 'Только непрочитанные',
  showAll: 'Показать все',
  loadMore: 'Показать ещё',
  loading: 'Загружаем…',

  /* --- states ------------------------------------------------------------- */

  emptyTitle: 'Пока пусто',
  emptyText: 'Здесь появятся напоминания о задачах, событиях и делах семьи.',
  emptyUnreadTitle: 'Всё прочитано',
  emptyUnreadText: 'Непрочитанных уведомлений нет.',
  loadFailed: 'Не удалось загрузить уведомления',
  markReadFailed: 'Не удалось отметить прочитанным',

  /* --- acknowledgement (D11) ---------------------------------------------- */

  /**
   * The only signal that stops a `critical` intent walking up the escalation
   * ladder to another family member. Everything else — arriving on the device,
   * being tapped — counts as `delivered`/`interacted` and does not stop it.
   */
  acknowledge: 'Подтвердить',
  acknowledging: 'Подтверждаем…',
  acknowledged: 'Подтверждено',
  acknowledgeHint: 'Пока никто не подтвердил, уведомление уйдёт следующему в семье.',
  acknowledgeFailed: 'Не удалось подтвердить',
  acknowledgeQueued: 'Подтверждение сохранено — отправим, как появится сеть.',
  acknowledgedAt: (when: string) => `Подтверждено ${when}`,

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
  acknowledged: 'Подтверждено',
};

/** `EscalationState` → a short Russian phrase for the receipts header. */
export const ESCALATION_STATE_RU: Record<EscalationState, string> = {
  none: 'Без эскалации',
  redelivered: 'Отправлено повторно',
  channel_fallback: 'Отправлено другим способом',
  person_escalated: 'Передано другому участнику',
  exhausted: 'Никто не подтвердил',
};

/** Priority → the tone of the row. Only `high`/`critical` are ever labelled. */
export const PRIORITY_RU: Record<NotificationPriority, string> = {
  low: 'Не срочно',
  normal: 'Обычное',
  high: 'Важное',
  critical: 'Срочное',
};
