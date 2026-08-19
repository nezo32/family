import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/shared/components/PageHeader';
import { Card } from '@/shared/ui/card';
import { useCan } from '@/shared/auth/use-can';
import { SETTINGS_NAV } from '@/app/layout/nav-items';
import { COMMON } from '@/shared/lib/i18n';

/**
 * PLACEHOLDER — owned by the `features/settings` agent.
 *
 * The index of `/settings`. Sub-pages live at `/settings/{profile,notifications,accounts}`
 * and are separate route entries, not nested `<Outlet>` children, so that each
 * one is a full screen on a phone.
 * Keep the file path and the default export.
 */
export default function SettingsPage() {
  const { can } = useCan();
  const items = SETTINGS_NAV.filter((item) => !item.perm || can(item.perm));

  return (
    <>
      <PageHeader title={COMMON.settings} description="Профиль, уведомления и способы входа." />
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
    </>
  );
}
