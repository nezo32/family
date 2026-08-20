import type { ReactNode } from 'react';
import { MemberDisc, type MemberDiscSize } from '@/shared/ui/member-disc';
import { cn } from '@/shared/lib/utils';
import { relativeTime } from '@/shared/lib/i18n';
import type { Roster } from '../hooks';

/**
 * «(М) Мама · 3 минуты назад» — one line, for anything with an author.
 *
 * Two changes from what this was, both of them §B:
 *
 * - **The disc comes from the member ramp, not from a hash of the id.**
 *   `UserAvatar` tints its fallback with `oklch(0.88 0.06 <hash>)`, i.e. any of
 *   360 hues — which is how a pink «БН» disc ended up sitting on a sand card.
 *   `MemberDisc` picks one of the five perceptually-spaced member colours, so a
 *   person is the same colour here, on the day rail and on Семья (§B4).
 * - **One line, not two.** The name over the timestamp made every note on the
 *   board 20px taller for information that fits beside itself. A board is rows.
 *
 * A `null` author means the app itself wrote the row (goal reached, birthday,
 * weekly digest), which reads as «Семейный бот» rather than as a missing name.
 */
export function AuthorLine(props: {
  roster: Roster;
  authorId: string | null;
  createdAt: string;
  size?: MemberDiscSize;
  /** Right-hand slot: badges, the overflow menu. */
  trailing?: ReactNode;
  className?: string;
}) {
  const name = props.roster.nameOf(props.authorId);
  const avatarUrl = props.authorId
    ? (props.roster.byId.get(props.authorId)?.avatarUrl ?? null)
    : null;

  return (
    <div className={cn('flex min-w-0 items-center gap-2', props.className)}>
      <MemberDisc
        id={props.authorId}
        displayName={name}
        avatarUrl={avatarUrl}
        size={props.size ?? 'sm'}
      />
      <span className="min-w-0 truncate text-[15px] leading-[22px] font-medium">{name}</span>
      <span aria-hidden className="shrink-0 text-[13px] leading-[18px] opacity-50">
        ·
      </span>
      <time
        dateTime={props.createdAt}
        className="shrink-0 truncate text-[13px] leading-[18px] font-medium opacity-70"
        title={props.createdAt}
      >
        {relativeTime(props.createdAt)}
      </time>
      {props.trailing ? (
        <div className="ms-auto flex shrink-0 items-center gap-1">{props.trailing}</div>
      ) : null}
    </div>
  );
}
