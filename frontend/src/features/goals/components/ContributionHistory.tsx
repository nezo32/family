import type { GoalTransactionResponse, PublicUser } from '@family/shared';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { formatDateTime, formatMoney } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { GOALS_RU, GOAL_TXN_KIND_RU } from '../locale';

/**
 * The ledger, rendered.
 *
 * It is append-only by design (D6 / household.md §2.2) — there is deliberately
 * no edit or delete affordance here, and none exists on the API either. A
 * mistake is offset by a correction row, which shows up as another entry.
 */
export function ContributionHistory(props: {
  transactions: GoalTransactionResponse[];
  roster: Map<string, PublicUser>;
  currentUserId: string | null;
  isLoading?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  if (props.isLoading) {
    return (
      <ul className="space-y-3">
        {[0, 1, 2].map((row) => (
          <li key={row} className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-4 w-16" />
          </li>
        ))}
      </ul>
    );
  }

  if (props.transactions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-4">
        <p className="text-sm font-medium">{GOALS_RU.historyEmpty}</p>
        <p className="text-sm text-muted-foreground">{GOALS_RU.historyEmptyDescription}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y">
        {props.transactions.map((transaction) => {
          const member = props.roster.get(transaction.userId);
          const positive = transaction.delta >= 0;
          return (
            <li key={transaction.id} className="flex items-center gap-3 py-3">
              <UserAvatar
                user={{
                  id: transaction.userId,
                  displayName: member?.displayName ?? '—',
                  avatarUrl: member?.avatarUrl ?? null,
                }}
                size="sm"
                highlighted={transaction.userId === props.currentUserId}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {member?.displayName ?? GOAL_TXN_KIND_RU[transaction.kind]}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {formatDateTime(transaction.occurredAt)}
                  {transaction.note ? ` · ${transaction.note}` : ''}
                </p>
              </div>
              <span
                className={cn(
                  'shrink-0 text-sm font-semibold tabular-nums',
                  positive ? 'text-success' : 'text-destructive',
                )}
              >
                {formatMoney(transaction.delta, { signed: true })}
              </span>
            </li>
          );
        })}
      </ul>

      {props.hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full"
          disabled={props.isLoadingMore ?? false}
          onClick={props.onLoadMore}
        >
          {GOALS_RU.loadMore}
        </Button>
      ) : null}
    </div>
  );
}
