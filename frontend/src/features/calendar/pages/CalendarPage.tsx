import { useMemo, useState } from 'react';
import type { EventOccurrenceResponse } from '@family/shared';
import { CalendarDays, Plus } from 'lucide-react';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { Can } from '@/shared/auth/Can';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { indexByDay, monthGridRange, monthKeyOf, todayKey, type DateKey } from '../calendar-model';
import {
  ageForOccurrence,
  useBirthdayAnchors,
  useCalendarOccurrences,
  useCalendarView,
  useFamilyMembers,
  useFamilyTimeZone,
  useMemberIndex,
  useMonthNavigation,
} from '../hooks';
import { CALENDAR_RU } from '../locale';
import { AgendaList } from '../components/AgendaList';
import { CalendarToolbar } from '../components/CalendarToolbar';
import { DayHeading } from '../components/DayHeading';
import { EventDetailSheet } from '../components/EventDetailSheet';
import { EventFormDialog } from '../components/EventFormDialog';
import { EventRow } from '../components/EventRow';
import { MonthGrid } from '../components/MonthGrid';
import { SubscribeCard, SubscribeDialog } from '../components/SubscribePanel';

/**
 * Календарь — the family's shared month / agenda view.
 *
 * The agenda is the default on a phone (see `useCalendarView`), the month grid
 * on a desktop, and an explicit choice is remembered. Both views read the same
 * `GET /events/calendar` window; grouping and day arithmetic live in
 * `calendar-model.ts`, which is where the D2 time rules are enforced.
 */
export default function CalendarPage() {
  const timeZone = useFamilyTimeZone();
  const [view, setView] = useCalendarView();
  const { monthKey, goToPrevious, goToNext, goToToday } = useMonthNavigation();

  const range = useMemo(() => monthGridRange(monthKey), [monthKey]);
  const occurrencesQuery = useCalendarOccurrences(range);
  const members = useFamilyMembers();
  const memberIndex = useMemberIndex();
  const birthdayAnchors = useBirthdayAnchors();

  const today = todayKey(timeZone);
  const [selectedDay, setSelectedDay] = useState<DateKey>(today);
  const [detail, setDetail] = useState<EventOccurrenceResponse | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EventOccurrenceResponse | null>(null);

  const occurrences = useMemo(() => occurrencesQuery.data ?? [], [occurrencesQuery.data]);
  const byDay = useMemo(() => indexByDay(occurrences, timeZone), [occurrences, timeZone]);

  /**
   * In the agenda, the current month starts at today: a family opening the app
   * wants the next thing, not the school run from three weeks ago.
   */
  const agendaOccurrences = useMemo(() => {
    if (monthKeyOf(today) !== monthKey) return occurrences;
    return occurrences.filter((occurrence) => occurrence.localDate >= today);
  }, [occurrences, monthKey, today]);

  const openDetail = (occurrence: EventOccurrenceResponse): void => {
    setDetail(occurrence);
    setDetailOpen(true);
  };

  const startCreate = (): void => {
    setEditing(null);
    setFormOpen(true);
  };

  const startEdit = (occurrence: EventOccurrenceResponse): void => {
    setDetailOpen(false);
    setEditing(occurrence);
    setFormOpen(true);
  };

  const selectedItems = byDay.get(selectedDay) ?? [];

  const createButton = (
    <Can perm="event:create">
      <Button className="h-11" onClick={startCreate}>
        <Plus aria-hidden />
        {CALENDAR_RU.createEventShort}
      </Button>
    </Can>
  );

  return (
    <>
      <PageHeader
        title={CALENDAR_RU.title}
        description={CALENDAR_RU.description}
        actions={
          <>
            <SubscribeDialog />
            {createButton}
          </>
        }
      />

      <div className="flex flex-col gap-4 pb-6">
        <CalendarToolbar
          view={view}
          onViewChange={setView}
          monthKey={monthKey}
          onPrevious={goToPrevious}
          onNext={goToNext}
          onToday={() => {
            goToToday();
            setSelectedDay(today);
          }}
        />

        {occurrencesQuery.isPending ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : occurrencesQuery.isError ? (
          <ErrorState
            title={CALENDAR_RU.loadFailed}
            error={occurrencesQuery.error}
            onRetry={() => {
              void occurrencesQuery.refetch();
            }}
          />
        ) : view === 'month' ? (
          <>
            <MonthGrid
              monthKey={monthKey}
              byDay={byDay}
              selectedDay={selectedDay}
              onSelectDay={setSelectedDay}
              timeZone={timeZone}
            />

            <section className="flex flex-col gap-1.5">
              <DayHeading dateKey={selectedDay} timeZone={timeZone} />
              {selectedItems.length === 0 ? (
                <EmptyState
                  compact
                  icon={CalendarDays}
                  title={CALENDAR_RU.emptyMonthTitle}
                  description={CALENDAR_RU.emptyMonthDescription}
                  action={createButton}
                />
              ) : (
                selectedItems.map((occurrence) => (
                  <EventRow
                    key={occurrence.id}
                    occurrence={occurrence}
                    members={memberIndex}
                    timeZone={timeZone}
                    age={ageForOccurrence(occurrence, birthdayAnchors)}
                    onSelect={openDetail}
                  />
                ))
              )}
            </section>
          </>
        ) : (
          <AgendaList
            occurrences={agendaOccurrences}
            members={memberIndex}
            birthdayAnchors={birthdayAnchors}
            timeZone={timeZone}
            onSelect={openDetail}
            emptyAction={createButton}
          />
        )}

        <SubscribeCard />
      </div>

      <EventDetailSheet
        occurrence={detail}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        members={memberIndex}
        birthdayAnchors={birthdayAnchors}
        timeZone={timeZone}
        onEdit={startEdit}
      />

      <EventFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        members={members.data ?? []}
        seriesId={editing?.seriesId}
        occurrence={editing ?? undefined}
        initialDateKey={selectedDay}
        onSaved={() => {
          setEditing(null);
        }}
      />
    </>
  );
}
