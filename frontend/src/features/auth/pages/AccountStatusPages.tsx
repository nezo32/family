import { useEffect, type ComponentType, type ReactNode } from 'react';
import { Ban, Clock, Loader2, PauseCircle, RefreshCw } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { ROUTES } from '@/shared/lib/routes';
import { relativeTime } from '@/shared/lib/i18n';
import { AUTH_RU } from '../locale';
import { TICKET_QUERY_PARAM, readStoredTicket, rememberTicket } from '../api';
import { useAccountStatus } from '../hooks';

/**
 * The three account-status screens (D3).
 *
 * **Fully public.** A `pending_approval` user is issued no session at all — not
 * a limited one, not a scoped one — so nothing here may touch `/api/me` or any
 * other authenticated endpoint: the 401 would end the session and bounce the
 * user to `/login`, which is precisely the loop these screens exist to break.
 *
 * The only server call is `GET /api/auth/status?ticket=…`, which is anonymous
 * and identified by the short-lived opaque ticket handed out by register or by
 * the OAuth callback. Without a ticket the screens still render — they just show
 * the generic copy instead of the user's name.
 *
 * Tone: `pending` is not an error. It is "вы почти внутри".
 */

/** The ticket travels in the URL and is mirrored into `sessionStorage` for reloads. */
function useTicket(): string | null {
  const [params] = useSearchParams();
  const fromUrl = params.get(TICKET_QUERY_PARAM);

  useEffect(() => {
    if (fromUrl) rememberTicket(fromUrl);
  }, [fromUrl]);

  return fromUrl ?? readStoredTicket();
}

function StatusScreen(props: {
  icon: ComponentType<{ className?: string }>;
  tone: 'neutral' | 'warning' | 'danger';
  title: string;
  description: string;
  greeting?: string | null;
  hint?: string;
  reason?: string | null;
  children?: ReactNode;
  action?: { to: string; label: string };
}) {
  const Icon = props.icon;
  const tone =
    props.tone === 'danger'
      ? 'bg-destructive/10 text-destructive'
      : props.tone === 'warning'
        ? 'bg-warning/15 text-warning-foreground'
        : 'bg-accent text-accent-foreground';

  return (
    <Card>
      <CardHeader className="items-center text-center">
        <div
          className={`mx-auto mb-2 flex size-12 items-center justify-center rounded-2xl ${tone}`}
        >
          <Icon className="size-6" aria-hidden />
        </div>
        {props.greeting ? (
          <p className="text-sm font-medium text-muted-foreground">{props.greeting}</p>
        ) : null}
        <CardTitle className="text-lg text-balance">{props.title}</CardTitle>
        <CardDescription className="text-balance">{props.description}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3 text-center">
        {props.reason ? (
          <div className="rounded-lg bg-muted px-3 py-2 text-left text-sm">
            <span className="block text-xs font-medium text-muted-foreground">
              {AUTH_RU.status.reasonLabel}
            </span>
            <span className="text-pretty">{props.reason}</span>
          </div>
        ) : null}

        {props.hint ? (
          <p className="text-xs text-muted-foreground text-pretty">{props.hint}</p>
        ) : null}

        {props.children}

        {props.action ? (
          <Button asChild variant="outline" className="h-11 w-full">
            <Link to={props.action.to}>{props.action.label}</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PendingApprovalPage() {
  const ticket = useTicket();
  const status = useAccountStatus(ticket);
  const data = status.data;

  const approved = data?.status === 'active';
  const submitted = data?.submittedAt ? relativeTime(data.submittedAt) : null;

  return (
    <StatusScreen
      icon={Clock}
      tone="neutral"
      greeting={data?.displayName ? AUTH_RU.status.greeting(data.displayName) : null}
      title={approved ? AUTH_RU.status.pendingApproved : AUTH_RU.status.pendingTitle}
      description={AUTH_RU.status.pendingDescription}
      hint={AUTH_RU.status.pendingHint}
      action={{
        to: ROUTES.login,
        label: approved ? AUTH_RU.status.backToLogin : AUTH_RU.status.tryAnotherWay,
      }}
    >
      {submitted ? (
        <p className="text-xs text-muted-foreground">
          {AUTH_RU.status.pendingSubmittedAt(submitted)}
        </p>
      ) : null}

      {ticket && !approved ? (
        <div className="space-y-2">
          <Button
            type="button"
            className="h-11 w-full"
            disabled={status.isFetching}
            onClick={() => void status.refetch()}
          >
            {status.isFetching ? (
              <>
                <Loader2 className="animate-spin" aria-hidden />
                {AUTH_RU.status.pendingChecking}
              </>
            ) : (
              <>
                <RefreshCw aria-hidden />
                {AUTH_RU.status.pendingCheck}
              </>
            )}
          </Button>
          {status.isSuccess && !status.isFetching ? (
            <p className="text-xs text-muted-foreground">{AUTH_RU.status.pendingStillWaiting}</p>
          ) : null}
          {status.isError ? (
            <p className="text-xs text-muted-foreground">{AUTH_RU.errors.statusUnavailable}</p>
          ) : null}
        </div>
      ) : null}
    </StatusScreen>
  );
}

export function RejectedPage() {
  const ticket = useTicket();
  const { data } = useAccountStatus(ticket);

  return (
    <StatusScreen
      icon={Ban}
      tone="danger"
      greeting={data?.displayName ? AUTH_RU.status.greeting(data.displayName) : null}
      title={AUTH_RU.status.rejectedTitle}
      description={AUTH_RU.status.rejectedDescription}
      reason={data?.reason ?? null}
      hint={AUTH_RU.status.rejectedHint}
      action={{ to: ROUTES.login, label: AUTH_RU.status.backToLogin }}
    />
  );
}

export function SuspendedPage() {
  const ticket = useTicket();
  const { data } = useAccountStatus(ticket);

  return (
    <StatusScreen
      icon={PauseCircle}
      tone="warning"
      greeting={data?.displayName ? AUTH_RU.status.greeting(data.displayName) : null}
      title={AUTH_RU.status.suspendedTitle}
      description={AUTH_RU.status.suspendedDescription}
      reason={data?.reason ?? null}
      hint={AUTH_RU.status.suspendedHint}
      action={{ to: ROUTES.login, label: AUTH_RU.status.backToLogin }}
    />
  );
}

export default PendingApprovalPage;
