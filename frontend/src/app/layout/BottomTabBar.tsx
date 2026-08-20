import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/shared/ui/drawer';
import { cn } from '@/shared/lib/utils';
import { NAV_LABELS } from '@/shared/lib/i18n';
import { useCan } from '@/shared/auth/use-can';
import { NAV_ITEMS, isNavItemActive } from './nav-items';

/**
 * Phone navigation (D7: bottom tab bar on phones).
 *
 * Design notes that are easy to get wrong:
 *  - The surface is an **opaque `--card`** (design §E). It used to be
 *    `bg-background/95 backdrop-blur-md`, and the measured result was
 *    `oklab(0.9905 0.00068 0.00646 / 0.95)` — bit for bit the page background
 *    at 95 % alpha. A bar painted in the page's own colour is not a bar; it is
 *    a dead band at the bottom of the screen that content slides under. Paper,
 *    not glass (§A3): `--card` is the same white every row group already uses,
 *    so the bar reads as a surface sitting on the sand ground, and the 1px top
 *    border becomes a real edge instead of a hairline drawn on nothing.
 *  - The bar sits above `env(safe-area-inset-bottom)` so the home indicator
 *    never overlaps a tap target, and the bar's background extends *into* the
 *    inset so there is no strip of page content showing through. The band of
 *    background below the labels is therefore the home indicator's 34px, not a
 *    layout error — but it is the *only* place in the app that pays that inset
 *    below the fold, which is why `AppShell` and the shopping composer no
 *    longer add one of their own.
 *  - The active tab gets a 48 × 32 `--secondary` pill behind its icon plus a
 *    `--primary` icon and label. Colour alone is not the signal (§B4): at a
 *    glance the pill is the shape that says "you are here", which survives both
 *    a colour-blind reader and a phone in bright sun.
 *  - `px-safe` as well as `pb-safe`: in landscape the notch eats the left or
 *    right edge, and `inset-x-0` would put «Сегодня» underneath it.
 *  - Nothing in the bar's ancestry may carry `transform`, `filter`,
 *    `backdrop-filter`, `perspective`, `will-change` or `contain` — any of them
 *    becomes the containing block for a `position: fixed` descendant and the
 *    bar silently starts scrolling with the page.
 *  - Targets are ≥ 44 px tall (Apple HIG) even though the icons are 22 px.
 *  - At most five slots. Overflow goes into a bottom drawer ("Ещё"), which is
 *    the platform-native pattern and reachable one-handed.
 *  - `touch-manipulation` removes the 300 ms tap delay on older WebKit.
 */
export function BottomTabBar() {
  const location = useLocation();
  const { can } = useCan();
  const [moreOpen, setMoreOpen] = useState(false);

  const visible = NAV_ITEMS.filter((item) => !item.perm || can(item.perm));
  const primary = visible.filter((item) => item.primary).slice(0, 4);
  const overflow = visible.filter((item) => !primary.includes(item));

  const overflowActive = overflow.some((item) => isNavItemActive(item, location.pathname));

  return (
    <>
      <nav
        aria-label="Основная навигация"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card px-safe pb-safe md:hidden"
      >
        <ul className="flex h-tabbar items-stretch">
          {primary.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex h-full min-h-11 touch-manipulation flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors no-callout',
                    isActive ? 'text-primary' : 'text-muted-foreground active:text-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={cn(
                        'flex h-8 w-12 items-center justify-center rounded-full transition-colors',
                        isActive && 'bg-secondary',
                      )}
                    >
                      <item.icon
                        className={cn('size-[22px]', isActive && 'stroke-[2.25]')}
                        aria-hidden
                      />
                    </span>
                    <span className="max-w-full truncate px-1">{item.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}

          {overflow.length > 0 ? (
            <li className="flex-1">
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(true);
                }}
                aria-haspopup="dialog"
                aria-expanded={moreOpen}
                className={cn(
                  'flex h-full w-full min-h-11 touch-manipulation flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors no-callout',
                  overflowActive ? 'text-primary' : 'text-muted-foreground active:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex h-8 w-12 items-center justify-center rounded-full transition-colors',
                    overflowActive && 'bg-secondary',
                  )}
                >
                  <MoreHorizontal className="size-[22px]" aria-hidden />
                </span>
                <span>{NAV_LABELS.more}</span>
              </button>
            </li>
          ) : null}
        </ul>
      </nav>

      <Drawer open={moreOpen} onOpenChange={setMoreOpen}>
        <DrawerContent className="pb-safe">
          <DrawerHeader className="pb-2">
            <DrawerTitle>Разделы</DrawerTitle>
          </DrawerHeader>
          <ul className="grid grid-cols-3 gap-2 px-4 pb-6">
            {overflow.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  onClick={() => {
                    setMoreOpen(false);
                  }}
                  className={({ isActive }) =>
                    cn(
                      'flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-xl border border-transparent p-3 text-center text-xs font-medium transition-colors',
                      isActive
                        ? 'border-border bg-accent text-accent-foreground'
                        : 'bg-muted/60 text-foreground active:bg-muted',
                    )
                  }
                >
                  <item.icon className="size-5" aria-hidden />
                  <span className="leading-tight">{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </DrawerContent>
      </Drawer>
    </>
  );
}
