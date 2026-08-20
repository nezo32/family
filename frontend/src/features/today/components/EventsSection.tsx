import { MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ROUTES } from '@/shared/lib/routes';
import { Section } from '@/shared/ui/section';
import { DayRailDivider, DayRailRow } from '@/shared/ui/day-rail';
import { MemberTick } from '@/shared/ui/member-disc';
import { TODAY_RU } from '../locale';
import type { DashboardEvent, DashboardEvents } from '../types';

/**
 * «Сегодня и завтра» — one railed list, not two cards (§D1).
 *
 * Tomorrow earns its place on a *today* screen because the thing a family
 * actually needs the evening before is «во сколько завтра тренировка». It used
 * to be a second labelled group inside a card, which meant two headings, two
 * paddings and a second «Весь календарь ›» footer for a list of four rows. Now
 * it is one surface with a `DayRailDivider` in the middle: the eye keeps
 * scanning a single left edge and the day marker costs 32px instead of a card.
 *
 * ## The tick colour
 *
 * §B4 assigns the ramp to *people*, and an event has attendees rather than one
 * owner — so the tick is keyed on `seriesId`. That keeps «Тренировка Саши» the
 * same colour every week (it is the same series), keeps every colour inside the
 * palette, and avoids painting the row with the series' stored `color`, which
 * on the seeded data is a stock cold Tailwind hue that fights the sand ground
 * on every screen it lands on.
 */
export function EventsSection(props: { events: DashboardEvents }) {
  const { events } = props;
  const total = events.today.length + events.tomorrow.length;

  if (total === 0) return null;

  return (
    <Section
      label={TODAY_RU.eventsTitle}
      count={total}
      action={
        <Link
          to={ROUTES.calendar}
          className="rounded-sm underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {TODAY_RU.linkEverything} ›
        </Link>
      }
    >
      {events.today.map((event) => (
        <EventRailRow key={event.id} event={event} />
      ))}
      {events.tomorrow.length > 0 ? <DayRailDivider label={TODAY_RU.eventsTomorrow} /> : null}
      {events.tomorrow.map((event) => (
        <EventRailRow key={event.id} event={event} muted />
      ))}
    </Section>
  );
}

function EventRailRow(props: { event: DashboardEvent; muted?: boolean }) {
  const { event } = props;
  return (
    <DayRailRow
      rail={event.isAllDay || !event.time ? TODAY_RU.allDay : event.time}
      muted={props.muted ?? false}
      tick={<MemberTick seed={event.seriesId} />}
    >
      <span className="truncate text-[17px] leading-6 font-medium text-foreground">
        {event.title}
      </span>
      {event.location ? (
        <span className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px] font-medium text-muted-foreground">
          <MapPin className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{event.location}</span>
        </span>
      ) : null}
    </DayRailRow>
  );
}
