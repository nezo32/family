import type { ComponentType, ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '../lib/utils';
import { COMMON } from '../lib/i18n';

/**
 * "Пока пусто" placeholder for lists that legitimately have no rows.
 *
 * An empty list is not an error and must never look like one: no warning
 * colours, no alert role.
 *
 * ## `action` is required (§D, §E)
 *
 * "An empty screen is an invitation" — a screen that tells the reader there is
 * nothing here and then offers no way to change that is a dead end, and the
 * only reason the app had six of them is that the prop was optional and easy to
 * forget. It is `ReactNode` rather than a non-null element because a great many
 * of these actions are permission-gated (`<Can>` renders nothing for a child
 * who may not create a goal) and because a filtered-empty list wants a
 * different way out than an empty one. Passing `null` is therefore legal —
 * but it is now a decision the call site has to write down, and the two places
 * that do it say why in a comment.
 */
export function EmptyState(props: {
  /** Lucide icon component, e.g. `ListTodo`. */
  icon?: ComponentType<{ className?: string }>;
  title?: string;
  description?: ReactNode;
  /**
   * Primary call to action — a `<Button>`, usually. Required: see above. Pass
   * `null` only when the invitation is already on screen (a composer directly
   * underneath) or when the reader genuinely may not act.
   */
  action: ReactNode;
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
