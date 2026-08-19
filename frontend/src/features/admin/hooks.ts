import { useMemo } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { assignableRoles, type MemberListQuery, type Role } from '@family/shared';
import { hasErrorCode } from '@/shared/api/errors';
import { notify } from '@/shared/lib/toast';
import { useCan } from '@/shared/auth/use-can';
import { useMe } from '@/shared/auth/use-me';
import {
  adminKeys,
  approveMember,
  fetchMembers,
  fetchPendingMembers,
  reactivateMember,
  rejectMember,
  suspendMember,
  type ApproveInput,
  type MemberList,
  type MemberRow,
  type PendingList,
  type RejectInput,
  type SuspendInput,
} from './api';
import { ADMIN_RU } from './locale';

/**
 * TanStack Query wrappers for member administration.
 *
 * ### The 409 is the interesting case
 *
 * Approval and rejection are conditional updates server-side (D3): two admins
 * tapping at the same moment produce one `200` and one `409 CONFLICT`. The
 * loser has not done anything wrong and must not be shown an error — the queue
 * simply refreshes and says «Уже обработано». `onSettled` invalidates on both
 * paths, so the refetch happens whether we won or lost.
 *
 * ### Queries are permission-gated, not just hidden
 *
 * `enabled` is driven by `useCan()`. A member without `member:approve` never
 * *issues* the request for the queue, so there is no 403 in the console and no
 * flash of moderation data if a guard is ever mis-wired upstream.
 */

/* -------------------------------------------------------------------------- */
/* queries                                                                     */
/* -------------------------------------------------------------------------- */

export function usePendingMembers(): UseQueryResult<PendingList, Error> {
  const { can, isReady } = useCan();
  const allowed = isReady && can('member:approve');

  return useQuery({
    queryKey: adminKeys.pending(),
    queryFn: ({ signal }) => fetchPendingMembers(signal),
    enabled: allowed,
    // The queue is the one list where "мама уже одобрила" matters within
    // seconds, so it revalidates on every focus rather than sitting on the
    // 30 s global stale time.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export function useMembers(query: MemberListQuery = {}): UseQueryResult<MemberList, Error> {
  const { can, isReady } = useCan();
  const allowed = isReady && can('member:read');

  return useQuery({
    queryKey: adminKeys.list(query),
    queryFn: ({ signal }) => fetchMembers(query, signal),
    enabled: allowed,
  });
}

/**
 * The pending-approval badge, for anything outside this feature that wants it
 * (the sidebar entry, the Today screen card).
 *
 * Returns `0` — never `undefined` — for a caller who may not see the queue, so
 * a consumer can render `{count > 0 && <Badge/>}` without a permission check of
 * its own. It still has one: the query never runs without `member:approve`.
 */
export function usePendingMemberCount(): number {
  const { data } = usePendingMembers();
  return data?.pendingCount ?? 0;
}

/* -------------------------------------------------------------------------- */
/* mutations                                                                   */
/* -------------------------------------------------------------------------- */

export interface MemberActionOptions {
  /** Somebody else decided first (`409`). Close your sheet, keep it friendly. */
  onConflict?: () => void;
  /** Ran through. */
  onDone?: (row: MemberRow) => void;
}

function useMemberAction<TVars>(
  mutationFn: (vars: TVars) => Promise<MemberRow>,
  successMessage: string,
  options: MemberActionOptions,
): UseMutationResult<MemberRow, Error, TVars> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: (row) => {
      notify.success(successMessage);
      options.onDone?.(row);
    },
    onError: (error) => {
      // `CONFLICT` is the conditional-update loser: expected, not exceptional.
      if (hasErrorCode(error, 'CONFLICT')) {
        notify.info(ADMIN_RU.alreadyHandled, ADMIN_RU.alreadyHandledDescription);
        options.onConflict?.();
        return;
      }
      // Everything else is rendered from the `ErrorCode`, never from the
      // server's English `message` (D7).
      notify.error(error);
    },
    onSettled: () => {
      // Won or lost, what is on screen is stale now.
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
  });
}

export function useApproveMember(
  options: MemberActionOptions = {},
): UseMutationResult<MemberRow, Error, ApproveInput> {
  return useMemberAction(approveMember, ADMIN_RU.approvedToast, options);
}

export function useRejectMember(
  options: MemberActionOptions = {},
): UseMutationResult<MemberRow, Error, RejectInput> {
  return useMemberAction(rejectMember, ADMIN_RU.rejectedToast, options);
}

export function useSuspendMember(
  options: MemberActionOptions = {},
): UseMutationResult<MemberRow, Error, SuspendInput> {
  return useMemberAction(suspendMember, ADMIN_RU.suspendedToast, options);
}

export function useReactivateMember(
  options: MemberActionOptions = {},
): UseMutationResult<MemberRow, Error, string> {
  return useMemberAction(reactivateMember, ADMIN_RU.reactivatedToast, options);
}

/* -------------------------------------------------------------------------- */
/* role choice                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The roles this admin may hand out at approval time.
 *
 * Two independent limits, and both are needed:
 *
 *  - **Permission** — `member:approve`, checked through `useCan()`. Without it
 *    the list is empty and the approve flow never renders.
 *  - **Rank** — `assignableRoles()` from `@family/shared`, the same function the
 *    backend enforces with, so the picker cannot offer a role the server will
 *    refuse. Reading `me.role` here is a *rank* computation, not an access
 *    decision: the gate above is the permission check (D4).
 */
export function useAssignableRoles(): Role[] {
  const { can, isReady } = useCan();
  const { data: me } = useMe();

  return useMemo(() => {
    if (!isReady || !me || !can('member:approve')) return [];
    return assignableRoles(me.role);
  }, [can, isReady, me]);
}
