import { ChevronRight } from 'lucide-react';
import { ROLE_LABELS_RU } from '@family/shared';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { MONTHS_GENITIVE } from '@/shared/lib/i18n';
import { FAMILY_RU, dayCount } from '../locale';
import type { RosterMember } from '../api';
import { RoleBadge, StatusBadge } from './RoleBadge';

/**
 * One member of the family roster, as a **56px row** (§D9).
 *
 * ```
 *  (П)  Павел                                    родитель  ›
 *       День рождения через 4 дня — 24 августа
 * ```
 *
 * The whole row is the tap target and opens the detail sheet — a phone has no
 * room for a row of icon buttons, and a single large target is what a thumb
 * actually hits.
 *
 * The role is `meta` text, not a badge, for the four ordinary roles: a badge
 * per row down a roster of five is five outlined boxes saying five different
 * words in the same shape, which reads as a status system rather than as "this
 * is Mum". `RoleBadge` survives for **owner and admin only**, where it is
 * genuinely a fact about permissions rather than about who somebody is; and
 * `StatusBadge` stays because «Доступ приостановлен» is worth interrupting for.
 *
 * Rendering order is the roster's order — `sortOrder`, then name. It is never
 * sorted by load, and it carries no per-person numbers at all (D5).
 */
export function MemberCard(props: { member: RosterMember; isSelf: boolean; onOpen: () => void }) {
  const { member } = props;
  const birthday = birthdayLabel(member.birthDate);
  const privileged = member.role === 'owner' || member.role === 'admin';

  const meta = [privileged ? null : ROLE_LABELS_RU[member.role], birthday].filter(
    (part): part is string => Boolean(part),
  );

  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex min-h-14 w-full max-w-row-measure items-center gap-3 px-4 py-1.5 text-left transition-colors hover:bg-muted/40 active:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <UserAvatar
        user={{ id: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl }}
        size="sm"
        highlighted={props.isSelf}
      />

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[17px] leading-6 font-medium text-foreground">
            {member.displayName}
          </span>
          {props.isSelf ? (
            <span className="shrink-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
              {FAMILY_RU.youBadge}
            </span>
          ) : null}
        </span>
        {meta.length > 0 ? (
          <span className="block truncate text-[13px] leading-[18px] font-medium text-muted-foreground">
            {meta.join(' · ')}
          </span>
        ) : null}
      </span>

      <span className="flex shrink-0 items-center gap-1.5">
        {privileged ? <RoleBadge role={member.role} /> : null}
        <StatusBadge status={member.status} />
      </span>

      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
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
