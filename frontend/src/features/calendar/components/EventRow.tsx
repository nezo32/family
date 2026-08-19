import type { EventOccurrenceResponse, PublicUser } from '@family/shared';
import { Cake, MapPin, Repeat } from 'lucide-react';
import { Badge } from '@/shared/ui/badge';
import { cn } from '@/shared/lib/utils';
import { formatTime } from '@/shared/lib/format';
import { occurrenceColor } from '../calendar-model';
import { CALENDAR_RU } from '../locale';
import { AttendeeAvatars } from './EventChip';

/**
 * One event in a list — the agenda's row and the selected day's row.
 *
 * All-day events show «Весь день» instead of a clock: rendering `00:00` for
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
  const color = occurrenceColor(occurrence);
  const isBirthday = occurrence.sourceKind === 'user_birthday';
  const isCancelled = occurrence.status === 'cancelled';

  return (
    <button
      type="button"
      onClick={() => {
        props.onSelect(occurrence);
      }}
      data-testid="event-row"
      data-source-kind={occurrence.sourceKind}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-xl border border-transparent bg-card px-3 py-2 text-left transition-colors',
        'hover:border-border hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        isCancelled && 'opacity-60',
      )}
    >
      <span
        className="h-8 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />

      <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">
        {occurrence.isAllDay ? CALENDAR_RU.allDay : formatTime(occurrence.startsAt, props.timeZone)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {isBirthday ? <Cake className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
          <span
            className={cn(
              'truncate text-sm font-medium text-foreground',
              isCancelled && 'line-through',
            )}
          >
            {occurrence.title}
          </span>
          {occurrence.isException ? (
            <Repeat className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          ) : null}
        </span>

        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {isBirthday && typeof props.age === 'number' ? (
            <span data-testid="birthday-age">{CALENDAR_RU.age(props.age)}</span>
          ) : null}
          {occurrence.location ? (
            <span className="flex min-w-0 items-center gap-1">
              <MapPin className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{occurrence.location}</span>
            </span>
          ) : null}
          {isCancelled ? (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              {CALENDAR_RU.cancelled}
            </Badge>
          ) : null}
        </span>
      </span>

      <AttendeeAvatars occurrence={occurrence} members={props.members} />
    </button>
  );
}
