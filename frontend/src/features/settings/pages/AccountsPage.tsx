import { useState } from 'react';
import { KeyRound, Link2, ShieldAlert, TriangleAlert } from 'lucide-react';
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
import { notify } from '@/shared/lib/toast';
import { formatDateTime } from '@/shared/lib/format';
import { ROUTES } from '@/shared/lib/routes';
import { SETTINGS_RU } from '../locale';
import { canUnlink, navigateTop, startProviderLink } from '../api';
import { useIdentities, useUnlinkIdentity } from '../hooks';

const T = SETTINGS_RU.accounts;

const PROVIDER_LABELS: Record<AuthProvider, string> = {
  google: T.providerGoogle,
  apple: T.providerApple,
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
 * outright — Apple private-relay addresses make email a lie, and "sign in with
 * your existing method, then link from Settings" is the only safe flow.
 */
export default function AccountsPage() {
  const { data, isPending, error, refetch } = useIdentities();
  const unlink = useUnlinkIdentity();
  const [pendingLink, setPendingLink] = useState<OAuthProvider | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState<AuthProvider | null>(null);

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
                {pendingLink === provider
                  ? T.linking
                  : `${T.link} ${PROVIDER_LABELS[provider]}`}
              </Button>
            ))}
          </CardContent>
        </Card>
      ) : null}

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
        <p className="text-xs text-muted-foreground">{T.linkedAt(formatDateTime(identity.linkedAt))}</p>
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
