import { ROLE_LABELS_RU, type UserStatus } from '@family/shared';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { ADMIN_RU, STATUS_LABELS_RU } from '../locale';
import type { MemberRow } from '../api';

/** Status colour: only a suspension is a warning; the rest is neutral. */
function statusVariant(status: UserStatus): 'secondary' | 'destructive' | 'outline' {
  if (status === 'suspended') return 'destructive';
  if (status === 'active') return 'secondary';
  return 'outline';
}

/**
 * An existing member, with the moderation action that applies to their current
 * status — suspend for an active member, reactivate for a suspended one.
 *
 * The buttons render only when `canModerate` is true, and that flag comes from
 * `useCan()` upstream. A member without the permission does not get a disabled
 * button: a control you can see but never use is worse than one that is not
 * there, and it leaks what the screen is for.
 *
 * Your own row carries «Это вы» — the same badge `/family` uses — and no
 * moderation button. Suspending yourself ends every one of your own sessions,
 * which is not a mistake worth leaving one tap away.
 */
export function MemberAdminRow(props: {
  member: MemberRow;
  /** The signed-in admin's own row. */
  isSelf?: boolean;
  canModerate: boolean;
  isBusy: boolean;
  onSuspend: () => void;
  onReactivate: () => void;
}) {
  const { member } = props;
  const suspended = member.status === 'suspended';

  return (
    <li className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
      <UserAvatar user={{ id: member.id, displayName: member.displayName }} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{member.displayName}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-normal">
            {ROLE_LABELS_RU[member.role]}
          </Badge>
          <Badge variant={statusVariant(member.status)} className="font-normal">
            {STATUS_LABELS_RU[member.status]}
          </Badge>
          {props.isSelf ? (
            <Badge variant="secondary" className="font-normal">
              {ADMIN_RU.youBadge}
            </Badge>
          ) : null}
        </div>
      </div>

      {props.canModerate && !props.isSelf ? (
        <Button
          type="button"
          size="sm"
          variant={suspended ? 'outline' : 'ghost'}
          className="min-h-11 shrink-0"
          disabled={props.isBusy}
          onClick={suspended ? props.onReactivate : props.onSuspend}
        >
          {suspended ? ADMIN_RU.reactivate : ADMIN_RU.suspend}
        </Button>
      ) : null}
    </li>
  );
}
