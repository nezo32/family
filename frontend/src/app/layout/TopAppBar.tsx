import { useLocation, useNavigate } from 'react-router-dom';
import { Bell, LogOut, Monitor, Moon, Settings, Sun, User } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { useMe } from '@/shared/auth/use-me';
import { signOut } from '@/shared/api/refresh';
import { ROUTES } from '@/shared/lib/routes';
import { COMMON, NAV_LABELS } from '@/shared/lib/i18n';
import { NOTIFICATIONS_RU } from '@/features/notifications/locale';
import { cn } from '@/shared/lib/utils';
import { ROLE_LABELS_RU } from '@family/shared';
import { THEME_LABELS_RU, useTheme, type ThemeMode } from '../theme-provider';
import { NAV_ITEMS, isNavItemActive } from './nav-items';
import { usePageSlots } from './page-slots';
import { SHELL_BAR_CONTAINER, SHELL_GUTTER } from './measures';

/**
 * The bar's own title, used only when no `PageHeader` has published one. Same
 * metrics as the portalled `<h1>` in `PageHeader` so the two are
 * indistinguishable across a route change.
 */
const FALLBACK_TITLE =
  'min-w-0 flex-1 truncate font-display text-[17px] leading-6 font-semibold tracking-tight';

/**
 * Top app bar: page title, notification bell, avatar menu.
 *
 * On mobile it is sticky rather than fixed, and padded by
 * `env(safe-area-inset-top)` because `apple-mobile-web-app-status-bar-style` is
 * `black-translucent` — the app paints under the status bar and has to make
 * room for it itself.
 *
 * ## This bar is band 1, at every width (§C2/§C4/§D2)
 *
 * On a desktop it used to be 1200×57 holding a section title on the left and
 * two icon buttons on the right, with a thousand pixels of nothing in between,
 * while the page below repeated the same word as its `<h1>`. On a phone it did
 * the same thing in 390px, which is where it actually hurt: «Задачи» in the bar
 * and «Задачи» again as a heading 8px underneath.
 *
 * The bar now carries the **page** title and the screen's one action at every
 * width, hoisted out of `PageHeader` by a portal, and its inner container
 * tracks the content container exactly — so the title starts on the main
 * column's left edge and the avatar ends on the side column's right edge.
 *
 * The nav-derived section name is the fallback: it shows while a lazy route is
 * still loading, and on the few screens that render no `PageHeader` at all.
 */
export function TopAppBar(props: {
  /**
   * Unread notification count. Supplied by `AppShell` from
   * `GET /api/notifications/unread-count`; `undefined` hides the badge.
   */
  unreadCount?: number;
  /** Opens the inbox sheet. `AppShell` owns the open state. */
  onOpenNotifications?: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { theme, setTheme } = useTheme();
  const slots = usePageSlots();

  const active = NAV_ITEMS.find((item) => isNavItemActive(item, location.pathname));
  const title = active?.label ?? 'Семья';
  const unread = props.unreadCount ?? 0;

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/90 pt-safe backdrop-blur-md">
      <div className={cn('flex h-appbar items-center gap-2', SHELL_GUTTER, SHELL_BAR_CONTAINER)}>
        {/*
          Band 1, at every width (§C2/§D2). `display: contents` on the slot so
          the portalled `<h1>` becomes a flex child of this row directly — an
          empty wrapper would otherwise eat a `gap` on every screen that
          publishes no title.

          The nav-derived section name is the fallback, and its level depends on
          who owns the page title. Nothing published one (a lazy route in
          flight, a screen with no `PageHeader`) → the bar *is* the page title,
          `<h1>`. Сегодня below `md` keeps its greeting in the page as the
          `<h1>` (§D1) → the bar names the section and steps down to `<h2>`, so
          the document still has exactly one level-1 heading.
        */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div ref={slots.setAppBarTitle} className="contents" />
          {slots.barTitle ? null : slots.pageTitle ? (
            <h2 className={FALLBACK_TITLE}>{title}</h2>
          ) : (
            <h1 className={FALLBACK_TITLE}>{title}</h1>
          )}
        </div>

        {/* The screen's one primary action (§C2 band 1), hoisted by `PageHeader`. */}
        <div ref={slots.setAppBarActions} className="contents" />

        <Button
          variant="ghost"
          size="icon"
          aria-label={unread > 0 ? NOTIFICATIONS_RU.unreadAria(unread) : NOTIFICATIONS_RU.openAria}
          onClick={props.onOpenNotifications}
          // 44px, not the 36px `size="icon"` default: this is a primary target
          // in a bar that is otherwise all thumb.
          className="relative size-11"
        >
          <Bell className="size-5" aria-hidden />
          {unread > 0 ? (
            <span
              className={cn(
                'absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-destructive-foreground',
              )}
            >
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Меню профиля"
              // The avatar itself stays 32px; the target around it is 44.
              className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <UserAvatar
                user={{
                  id: me?.user.id,
                  displayName: me?.user.displayName ?? '?',
                  avatarUrl: me?.user.avatarUrl ?? null,
                }}
                size="sm"
              />
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="space-y-0.5">
              <div className="truncate text-sm font-medium">{me?.user.displayName ?? '—'}</div>
              {me ? (
                <div className="text-xs font-normal text-muted-foreground">
                  {ROLE_LABELS_RU[me.user.role]}
                </div>
              ) : null}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />

            <DropdownMenuItem
              onSelect={() => {
                void navigate(ROUTES.settingsProfile);
              }}
            >
              <User className="size-4" aria-hidden />
              {NAV_LABELS.profile}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void navigate(ROUTES.settings);
              }}
            >
              <Settings className="size-4" aria-hidden />
              {COMMON.settings}
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Оформление
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => {
                setTheme(value as ThemeMode);
              }}
            >
              <DropdownMenuRadioItem value="light">
                <Sun className="size-4" aria-hidden />
                {THEME_LABELS_RU.light}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="size-4" aria-hidden />
                {THEME_LABELS_RU.dark}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor className="size-4" aria-hidden />
                {THEME_LABELS_RU.system}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                void signOut();
              }}
            >
              <LogOut className="size-4" aria-hidden />
              {COMMON.signOut}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
