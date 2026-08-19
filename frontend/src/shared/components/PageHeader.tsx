import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

/**
 * Standard heading block for a feature page.
 *
 * Every screen under `AppShell` should start with one of these so the vertical
 * rhythm and the `<h1>` per page are consistent. The mobile top bar shows the
 * page title too; this is the in-content title, which can be richer.
 */
export function PageHeader(props: {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons, filters — right-aligned on desktop, wrapped below on mobile. */
  actions?: ReactNode;
  /** Breadcrumb or back link, rendered above the title. */
  eyebrow?: ReactNode;
  className?: string;
  /** Sticky under the app bar. Useful for list screens with a filter row. */
  sticky?: boolean;
}) {
  return (
    <header
      className={cn(
        'flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4',
        props.sticky && 'bg-background/85 sticky top-0 z-20 pt-1 backdrop-blur-sm',
        props.className,
      )}
    >
      <div className="min-w-0 space-y-1">
        {props.eyebrow ? (
          <div className="text-xs font-medium text-muted-foreground">{props.eyebrow}</div>
        ) : null}
        <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
          {props.title}
        </h1>
        {props.description ? (
          <p className="text-sm text-pretty text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      {props.actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{props.actions}</div>
      ) : null}
    </header>
  );
}
