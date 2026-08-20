import { PLURALS, pluralize } from '@/shared/lib/i18n';

/**
 * Every user-facing string of the «Семья» section (D7).
 *
 * The tone rule that shapes this whole file comes from **D5**: this screen says
 * who is in the family and what each person's role is, and it attaches no
 * number to anybody. There is no "лучший", no "место", no "больше всех" and no
 * score anywhere below, and there must never be — a leaderboard of siblings
 * produces arguments, not clean rooms. The week's split of the housework is a
 * family-level picture and lives on the chores screen.
 */
export const FAMILY_RU = {
  title: 'Семья',
  description: 'Кто в семье, чем занят и какая роль у каждого.',

  /* roster ---------------------------------------------------------------- */
  emptyTitle: 'Пока никого нет',
  emptyDescription: 'Здесь появятся все участники семьи.',
  loadErrorTitle: 'Не удалось загрузить участников',
  youBadge: 'Это вы',
  birthdayPrefix: 'День рождения',
  birthdayToday: 'День рождения сегодня 🎂',
  birthdayInDays: 'День рождения через',

  /* member sheet ---------------------------------------------------------- */
  sheetUpcoming: 'Ближайшие дела',
  sheetUpcomingEmpty: 'Ближайших дел нет.',
  sheetUpcomingError: 'Не удалось загрузить ближайшие дела.',
  sheetRoleTitle: 'Роль',
  sheetRoleHint: 'От роли зависит, что человек видит в приложении.',
  sheetWeightTitle: 'Вес в ротации дел',
  sheetWeightHint:
    'Чем больше вес, тем чаще дела достаются этому участнику. 0 — временно освобождён.',
  sheetWeightDecrease: 'Уменьшить вес',
  sheetWeightIncrease: 'Увеличить вес',
  sheetAccessTitle: 'Доступ',

  /* role change ----------------------------------------------------------- */
  roleChangeSaved: 'Роль обновлена',
  weightSaved: 'Вес обновлён',

  /* suspension ------------------------------------------------------------ */
  suspend: 'Приостановить доступ',
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

  /* statuses -------------------------------------------------------------- */
  statusSuspended: 'Доступ приостановлен',
  statusPending: 'Ждёт решения',
  statusRejected: 'Отклонён',

  /* access ---------------------------------------------------------------- */
  noAccessTitle: 'Нет доступа',
  noAccessDescription: 'Список участников семьи виден не всем.',
} as const;

/* -------------------------------------------------------------------------- */
/* Counted phrases                                                             */
/* -------------------------------------------------------------------------- */

export const memberCount = (n: number): string => pluralize(n, PLURALS.member);
export const choreCount = (n: number): string => pluralize(n, PLURALS.chore);
export const dayCount = (n: number): string => pluralize(n, PLURALS.day);
