import type { EventOccurrenceResponse, PublicUser } from '@family/shared';
import { Cake } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { occurrenceColor, startTimeLabel } from '../calendar-model';
import { CALENDAR_RU } from '../locale';

/**
 * The month-grid chip. Deliberately **not** interactive: the whole day cell is
 * the tap target (a chip inside a button is invalid markup, and a 14 px chip is
 * not a 44 px target). Selecting a day reveals its full rows underneath.
 */
export function EventChip(props: {
  occurrence: EventOccurrenceResponse;
  timeZone: string;
  className?: string;
}) {
  const { occurrence } = props;
  const color = occurrenceColor(occurrence);
  const time = startTimeLabel(occurrence, props.timeZone);
  const isBirthdayChip = occurrence.sourceKind === 'user_birthday';
  const isCancelled = occurrence.status === 'cancelled';

  return (
    <span
      className={cn(
        'flex w-full items-center gap-1 overflow-hidden rounded-[5px] border-l-2 bg-muted/60 px-1 py-px text-[10px] leading-tight',
        isCancelled && 'line-through opacity-55',
        props.className,
      )}
      style={{ borderLeftColor: color }}
    >
      {isBirthdayChip ? (
        <Cake className="size-2.5 shrink-0" style={{ color }} aria-hidden />
      ) : time ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">{time}</span>
      ) : null}
      <span className="truncate text-foreground">{occurrence.title}</span>
    </span>
  );
}

/** The phone-sized version of the same information: colour only. */
export function EventDot(props: { occurrence: EventOccurrenceResponse }) {
  return (
    <span
      className="size-1.5 rounded-full"
      style={{ backgroundColor: occurrenceColor(props.occurrence) }}
      aria-hidden
    />
  );
}

/** Overlapping attendee avatars, resolved against the family roster. */
export function AttendeeAvatars(props: {
  occurrence: EventOccurrenceResponse;
  members: Map<string, PublicUser>;
  max?: number;
}) {
  const shown = props.occurrence.attendees.slice(0, props.max ?? 3);
  const rest = props.occurrence.attendees.length - shown.length;
  if (shown.length === 0) return null;

  return (
    <span className="flex shrink-0 items-center -space-x-1.5" aria-label={CALENDAR_RU.attendees}>
      {shown.map((attendee) => {
        const member = props.members.get(attendee.userId);
        const name = member?.displayName ?? '?';
        return (
          <span
            key={attendee.userId}
            title={name}
            className={cn(
              'flex size-5 items-center justify-center overflow-hidden rounded-full bg-secondary text-[9px] font-medium text-secondary-foreground ring-2 ring-background',
              attendee.rsvp === 'no' && 'opacity-45',
            )}
          >
            {member?.avatarUrl ? (
              <img src={member.avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              name.slice(0, 1).toUpperCase()
            )}
          </span>
        );
      })}
      {rest > 0 ? (
        <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-2 ring-background">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
