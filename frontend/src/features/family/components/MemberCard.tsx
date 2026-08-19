import { ChevronRight } from 'lucide-react';
import type { FairnessMember } from '@family/shared';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { MONTHS_GENITIVE } from '@/shared/lib/i18n';
import { FAMILY_RU, dayCount } from '../locale';
import type { RosterMember } from '../api';
import { RoleBadge, StatusBadge } from './RoleBadge';
import { WeekLoadBar } from './WeekLoadBar';

/**
 * One member of the family roster.
 *
 * The whole card is the tap target (≥44px, full width) and opens the detail
 * sheet — a phone has no room for a row of icon buttons, and a single large
 * target is what a thumb actually hits.
 *
 * Rendering order is the roster's order, which is `sortOrder` then name. It is
 * never sorted by load: see `WeekLoadBar` and D5.
 */
export function MemberCard(props: {
  member: RosterMember;
  load: FairnessMember | undefined;
  isSelf: boolean;
  onOpen: () => void;
}) {
  const { member } = props;
  const birthday = birthdayLabel(member.birthDate);

  return (
    <li>
      <button
        type="button"
        onClick={props.onOpen}
        className="flex w-full min-h-11 items-start gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <UserAvatar
          user={{ id: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl }}
          size="md"
          highlighted={props.isSelf}
        />

        <span className="min-w-0 flex-1 space-y-1.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold text-foreground">
              {member.displayName}
            </span>
            {props.isSelf ? (
              <span className="text-xs text-muted-foreground">{FAMILY_RU.youBadge}</span>
            ) : null}
          </span>

          <span className="flex flex-wrap items-center gap-1.5">
            <RoleBadge role={member.role} />
            <StatusBadge status={member.status} />
          </span>

          {birthday ? (
            <span className="block text-xs text-muted-foreground">{birthday}</span>
          ) : null}

          <WeekLoadBar load={props.load} className="pt-0.5" />
        </span>

        <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </li>
  );
}

/**
 * A birth date is a **floating calendar date**, not an instant: parsing
 * `1998-03-07` with `new Date()` and formatting it in the family timezone can
 * shift it by a day. The parts are therefore read straight out of the string
 * and never converted.
 */
function birthdayLabel(birthDate: string | null | undefined): string | null {
  if (!birthDate) return null;
  const parts = birthDate.split('-');
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
  const monthName = MONTHS_GENITIVE[month - 1];
  if (!monthName) return null;

  const days = daysUntil(month, day);
  if (days === 0) return FAMILY_RU.birthdayToday;
  if (days !== null && days <= 30) {
    return `${FAMILY_RU.birthdayInDays} ${dayCount(days)} — ${String(day)} ${monthName}`;
  }
  return `${FAMILY_RU.birthdayPrefix} ${String(day)} ${monthName}`;
}

function daysUntil(month: number, day: number): number | null {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), month - 1, day);
  if (next.getTime() < today.getTime()) next = new Date(now.getFullYear() + 1, month - 1, day);
  const diff = Math.round((next.getTime() - today.getTime()) / 86_400_000);
  return Number.isFinite(diff) ? diff : null;
}
