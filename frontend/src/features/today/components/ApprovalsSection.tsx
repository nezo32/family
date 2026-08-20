import { Link } from 'react-router-dom';
import { ROUTES } from '@/shared/lib/routes';
import { relativeTime } from '@/shared/lib/i18n';
import { Section } from '@/shared/ui/section';
import { MemberDisc } from '@/shared/ui/member-disc';
import { TODAY_RU } from '../locale';
import type { DashboardPendingMember } from '../types';

/**
 * Pending member signups, as an ordinary section.
 *
 * A `pending_approval` user gets no session at all (D3): until somebody taps
 * this, the person who signed up last night is staring at «Заявка ещё на
 * рассмотрении». That is why it earns a slot on the home screen rather than
 * living only behind a nav badge.
 *
 * It is *also* an arm of the attention block (§C2). Which one renders is the
 * page's decision, taken once by `pickAttention`: when overdue chores have
 * already claimed the tinted ground, the queue drops back to a quiet section
 * here rather than becoming a second loud thing.
 *
 * Gated on `member:approve` — never on `role === 'admin'` (D4).
 */
export function ApprovalsSection(props: { members: readonly DashboardPendingMember[] }) {
  if (props.members.length === 0) return null;

  return (
    <Section
      label={TODAY_RU.approvalsTitle}
      count={props.members.length}
      action={
        <Link
          to={ROUTES.adminMembers}
          className="rounded-sm underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {TODAY_RU.approvalsAction} ›
        </Link>
      }
    >
      {props.members.slice(0, 3).map((member) => (
        <Link
          key={member.id}
          to={ROUTES.adminMembers}
          className="flex min-h-14 w-full max-w-row-measure items-center gap-3 px-4 py-1.5 transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <MemberDisc id={member.id} displayName={member.displayName} size="md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[17px] leading-6 font-medium text-foreground">
              {member.displayName}
            </span>
            <span className="block truncate text-[13px] leading-[18px] font-medium text-muted-foreground">
              {relativeTime(member.requestedAt)}
            </span>
          </span>
        </Link>
      ))}
    </Section>
  );
}
