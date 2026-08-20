import { useState } from 'react';
import { Info, ShieldCheck, UserCheck } from 'lucide-react';
import type { Role } from '@family/shared';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { Skeleton } from '@/shared/ui/skeleton';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { ROUTES } from '@/shared/lib/routes';
import { COMMON } from '@/shared/lib/i18n';
import { useCan } from '@/shared/auth/use-can';
import { useMe } from '@/shared/auth/use-me';
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
import { RejectedRequestRow } from '../components/RejectedRequestRow';
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
  const { data: me } = useMe();

  const canApprove = can('member:approve');
  // The affordance for taking access away. The endpoint enforces
  // `member:update:any`; `member:remove` is the narrower of the two and the one
  // this destructive control follows.
  const canModerate = can('member:remove');
  const canReadRoster = can('member:read');

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
  /*
   * `includeRejected` is this screen's alone.
   *
   * `GET /members` subtracts rejected rows for everybody by default — they are
   * declined join requests, not people in the family, and the roster is the
   * one query behind every picker in the app. Moderation is the exception: an
   * admin who declined somebody by accident has to be able to see what they
   * declined, so this call opts back in. The server still requires
   * `member:update:any` for the opt-in, so a stale bundle asking for it from a
   * child's session simply gets the default list back.
   */
  const members = useMembers({ includeRejected: true });
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
          // The roster itself is not privileged — only deciding who joins is.
          // So the way out of this screen is the same list without the verbs.
          action={
            <Button asChild variant="outline" className="h-11">
              <Link to={ROUTES.family}>{ADMIN_RU.noAccessAction}</Link>
            </Button>
          }
        />
      </>
    );
  }

  const pendingItems = pending.data?.items ?? [];
  /*
   * The roster endpoint returns *everyone*, the approval queue included, so a
   * person waiting for a decision was listed twice: once above with
   * «Одобрить»/«Отклонить», and once here with «Приостановить» — an action that
   * makes no sense against an account that has never been let in. The queue is
   * the only place a `pending_approval` row belongs.
   */
  const memberItems = (members.data?.items ?? []).filter(
    (member) => member.status !== 'pending_approval' && member.status !== 'rejected',
  );
  /*
   * Declined requests get their own list rather than a row among «Участники
   * семьи» — which is the complaint that started this: «впринципе не отображай
   * таких пользователей в семье». Here they are history an admin can look at,
   * not members with actions attached.
   */
  const rejectedItems = (members.data?.items ?? []).filter(
    (member) => member.status === 'rejected',
  );
  const selfId = me?.user.id;

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

      {/*
        Two independent lists, stacked. They used to sit side by side above
        `xl`, because the alternative was one 1024px-wide column where
        «Приостановить» floated 480px away from the name it belonged to — but
        that is now fixed at the source: §C2 caps the column at 720, so a row's
        trailing control is always beside its label. Two 344px columns inside
        that would only re-break what the cap fixed.
      */}
      <div className="grid items-start gap-8">
        {/* ---- the queue --------------------------------------------------- */}
        <section aria-labelledby="pending-heading" className="min-w-0">
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
              // An admin lands here *because* somebody said they had applied.
              // Re-asking the server is the only thing that can change the
              // answer, and it is the thing they would otherwise do by pulling
              // the page down and hoping.
              action={
                <Button
                  variant="outline"
                  className="h-11"
                  disabled={pending.isFetching}
                  onClick={() => void pending.refetch()}
                >
                  {COMMON.refresh}
                </Button>
              }
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
        {/* `useMembers` is enabled on `member:read`, and a disabled query stays
          `pending` forever — so the section is gated on the same check rather
          than rendering a skeleton that never resolves. */}
        {canReadRoster ? (
          <section aria-labelledby="members-heading" className="min-w-0">
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
                action={
                  <Button
                    variant="outline"
                    className="h-11"
                    disabled={members.isFetching}
                    onClick={() => void members.refetch()}
                  >
                    {COMMON.refresh}
                  </Button>
                }
              />
            ) : (
              <>
                <p className="mb-2 text-sm text-muted-foreground">{ADMIN_RU.membersHint}</p>
                <ul className="flex flex-col gap-2 pb-safe">
                  {memberItems.map((member) => (
                    <MemberAdminRow
                      key={member.id}
                      member={member}
                      isSelf={member.id === selfId}
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
        ) : null}

        {/* ---- declined requests -------------------------------------------- */}
        {/* Only rendered when there is something to show: an empty «Отклонённые
          заявки» heading on a healthy family is a permanent reminder of a list
          that does not matter. */}
        {canReadRoster && rejectedItems.length > 0 ? (
          <section aria-labelledby="rejected-heading" className="min-w-0">
            <h2
              id="rejected-heading"
              className="mb-2 text-base font-semibold text-muted-foreground"
            >
              {ADMIN_RU.rejectedTitle}
            </h2>
            <p className="mb-2 text-sm text-muted-foreground">{ADMIN_RU.rejectedHint}</p>
            <ul className="flex flex-col gap-2 pb-safe">
              {rejectedItems.map((member) => (
                <RejectedRequestRow key={member.id} member={member} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>

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
