import { CloudOff, RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { cn } from '@/shared/lib/utils';
import { SHOPPING_RU } from '../locale';

/**
 * The honest offline banner.
 *
 * Three states, and the wording of each is the point:
 *
 * - **offline, nothing queued** — «Нет сети». Purely informational.
 * - **anything queued** — the exact number of changes still on the phone, plus
 *   «Отправим, когда откроете приложение со связью». That sentence is the whole
 *   contract with the user: WebKit has no Background Sync
 *   (`docs/research/ios-pwa-push.md` §7), so nothing is delivered while the app
 *   is closed, and promising otherwise is the kind of lie a family only
 *   discovers when the other parent buys the milk again.
 * - **online, empty queue** — nothing at all. A permanent status bar becomes
 *   invisible within a week.
 */
export function OfflineBanner(props: {
  online: boolean;
  pending: number;
  flushing: boolean;
  onRetry: () => void;
  className?: string;
}) {
  const { online, pending, flushing } = props;
  if (online && pending === 0) return null;

  const Icon = online ? CloudOff : WifiOff;
  const title = pending > 0 ? SHOPPING_RU.queuedCount(pending) : SHOPPING_RU.offlineTitle;
  const description = online ? SHOPPING_RU.queuedDescription : SHOPPING_RU.offlineDescription;

  return (
    <div
      role="status"
      data-testid="offline-banner"
      className={cn(
        'flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5',
        props.className,
      )}
    >
      <Icon className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-pretty text-muted-foreground">{description}</p>
      </div>
      {pending > 0 && online ? (
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 shrink-0"
          onClick={props.onRetry}
          disabled={flushing}
        >
          <RefreshCw className={cn('size-4', flushing && 'animate-spin')} aria-hidden />
          <span className="sr-only sm:not-sr-only">
            {flushing ? SHOPPING_RU.syncing : SHOPPING_RU.retryNow}
          </span>
        </Button>
      ) : null}
    </div>
  );
}
