import type { ReactNode } from 'react';
import { AlertTriangle, WifiOff } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../lib/utils';
import { COMMON } from '../lib/i18n';
import { errorMessageRu } from '../api/errors-ru';
import { isApiError, isNetworkError } from '../api/errors';

/**
 * The one way this app tells the user something failed.
 *
 * D7: the server's `message` field is English and developer-facing. We render
 * `errorMessageRu(error)`, which maps the machine-readable `ErrorCode` to a
 * Russian sentence. The request id is shown in small print so a user can quote
 * it — that is the only server-provided string on screen, and it is opaque.
 */
export function ErrorState(props: {
  error?: unknown;
  /** Overrides the message derived from `error`. */
  title?: string;
  description?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  /** Fill the viewport instead of the parent. */
  fullscreen?: boolean;
  className?: string;
}) {
  const offline = isNetworkError(props.error);
  const Icon = offline ? WifiOff : AlertTriangle;

  const title = props.title ?? (offline ? COMMON.noConnection : COMMON.somethingWentWrong);
  const description = props.description ?? errorMessageRu(props.error);
  const requestId = isApiError(props.error) ? props.error.requestId : undefined;

  return (
    <div
      role="alert"
      className={cn(
        'flex w-full flex-col items-center justify-center gap-4 px-6 text-center',
        props.fullscreen ? 'min-h-dvh' : 'min-h-64 flex-1 py-12',
        props.className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <Icon className="size-6" aria-hidden />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mx-auto max-w-sm text-sm text-balance text-muted-foreground">{description}</p>
      </div>
      {props.onRetry ? (
        <Button variant="outline" onClick={props.onRetry}>
          {props.retryLabel ?? COMMON.retry}
        </Button>
      ) : null}
      {requestId ? (
        <p className="text-[11px] text-muted-foreground/70 select-all">Код обращения: {requestId}</p>
      ) : null}
    </div>
  );
}
