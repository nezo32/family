import type { ComponentType, ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '../lib/utils';
import { COMMON } from '../lib/i18n';

/**
 * "Пока пусто" placeholder for lists that legitimately have no rows.
 *
 * An empty list is not an error and must never look like one: no warning
 * colours, no alert role. Give it an action when there is something the user
 * can actually do about it.
 */
export function EmptyState(props: {
  /** Lucide icon component, e.g. `ListTodo`. */
  icon?: ComponentType<{ className?: string }>;
  title?: string;
  description?: ReactNode;
  /** Primary call to action — a `<Button>`, usually. */
  action?: ReactNode;
  /** Rendered under the action, e.g. a secondary link. */
  footer?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const Icon = props.icon ?? Inbox;
  return (
    <div
      className={cn(
        'flex w-full flex-col items-center justify-center gap-4 text-center',
        props.compact ? 'px-4 py-8' : 'px-6 py-14',
        props.className,
      )}
    >
      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Icon className="size-7" aria-hidden />
      </div>
      <div className="space-y-1.5">
        <h3 className="text-base font-semibold text-foreground">
          {props.title ?? COMMON.nothingHere}
        </h3>
        {props.description ? (
          <p className="mx-auto max-w-xs text-sm text-balance text-muted-foreground">
            {props.description}
          </p>
        ) : null}
      </div>
      {props.action}
      {props.footer}
    </div>
  );
}
