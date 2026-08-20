import type { ReactNode } from 'react';
import type { EventOccurrenceResponse, PublicUser } from '@family/shared';
import { CalendarDays } from 'lucide-react';
import { EmptyState } from '@/shared/components/EmptyState';
import { Section, SectionStack } from '@/shared/ui/section';
import { ageForOccurrence } from '../hooks';
import { groupByDay, todayKey } from '../calendar-model';
import { CALENDAR_RU, eventCount } from '../locale';
import { DayHeading } from './DayHeading';
import { EventRow } from './EventRow';

/**
 * The agenda: days as sections, events as railed rows.
 *
 * Default on a phone — a 7×5 grid of dots answers "is something happening" but
 * never "what". Each day is a `Section`, so the date sits **outside** the
 * surface as a quiet label with its count, and the day's events are one object
 * of hairline-separated rows rather than a stack of individually-bordered
 * cards.
 *
 * The sticky day heading is gone with the card stack. It was
 * `bg-background/90 backdrop-blur-sm`, i.e. the page colour at 90 % with a blur
 * — §A3 rules translucency out, and once the days are visibly separate objects
 * a heading pinned to the top of the viewport is solving a problem the layout
 * no longer has.
 */
export function AgendaList(props: {
  occurrences: readonly EventOccurrenceResponse[];
  members: Map<string, PublicUser>;
  birthdayAnchors: Map<string, string>;
  timeZone: string;
  onSelect: (occurrence: EventOccurrenceResponse) => void;
  emptyAction?: ReactNode;
}) {
  const groups = groupByDay(props.occurrences, props.timeZone);
  const today = todayKey(props.timeZone);

  // The wrapper (and its test id) marks *the agenda view*, empty or not — the
  // agenda showing nothing for this month is a state of the agenda, not the
  // absence of one.
  if (groups.length === 0) {
    return (
      <div data-testid="agenda-list">
        <EmptyState
          icon={CalendarDays}
          title={CALENDAR_RU.emptyAgendaTitle}
          description={CALENDAR_RU.emptyAgendaDescription}
          action={props.emptyAction}
        />
      </div>
    );
  }

  return (
    <div data-testid="agenda-list">
      <SectionStack>
        {groups.map((group) => (
          <Section
            key={group.dateKey}
            label={
              <span className={group.dateKey === today ? 'text-primary' : undefined}>
                <DayHeading dateKey={group.dateKey} timeZone={props.timeZone} />
              </span>
            }
            count={eventCount(group.items.length)}
          >
            {group.items.map((occurrence) => (
              <EventRow
                key={`${group.dateKey}-${occurrence.id}`}
                occurrence={occurrence}
                members={props.members}
                timeZone={props.timeZone}
                age={ageForOccurrence(occurrence, props.birthdayAnchors)}
                onSelect={props.onSelect}
              />
            ))}
          </Section>
        ))}
      </SectionStack>
    </div>
  );
}
