import type { DeliveryReceipt, PublicUser } from '@family/shared';
import { Badge } from '@/shared/ui/badge';
import { Skeleton } from '@/shared/ui/skeleton';
import { ErrorState } from '@/shared/components/ErrorState';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { formatDateTime } from '@/shared/lib/format';
import { useDeliveryReceipts } from '../hooks';
import { DELIVERY_STATUS_RU, ESCALATION_STATE_RU, NOTIFICATIONS_RU } from '../locale';

/**
 * «Кому доставлено» — the D11 receipts for one notification intent.
 *
 * This is the sender-side answer to «дошло ли до Ани», and the reason the
 * escalation ladder is legible instead of magic: the header names which rung the
 * chain is on, and each row carries the furthest state that recipient reached.
 *
 * `roster` is optional: without it the rows show the user id's avatar tint and
 * no name, which is still useful, but a caller that already has the member list
 * should pass it.
 */
export function DeliveryReceipts(props: {
  intentId: string | null;
  roster?: ReadonlyMap<string, PublicUser>;
}) {
  const query = useDeliveryReceipts(props.intentId);

  if (props.intentId === null) return null;

  if (query.isPending) {
    return (
      <div className="space-y-2" aria-busy>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <ErrorState
        error={query.error}
        title={NOTIFICATIONS_RU.receiptsLoadFailed}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const { receipts, escalationState } = query.data;

  return (
    <section className="space-y-2">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{NOTIFICATIONS_RU.receiptsTitle}</h3>
        <Badge variant="outline">
          {NOTIFICATIONS_RU.escalation}: {ESCALATION_STATE_RU[escalationState]}
        </Badge>
      </header>

      {receipts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NOTIFICATIONS_RU.receiptsEmpty}</p>
      ) : (
        <ul className="space-y-1.5">
          {receipts.map((receipt) => (
            <ReceiptRow key={receipt.id} receipt={receipt} user={props.roster?.get(receipt.userId)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReceiptRow(props: { receipt: DeliveryReceipt; user: PublicUser | undefined }) {
  const { receipt } = props;
  // The furthest timestamp is the honest one: a delivery that was acknowledged
  // was also delivered, and showing the earliest would understate it.
  const at =
    receipt.acknowledgedAt ?? receipt.interactedAt ?? receipt.deliveredAt ?? receipt.sentAt;
  const failed = receipt.status === 'failed' || receipt.status === 'suppressed';

  return (
    <li className="flex items-center gap-2 text-sm">
      <UserAvatar
        user={{
          id: receipt.userId,
          displayName: props.user?.displayName ?? '?',
          avatarUrl: props.user?.avatarUrl ?? null,
        }}
        size="sm"
      />
      <span className="min-w-0 flex-1 truncate">{props.user?.displayName ?? '—'}</span>
      <Badge variant={failed ? 'destructive' : 'secondary'}>
        {DELIVERY_STATUS_RU[receipt.status]}
      </Badge>
      {at ? (
        <time className="text-xs text-muted-foreground" dateTime={at}>
          {formatDateTime(at)}
        </time>
      ) : null}
    </li>
  );
}
