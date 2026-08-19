import { Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { COMMON } from '../lib/i18n';

/**
 * Full-height loading state for route-level suspense and auth checks.
 *
 * Deliberately plain: a skeleton that guesses at the layout of a screen it
 * knows nothing about is worse than an honest spinner. Feature screens should
 * render their own skeletons instead of using this.
 */
export function LoadingScreen(props: {
  label?: string;
  /** Fill the viewport rather than the parent. */
  fullscreen?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex w-full flex-col items-center justify-center gap-3 text-muted-foreground',
        props.fullscreen ? 'min-h-dvh' : 'min-h-64 flex-1 py-16',
        props.className,
      )}
    >
      <Loader2 className="size-6 animate-spin" aria-hidden />
      <span className="text-sm">{props.label ?? COMMON.loading}</span>
    </div>
  );
}

/** Inline spinner for buttons and list rows. */
export function InlineSpinner(props: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin', props.className)} aria-hidden />;
}
