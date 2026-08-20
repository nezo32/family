import type { EventOccurrenceResponse, PublicUser } from '@family/shared';
import { Cake } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { useAvatarSource } from '@/shared/api/authed-image';
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

/**
 * The phone-sized version of the same information: a **3px tick**, not a dot
 * (§D3).
 *
 * It is the same 3px mark the day rail uses on every other list in the app, at
 * the one size a 45px month cell can afford — so a colour a reader learned on
 * the agenda still means the same thing in the grid.
 */
export function EventDot(props: { occurrence: EventOccurrenceResponse }) {
  return (
    <span
      className="h-3 w-[3px] shrink-0 rounded-full"
      style={{ backgroundColor: occurrenceColor(props.occurrence) }}
      aria-hidden
    />
  );
}

/**
 * One 20px face in the attendee row.
 *
 * Its own component because resolving an avatar takes a hook, and this used to
 * be a bare `<img src={member.avatarUrl}>` inside a `.map()`. That worked for
 * the Google URLs every account currently has and would have broken silently
 * the day somebody uploaded a photo through the cropper: an uploaded avatar is
 * `/api/users/:id/avatar`, behind the session, and an `<img>` sends no bearer
 * token — 401, broken image. `useAvatarSource` handles both shapes and falls
 * back to the initial.
 */
function AttendeeFace(props: { member: PublicUser | undefined; declined: boolean }) {
  const name = props.member?.displayName ?? '?';
  const { src, external } = useAvatarSource(props.member?.avatarUrl);

  return (
    <span
      title={name}
      className={cn(
        'flex size-5 items-center justify-center overflow-hidden rounded-full bg-secondary text-[9px] font-medium text-secondary-foreground ring-2 ring-background',
        props.declined && 'opacity-45',
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          decoding="async"
          {...(external ? { referrerPolicy: 'no-referrer' as const } : {})}
          className="size-full object-cover"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
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
      {shown.map((attendee) => (
        <AttendeeFace
          key={attendee.userId}
          member={props.members.get(attendee.userId)}
          declined={attendee.rsvp === 'no'}
        />
      ))}
      {rest > 0 ? (
        <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-2 ring-background">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
