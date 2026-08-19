import { PLURALS, pluralize } from '@/shared/lib/i18n';
import type { AuthProvider, UserStatus } from '@family/shared';

/**
 * Every user-facing string of the member-administration screen (D7).
 *
 * Tone rules for this file. This screen decides whether a person gets into the
 * family at all, so the copy has to be calm and factual:
 *
 *  - A conflict is **not an error**. Two parents tapping «Одобрить» at the same
 *    moment is normal behaviour, not a fault: «Уже обработано», never «Ошибка».
 *  - Destructive copy spells out the consequence *before* the tap, not after —
 *    «все сессии будут завершены» is the whole point of the confirmation.
 *  - The role picker explains, it does not label. `ROLE_DESCRIPTIONS_RU` from
 *    `@family/shared` is rendered next to every option, because "Подросток" on
 *    its own tells an admin nothing about what the person will actually see.
 */
export const ADMIN_RU = {
  title: 'Участники',
  description: 'Заявки на вступление, роли и доступ к семье.',

  /* access ---------------------------------------------------------------- */
  noAccessTitle: 'Нет доступа',
  noAccessDescription: 'Заявки на вступление видят только администраторы семьи.',

  /* the approval queue ---------------------------------------------------- */
  queueTitle: 'Ждут решения',
  queueHint: 'Человек узнает о решении при следующей попытке войти.',
  queueEmptyTitle: 'Новых заявок нет',
  queueEmptyDescription: 'Как только кто-то попросит доступ, заявка появится здесь.',
  requestedPrefix: 'Заявка',
  signedInWith: 'Вход через',
  emailUnknown: 'Почты нет',

  /* approve --------------------------------------------------------------- */
  approve: 'Одобрить',
  approveSheetTitle: 'Кем будет этот человек?',
  approveSheetDescription:
    'Роль выбирается сейчас: от неё зависит, что человек увидит в приложении. Изменить её можно в любой момент.',
  approveSheetHint: 'Нажмите на роль — участник будет добавлен сразу.',
  approving: 'Одобряем…',
  approvedToast: 'Участник добавлен',
  noAssignableRolesTitle: 'Нет ролей для назначения',
  noAssignableRolesDescription: 'Назначать можно только роли ниже вашей собственной.',

  /* reject ---------------------------------------------------------------- */
  reject: 'Отклонить',
  rejectDialogTitle: 'Отклонить заявку?',
  rejectDialogDescription:
    'Человек увидит отказ при следующей попытке войти. Причину указывать необязательно — её покажут на экране отказа.',
  rejectReasonLabel: 'Причина',
  rejectReasonPlaceholder: 'Например: незнакомый человек',
  rejectConfirm: 'Отклонить заявку',
  rejectedToast: 'Заявка отклонена',

  /* the conditional-update loser (409) ------------------------------------ */
  alreadyHandled: 'Уже обработано',
  alreadyHandledDescription:
    'Другой администратор ответил на эту заявку раньше вас. Список обновлён.',

  /* roster & moderation --------------------------------------------------- */
  membersTitle: 'Участники семьи',
  membersHint: 'Доступ можно приостановить и вернуть.',
  membersEmptyTitle: 'Участников пока нет',
  membersEmptyDescription: 'Здесь появятся все, кто получил доступ к семье.',

  suspend: 'Приостановить',
  suspendDialogTitle: 'Приостановить доступ?',
  suspendDialogDescription:
    'Все сессии будут завершены: человек выйдет из приложения на всех устройствах и не сможет войти, пока доступ не вернут.',
  suspendConfirm: 'Приостановить доступ',
  suspendedToast: 'Доступ приостановлен',

  reactivate: 'Вернуть доступ',
  reactivateDialogTitle: 'Вернуть доступ?',
  reactivateDialogDescription:
    'Человек снова сможет войти. Прежние сессии не восстановятся — потребуется войти заново.',
  reactivateConfirm: 'Вернуть доступ',
  reactivatedToast: 'Доступ возвращён',

  /* misc ------------------------------------------------------------------ */
  pendingBadgeLabel: 'Заявки на вступление',
  loadErrorTitle: 'Не удалось загрузить участников',
} as const;

/** Which sign-in method the request arrived through. */
export const PROVIDER_LABELS_RU: Record<AuthProvider, string> = {
  google: 'Google',
  apple: 'Apple',
  telegram: 'Telegram',
  password: 'Почта и пароль',
};

/** Moderation state, in the words an admin uses out loud. */
export const STATUS_LABELS_RU: Record<UserStatus, string> = {
  pending_approval: 'Ждёт решения',
  active: 'Активен',
  rejected: 'Отклонён',
  suspended: 'Доступ приостановлен',
};

/* -------------------------------------------------------------------------- */
/* Counted phrases                                                             */
/* -------------------------------------------------------------------------- */

export const requestCount = (n: number): string => pluralize(n, PLURALS.request);
