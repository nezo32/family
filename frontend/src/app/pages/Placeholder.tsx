import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Construction } from 'lucide-react';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';
import { Button } from '@/shared/ui/button';
import { ROUTES } from '@/shared/lib/routes';
import { NAV_LABELS } from '@/shared/lib/i18n';

/**
 * Scaffolding for routes whose feature has not been built yet.
 *
 * Every placeholder page under `src/features/<domain>/pages/` renders this. A
 * feature agent taking ownership of a domain replaces the *body* of its page
 * component — the file path, the default export and the route entry in
 * `app/router.tsx` all stay exactly as they are.
 */
export function Placeholder(props: {
  title: string;
  description?: string;
  /** Which agent/module owns this screen — shown in dev only. */
  owner?: string;
  icon?: ComponentType<{ className?: string }>;
  children?: ReactNode;
}) {
  return (
    <>
      <PageHeader title={props.title} description={props.description} />
      <EmptyState
        icon={props.icon ?? Construction}
        title="Раздел в разработке"
        description="Экран появится здесь, как только команда его закончит."
        // Nothing here can be done *here*, so the way out is the way back:
        // Сегодня is the one screen that always has something on it.
        action={
          <Button asChild variant="outline" className="h-11">
            <Link to={ROUTES.today}>{NAV_LABELS.today}</Link>
          </Button>
        }
        footer={
          import.meta.env.DEV && props.owner ? (
            <p className="text-xs text-muted-foreground/70">Владелец модуля: {props.owner}</p>
          ) : null
        }
      />
      {props.children}
    </>
  );
}
