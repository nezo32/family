import { useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { Skeleton } from '@/shared/ui/skeleton';
import { useCan } from '@/shared/auth/use-can';
import { useMe } from '@/shared/auth/use-me';
import { FAMILY_RU, memberCount } from '../locale';
import { useRoster, useWeeklyLoad } from '../hooks';
import type { RosterMember } from '../api';
import { MemberCard } from '../components/MemberCard';
import { MemberSheet } from '../components/MemberSheet';

/**
 * `/family` — the roster.
 *
 * ### Not a leaderboard (D5)
 *
 * The list order is `sortOrder`, then name. It is **never** sorted by points,
 * by completed chores or by anything else a child could read as a placing, and
 * no card shows a position. Each member's week is drawn against their own fair
 * share; that is the entire comparison this screen makes.
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
  const load = useWeeklyLoad();

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const members = useMemo(() => sortRoster(roster.data?.items ?? []), [roster.data]);
  const selected = useMemo(
    () => members.find((member) => member.id === selectedId) ?? null,
    [members, selectedId],
  );

  if (!isReady) {
    return (
      <>
        <PageHeader title={FAMILY_RU.title} description={FAMILY_RU.description} />
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
        />
      </>
    );
  }

  if (roster.isPending) {
    return (
      <>
        <PageHeader title={FAMILY_RU.title} description={FAMILY_RU.description} />
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
      <PageHeader
        title={FAMILY_RU.title}
        description={
          members.length > 0 ? `${memberCount(members.length)} · ${FAMILY_RU.loadHint}` : undefined
        }
      />

      {members.length === 0 ? (
        <EmptyState
          icon={Users}
          title={FAMILY_RU.emptyTitle}
          description={FAMILY_RU.emptyDescription}
        />
      ) : (
        <ul className="flex flex-col gap-3 pb-safe">
          {members.map((member) => (
            <MemberCard
              key={member.id}
              member={member}
              load={load.byMember.get(member.id)}
              isSelf={member.id === me?.user.id}
              onOpen={() => {
                setSelectedId(member.id);
              }}
            />
          ))}
        </ul>
      )}

      <MemberSheet
        member={selected}
        load={selected ? load.byMember.get(selected.id) : undefined}
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

function RosterSkeleton() {
  return (
    <ul className="flex flex-col gap-3" aria-hidden>
      {[0, 1, 2, 3].map((n) => (
        <li key={n} className="rounded-2xl border border-border p-3">
          <div className="flex items-start gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-2 w-full" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
