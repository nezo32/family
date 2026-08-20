import type { ActivityItem } from '@family/shared';
import { MemberDisc } from '@/shared/ui/member-disc';
import { relativeTime } from '@/shared/lib/i18n';
import type { Roster } from '../hooks';
import { WALL_RU } from '../locale';

/**
 * One line of "who did what" — the quiet layer of the board.
 *
 * `summary` is a **pre-rendered Russian sentence** frozen at write time («Папа
 * выполнил задачу „Вынести мусор"»). It is rendered verbatim: it has to stay
 * readable after the referenced task is renamed or deleted, and re-composing it
 * here would couple the board to every other module's wording. `entityType` /
 * `entityId` are for the link, nothing else.
 *
 * Visually this is a note somebody scribbled in the margin: no title, no
 * reactions, no thread, muted 15px on the board's own surface. An announcement
 * must never have to compete with «Лиза полила цветы», and the difference in
 * *size* is what says so — if the two layers ever start looking alike, the
 * board stops working as a board.
 */
export function ActivityRow(props: { activity: ActivityItem; roster: Roster }) {
  const { activity } = props;
  const name = props.roster.nameOf(activity.actorId);

  return (
    <div className="flex w-full max-w-row-measure items-start gap-2 px-4 py-2.5">
      {activity.actorId ? (
        <MemberDisc id={activity.actorId} displayName={name} className="mt-px" />
      ) : (
        <span
          aria-hidden
          className="mt-2 size-1.5 shrink-0 rounded-full bg-border"
          title={WALL_RU.board.systemAuthor}
        />
      )}
      {/*
        The time rides *inside* the sentence rather than beside it. Measured at
        320px, a right-aligned timestamp next to a wrapping summary reads as
        «Лиза выполнила · 55 минут назад · задачу „Полить цветы"» — the clock
        interrupts the sentence mid-clause. Inline, it wraps where the line
        wraps and the sentence stays a sentence.
      */}
      <p className="min-w-0 flex-1 wrap-break-word text-[15px] leading-[22px] text-muted-foreground">
        {activity.summary}
        <span aria-hidden> · </span>
        <time
          dateTime={activity.createdAt}
          title={activity.createdAt}
          className="whitespace-nowrap text-[13px] font-medium text-muted-foreground/80"
        >
          {relativeTime(activity.createdAt)}
        </time>
      </p>
    </div>
  );
}
