import { UserRoundPlus } from 'lucide-react';
import { ROUTES } from '@/shared/lib/routes';
import { AvatarGroup } from '@/shared/components/UserAvatar';
import { TODAY_RU, requestCount } from '../locale';
import type { TodayApprovalsSection } from '../types';
import { WidgetCard } from './WidgetCard';

/**
 * Pending member signups, for people who may act on them.
 *
 * A `pending_approval` user has no session at all (D3): until somebody taps
 * this, a family member who signed up last night is staring at «Заявка ещё на
 * рассмотрении». That is why it earns a slot on the home screen instead of
 * living only behind the admin nav badge.
 *
 * Gated on `member:approve` by the page — never on `role === 'admin'` (D4).
 */
export function ApprovalsWidget(props: { approvals: TodayApprovalsSection }) {
  const { approvals } = props;
  if (approvals.pendingCount === 0) return null;

  return (
    <WidgetCard
      title={TODAY_RU.approvalsTitle}
      icon={UserRoundPlus}
      meta={requestCount(approvals.pendingCount)}
      linkTo={ROUTES.adminMembers}
      linkLabel={TODAY_RU.approvalsAction}
    >
      <div className="flex items-center gap-3">
        {approvals.members.length > 0 ? (
          <AvatarGroup
            users={approvals.members.map((member) => ({
              id: member.id,
              displayName: member.displayName,
              avatarUrl: member.avatarUrl,
            }))}
            max={3}
          />
        ) : null}
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          <span className="block truncate text-foreground">
            {approvals.members.map((member) => member.displayName).join(', ')}
          </span>
          {TODAY_RU.approvalsHint}
        </p>
      </div>
    </WidgetCard>
  );
}
