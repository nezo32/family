import type { GoalContributor, PublicUser } from '@family/shared';
import { AvatarGroup, type AvatarUser } from '@/shared/components/UserAvatar';
import { formatMoney } from '@/shared/lib/format';
import { contributorsLabel, GOALS_RU } from '../locale';

/**
 * "Кто уже вложился" — the social half of a savings goal.
 *
 * `contributors` is only present on the detail response (see
 * `contracts/goals.ts`), so this renders nothing rather than assuming the array
 * exists: a list card legitimately has no idea who has paid in yet.
 */
export function ContributorAvatars(props: {
  contributors: GoalContributor[] | undefined;
  roster: Map<string, PublicUser>;
  max?: number;
  showTotalLine?: boolean;
}) {
  const contributors = props.contributors ?? [];
  if (contributors.length === 0) return null;

  const users: AvatarUser[] = contributors.map((contributor) => {
    const member = props.roster.get(contributor.userId);
    return {
      id: contributor.userId,
      displayName: member?.displayName ?? '—',
      avatarUrl: member?.avatarUrl ?? null,
    };
  });

  return (
    <div className="flex min-w-0 items-center gap-2">
      <AvatarGroup users={users} max={props.max ?? 4} size="sm" />
      {props.showTotalLine ? (
        <span className="truncate text-xs text-muted-foreground">
          {contributorsLabel(contributors.length)}
        </span>
      ) : null}
    </div>
  );
}

/** Detailed per-member split, for the goal detail screen. */
export function ContributorBreakdown(props: {
  contributors: GoalContributor[] | undefined;
  roster: Map<string, PublicUser>;
  currentUserId: string | null;
}) {
  const contributors = [...(props.contributors ?? [])].sort((a, b) => b.amount - a.amount);
  const total = contributors.reduce((sum, c) => sum + Math.max(0, c.amount), 0);

  if (contributors.length === 0) {
    return <p className="text-sm text-muted-foreground">{GOALS_RU.noContributors}</p>;
  }

  return (
    <ul className="space-y-3">
      {contributors.map((contributor) => {
        const member = props.roster.get(contributor.userId);
        const share = total > 0 ? Math.round((Math.max(0, contributor.amount) / total) * 100) : 0;
        return (
          <li key={contributor.userId} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm font-medium">
                {member?.displayName ?? '—'}
                {contributor.userId === props.currentUserId ? (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">(вы)</span>
                ) : null}
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums">
                {formatMoney(contributor.amount)}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${String(share)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
