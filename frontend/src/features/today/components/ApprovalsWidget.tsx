import { UserRoundPlus } from 'lucide-react';
import { ROUTES } from '@/shared/lib/routes';
import { AvatarGroup } from '@/shared/components/UserAvatar';
import { TODAY_RU, requestCount } from '../locale';
import type { DashboardPendingMember } from '../types';
import { WidgetCard } from './WidgetCard';

/**
 * Pending member signups, for people who may act on them.
 *
 * A `pending_approval` user gets no session at all (D3): until somebody taps
 * this, the person who signed up last night is staring at «Заявка ещё на
 * рассмотрении». That is why it earns a slot on the home screen rather than
 * living only behind a nav badge.
 *
 * Gated on `member:approve` — never on `role === 'admin'` (D4).
 */
export function ApprovalsWidget(props: { members: DashboardPendingMember[] }) {
  if (props.members.length === 0) return null;

  return (
    <WidgetCard
      title={TODAY_RU.approvalsTitle}
      icon={UserRoundPlus}
      meta={requestCount(props.members.length)}
      linkTo={ROUTES.adminMembers}
      linkLabel={TODAY_RU.approvalsAction}
    >
      <div className="flex items-center gap-3">
        <AvatarGroup
          users={props.members.map((member) => ({
            id: member.id,
            displayName: member.displayName,
          }))}
          max={3}
        />
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          <span className="block truncate text-foreground">
            {props.members.map((member) => member.displayName).join(', ')}
          </span>
          {TODAY_RU.approvalsHint}
        </p>
      </div>
    </WidgetCard>
  );
}
