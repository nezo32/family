import { useState } from 'react';
import { Check, ListTodo } from 'lucide-react';
import {
  ROLE_DESCRIPTIONS_RU,
  ROLE_LABELS_RU,
  type FairnessMember,
  type Role,
} from '@family/shared';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/shared/ui/sheet';
import { Button } from '@/shared/ui/button';
import { Separator } from '@/shared/ui/separator';
import { Skeleton } from '@/shared/ui/skeleton';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { formatDateTime } from '@/shared/lib/format';
import { useCan } from '@/shared/auth/use-can';
import { FAMILY_RU } from '../locale';
import type { RosterMember } from '../api';
import { clampChoreWeight, formatChoreWeight } from '../api';
import {
  useAssignableRoles,
  useCanManageMember,
  useMemberUpcomingTasks,
  useReactivateMember,
  useSuspendMember,
  useUpdateChoreWeight,
  useUpdateMemberRole,
} from '../hooks';
import { RoleBadge, StatusBadge } from './RoleBadge';
import { WeekLoadBar } from './WeekLoadBar';
import { ChoreWeightControl } from './ChoreWeightControl';

/**
 * The member detail sheet: who they are, what is coming up for them, and — for
 * whoever is permitted — the three controls that change their standing in the
 * family.
 *
 * Every control is gated twice over, and both gates matter:
 *
 *  - a **permission** from `useCan()` (`member:role:assign`, `member:update:any`,
 *    `member:remove`) — never `role === 'admin'` (D4);
 *  - a **rank** check (`useCanManageMember`), mirroring the backend's
 *    `assertCanManageTarget`, so an admin is not offered a control that would
 *    403 against an owner.
 *
 * When either fails the control is **not rendered at all**. A disabled button
 * tells a teenager exactly which lever exists and who to pester about it.
 */
export function MemberSheet(props: {
  member: RosterMember | null;
  load: FairnessMember | undefined;
  isSelf: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { member } = props;
  const { can } = useCan();

  const [suspendOpen, setSuspendOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);

  const canManage = useCanManageMember(member);
  const roles = useAssignableRoles();

  const upcoming = useMemberUpcomingTasks(props.open && member ? member.id : null);
  const changeRole = useUpdateMemberRole();
  const changeWeight = useUpdateChoreWeight();
  const suspend = useSuspendMember(() => {
    setSuspendOpen(false);
    props.onOpenChange(false);
  });
  const reactivate = useReactivateMember(() => {
    setReactivateOpen(false);
  });

  if (!member) return null;

  const canPickRole = canManage && roles.length > 0;
  const canEditWeight = canManage && can('member:update:any') && member.choreWeight !== undefined;
  const canSuspend = canManage && can('member:remove');
  const weight = member.choreWeight ?? 1;

  return (
    <>
      <Sheet open={props.open} onOpenChange={props.onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[90dvh] gap-0 overflow-y-auto rounded-t-2xl pb-safe"
          data-scroll-pane
        >
          <SheetHeader className="text-left">
            <SheetTitle className="flex items-center gap-3">
              <UserAvatar
                user={{
                  id: member.id,
                  displayName: member.displayName,
                  avatarUrl: member.avatarUrl,
                }}
                size="md"
                highlighted={props.isSelf}
              />
              <span className="min-w-0 flex-1 truncate">{member.displayName}</span>
            </SheetTitle>
            <SheetDescription>{ROLE_DESCRIPTIONS_RU[member.role]}</SheetDescription>
          </SheetHeader>

          <div className="space-y-6 px-4 pb-6">
            <div className="flex flex-wrap items-center gap-1.5">
              <RoleBadge role={member.role} />
              <StatusBadge status={member.status} />
            </div>

            {/* ---- the neutral week --------------------------------------- */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">{FAMILY_RU.loadTitle}</h3>
              <WeekLoadBar load={props.load} />
              <p className="text-xs text-muted-foreground">{FAMILY_RU.loadHint}</p>
            </section>

            <Separator />

            {/* ---- upcoming ----------------------------------------------- */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">{FAMILY_RU.sheetUpcoming}</h3>
              {upcoming.isPending ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-28" />
                </div>
              ) : upcoming.isError ? (
                <p className="text-xs text-muted-foreground">{FAMILY_RU.sheetUpcomingError}</p>
              ) : upcoming.data && upcoming.data.length > 0 ? (
                <ul className="space-y-2">
                  {upcoming.data.map((task) => (
                    <li key={task.id} className="flex items-start gap-2">
                      <ListTodo
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">{task.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {formatDateTime(task.dueAt)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{FAMILY_RU.sheetUpcomingEmpty}</p>
              )}
            </section>

            {/* ---- role ---------------------------------------------------- */}
            {canPickRole ? (
              <>
                <Separator />
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    {FAMILY_RU.sheetRoleTitle}
                  </h3>
                  <p className="text-xs text-muted-foreground">{FAMILY_RU.sheetRoleHint}</p>
                  <ul className="space-y-2">
                    {roles.map((role) => (
                      <li key={role}>
                        <RoleOption
                          role={role}
                          current={role === member.role}
                          busy={changeRole.isPending}
                          onSelect={() => {
                            if (role === member.role) return;
                            changeRole.mutate({ id: member.id, role });
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            ) : null}

            {/* ---- chore weight -------------------------------------------- */}
            {canEditWeight ? (
              <>
                <Separator />
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    {FAMILY_RU.sheetWeightTitle}
                  </h3>
                  <p className="text-xs text-muted-foreground">{FAMILY_RU.sheetWeightHint}</p>
                  <ChoreWeightControl
                    value={clampChoreWeight(weight)}
                    disabled={changeWeight.isPending}
                    onChange={(next) => {
                      changeWeight.mutate({
                        id: member.id,
                        choreWeight: formatChoreWeight(next),
                      });
                    }}
                  />
                </section>
              </>
            ) : null}

            {/* ---- access -------------------------------------------------- */}
            {canSuspend ? (
              <>
                <Separator />
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    {FAMILY_RU.sheetAccessTitle}
                  </h3>
                  {member.status === 'suspended' ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 w-full"
                      disabled={reactivate.isPending}
                      onClick={() => {
                        setReactivateOpen(true);
                      }}
                    >
                      {FAMILY_RU.reactivate}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="destructive"
                      className="min-h-11 w-full"
                      disabled={suspend.isPending}
                      onClick={() => {
                        setSuspendOpen(true);
                      }}
                    >
                      {FAMILY_RU.suspend}
                    </Button>
                  )}
                </section>
              </>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      {/* Consequences spelled out before the tap, not after. */}
      <ConfirmDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        title={FAMILY_RU.suspendDialogTitle}
        description={FAMILY_RU.suspendDialogDescription}
        confirmLabel={FAMILY_RU.suspendConfirm}
        isPending={suspend.isPending}
        onConfirm={() => {
          suspend.mutate(member.id);
        }}
      />

      <ConfirmDialog
        open={reactivateOpen}
        onOpenChange={setReactivateOpen}
        destructive={false}
        title={FAMILY_RU.reactivateDialogTitle}
        description={FAMILY_RU.reactivateDialogDescription}
        confirmLabel={FAMILY_RU.reactivateConfirm}
        isPending={reactivate.isPending}
        onConfirm={() => {
          reactivate.mutate(member.id);
        }}
      />
    </>
  );
}

/**
 * One role in the picker: the label, the explanation, and nothing else. The
 * options are exactly what `assignableRoles()` returned — a role the current
 * user may not hand out is not shown greyed out, it is not shown at all.
 */
function RoleOption(props: { role: Role; current: boolean; busy: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      disabled={props.busy}
      aria-current={props.current}
      onClick={props.onSelect}
      className="flex min-h-11 w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent aria-[current=true]:border-primary aria-[current=true]:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          {ROLE_LABELS_RU[props.role]}
        </span>
        <span className="mt-0.5 block text-xs text-pretty text-muted-foreground">
          {ROLE_DESCRIPTIONS_RU[props.role]}
        </span>
      </span>
      {props.current ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /> : null}
      {props.busy ? <InlineSpinner className="mt-0.5 text-muted-foreground" /> : null}
    </button>
  );
}
