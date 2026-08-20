import type { FairnessMember, PublicUser } from '@family/shared';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { useCan } from '@/shared/auth/use-can';
import { EmptyState } from '@/shared/components/EmptyState';
import { TASKS_RU } from '../locale';

/**
 * «Как разделились дела на этой неделе» — the one place the family sees its own
 * distribution of housework.
 *
 * This is the component that survived the removal of the score system (D5), and
 * it only survived on terms. What it is: a picture of how one week's work split
 * across the household, so an adult can notice a lopsided week and start a
 * conversation. What it is deliberately not:
 *
 * - **no per-person totals.** There used to be «3 · 21 балл» beside every name.
 *   A number attached to a person, printed next to their siblings' numbers, is
 *   a scoreboard whatever the header says — and a child reading a smaller
 *   number next to a bigger one learns they are losing. The bars stayed; the
 *   numbers went.
 * - **no ranking.** Members are listed alphabetically, never by effort, and
 *   there is no position, medal or arrow. The contract has no `rank` field for
 *   exactly this reason, and adding one here would be a regression.
 * - **no score.** Nothing here accumulates across weeks. The window resets, and
 *   with it any sense that somebody is "behind".
 *
 * Each row compares one person to **their own fair share** — the tick on their
 * bar, derived from their rotation weight. Two children with different weights
 * can both sit exactly on their mark, and that is the point: the honest
 * question is "is the split about right", not "who did most".
 */
export function WeeklyLoad(props: {
  members: readonly FairnessMember[];
  roster: readonly PublicUser[];
  imbalance: number;
}) {
  const { userId } = useCan();

  if (props.members.length === 0) {
    return <EmptyState compact title={TASKS_RU.load.empty} />;
  }

  const rows = props.members
    .map((member) => ({
      member,
      user: props.roster.find((candidate) => candidate.id === member.userId),
    }))
    .sort((a, b) =>
      (a.user?.displayName ?? a.member.userId).localeCompare(
        b.user?.displayName ?? b.member.userId,
        'ru',
      ),
    );

  const verdict =
    props.imbalance < 0.25
      ? TASKS_RU.load.balanced
      : props.imbalance < 0.6
        ? TASKS_RU.load.slightlyOff
        : TASKS_RU.load.off;

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold text-foreground">{TASKS_RU.load.title}</h2>
        <p className="text-xs text-muted-foreground">{TASKS_RU.load.description}</p>
      </header>

      <ul className="space-y-3">
        {rows.map(({ member, user }) => {
          const actual = Math.max(0, Math.min(1, member.actualShare));
          const fair = Math.max(0, Math.min(1, member.fairShare));
          const name = user?.displayName ?? '—';
          return (
            <li key={member.userId} className="space-y-1.5">
              <span className="flex min-w-0 items-center gap-2">
                {user ? (
                  <UserAvatar user={user} size="xs" highlighted={user.id === userId} />
                ) : null}
                <span className="truncate text-sm text-foreground">{name}</span>
              </span>

              <div
                className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`${name}: ${String(Math.round(actual * 100))}% (${TASKS_RU.load.fairShare.toLowerCase()} ${String(Math.round(fair * 100))}%)`}
              >
                <div
                  className="h-full rounded-full bg-primary/70"
                  style={{ width: `${String(actual * 100)}%` }}
                />
                {/* The tick is the person's own fair share — the only comparison
                    this component makes. */}
                <div
                  aria-hidden
                  className="absolute inset-y-0 w-0.5 bg-foreground/50"
                  style={{ left: `calc(${String(fair * 100)}% - 1px)` }}
                />
              </div>

              {member.coveredForOthers > 0 ? (
                <p className="text-xs text-muted-foreground">{TASKS_RU.load.covered}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <footer className="text-xs text-pretty text-muted-foreground">{verdict}</footer>
    </section>
  );
}
