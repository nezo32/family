import { useState } from 'react';
import { Info, ShieldCheck, UserCheck } from 'lucide-react';
import type { Role } from '@family/shared';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { Skeleton } from '@/shared/ui/skeleton';
import { Badge } from '@/shared/ui/badge';
import { useCan } from '@/shared/auth/use-can';
import { ADMIN_RU, requestCount } from '../locale';
import {
  useApproveMember,
  useAssignableRoles,
  useMembers,
  usePendingMembers,
  useReactivateMember,
  useRejectMember,
  useSuspendMember,
} from '../hooks';
import type { MemberRow, PendingMember } from '../api';
import { PendingMemberCard } from '../components/PendingMemberCard';
import { MemberAdminRow } from '../components/MemberAdminRow';
import { ApproveRoleSheet } from '../components/ApproveRoleSheet';
import { RejectDialog } from '../components/RejectDialog';

/**
 * `/admin/members` — the approval queue and member moderation.
 *
 * ### Permissions
 *
 * Everything on this screen is gated with `useCan()`, never with `role ===`
 * (D4). A caller without `member:approve` does not get a redirect and does not
 * get disabled buttons — the queue is **not rendered and not requested**. The
 * route guard in the shell already covers the normal path; this is the second
 * lock, for the shared-link and stale-bundle cases.
 *
 * ### The 409
 *
 * Approval is a conditional update server-side, so two admins tapping at once
 * produce one winner and one `409 CONFLICT`. The loser sees «Уже обработано» in
 * a neutral banner — kept at page level so it survives the refetch that removes
 * the row — plus a refreshed queue. No error dialog: they did nothing wrong.
 *
 * ### Mobile
 *
 * Cards, not a table. Approve is two taps — «Одобрить», then a role — because
 * the common case is a parent doing this on a phone.
 */
export default function MembersPage() {
  const { can, isReady } = useCan();

  const canApprove = can('member:approve');
  // The affordance for taking access away. The endpoint enforces
  // `member:update:any`; `member:remove` is the narrower of the two and the one
  // this destructive control follows.
  const canModerate = can('member:remove');

  const [approveFor, setApproveFor] = useState<PendingMember | null>(null);
  const [rejectFor, setRejectFor] = useState<PendingMember | null>(null);
  const [suspendFor, setSuspendFor] = useState<MemberRow | null>(null);
  const [reactivateFor, setReactivateFor] = useState<MemberRow | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pendingRole, setPendingRole] = useState<Role | null>(null);

  const closeAll = () => {
    setApproveFor(null);
    setRejectFor(null);
    setSuspendFor(null);
    setReactivateFor(null);
    setPendingRole(null);
  };

  const onConflict = () => {
    setConflict(true);
    closeAll();
  };

  const approve = useApproveMember({ onConflict, onDone: closeAll });
  const reject = useRejectMember({ onConflict, onDone: closeAll });
  const suspend = useSuspendMember({ onConflict, onDone: closeAll });
  const reactivate = useReactivateMember({ onConflict, onDone: closeAll });

  const pending = usePendingMembers();
  const members = useMembers();
  const roles = useAssignableRoles();

  const busy = approve.isPending || reject.isPending || suspend.isPending || reactivate.isPending;

  /* ---------------------------------------------------------------------- */

  if (!isReady) {
    return (
      <>
        <PageHeader title={ADMIN_RU.title} description={ADMIN_RU.description} />
        <ListSkeleton />
      </>
    );
  }

  // Not "redirected elsewhere" — the moderation surface does not exist for this
  // user at all.
  if (!canApprove) {
    return (
      <>
        <PageHeader title={ADMIN_RU.title} />
        <EmptyState
          icon={ShieldCheck}
          title={ADMIN_RU.noAccessTitle}
          description={ADMIN_RU.noAccessDescription}
        />
      </>
    );
  }

  const pendingItems = pending.data?.items ?? [];
  const memberItems = members.data?.items ?? [];

  return (
    <>
      <PageHeader title={ADMIN_RU.title} description={ADMIN_RU.description} />

      {conflict ? (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-xl border border-border bg-muted/60 p-3"
        >
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">
            <span className="font-medium">{ADMIN_RU.alreadyHandled}</span>
            <span className="text-muted-foreground"> {ADMIN_RU.alreadyHandledDescription}</span>
          </p>
        </div>
      ) : null}

      {/* ---- the queue --------------------------------------------------- */}
      <section aria-labelledby="pending-heading" className="mb-8">
        <div className="mb-2 flex items-center gap-2">
          <h2 id="pending-heading" className="text-base font-semibold text-foreground">
            {ADMIN_RU.queueTitle}
          </h2>
          {pendingItems.length > 0 ? (
            <Badge className="tabular-nums">{pendingItems.length}</Badge>
          ) : null}
        </div>

        {pending.isPending ? (
          <ListSkeleton />
        ) : pending.isError ? (
          <ErrorState
            error={pending.error}
            title={ADMIN_RU.loadErrorTitle}
            onRetry={() => void pending.refetch()}
          />
        ) : pendingItems.length === 0 ? (
          <EmptyState
            compact
            icon={UserCheck}
            title={ADMIN_RU.queueEmptyTitle}
            description={ADMIN_RU.queueEmptyDescription}
          />
        ) : (
          <>
            <p className="mb-2 text-sm text-muted-foreground">
              {requestCount(pendingItems.length)} · {ADMIN_RU.queueHint}
            </p>
            <ul className="flex flex-col gap-3">
              {pendingItems.map((member) => (
                <PendingMemberCard
                  key={member.id}
                  member={member}
                  isBusy={busy}
                  onApprove={() => {
                    setConflict(false);
                    setApproveFor(member);
                  }}
                  onReject={() => {
                    setConflict(false);
                    setRejectFor(member);
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ---- everybody else ---------------------------------------------- */}
      <section aria-labelledby="members-heading">
        <h2 id="members-heading" className="mb-2 text-base font-semibold text-foreground">
          {ADMIN_RU.membersTitle}
        </h2>

        {members.isPending ? (
          <ListSkeleton />
        ) : members.isError ? (
          <ErrorState
            error={members.error}
            title={ADMIN_RU.loadErrorTitle}
            onRetry={() => void members.refetch()}
          />
        ) : memberItems.length === 0 ? (
          <EmptyState
            compact
            title={ADMIN_RU.membersEmptyTitle}
            description={ADMIN_RU.membersEmptyDescription}
          />
        ) : (
          <>
            <p className="mb-2 text-sm text-muted-foreground">{ADMIN_RU.membersHint}</p>
            <ul className="flex flex-col gap-2 pb-safe">
              {memberItems.map((member) => (
                <MemberAdminRow
                  key={member.id}
                  member={member}
                  canModerate={canModerate}
                  isBusy={busy}
                  onSuspend={() => {
                    setConflict(false);
                    setSuspendFor(member);
                  }}
                  onReactivate={() => {
                    setConflict(false);
                    setReactivateFor(member);
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ---- flows -------------------------------------------------------- */}
      <ApproveRoleSheet
        open={approveFor !== null}
        onOpenChange={(open) => {
          if (!open) closeAll();
        }}
        memberName={approveFor?.displayName ?? ''}
        roles={roles}
        pendingRole={approve.isPending ? pendingRole : null}
        onPick={(role) => {
          if (!approveFor) return;
          setPendingRole(role);
          approve.mutate({ id: approveFor.id, role });
        }}
      />

      <RejectDialog
        open={rejectFor !== null}
        onOpenChange={(open) => {
          if (!open) closeAll();
        }}
        memberName={rejectFor?.displayName ?? ''}
        isPending={reject.isPending}
        onConfirm={(reason) => {
          if (!rejectFor) return;
          reject.mutate({ id: rejectFor.id, ...(reason.trim() ? { reason } : {}) });
        }}
      />

      <ConfirmDialog
        open={suspendFor !== null}
        onOpenChange={(open) => {
          if (!open) closeAll();
        }}
        title={ADMIN_RU.suspendDialogTitle}
        description={ADMIN_RU.suspendDialogDescription}
        confirmLabel={ADMIN_RU.suspendConfirm}
        isPending={suspend.isPending}
        onConfirm={() => {
          if (suspendFor) suspend.mutate({ id: suspendFor.id });
        }}
      />

      <ConfirmDialog
        open={reactivateFor !== null}
        onOpenChange={(open) => {
          if (!open) closeAll();
        }}
        destructive={false}
        title={ADMIN_RU.reactivateDialogTitle}
        description={ADMIN_RU.reactivateDialogDescription}
        confirmLabel={ADMIN_RU.reactivateConfirm}
        isPending={reactivate.isPending}
        onConfirm={() => {
          if (reactivateFor) reactivate.mutate(reactivateFor.id);
        }}
      />
    </>
  );
}

function ListSkeleton() {
  return (
    <ul className="flex flex-col gap-3" aria-hidden>
      {[0, 1, 2].map((n) => (
        <li key={n} className="rounded-2xl border border-border p-3">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
