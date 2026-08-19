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
import { cn } from '@/shared/lib/utils';
import { ROLE_LABELS_RU } from '@family/shared';
import { THEME_LABELS_RU, useTheme, type ThemeMode } from '../theme-provider';
import { NAV_ITEMS, isNavItemActive } from './nav-items';

/**
 * Top app bar: page title, notification bell, avatar menu.
 *
 * On mobile it is sticky rather than fixed, and padded by
 * `env(safe-area-inset-top)` because `apple-mobile-web-app-status-bar-style` is
 * `black-translucent` — the app paints under the status bar and has to make
 * room for it itself.
 */
export function TopAppBar(props: {
  /** Unread notification count; `undefined` hides the badge. */
  unreadCount?: number;
  onOpenNotifications?: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { theme, setTheme } = useTheme();

  const active = NAV_ITEMS.find((item) => isNavItemActive(item, location.pathname));
  const title = active?.label ?? 'Семья';
  const unread = props.unreadCount ?? 0;

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/90 pt-safe backdrop-blur-md">
      <div className="flex h-appbar items-center gap-2 px-4">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight md:text-lg">
          {title}
        </h2>

        <Button
          variant="ghost"
          size="icon"
          aria-label={
            unread > 0
              ? `${NAV_LABELS.notifications}: ${String(unread)} новых`
              : NAV_LABELS.notifications
          }
          onClick={props.onOpenNotifications}
          className="relative"
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
              className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
