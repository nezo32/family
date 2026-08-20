import { useState } from 'react';
import type { ActivityItem } from '@family/shared';
import { MemberDisc } from '@/shared/ui/member-disc';
import { relativeTime } from '@/shared/lib/i18n';
import type { Roster } from '../hooks';
import { WALL_RU } from '../locale';

/** Three lines, then «и ещё N» — enough to see the shape of the day. */
const SHOWN = 3;

/**
 * «Кто что сделал» — one card per **run**, not one card per line (§D7.6).
 *
 * > A run of consecutive activity items — nothing else between them in the
 * > stream — renders as one card, not as one card each.
 *
 * This is the mechanic that makes a chronological feed survivable, and it is
 * the direct answer to "recency ordering treats an unanswered poll and «Лиза
 * полила цветы» identically". Without it a Saturday of chores produces twenty
 * near-identical muted lines and the announcement about Sunday sits below all
 * of them — exactly the burial the board's ordering used to prevent.
 *
 * Three rules the card must keep:
 *
 * - **`summary` is rendered verbatim.** It is a pre-rendered Russian sentence
 *   frozen at write time («Папа выполнил задачу „Вынести мусор“»); it has to
 *   stay readable after the referenced task is renamed or deleted, and
 *   re-composing it here would couple Стена to every other module's wording.
 * - **The time rides inside the sentence.** Measured at 320px, a right-aligned
 *   timestamp next to a wrapping summary reads as «Лиза выполнила · 55 минут
 *   назад · задачу „Полить цветы“» — the clock interrupts the clause.
 * - **No reactions, no thread, no `⋯`.** An activity line is a scribble in the
 *   margin; a foot line would give it the weight of an announcement. The
 *   difference in *height* is the hierarchy, and if a digest ever grows to the
 *   size of an announcement this screen has stopped working.
 *
 * «и ещё N» expands **in place**: the items are already in the page, so it
 * fetches nothing and navigates nowhere.
 */
export function ActivityDigest(props: { items: readonly ActivityItem[]; roster: Roster }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = props.items.length - SHOWN;
  const shown = expanded ? props.items : props.items.slice(0, SHOWN);

  return (
    <div className="flex w-full max-w-row-measure flex-col gap-1 px-4 py-2.5">
      {shown.map((activity) => (
        <ActivityLine key={activity.id} activity={activity} roster={props.roster} />
      ))}

      {hidden > 0 ? (
        <button
          type="button"
          // 44px of target, not 25×18 of text: §F1 applies to a text link on a
          // coarse pointer exactly as it applies to an icon button.
          className="-mx-2 flex min-h-11 min-w-11 items-center justify-start self-start rounded-sm px-2 text-[13px] leading-[18px] font-medium text-muted-foreground underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((value) => !value);
          }}
        >
          {expanded ? WALL_RU.feed.collapse : WALL_RU.feed.andMore(hidden)}
        </button>
      ) : null}
    </div>
  );
}

function ActivityLine(props: { activity: ActivityItem; roster: Roster }) {
  const { activity } = props;
  const name = props.roster.nameOf(activity.actorId);

  return (
    <div className="flex items-start gap-2">
      {activity.actorId ? (
        <MemberDisc
          id={activity.actorId}
          displayName={name}
          avatarUrl={props.roster.byId.get(activity.actorId)?.avatarUrl ?? null}
          className="mt-px"
        />
      ) : (
        <span
          aria-hidden
          className="mt-2 size-1.5 shrink-0 rounded-full bg-border"
          title={WALL_RU.feed.systemAuthor}
        />
      )}
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
