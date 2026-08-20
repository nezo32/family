import { AlarmClock, ShoppingCart, UserRoundPlus } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useCan } from '@/shared/auth/use-can';
import { ROUTES } from '@/shared/lib/routes';
import { Section } from '@/shared/ui/section';
import { MemberDisc } from '@/shared/ui/member-disc';
import { relativeTime } from '@/shared/lib/i18n';
import { TODAY_RU, taskCount } from '../locale';
import type { DashboardPendingMember, DashboardShopping, DashboardTask } from '../types';
import { TaskRow } from './TaskRow';

/**
 * Band 2 of §C2: **at most one** block per screen may use the tinted ground.
 *
 * The old home screen stacked six white cards of near-identical weight — 1661px
 * of them on an 844px viewport — each with its own icon, its own count and its
 * own footer link. Six things shouting is a screen where nothing was decided,
 * and the three-second question ("does anything need me before I put my shoes
 * on?") went unanswered.
 *
 * So exactly one thing gets the clay wash, chosen by a **fixed precedence**:
 *
 *   overdue tasks → pending member approvals → urgent shopping → nothing
 *
 * and everything that does not win stays an ordinary section in band 3. The
 * precedence is fixed rather than "whatever is biggest" on purpose: a rule the
 * reader can learn is worth more than one that is always locally optimal.
 *
 * When nothing qualifies this renders `null` and the band simply is not there.
 * An attention block that says "nothing needs your attention" is furniture.
 */

export type AttentionKind = 'overdue' | 'approvals' | 'shopping' | null;

/**
 * Which block wins, decided once by the page so band 3 knows what *not* to
 * repeat. Exported because that decision has two consumers, and duplicating it
 * is how the same list ends up on screen twice — which is the defect this
 * screen is being rebuilt to remove.
 */
export function pickAttention(input: {
  overdue: readonly DashboardTask[];
  approvals: readonly DashboardPendingMember[] | null;
  shopping: DashboardShopping | null;
}): AttentionKind {
  if (input.overdue.length > 0) return 'overdue';
  if (input.approvals && input.approvals.length > 0) return 'approvals';
  if (input.shopping && input.shopping.urgent.length > 0) return 'shopping';
  return null;
}

/** How many rows fit before the block stops being glanceable at arm's length. */
const VISIBLE = 3;

export function AttentionBlock(props: {
  kind: AttentionKind;
  overdue: readonly DashboardTask[];
  approvals: readonly DashboardPendingMember[] | null;
  shopping: DashboardShopping | null;
  onComplete: (occurrenceId: string) => void;
}) {
  const { can } = useCan();

  if (props.kind === 'overdue') {
    const shown = props.overdue.slice(0, VISIBLE);
    const rest = props.overdue.length - shown.length;
    return (
      <AttentionShell
        icon={AlarmClock}
        title={TODAY_RU.overdueTitle}
        count={props.overdue.length}
        to={ROUTES.tasks}
        footnote={rest > 0 ? `+ ${taskCount(rest)}` : undefined}
      >
        {shown.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            overdue
            canComplete={can('task:complete', task)}
            onComplete={props.onComplete}
          />
        ))}
      </AttentionShell>
    );
  }

  if (props.kind === 'approvals') {
    const members = props.approvals ?? [];
    return (
      <AttentionShell
        icon={UserRoundPlus}
        title={TODAY_RU.approvalsTitle}
        count={members.length}
        to={ROUTES.adminMembers}
      >
        {members.slice(0, VISIBLE).map((member) => (
          <div
            key={member.id}
            className="flex min-h-14 w-full max-w-row-measure items-center gap-3 px-4 py-1.5"
          >
            <MemberDisc id={member.id} displayName={member.displayName} size="md" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[17px] leading-6 font-medium">
                {member.displayName}
              </span>
              <span className="block truncate text-[13px] leading-[18px] font-medium opacity-80">
                {member.email ?? relativeTime(member.requestedAt)}
              </span>
            </span>
          </div>
        ))}
      </AttentionShell>
    );
  }

  if (props.kind === 'shopping' && props.shopping) {
    const items = props.shopping.urgent;
    return (
      <AttentionShell
        icon={ShoppingCart}
        title={TODAY_RU.shoppingTitle}
        count={items.length}
        to={ROUTES.shopping}
      >
        {items.slice(0, VISIBLE).map((item) => (
          <div
            key={item.id}
            className="flex min-h-14 w-full max-w-row-measure items-center gap-3 px-4 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-[17px] leading-6 font-medium">
              {item.name}
            </span>
            {item.quantity ? (
              <span className="shrink-0 text-[13px] leading-[18px] font-medium tabular-nums opacity-80">
                {item.quantity}
                {item.unit ? ` ${item.unit}` : ''}
              </span>
            ) : null}
          </div>
        ))}
      </AttentionShell>
    );
  }

  return null;
}

/**
 * The wash, the heading and the one link — identical for all three arms so the
 * block is recognisably *the same slot* whatever happens to be in it today.
 *
 * The heading is the first child of the section body rather than part of the
 * `Section` header because the header sits *outside* the surface at `meta`
 * weight (that is what stops a section reading as a card), and «Просрочено · 1»
 * is the loud line — it belongs on the wash.
 */
function AttentionShell(props: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  count: number;
  to: string;
  footnote?: string | undefined;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <Section
      surface="attention"
      label={
        <span className="flex items-center gap-1.5">
          <Icon className="size-3.5" aria-hidden />
          {TODAY_RU.attentionLabel}
        </span>
      }
    >
      <div className="flex min-h-11 w-full max-w-row-measure items-center gap-3 px-4 py-1.5">
        <h3 className="min-w-0 flex-1 truncate font-display text-[17px] leading-6 font-semibold">
          {props.title}
        </h3>
        <Link
          to={props.to}
          className="shrink-0 rounded-sm text-[13px] leading-[18px] font-medium tabular-nums underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {props.count} ›
        </Link>
      </div>
      {props.children}
      {props.footnote ? (
        <p className="px-4 py-1.5 text-[13px] leading-[18px] font-medium opacity-80">
          {props.footnote}
        </p>
      ) : null}
    </Section>
  );
}
