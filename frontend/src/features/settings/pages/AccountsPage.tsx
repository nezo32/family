import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, KeyRound, Link2, ShieldAlert, TriangleAlert } from 'lucide-react';
import {
  OAUTH_PROVIDERS,
  type AuthProvider,
  type LinkedIdentity,
  type OAuthProvider,
} from '@family/shared';
import { PageHeader } from '@/shared/components/PageHeader';
import { ErrorState } from '@/shared/components/ErrorState';
import { LoadingScreen } from '@/shared/components/LoadingScreen';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { isApiError } from '@/shared/api/errors';
import { ERROR_MESSAGES_RU } from '@/shared/api/errors-ru';
import { notify } from '@/shared/lib/toast';
import { formatDateTime } from '@/shared/lib/format';
import { ROUTES } from '@/shared/lib/routes';
import { SETTINGS_RU } from '../locale';
import { canUnlink, navigateTop, startProviderLink } from '../api';
import { useIdentities, useUnlinkIdentity } from '../hooks';

const T = SETTINGS_RU.accounts;

const PROVIDER_LABELS: Record<AuthProvider, string> = {
  google: T.providerGoogle,
  telegram: T.providerTelegram,
  password: T.providerPassword,
};

/**
 * Способы входа — OAuth account binding (D3).
 *
 * Two rules govern this screen, and both of them are about *not* surprising the
 * user:
 *
 * 1. **Never a popup.** `window.open` is dead weight in an installed iOS PWA: it
 *    either opens Safari — a different storage partition, so the `__Host-rt`
 *    cookie the callback sets never reaches the app — or is blocked outright.
 *    Linking is always a top-level navigation (see `startProviderLink`).
 * 2. **Explain `LAST_LOGIN_METHOD` before it happens.** Unbinding your only way
 *    in leaves you locked out of the family with only an admin able to help.
 *    The server guards it with `SELECT … FOR UPDATE` and a 403; the job of this
 *    screen is to make sure nobody ever sees that 403, by disabling the button
 *    and saying why in a sentence a person can act on.
 *
 * Note what is *absent*: any auto-linking on a matching email. D3 forbids it
 * outright — a provider asserting an address is not the human proving they
 * control the account, so "sign in with your existing method, then link from
 * Settings" is the only safe flow.
 *
 * 3. **This is also where a link flow comes back when it did not finish.** The
 *    callback is a top-level navigation and therefore never renders an API
 *    error body; it redirects here with `?error=` or `?oauth=replayed`. The
 *    replay case is the interesting one — see `callbackBanner` at the bottom.
 */
export default function AccountsPage() {
  const { data, isPending, error, refetch } = useIdentities();
  const unlink = useUnlinkIdentity();
  const [pendingLink, setPendingLink] = useState<OAuthProvider | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState<AuthProvider | null>(null);

  // Read once, then stripped from the URL below: a reload or a share of this
  // address must not resurrect a notice about a round trip that is long over.
  const [params, setParams] = useSearchParams();
  const [outcome] = useState(() => callbackOutcomeFrom(params));

  useEffect(() => {
    if (!outcome) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const key of CALLBACK_PARAMS) next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [outcome, setParams]);

  if (isPending) return <LoadingScreen />;
  if (error || !data) {
    return (
      <ErrorState
        error={error}
        title={T.loadFailed}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  const linked = data.items;
  const banner = outcome ? callbackBanner(outcome, linked) : null;
  const unlinkAllowed = canUnlink(data);
  const available = data.available.filter((provider): provider is OAuthProvider =>
    (OAUTH_PROVIDERS as readonly string[]).includes(provider),
  );

  const beginLink = (provider: OAuthProvider) => {
    setPendingLink(provider);
    // Authenticated fetch first (the bearer token cannot ride a top-level
    // navigation), then a top-level assign. Never `window.open`.
    void startProviderLink(provider, ROUTES.settingsAccounts)
      .then((url) => {
        navigateTop(url);
      })
      .catch((linkError: unknown) => {
        setPendingLink(null);
        // A provider the server refuses to start is misconfigured, not busy —
        // the generic 503 sentence would just invite a retry that cannot work.
        if (isApiError(linkError) && linkError.code === 'SERVICE_UNAVAILABLE') {
          notify.warning(T.linkNotConfigured(PROVIDER_LABELS[provider]), T.linkNotConfiguredHint);
          return;
        }
        notify.error(linkError, T.linkFailed);
      });
  };

  const doUnlink = (provider: AuthProvider) =>
    unlink
      .mutateAsync(provider)
      .then(() => {
        notify.success(T.unlinked);
      })
      .catch((unlinkError: unknown) => {
        notify.error(unlinkError);
      });

  return (
    <>
      <PageHeader title={T.title} description={T.description} />

      <div className="max-w-2xl">
        {/* How the last round trip to the provider ended, if there was one. */}
        {banner ? (
          <Alert
            className="mb-4"
            {...(banner.variant === 'destructive' ? { variant: 'destructive' as const } : {})}
          >
            {banner.variant === 'success' ? <CheckCircle2 aria-hidden /> : null}
            {banner.variant === 'destructive' ? <TriangleAlert aria-hidden /> : null}
            {banner.variant === 'neutral' ? <Link2 aria-hidden /> : null}
            <AlertTitle>{banner.title}</AlertTitle>
            <AlertDescription>{banner.text}</AlertDescription>
          </Alert>
        ) : null}

        {/* The whole point of the screen, said before anything can go wrong. */}
        {!unlinkAllowed && linked.length > 0 ? (
          <Alert className="mb-4">
            <ShieldAlert aria-hidden />
            <AlertTitle>{T.lastMethodTitle}</AlertTitle>
            <AlertDescription>{T.lastMethodText}</AlertDescription>
          </Alert>
        ) : null}

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>{T.linkedTitle}</CardTitle>
            <CardDescription>{T.addSecondHint}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {linked.length === 0 ? (
              <p className="text-sm text-muted-foreground">{T.empty}</p>
            ) : (
              linked.map((identity) => (
                <IdentityRow
                  key={identity.provider}
                  identity={identity}
                  canUnlink={unlinkAllowed}
                  busy={unlink.isPending}
                  onUnlink={() => {
                    setConfirmUnlink(identity.provider);
                  }}
                />
              ))
            )}
          </CardContent>
        </Card>

        {available.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>{T.availableTitle}</CardTitle>
              <CardDescription>{T.neverAutoLinkHint}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {available.map((provider) => (
                <Button
                  key={provider}
                  variant="outline"
                  disabled={pendingLink !== null}
                  onClick={() => {
                    beginLink(provider);
                  }}
                >
                  <Link2 aria-hidden />
                  {pendingLink === provider ? T.linking : `${T.link} ${PROVIDER_LABELS[provider]}`}
                </Button>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmUnlink !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmUnlink(null);
        }}
        title={confirmUnlink ? T.unlinkConfirmTitle(PROVIDER_LABELS[confirmUnlink]) : ''}
        description={confirmUnlink ? T.unlinkConfirmText(PROVIDER_LABELS[confirmUnlink]) : ''}
        confirmLabel={T.unlink}
        onConfirm={() => (confirmUnlink ? doUnlink(confirmUnlink) : undefined)}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* coming back from the provider                                               */
/* -------------------------------------------------------------------------- */

/** Stripped from the URL once read, so a reload does not replay the notice. */
const CALLBACK_PARAMS = ['oauth', 'error', 'provider'] as const;

type CallbackOutcome =
  | { kind: 'replayed'; provider: OAuthProvider | null }
  | { kind: 'failed'; provider: OAuthProvider | null; code: keyof typeof ERROR_MESSAGES_RU };

interface CallbackBanner {
  variant: 'success' | 'neutral' | 'destructive';
  title: string;
  text: string;
}

function providerParam(value: string | null): OAuthProvider | null {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value ?? '')
    ? (value as OAuthProvider)
    : null;
}

/**
 * `/settings/accounts?oauth=replayed&provider=…` or `?error=<ErrorCode>&provider=…`.
 *
 * Only codes with a Russian sentence are accepted — a query string is attacker
 * controlled, and nothing free-form from it is ever rendered.
 */
function callbackOutcomeFrom(params: URLSearchParams): CallbackOutcome | null {
  const provider = providerParam(params.get('provider'));

  if (params.get('oauth') === 'replayed') return { kind: 'replayed', provider };

  const code = params.get('error');
  if (code && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES_RU, code)) {
    return { kind: 'failed', provider, code: code as keyof typeof ERROR_MESSAGES_RU };
  }
  return null;
}

/**
 * Turn the outcome into a sentence — reading the answer off the linked list
 * rather than off the query string.
 *
 * `?oauth=replayed` means the callback ran a second time for one authorization
 * and found the one-time state already spent. The server refuses to guess what
 * that means: "already consumed" and "never existed" are the same observation
 * once the row is deleted (D3), and the second is also what a replayed link
 * would look like. It does not have to guess, because by the time this renders
 * we have asked `GET /me/identities` and **know** whether the provider is
 * attached. So a replay after a link that worked says so plainly, and a replay
 * with nothing attached says only what is certain: the link did not complete,
 * start again. Neither sentence is an error, and neither is a claim.
 */
function callbackBanner(
  outcome: CallbackOutcome,
  linked: readonly LinkedIdentity[],
): CallbackBanner {
  const name = outcome.provider ? PROVIDER_LABELS[outcome.provider] : null;

  if (outcome.kind === 'replayed') {
    const attached =
      outcome.provider !== null && linked.some((row) => row.provider === outcome.provider);
    return attached && name
      ? { variant: 'success', title: T.replayedLinked(name), text: T.replayedLinkedText }
      : { variant: 'neutral', title: T.replayedUnknownTitle, text: T.replayedUnknownText };
  }

  return {
    variant: 'destructive',
    title: name ? T.callbackFailedTitle(name) : T.callbackFailedTitleGeneric,
    // D7: the machine-readable code carries the copy; the server's `message`
    // never reaches a person.
    text: ERROR_MESSAGES_RU[outcome.code],
  };
}

function IdentityRow(props: {
  identity: LinkedIdentity;
  canUnlink: boolean;
  busy: boolean;
  onUnlink: () => void;
}) {
  const { identity } = props;
  const subtitle = identity.providerUsername ?? identity.providerEmail;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
      <KeyRound className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{PROVIDER_LABELS[identity.provider]}</span>
          {identity.isPrimary ? <Badge variant="secondary">{T.primaryBadge}</Badge> : null}
          {!props.canUnlink ? (
            <Badge variant="outline" className="gap-1">
              <TriangleAlert className="size-3" aria-hidden />
              {T.lastMethodBadge}
            </Badge>
          ) : null}
        </div>
        {subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}
        <p className="text-xs text-muted-foreground">
          {T.linkedAt(formatDateTime(identity.linkedAt))}
        </p>
      </div>

      {props.canUnlink ? (
        <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onUnlink}>
          {props.busy ? T.unlinking : T.unlink}
        </Button>
      ) : (
        // Disabled rather than hidden: the user must understand *why* they
        // cannot do this, or they will keep looking for the button.
        <span className="text-xs text-muted-foreground">{T.lastMethodAction}</span>
      )}
    </div>
  );
}
