import { ROLE_LABELS_RU } from '@family/shared';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { relativeTime } from '@/shared/lib/i18n';
import { ADMIN_RU, PROVIDER_LABELS_RU } from '../locale';
import type { PendingMember } from '../api';

/**
 * One signup awaiting a decision.
 *
 * Answers the three questions an admin actually has, in the order they ask
 * them: **who** (avatar + name + email), **how they got in** (which provider —
 * "вход через Telegram" is often the only thing that identifies a relative who
 * has no email), and **when**.
 *
 * The two actions are full-width, ≥44px, side by side. Approving is the
 * affirmative default; rejecting is an outline button, not a red one — a
 * declined signup is reversible and does not deserve destructive styling here.
 * The consequence-heavy red is reserved for suspension.
 */
export function PendingMemberCard(props: {
  member: PendingMember;
  isBusy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { member } = props;
  const providers = member.providers ?? [];

  return (
    <li className="rounded-2xl border border-border bg-card p-3">
      <div className="flex items-start gap-3">
        <UserAvatar user={{ id: member.id, displayName: member.displayName }} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{member.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {member.email ?? ADMIN_RU.emailUnknown}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {providers.length > 0 ? (
              providers.map((provider) => (
                <Badge key={provider} variant="secondary" className="font-normal">
                  {ADMIN_RU.signedInWith} {PROVIDER_LABELS_RU[provider]}
                </Badge>
              ))
            ) : (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {ROLE_LABELS_RU[member.role]}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {ADMIN_RU.requestedPrefix} {relativeTime(member.createdAt)}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          className="min-h-11 flex-1"
          disabled={props.isBusy}
          onClick={props.onApprove}
        >
          {ADMIN_RU.approve}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 flex-1"
          disabled={props.isBusy}
          onClick={props.onReject}
        >
          {ADMIN_RU.reject}
        </Button>
      </div>
    </li>
  );
}
