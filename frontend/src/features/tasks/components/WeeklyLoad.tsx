import type { FairnessMember, PublicUser } from '@family/shared';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { useCan } from '@/shared/auth/use-can';
import { EmptyState } from '@/shared/components/EmptyState';
import { TASKS_RU } from '../locale';

/**
 * «Нагрузка за неделю» — the neutral bar of D5.
 *
 * Explicitly **not** a leaderboard: there is no rank, no ordering by effort, no
 * winner. Members are listed alphabetically and each row compares one person to
 * **their own fair share** (the tick on the bar), never to a sibling. The
 * contract has no `rank` field for exactly this reason, and adding one here
 * would be a regression: ranking siblings generates arguments, not chores.
 *
 * Points are shown quietly, as something already earned — never as a score to
 * beat.
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
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  {user ? (
                    <UserAvatar user={user} size="xs" highlighted={user.id === userId} />
                  ) : null}
                  <span className="truncate text-sm text-foreground">{name}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {member.completed} · {member.earned} {TASKS_RU.load.earned.toLowerCase()}
                </span>
              </div>

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
                <p className="text-xs text-muted-foreground">
                  {TASKS_RU.load.covered}: {member.coveredForOthers}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <footer className="text-xs text-pretty text-muted-foreground">{verdict}</footer>
    </section>
  );
}
