import { CalendarDays, MapPin } from 'lucide-react';
import type { EventOccurrenceResponse } from '@family/shared';
import { ROUTES } from '@/shared/lib/routes';
import { cn } from '@/shared/lib/utils';
import { formatTime } from '@/shared/lib/format';
import { TODAY_RU, eventCount } from '../locale';
import type { TodayEventsSection } from '../types';
import { WidgetCard } from './WidgetCard';

/** Today and tomorrow only — the calendar screen owns everything further out. */
export function EventsWidget(props: { events: TodayEventsSection }) {
  const { events } = props;
  const total = events.today.length + events.tomorrow.length;

  return (
    <WidgetCard
      title={TODAY_RU.eventsTitle}
      icon={CalendarDays}
      meta={total > 0 ? eventCount(total) : undefined}
      linkTo={ROUTES.calendar}
      linkLabel={TODAY_RU.eventsAll}
    >
      {total === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{TODAY_RU.eventsEmpty}</p>
      ) : (
        <div className="space-y-3">
          <EventGroup label={TODAY_RU.eventsToday} items={events.today} />
          <EventGroup label={TODAY_RU.eventsTomorrow} items={events.tomorrow} muted />
        </div>
      )}
    </WidgetCard>
  );
}

function EventGroup(props: { label: string; items: EventOccurrenceResponse[]; muted?: boolean }) {
  if (props.items.length === 0) return null;

  return (
    <div>
      <p className="pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.label}
      </p>
      <ul className="space-y-1">
        {props.items.slice(0, 4).map((event) => (
          <li key={event.id} className="flex min-h-11 items-center gap-3">
            {/* Fixed-width time gutter: the eye scans one column, not a ragged edge. */}
            <span
              className={cn(
                'w-16 shrink-0 text-xs font-medium tabular-nums',
                props.muted ? 'text-muted-foreground/70' : 'text-muted-foreground',
              )}
            >
              {event.isAllDay ? TODAY_RU.allDay : formatTime(event.startsAt)}
            </span>
            <span
              className="h-8 w-1 shrink-0 rounded-full"
              style={{ backgroundColor: event.color ?? 'var(--color-primary)' }}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {event.title}
              </span>
              {event.location ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <MapPin className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{event.location}</span>
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
