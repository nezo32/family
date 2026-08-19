import type { EventOccurrenceResponse, PublicUser } from '@family/shared';
import { CalendarDays } from 'lucide-react';
import { EmptyState } from '@/shared/components/EmptyState';
import { cn } from '@/shared/lib/utils';
import { ageForOccurrence } from '../hooks';
import { groupByDay, todayKey } from '../calendar-model';
import { CALENDAR_RU } from '../locale';
import { DayHeading } from './DayHeading';
import { EventRow } from './EventRow';

/**
 * The agenda: a flat, scrollable list grouped by day. Default on a phone —
 * a 7×5 grid of dots answers "is something happening" but never "what".
 */
export function AgendaList(props: {
  occurrences: readonly EventOccurrenceResponse[];
  members: Map<string, PublicUser>;
  birthdayAnchors: Map<string, string>;
  timeZone: string;
  onSelect: (occurrence: EventOccurrenceResponse) => void;
  emptyAction?: React.ReactNode;
}) {
  const groups = groupByDay(props.occurrences, props.timeZone);
  const today = todayKey(props.timeZone);

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title={CALENDAR_RU.emptyAgendaTitle}
        description={CALENDAR_RU.emptyAgendaDescription}
        action={props.emptyAction}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5" data-testid="agenda-list">
      {groups.map((group) => (
        <section key={group.dateKey} className="flex flex-col gap-1.5">
          <DayHeading
            dateKey={group.dateKey}
            timeZone={props.timeZone}
            className={cn(
              'bg-background/90 sticky top-0 z-10 -mx-1 px-1 py-1.5 backdrop-blur-sm',
              group.dateKey === today && 'text-primary',
            )}
          />
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
        </section>
      ))}
    </div>
  );
}
