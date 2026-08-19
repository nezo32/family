import { NavLink } from 'react-router-dom';
import { Home } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { useCan } from '@/shared/auth/use-can';
import { useMe } from '@/shared/auth/use-me';
import { ROUTES } from '@/shared/lib/routes';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { NAV_ITEMS } from './nav-items';

/**
 * Desktop navigation (D7: sidebar on desktop).
 *
 * Fixed rail, not a collapsible drawer: at family scale there are nine
 * destinations and hiding them behind a hamburger on a 1440 px screen is a
 * pointless click. Hidden below `md`, where `BottomTabBar` takes over.
 */
export function DesktopSidebar() {
  const { can } = useCan();
  const { data: me } = useMe();
  const familyName = me?.family.name ?? 'Семья';

  const items = NAV_ITEMS.filter((item) => !item.perm || can(item.perm));

  return (
    <aside className="hidden w-60 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col">
      <NavLink
        to={ROUTES.today}
        className="flex h-appbar items-center gap-2.5 px-4 text-sidebar-foreground"
      >
        <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
          <Home className="size-4" aria-hidden />
        </span>
        <span className="truncate text-sm font-semibold tracking-tight">{familyName}</span>
      </NavLink>

      <ScrollArea className="flex-1 px-2 pb-4">
        <nav aria-label="Разделы">
          <ul className="space-y-0.5">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === ROUTES.today}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <item.icon
                        className={cn('size-4.5 shrink-0', isActive && 'text-sidebar-primary')}
                        aria-hidden
                      />
                      <span className="truncate">{item.label}</span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </ScrollArea>
    </aside>
  );
}
