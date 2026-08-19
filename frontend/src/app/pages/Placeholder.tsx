import type { ComponentType, ReactNode } from 'react';
import { Construction } from 'lucide-react';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';

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
