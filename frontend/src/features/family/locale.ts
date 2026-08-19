import { pluralize } from '@/shared/lib/i18n';

/**
 * Every user-facing string of the «Семья» section (D7).
 *
 * The tone rule that shapes this whole file comes from **D5**: load is
 * surfaced as a neutral statement of fact, never as a competition. There is no
 * "лучший", no "место", no "больше всех" anywhere below, and there must never
 * be — a leaderboard of siblings produces arguments, not clean rooms. Each
 * member is compared to *their own* fair share, and the phrasing stays flat
 * whichever side of it they are on.
 */
export const FAMILY_RU = {
  title: 'Семья',
  description: 'Кто в семье, чем занят и какая роль у каждого.',

  /* roster ---------------------------------------------------------------- */
  emptyTitle: 'Пока никого нет',
  emptyDescription: 'Здесь появятся все участники семьи.',
  loadErrorTitle: 'Не удалось загрузить участников',
  loadingLabel: 'Загружаем семью',
  youBadge: 'Это вы',
  birthdayPrefix: 'День рождения',
  birthdayToday: 'День рождения сегодня 🎂',
  birthdayInDays: 'День рождения через',

  /* weekly load ----------------------------------------------------------- */
  loadTitle: 'Нагрузка за неделю',
  loadHint: 'Каждый сравнивается со своей долей, а не друг с другом.',
  loadShareLabel: 'Своя доля недели',
  loadDone: 'сделано',
  loadPlanned: 'запланировано',
  loadPoints: 'баллов за неделю',
  loadEmpty: 'На этой неделе дел за этим участником не закреплено.',
  loadUnavailable: 'Нагрузка за неделю пока недоступна.',
  loadBarLabel: 'Доля недели',

  /* member sheet ---------------------------------------------------------- */
  sheetUpcoming: 'Ближайшие дела',
  sheetUpcomingEmpty: 'Ближайших дел нет.',
  sheetUpcomingError: 'Не удалось загрузить ближайшие дела.',
  sheetRoleTitle: 'Роль',
  sheetRoleHint: 'От роли зависит, что человек видит в приложении.',
  sheetRoleReadOnly: 'Роль может изменить только администратор с более высокой ролью.',
  sheetWeightTitle: 'Вес в ротации дел',
  sheetWeightHint:
    'Чем больше вес, тем чаще дела достаются этому участнику. 0 — временно освобождён.',
  sheetWeightDecrease: 'Уменьшить вес',
  sheetWeightIncrease: 'Увеличить вес',
  sheetAccessTitle: 'Доступ',
  sheetClose: 'Закрыть',

  /* role change ----------------------------------------------------------- */
  roleChangeSaved: 'Роль обновлена',
  weightSaved: 'Вес обновлён',
  noAssignableRoles: 'Вам недоступно назначение ролей этому участнику.',

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

export const memberCount = (n: number): string =>
  pluralize(n, ['участник', 'участника', 'участников']);
export const choreCount = (n: number): string => pluralize(n, ['дело', 'дела', 'дел']);
export const pointCount = (n: number): string => pluralize(n, ['балл', 'балла', 'баллов']);
export const dayCount = (n: number): string => pluralize(n, ['день', 'дня', 'дней']);
