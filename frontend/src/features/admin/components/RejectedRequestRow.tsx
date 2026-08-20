import { Badge } from '@/shared/ui/badge';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { relativeTime } from '@/shared/lib/i18n';
import { ADMIN_RU, STATUS_LABELS_RU } from '../locale';
import type { MemberRow } from '../api';

/**
 * A join request that was declined.
 *
 * Deliberately **actionless**. A rejected row is not a member: suspending it
 * would 409 against a conditional update that only accepts `active`, and
 * reinstating it is not a transition that exists — the person applies again
 * instead, which they now can, because rejecting released the identity they
 * applied with. A button that could only ever fail is worse than no button.
 *
 * Rendered muted and half-opacity for the same reason the roster no longer
 * carries these rows at all: this is history, not the family. It exists so an
 * admin who declined somebody by accident can see who that was — which is the
 * one thing releasing the identity would otherwise have taken away.
 */
export function RejectedRequestRow(props: { member: MemberRow }) {
  const { member } = props;

  return (
    <li className="flex items-center gap-3 rounded-2xl border border-dashed border-border bg-muted/30 p-3">
      <div className="opacity-60">
        <UserAvatar
          user={{
            id: member.id,
            displayName: member.displayName,
            avatarUrl: member.avatarUrl,
          }}
          size="sm"
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-muted-foreground">{member.displayName}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {STATUS_LABELS_RU.rejected}
          </Badge>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {member.rejectedReason ?? ADMIN_RU.rejectedNoReason}
          </span>
        </div>
        {member.createdAt ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {ADMIN_RU.requestedPrefix} {relativeTime(member.createdAt)}
          </p>
        ) : null}
      </div>
    </li>
  );
}
