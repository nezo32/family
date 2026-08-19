import { useMemo } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  assignableRoles,
  canManageRole,
  type FairnessMember,
  type Role,
  type TaskOccurrenceResponse,
} from '@family/shared';
import { notify } from '@/shared/lib/toast';
import { toLocalDateKey } from '@/shared/lib/format';
import { useCan } from '@/shared/auth/use-can';
import { useMe } from '@/shared/auth/use-me';
import {
  familyKeys,
  fetchRoster,
  fetchUpcomingTasks,
  fetchWeeklyLoad,
  reactivateMember,
  suspendMember,
  updateMember,
  type Roster,
  type RosterMember,
  type UpdateMemberInput,
} from './api';
import { FAMILY_RU } from './locale';

/**
 * TanStack Query wrappers for the «Семья» section.
 *
 * Two rules run through all of it:
 *
 *  1. **Enrichment must not be able to break the roster.** The weekly-load and
 *     upcoming-task queries hit endpoints that are specified but not yet
 *     implemented. They never retry, they never surface an error state of their
 *     own, and the roster renders identically with or without them.
 *  2. **Access decisions come from `useCan()`.** `me.role` is read in exactly
 *     two places — `useAssignableRoles()` and `useCanManageMember()` — and only
 *     to compute *rank*, which is what `assignableRoles()` / `canManageRole()`
 *     need. The permission gate always sits in front of it (D4).
 */

/** The load window shown on this screen: the last seven days. */
export const LOAD_WINDOW_DAYS = 7;

/** How far ahead the member sheet looks for "ближайшие дела". */
const UPCOMING_WINDOW_DAYS = 14;

/* -------------------------------------------------------------------------- */
/* queries                                                                     */
/* -------------------------------------------------------------------------- */

export function useRoster(): UseQueryResult<Roster, Error> {
  const { can, isReady } = useCan();

  return useQuery({
    queryKey: familyKeys.roster(),
    queryFn: ({ signal }) => fetchRoster(signal),
    enabled: isReady && can('member:read'),
  });
}

export interface WeeklyLoadResult {
  /** `userId` → their own numbers. Empty when the endpoint is unavailable. */
  byMember: ReadonlyMap<string, FairnessMember>;
  /** False when there is simply no load data to show — not an error state. */
  isAvailable: boolean;
  isPending: boolean;
}

/**
 * The neutral weekly load (D5).
 *
 * Requires the `any` scope on `task:read`: load across the *whole family* is a
 * different question from "my own chores", and a child holding `task:read:own`
 * must not be able to ask it.
 */
export function useWeeklyLoad(): WeeklyLoadResult {
  const { scopeFor, isReady } = useCan();

  const query = useQuery({
    queryKey: familyKeys.load(LOAD_WINDOW_DAYS),
    queryFn: ({ signal }) => fetchWeeklyLoad(LOAD_WINDOW_DAYS, signal),
    enabled: isReady && scopeFor('task:read') === 'any',
    // Enrichment: a missing endpoint must cost one request, not three.
    retry: false,
    staleTime: 60_000,
  });

  const { data, isSuccess, isPending, fetchStatus } = query;

  return useMemo(() => {
    const byMember = new Map<string, FairnessMember>();
    for (const member of data?.members ?? []) byMember.set(member.userId, member);
    return {
      byMember,
      isAvailable: isSuccess && byMember.size > 0,
      isPending: isPending && fetchStatus !== 'idle',
    };
  }, [data, isSuccess, isPending, fetchStatus]);
}

export function useMemberUpcomingTasks(
  memberId: string | null,
): UseQueryResult<TaskOccurrenceResponse[], Error> {
  const { can, isReady } = useCan();

  const range = useMemo(() => {
    const now = new Date();
    const to = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return { from: toLocalDateKey(now), to: toLocalDateKey(to) };
  }, []);

  return useQuery({
    queryKey: familyKeys.upcoming(memberId ?? 'none'),
    queryFn: ({ signal }) =>
      memberId ? fetchUpcomingTasks(memberId, range, signal) : Promise.resolve([]),
    enabled: isReady && memberId !== null && can('task:read'),
    retry: false,
    staleTime: 30_000,
  });
}

/* -------------------------------------------------------------------------- */
/* mutations                                                                   */
/* -------------------------------------------------------------------------- */

function useMemberMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<RosterMember>,
  successMessage: string,
  onDone?: () => void,
): UseMutationResult<RosterMember, Error, TVars> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      notify.success(successMessage);
      onDone?.();
    },
    // Russian from the `ErrorCode`; the server's English `message` never
    // reaches a user (D7).
    onError: (error) => {
      notify.error(error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: familyKeys.all });
    },
  });
}

export function useUpdateMemberRole(
  onDone?: () => void,
): UseMutationResult<RosterMember, Error, { id: string; role: Role }> {
  return useMemberMutation(
    (vars) => updateMember({ id: vars.id, patch: { role: vars.role } }),
    FAMILY_RU.roleChangeSaved,
    onDone,
  );
}

export function useUpdateChoreWeight(): UseMutationResult<
  RosterMember,
  Error,
  { id: string; choreWeight: string }
> {
  return useMemberMutation(
    (vars) => updateMember({ id: vars.id, patch: { choreWeight: vars.choreWeight } }),
    FAMILY_RU.weightSaved,
  );
}

/** Escape hatch for any other admin patch (display name, colour, sort order). */
export function useUpdateMember(): UseMutationResult<RosterMember, Error, UpdateMemberInput> {
  return useMemberMutation(updateMember, FAMILY_RU.roleChangeSaved);
}

export function useSuspendMember(
  onDone?: () => void,
): UseMutationResult<RosterMember, Error, string> {
  return useMemberMutation(suspendMember, FAMILY_RU.suspendedToast, onDone);
}

export function useReactivateMember(
  onDone?: () => void,
): UseMutationResult<RosterMember, Error, string> {
  return useMemberMutation(reactivateMember, FAMILY_RU.reactivatedToast, onDone);
}

/* -------------------------------------------------------------------------- */
/* role affordances                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Roles the current user may assign to somebody else.
 *
 * Gated on `member:role:assign` through `useCan()` — that is the access
 * decision. `assignableRoles(me.role)` then narrows by *rank*, using the same
 * shared function the backend enforces with, so the picker can never offer a
 * role the server would reject.
 */
export function useAssignableRoles(): Role[] {
  const { can, isReady } = useCan();
  const { data: me } = useMe();

  return useMemo(() => {
    if (!isReady || !me || !can('member:role:assign')) return [];
    return assignableRoles(me.user.role);
  }, [can, isReady, me]);
}

/**
 * May the current user act on this particular member at all?
 *
 * Rank only — the permission checks are separate and live at the call site.
 * The backend applies exactly this test (`assertCanManageTarget`), so mirroring
 * it keeps the UI from offering a control that would 403. Acting on yourself is
 * excluded: demoting or suspending your own account from the roster is a
 * mistake, not a feature.
 */
export function useCanManageMember(target: RosterMember | null): boolean {
  const { data: me } = useMe();
  if (!me || !target) return false;
  if (me.user.id === target.id) return false;
  return canManageRole(me.user.role, target.role);
}
