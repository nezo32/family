import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
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
 * ### Not a leaderboard, and now not a load screen either (D5)
 *
 * The list order is `sortOrder`, then name. It is **never** sorted by completed
 * chores or by anything else a child could read as a placing, and no row shows
 * a number.
 *
 * The removal happened in three passes, and the order is the argument. First
 * the per-person totals went. Then the little load bar glued to every member's
 * card went, because one bar per person stacked down a roster of siblings *is*
 * the comparison however carefully each bar is worded. What survived was one
 * family-level picture in the side column — and that has now gone too, at the
 * owner's request: a distribution of housework is still a distribution of
 * housework, and the family does not need the app to draw it.
 *
 * So this screen is a roster and nothing else. It renders no share, no bar and
 * no proportion, in the DOM or in an `aria-label`, and it asks the server for
 * none. The rotation still balances chores behind the scenes; that is a
 * scheduling input with no display (D5).
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

      {/* No `<SideColumn>`: this screen publishes nothing into it since the
          weekly load was removed, and the shell's `<aside>` is `empty:hidden`,
          so the grid gap goes with it rather than leaving a hole beside the
          roster. */}
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
 * then name. Chore counts never enter into it — reordering the roster by who
 * did most this week is a leaderboard wearing a disguise.
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
