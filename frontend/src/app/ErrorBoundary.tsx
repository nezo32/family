import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { ROUTES } from '@/shared/lib/routes';
import { COMMON } from '@/shared/lib/i18n';
import { errorMessageRu } from '@/shared/api/errors-ru';
import { isApiError } from '@/shared/api/errors';

/**
 * Top-level crash handler.
 *
 * Two things live here because they must show the same screen:
 *  - `AppErrorBoundary`, a class component catching render-phase throws;
 *  - `RouteErrorBoundary`, the `errorElement` React Router renders for loader
 *    and render errors inside a route subtree.
 *
 * Both offer a reload rather than a "go back", because after a render crash the
 * component tree is not trustworthy — a fresh boot is the honest recovery.
 * A lazy-chunk failure after a deploy is the most common cause, and a reload
 * fixes exactly that.
 */

interface Props {
  children: ReactNode;
  /** Rendered instead of the default screen. */
  fallback?: (error: unknown, reset: () => void) => ReactNode;
}

interface State {
  error: unknown;
}

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No error-reporting service in v1 (D9). The console is the record.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
    return <CrashScreen error={this.state.error} onReset={this.reset} />;
  }
}

/** React Router `errorElement`. */
export function RouteErrorBoundary(): ReactNode {
  const error = useRouteError();
  const navigate = useNavigate();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundBody onHome={() => void navigate(ROUTES.today, { replace: true })} />;
  }

  return (
    <CrashScreen
      error={error}
      onReset={() => {
        window.location.reload();
      }}
    />
  );
}

function CrashScreen(props: { error: unknown; onReset: () => void }) {
  const description = isApiError(props.error)
    ? errorMessageRu(props.error)
    : 'Приложение неожиданно остановилось. Обычно помогает перезагрузка страницы.';

  const technical = props.error instanceof Error ? props.error.message : null;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <TriangleAlert className="size-7" aria-hidden />
      </div>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{COMMON.somethingWentWrong}</h1>
        <p className="mx-auto max-w-sm text-sm text-balance text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          onClick={() => {
            window.location.reload();
          }}
        >
          <RotateCcw className="size-4" aria-hidden />
          Перезагрузить
        </Button>
        <Button variant="ghost" onClick={props.onReset}>
          {COMMON.retry}
        </Button>
      </div>
      {import.meta.env.DEV && technical ? (
        <pre className="max-w-full overflow-x-auto rounded-lg bg-muted p-3 text-left text-xs text-muted-foreground">
          {technical}
        </pre>
      ) : null}
    </div>
  );
}

/** 404 screen, also used by the catch-all route. */
export function NotFound(): ReactNode {
  const navigate = useNavigate();
  return <NotFoundBody onHome={() => void navigate(ROUTES.today, { replace: true })} />;
}

function NotFoundBody(props: { onHome: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <p className="text-6xl font-semibold tracking-tight text-muted-foreground/40 select-none">404</p>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{COMMON.notFound}</h1>
        <p className="mx-auto max-w-sm text-sm text-balance text-muted-foreground">
          Такой страницы нет. Возможно, ссылка устарела или запись удалили.
        </p>
      </div>
      <Button onClick={props.onHome}>На главную</Button>
    </div>
  );
}
