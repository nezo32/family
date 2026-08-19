import { useState } from 'react';
import { BellRing, ChevronRight, LogOut } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/shared/components/PageHeader';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { useCan } from '@/shared/auth/use-can';
import { SETTINGS_NAV } from '@/app/layout/nav-items';
import { signOut } from '@/shared/api/refresh';
import { COMMON } from '@/shared/lib/i18n';
import { SETTINGS_RU } from '../locale';
import { usePush } from '../push/use-push';

/**
 * The `/settings` index.
 *
 * Sub-pages are separate top-level route entries rather than nested `<Outlet>`
 * children, so each one is a full screen on a phone with its own back
 * behaviour. The list is filtered through `useCan()` — never `role ===` (D4).
 *
 * The push status line here is deliberate: «уведомления не работают» is the
 * complaint this feature exists to prevent, and the hub is where a family member
 * looks first.
 */
export default function SettingsPage() {
  const { can } = useCan();
  const push = usePush();
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const items = SETTINGS_NAV.filter((item) => !item.perm || can(item.perm));

  const pushStatus = (): string => {
    if (push.availability === 'unsupported') return SETTINGS_RU.push.statusUnsupported;
    if (push.availability === 'needs-install') return SETTINGS_RU.push.statusNotInstalled;
    if (push.permission === 'denied') return SETTINGS_RU.push.statusDenied;
    if (push.needsReEnable) return SETTINGS_RU.push.reEnableTitle;
    return push.isEnabled ? SETTINGS_RU.push.statusOn : SETTINGS_RU.push.statusOff;
  };

  return (
    <>
      <PageHeader title={SETTINGS_RU.hub.title} description={SETTINGS_RU.hub.description} />

      {/*
        `max-w-2xl`, left-aligned. The shell is 1024px wide on a desktop and a
        row of «Профиль …………………… ›» stretched across all of it put a word and its
        affordance 950px apart. A single column of rows has a readable measure
        whatever the window does; `mx-auto` is deliberately absent so this page
        keeps the same left edge as every other section.
      */}
      <div className="max-w-2xl">
        <Card className="divide-y divide-border overflow-hidden p-0">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
            >
              <item.icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1 text-sm font-medium">{item.label}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          ))}
        </Card>

        <div className="mt-4 flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <BellRing className="size-3.5 shrink-0" aria-hidden />
          <span>
            {SETTINGS_RU.push.sectionTitle}: {pushStatus()}
          </span>
        </div>

        <div className="mt-8">
          <Button
            variant="outline"
            className="h-11 w-full sm:w-auto"
            onClick={() => {
              setConfirmSignOut(true);
            }}
          >
            <LogOut aria-hidden />
            {SETTINGS_RU.hub.signOut}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmSignOut}
        onOpenChange={setConfirmSignOut}
        title={SETTINGS_RU.hub.signOutConfirmTitle}
        description={SETTINGS_RU.hub.signOutConfirmText}
        confirmLabel={COMMON.signOut}
        onConfirm={() => signOut()}
      />
    </>
  );
}
