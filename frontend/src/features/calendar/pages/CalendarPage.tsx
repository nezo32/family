import { useMemo, useState } from 'react';
import type { EventOccurrenceResponse } from '@family/shared';
import { CalendarDays, Plus } from 'lucide-react';
import { SideColumn } from '@/app/layout/SideColumn';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { Can } from '@/shared/auth/Can';
import { Button } from '@/shared/ui/button';
import { Section, SectionStack } from '@/shared/ui/section';
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
import { CALENDAR_RU, eventCount } from '../locale';
import { AgendaList } from '../components/AgendaList';
import { MonthStepper, ViewSwitch } from '../components/CalendarToolbar';
import { DayHeading } from '../components/DayHeading';
import { EventDetailSheet } from '../components/EventDetailSheet';
import { EventFormDialog } from '../components/EventFormDialog';
import { EventRow } from '../components/EventRow';
import { MonthGrid } from '../components/MonthGrid';
import { SubscribeCard } from '../components/SubscribePanel';

/**
 * Календарь — the family's shared month / agenda view (§D3).
 *
 * **What the user came for:** "what is happening, and when."
 *
 * ## What changed
 *
 * The month moved into the page title (`MonthStepper`), which `PageHeader`
 * hoists into the app bar from `md` up. That collapses five rows of chrome —
 * title, subtitle, a full-width «+ Событие», a month stepper, a view switch —
 * into one 44px control row above the first event. On a 390px phone that was
 * ~370px, or 44 % of the viewport, spent before anything the reader came for.
 *
 * `SubscribePanel` is off the page proper. It is a once-per-device setup that
 * was sitting as a loose paragraph under the agenda, pushing next month below
 * the fold — and it is duplicated in Настройки. It survives here as side-column
 * content at ≥ 1088px only (§C4), where there is room and no cost.
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
   * The agenda shows **the navigated month**, and in the current month it starts
   * at today: a family opening the app wants the next thing, not the school run
   * from three weeks ago.
   *
   * The month filter is not redundant. `monthGridRange` fetches the whole 6×7
   * grid, so the window spills a few days either side — and the agenda used to
   * list them, which is how a heading reading «Август 2026» ended up with
   * «четверг, 3 сентября» as its only entry. The neighbouring month is one tap
   * on the arrow; a heading that lies is not fixable by the reader.
   */
  const agendaOccurrences = useMemo(() => {
    const inMonth = occurrences.filter(
      (occurrence) => monthKeyOf(occurrence.localDate) === monthKey,
    );
    if (monthKeyOf(today) !== monthKey) return inMonth;
    return inMonth.filter((occurrence) => occurrence.localDate >= today);
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
  const onCurrentMonth = monthKeyOf(today) === monthKey;

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
        title={
          <MonthStepper
            monthKey={monthKey}
            onPrevious={goToPrevious}
            onNext={goToNext}
            // Dead for eleven months out of twelve, so it only exists when it
            // can actually do something.
            onToday={
              onCurrentMonth
                ? undefined
                : () => {
                    goToToday();
                    setSelectedDay(today);
                  }
            }
          />
        }
        actions={createButton}
      />

      <div className="flex flex-col gap-4">
        <ViewSwitch view={view} onViewChange={setView} />

        {occurrencesQuery.isPending ? (
          <div className="flex max-w-row-measure flex-col gap-2" aria-busy="true">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
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
          <SectionStack>
            <MonthGrid
              monthKey={monthKey}
              byDay={byDay}
              selectedDay={selectedDay}
              onSelectDay={setSelectedDay}
              timeZone={timeZone}
            />

            {selectedItems.length === 0 ? (
              <Section label={<DayHeading dateKey={selectedDay} timeZone={timeZone} />}>
                <EmptyState
                  compact
                  icon={CalendarDays}
                  title={CALENDAR_RU.emptyDayTitle}
                  description={CALENDAR_RU.emptyDayDescription}
                  action={createButton}
                />
              </Section>
            ) : (
              <Section
                label={<DayHeading dateKey={selectedDay} timeZone={timeZone} />}
                count={eventCount(selectedItems.length)}
              >
                {selectedItems.map((occurrence) => (
                  <EventRow
                    key={occurrence.id}
                    occurrence={occurrence}
                    members={memberIndex}
                    timeZone={timeZone}
                    age={ageForOccurrence(occurrence, birthdayAnchors)}
                    onSelect={openDetail}
                  />
                ))}
              </Section>
            )}
          </SectionStack>
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
      </div>

      {/*
        §C4: «Подписаться на календарь» is side-column content — the thing you
        do once and never again. Hidden below the two-column breakpoint rather
        than collapsed to the bottom of the page: on a phone it was a loose
        paragraph under the agenda, and the same setup already lives in
        Настройки → «Календарь на телефоне», which is where a once-per-device
        step belongs (§D3).
      */}
      <SideColumn>
        <div className="hidden min-[1088px]:block">
          <SubscribeCard />
        </div>
      </SideColumn>

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
