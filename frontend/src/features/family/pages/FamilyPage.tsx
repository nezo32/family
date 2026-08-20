import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import { SideColumn } from '@/app/layout/SideColumn';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { Button } from '@/shared/ui/button';
import { Section } from '@/shared/ui/section';
import { ROUTES } from '@/shared/lib/routes';
import { COMMON, NAV_LABELS } from '@/shared/lib/i18n';
import { Skeleton } from '@/shared/ui/skeleton';
import { useCan } from '@/shared/auth/use-can';
import { useMe } from '@/shared/auth/use-me';
import { useFairness, useMembers } from '@/features/tasks/hooks';
import { WeeklyLoad } from '@/features/tasks/components/WeeklyLoad';
import { FAMILY_RU, memberCount } from '../locale';
import { useRoster } from '../hooks';
import type { RosterMember } from '../api';
import { MemberCard } from '../components/MemberCard';
import { MemberSheet } from '../components/MemberSheet';

/**
 * `/family` — the roster (§D9).
 *
 * **What the user came for:** "who is in the family and who is carrying what."
 *
 * ### Not a leaderboard (D5)
 *
 * The list order is `sortOrder`, then name. It is **never** sorted by completed
 * chores or by anything else a child could read as a placing, and no row shows
 * a number.
 *
 * Every member's card used to carry a little load bar. That went with the score
 * system, and it went for a reason worth keeping written down: one bar per
 * person, stacked down a roster of siblings, *is* the comparison, however
 * carefully each individual bar is worded.
 *
 * The load comes back in the side column (§D9) as one **family-level** picture
 * — `WeeklyLoad`, the same component Задачи uses, which compares each person to
 * their own rotation weight, lists everybody alphabetically and prints no
 * rankable number anywhere, including in its `aria-label`. It is imported from
 * `features/tasks` rather than copied: two implementations of "how did the
 * housework split" is two places for a number to creep back in.
 *
 * ### Permissions
 *
 * `member:read` gates the roster, and the per-member controls in the sheet are
 * gated separately (`member:role:assign`, `member:update:any`,
 * `member:remove`). Nothing here branches on `role ===`; the role is display
 * copy (D4).
 */
export default function FamilyPage() {
  const { can, isReady } = useCan();
  const { data: me } = useMe();

  const roster = useRoster();
  const fairness = useFairness(7);
  // `WeeklyLoad` resolves names against the task roster, which is the same
  // `GET /members` payload under a different query key — the request is shared,
  // not doubled.
  const taskRoster = useMembers();

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const members = useMemo(() => sortRoster(roster.data?.items ?? []), [roster.data]);
  const selected = useMemo(
    () => members.find((member) => member.id === selectedId) ?? null,
    [members, selectedId],
  );

  if (!isReady) {
    return (
      <>
        <PageHeader title={FAMILY_RU.title} />
        <RosterSkeleton />
      </>
    );
  }

  // Before the loading branch, deliberately: the roster query is `enabled` on
  // this same permission, and a disabled query stays `pending` forever — the
  // other order would show a skeleton that never resolves.
  if (!can('member:read')) {
    return (
      <>
        <PageHeader title={FAMILY_RU.title} />
        <EmptyState
          icon={Users}
          title={FAMILY_RU.noAccessTitle}
          description={FAMILY_RU.noAccessDescription}
          // There is nothing to do on a screen you may not read, so the action
          // is the way off it — back to the one screen everybody can see.
          action={
            <Button asChild variant="outline" className="h-11">
              <Link to={ROUTES.today}>{NAV_LABELS.today}</Link>
            </Button>
          }
        />
      </>
    );
  }

  if (roster.isPending) {
    return (
      <>
        <PageHeader title={FAMILY_RU.title} />
        <RosterSkeleton />
      </>
    );
  }

  if (roster.isError) {
    return (
      <>
        <PageHeader title={FAMILY_RU.title} />
        <ErrorState
          error={roster.error}
          title={FAMILY_RU.loadErrorTitle}
          onRetry={() => void roster.refetch()}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title={FAMILY_RU.title} />

      {members.length === 0 ? (
        <EmptyState
          icon={Users}
          title={FAMILY_RU.emptyTitle}
          description={FAMILY_RU.emptyDescription}
          // A roster that does not even contain the reader is a stale cache far
          // more often than it is a real answer.
          action={
            <Button
              variant="outline"
              className="h-11"
              disabled={roster.isFetching}
              onClick={() => void roster.refetch()}
            >
              {COMMON.refresh}
            </Button>
          }
        />
      ) : (
        <Section label={FAMILY_RU.rosterLabel} count={memberCount(members.length)}>
          {members.map((member) => (
            <MemberCard
              key={member.id}
              member={member}
              isSelf={member.id === me?.user.id}
              onOpen={() => {
                setSelectedId(member.id);
              }}
            />
          ))}
        </Section>
      )}

      {/* §D9: the load, family-level and neutral by construction, beside the
          roster on a wide screen and under it on a phone. */}
      <SideColumn>
        {fairness.isSuccess ? (
          <WeeklyLoad
            members={fairness.data.members}
            roster={taskRoster.data ?? members}
            imbalance={fairness.data.imbalance}
          />
        ) : null}
      </SideColumn>

      <MemberSheet
        member={selected}
        isSelf={selected?.id === me?.user.id}
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </>
  );
}

/**
 * Stable, boring order: the family's own `sortOrder` (which an admin controls),
 * then name. Load never enters into it — reordering the roster by who did most
 * this week is a leaderboard wearing a disguise.
 */
function sortRoster(items: readonly RosterMember[]): RosterMember[] {
  return [...items].sort((a, b) => {
    const orderA = a.sortOrder ?? 0;
    const orderB = b.sortOrder ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.displayName.localeCompare(b.displayName, 'ru');
  });
}

/** 56px rows on one surface — the geometry `MemberCard` actually produces. */
function RosterSkeleton() {
  return (
    <div className="flex flex-col" aria-hidden>
      <div className="px-4 pb-2">
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="max-w-row-measure overflow-hidden rounded-xl border border-border bg-card">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className="flex h-14 items-center gap-3 px-4">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}
