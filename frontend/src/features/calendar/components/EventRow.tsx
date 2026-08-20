import type { EventOccurrenceResponse, PublicUser } from '@family/shared';
import { Cake, MapPin, Repeat } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { formatTime } from '@/shared/lib/format';
import { DayRailRow } from '@/shared/ui/day-rail';
import { occurrenceColor } from '../calendar-model';
import { CALENDAR_RU } from '../locale';
import { AttendeeAvatars } from './EventChip';

/**
 * One event in a list — the agenda's row and the selected day's row — hung off
 * the day rail (§C3).
 *
 * ```
 *  19:00 ┃  Ужин у бабушки                            (П)(М)
 *        ┃  Ул. Садовая, 12
 * ```
 *
 * The rail is what makes Сегодня, Задачи and Календарь read as three views of
 * one board: the time sits in a fixed 56px column at every breakpoint, so the
 * eye scans one edge instead of a ragged left margin that moves with each
 * title's length.
 *
 * All-day events show «Весь день» instead of a clock. Rendering `00:00` for
 * them is how an all-day event starts looking like a midnight appointment, and
 * a birthday on the 7th starts drifting to the 6th.
 */
export function EventRow(props: {
  occurrence: EventOccurrenceResponse;
  members: Map<string, PublicUser>;
  timeZone: string;
  /** Age turned, for `user_birthday` occurrences only. */
  age?: number | null;
  onSelect: (occurrence: EventOccurrenceResponse) => void;
}) {
  const { occurrence } = props;
  const isBirthday = occurrence.sourceKind === 'user_birthday';
  const isCancelled = occurrence.status === 'cancelled';

  const meta = (
    <>
      {isBirthday && typeof props.age === 'number' ? (
        <span data-testid="birthday-age">{CALENDAR_RU.age(props.age)}</span>
      ) : null}
      {occurrence.location ? (
        <span className="flex min-w-0 items-center gap-1">
          <MapPin className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{occurrence.location}</span>
        </span>
      ) : null}
      {isCancelled ? <span>{CALENDAR_RU.cancelled.toLowerCase()}</span> : null}
    </>
  );

  const hasMeta =
    (isBirthday && typeof props.age === 'number') || Boolean(occurrence.location) || isCancelled;

  return (
    <DayRailRow
      as="button"
      rail={
        occurrence.isAllDay ? CALENDAR_RU.allDay : formatTime(occurrence.startsAt, props.timeZone)
      }
      muted={isCancelled}
      tick={
        <span
          aria-hidden
          className="w-[3px] shrink-0 self-stretch rounded-full"
          // The one place a per-series colour is still honoured: a family may
          // set one, and `occurrenceColor` now falls back to the five-colour
          // ramp rather than to a hash over all 360 hues (§B1).
          style={{ backgroundColor: occurrenceColor(occurrence) }}
        />
      }
      className={cn(
        'text-left transition-colors hover:bg-muted/40 active:bg-muted/60',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        isCancelled && 'opacity-60',
      )}
      trailing={<AttendeeAvatars occurrence={occurrence} members={props.members} />}
      elementProps={{
        type: 'button',
        onClick: () => {
          props.onSelect(occurrence);
        },
        'data-testid': 'event-row',
        'data-source-kind': occurrence.sourceKind,
      }}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {isBirthday ? (
          <Cake className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : null}
        <span
          className={cn(
            'truncate text-[17px] leading-6 font-medium text-foreground',
            isCancelled && 'line-through',
          )}
        >
          {occurrence.title}
        </span>
        {occurrence.isException ? (
          <Repeat
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label={CALENDAR_RU.changedThisTime}
          />
        ) : null}
      </span>

      {hasMeta ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] leading-[18px] font-medium text-muted-foreground">
          {meta}
        </span>
      ) : null}
    </DayRailRow>
  );
}
