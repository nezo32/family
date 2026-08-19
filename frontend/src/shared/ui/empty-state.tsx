import * as React from 'react';
import { cn } from '@/shared/lib/utils';

/**
 * Composable empty-state primitives, in the shadcn house style.
 *
 * Not part of the upstream registry (`empty-state` does not exist there), so it
 * is written by hand but follows the same conventions: `data-slot`, `cn()`,
 * `React.ComponentProps` spreading, no opinions about copy.
 *
 * For the common case use `@/shared/components/EmptyState`, which composes these
 * into the standard icon + title + description + action layout.
 */

function Empty({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty"
      className={cn(
        'flex w-full flex-col items-center justify-center gap-4 px-6 py-14 text-center',
        className,
      )}
      {...props}
    />
  );
}

function EmptyMedia({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-media"
      className={cn(
        'flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground [&_svg]:size-7',
        className,
      )}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="empty-header" className={cn('space-y-1.5', className)} {...props} />;
}

function EmptyTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return (
    <h3
      data-slot="empty-title"
      className={cn('text-base font-semibold text-foreground', className)}
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="empty-description"
      className={cn('mx-auto max-w-xs text-sm text-balance text-muted-foreground', className)}
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-content"
      className={cn('flex flex-col items-center gap-2', className)}
      {...props}
    />
  );
}

export { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle };
