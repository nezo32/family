import {
  CalendarDays,
  Home,
  ListTodo,
  MessageSquareHeart,
  PiggyBank,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { ROUTES } from '@/shared/lib/routes';
import { NAV_LABELS } from '@/shared/lib/i18n';

/**
 * The navigation model, shared by the mobile tab bar and the desktop sidebar.
 *
 * `perm` is the **base** permission required to see the entry; `undefined`
 * means everyone with a session sees it. Entries are filtered through
 * `useCan()` — never through `role ===` (D4).
 *
 * `primary: true` marks the (max five) destinations that fit on the phone tab
 * bar. Everything else lives behind "Ещё" on mobile and is a plain sidebar row
 * on desktop.
 */
export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Base permission gating visibility. */
  perm?: string;
  /** Shown in the phone tab bar. */
  primary?: boolean;
  /** Match child routes as active too (`/settings/*`). */
  matchPrefix?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: ROUTES.today, label: NAV_LABELS.today, icon: Home, primary: true },
  { to: ROUTES.tasks, label: NAV_LABELS.tasks, icon: ListTodo, perm: 'task:read', primary: true },
  {
    to: ROUTES.calendar,
    label: NAV_LABELS.calendar,
    icon: CalendarDays,
    perm: 'event:read',
    primary: true,
  },
  {
    to: ROUTES.shopping,
    label: NAV_LABELS.shopping,
    icon: ShoppingCart,
    perm: 'shopping:read',
    primary: true,
  },
  { to: ROUTES.goals, label: NAV_LABELS.goals, icon: PiggyBank, perm: 'goal:read' },
  { to: ROUTES.wall, label: NAV_LABELS.wall, icon: MessageSquareHeart, perm: 'post:create' },
  { to: ROUTES.family, label: NAV_LABELS.family, icon: Users, perm: 'member:read' },
  {
    to: ROUTES.adminMembers,
    label: NAV_LABELS.members,
    icon: ShieldCheck,
    perm: 'member:approve',
  },
  { to: ROUTES.settings, label: NAV_LABELS.settings, icon: Settings, matchPrefix: true },
] as const;

/** Sections inside `/settings`, rendered as a sub-navigation. */
export const SETTINGS_NAV: readonly NavItem[] = [
  { to: ROUTES.settingsProfile, label: NAV_LABELS.profile, icon: Users },
  {
    to: ROUTES.settingsNotifications,
    label: NAV_LABELS.notifications,
    icon: MessageSquareHeart,
    perm: 'notification:manage:own',
  },
  { to: ROUTES.settingsAccounts, label: NAV_LABELS.accounts, icon: ShieldCheck, perm: 'identity:manage:own' },
] as const;

/** Is `pathname` inside `item`? */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.to === ROUTES.today) return pathname === ROUTES.today;
  if (item.matchPrefix) return pathname === item.to || pathname.startsWith(`${item.to}/`);
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
