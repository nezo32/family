import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { EditScope, EventOccurrenceResponse, EventSeriesResponse } from '@family/shared';
import { CalendarOff, ChevronLeft, Info, MapPin, Pencil, Repeat, Trash2 } from 'lucide-react';
import { PageHeader } from '@/shared/components/PageHeader';
import { ErrorState } from '@/shared/components/ErrorState';
import { EmptyState } from '@/shared/components/EmptyState';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { Skeleton } from '@/shared/ui/skeleton';
import { useCan } from '@/shared/auth/use-can';
import { hasErrorCode } from '@/shared/api/errors';
import { eventDetail, EVENT_DATE_PARAM, ROUTES } from '@/shared/lib/routes';
import { formatDateKeyLong } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { todayKey } from '../calendar-model';
import {
  ageForOccurrence,
  useBirthdayAnchors,
  useDeleteEvent,
  useEventSeries,
  useFamilyMembers,
  useFamilyTimeZone,
  useMemberIndex,
  useSeriesOccurrences,
} from '../hooks';
import { CALENDAR_RU } from '../locale';
import { EditScopeDialog } from '@/shared/components';
import { EventDetailSheet } from '../components/EventDetailSheet';
import { EventFormDialog } from '../components/EventFormDialog';
import { EventRow } from '../components/EventRow';

/**
 * `/calendar/:eventId` — one event **series** and its upcoming dates.
 *
 * The id in the path is a series id: `GET /events/series/:id` is the only
 * single-item read the events module exposes, and a series is what a person
 * means by "это событие" when they want to edit or delete it.
 *
 * ## Nothing in the UI links here
 *
 * The calendar opens a sheet rather than navigating, so a **push notification
 * is the only way a human reaches this screen** — which makes it the one detail
 * route that can rot for a whole release without anybody noticing. It did:
 * `event_reminder` sent an *occurrence* id in a path keyed by a series, so
 * every reminder anyone ever tapped landed on a lookup that cannot match.
 *
 * Two consequences for this file, both load-bearing:
 *
 *  - **`?date=` (`EVENT_DATE_PARAM`)** carries which instance the notification
 *    was about. It is a floating local date, not an id, because occurrence rows
 *    are regenerated on every series edit — a date stays true, an id does not.
 *    When it matches nothing the page just stops highlighting a row.
 *  - **A 404 gets its own screen.** Deliveries outlive the rows they point at
 *    (`notification_intents.entity_id` has no foreign key and nothing sweeps
 *    the inbox), and a push sent last week may name a series deleted since. The
 *    reader gets «Событие не найдено» and a way back, not the red alert card.
 *    D4 makes a denial indistinguishable from a deletion, so the copy claims
 *    neither.
 *  - **The series id in the path can change under a save.** «Это и
 *    последующие» splits the series and returns a *successor*, so `onSaved`
 *    re-points the URL — see `followSaved` below.
 */
export default function EventDetailPage() {
  const params = useParams<{ eventId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const seriesId = params.eventId ?? '';

  // Untrusted: it arrives from a URL anyone can type. Anything that is not a
  // date key is treated as absent rather than rendered.
  const remindedDateRaw = searchParams.get(EVENT_DATE_PARAM);
  const remindedDate =
    remindedDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(remindedDateRaw) ? remindedDateRaw : null;

  const timeZone = useFamilyTimeZone();
  const { can } = useCan();
  const seriesQuery = useEventSeries(seriesId);
  const members = useFamilyMembers();
  const memberIndex = useMemberIndex();
  const birthdayAnchors = useBirthdayAnchors();
  const occurrencesQuery = useSeriesOccurrences(
    { seriesId, from: todayKey(timeZone), limit: 25 },
    Boolean(seriesId),
  );
  const remove = useDeleteEvent(seriesId);

  const [detail, setDetail] = useState<EventOccurrenceResponse | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const backLink = (
    <Link
      to={ROUTES.calendar}
      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" aria-hidden />
      {CALENDAR_RU.backToCalendar}
    </Link>
  );

  if (seriesQuery.isPending) {
    return (
      <>
        <PageHeader eyebrow={backLink} title={<Skeleton className="h-7 w-56" />} />
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </>
    );
  }

  if (seriesQuery.isError) {
    /*
     * A 404 here is not a failure, it is an outcome — and the usual one for a
     * link opened from the inbox days after it was written. Retrying a lookup
     * that will never succeed is worse than useless, so the gone case gets an
     * empty state with a way back and no «Повторить».
     */
    if (hasErrorCode(seriesQuery.error, 'NOT_FOUND')) {
      return (
        <>
          <PageHeader eyebrow={backLink} title={CALENDAR_RU.title} />
          <EmptyState
            icon={CalendarOff}
            title={CALENDAR_RU.notFoundTitle}
            description={CALENDAR_RU.notFoundDescription}
            action={
              <Button asChild variant="outline" className="h-11">
                <Link to={ROUTES.calendar}>{CALENDAR_RU.backToCalendar}</Link>
              </Button>
            }
          />
        </>
      );
    }

    return (
      <>
        <PageHeader eyebrow={backLink} title={CALENDAR_RU.title} />
        <ErrorState
          error={seriesQuery.error}
          onRetry={() => {
            void seriesQuery.refetch();
          }}
        />
      </>
    );
  }

  const series = seriesQuery.data;
  const isGenerated = series.sourceKind !== 'manual' || series.isReadOnly;
  const recurring = Boolean(series.recurrence.rrule);
  const canEdit = !isGenerated && can('event:update', series);
  const canDelete = !isGenerated && can('event:delete', series);
  const occurrences = occurrencesQuery.data ?? [];

  /**
   * The instance a scoped edit or delete hangs off — «это» and «это и
   * последующие» are both answered relative to *one* date.
   *
   * The date the reader was reminded about wins over the first upcoming one,
   * because that is the one they came here holding. It falls back to
   * `occurrences[0]` when there was no reminder, or when the reminded date has
   * already passed out of the list.
   */
  const anchor = occurrences.find((o) => o.localDate === remindedDate) ?? occurrences[0];

  /**
   * True only when the reminded date has demonstrably left the schedule.
   *
   * The usual way to get here is the reader's own «это и последующие» edit
   * changing the rule so their date no longer falls on it — the split case the
   * tasks page answers with a whole screen. This page does not need one: it is
   * keyed by the series, so it still has a series to render either way, and
   * only the caption above the list has anything to correct.
   *
   * The claim is made **only** from evidence. `occurrences` is one bounded,
   * from-today window, so a date outside it proves nothing: earlier means
   * merely past, and later may simply be beyond the 25 rows we asked for.
   * Inside the window a miss is real, and that is the only case that speaks.
   */
  const first = occurrences.at(0);
  const last = occurrences.at(-1);
  const remindedDateGone =
    remindedDate !== null &&
    first !== undefined &&
    last !== undefined &&
    remindedDate >= first.localDate &&
    remindedDate <= last.localDate &&
    !occurrences.some((o) => o.localDate === remindedDate);

  /**
   * Where this **series** went, after a save that may have replaced it.
   *
   * «Это и последующие» is the one scope that does not edit in place: it
   * truncates this series and inserts a successor carrying the edited fields
   * (`events.service.ts` §3.3, `splitSeries`). The successor has a new id, and
   * the URL still names the old one — so without this the reader watched a
   * «Событие обновлено» toast settle over pre-edit content and an empty
   * «Ближайшие даты», because every edited date had moved to an id this page
   * never learned.
   *
   * `replace`, not `push`: the old id still resolves (the truncated series is
   * real), so leaving it in the history stack arms the back button with a page
   * showing the dates the user just edited away.
   *
   * Unlike the tasks side, this needs no lookup to find out where the reader's
   * date went. `/tasks/:taskId` is keyed by an occurrence row, so a split
   * forces it to re-resolve the date to a new row id; this route is keyed by
   * the series and carries the date as a *date*, which no split can invalidate.
   * `saved.id` is the whole answer, and the query param rides along untouched.
   */
  const followSaved = (saved: EventSeriesResponse): void => {
    // An in-place edit returns the same series. Navigating to where we already
    // are would be a pointless history write, and it would re-mount the page
    // under the same id for no reason.
    if (saved.id === seriesId) return;
    void navigate(eventDetail(saved.id, remindedDate ?? undefined), { replace: true });
  };

  const doDelete = (scope: EditScope): void => {
    remove.mutate(
      { scope, ...(scope === 'all' ? {} : { occurrenceId: anchor?.id }) },
      {
        onSuccess: () => {
          setScopeOpen(false);
          setConfirmOpen(false);
          void navigate(ROUTES.calendar);
        },
      },
    );
  };

  return (
    <>
      <PageHeader
        eyebrow={backLink}
        title={series.title}
        description={series.recurrence.summary}
        actions={
          isGenerated ? null : (
            <>
              {canEdit ? (
                <Button
                  variant="outline"
                  className="h-11"
                  onClick={() => {
                    setFormOpen(true);
                  }}
                >
                  <Pencil aria-hidden />
                  {COMMON.edit}
                </Button>
              ) : null}
              {canDelete ? (
                <Button
                  variant="outline"
                  className="h-11 text-destructive"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (recurring) setScopeOpen(true);
                    else setConfirmOpen(true);
                  }}
                >
                  <Trash2 aria-hidden />
                  {COMMON.delete}
                </Button>
              ) : null}
            </>
          )
        }
      />

      <div className="flex flex-col gap-5 pb-6">
        <div className="flex flex-wrap gap-1.5">
          {series.sourceKind === 'user_birthday' ? (
            <Badge variant="secondary">{CALENDAR_RU.birthday}</Badge>
          ) : null}
          {series.isAllDay ? <Badge variant="outline">{CALENDAR_RU.allDay}</Badge> : null}
          {series.category ? (
            <Badge variant="ghost" className="border-border">
              {series.category}
            </Badge>
          ) : null}
        </div>

        {series.location ? (
          <p className="flex items-start gap-2 text-sm">
            <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 break-words">{series.location}</span>
          </p>
        ) : null}

        {series.description ? (
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">{series.description}</p>
        ) : null}

        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Repeat className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{recurring ? series.recurrence.summary : CALENDAR_RU.noRepeat}</span>
        </p>

        {isGenerated ? (
          <p className="flex items-start gap-2 rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {series.sourceKind === 'user_birthday'
                ? CALENDAR_RU.birthdayHint
                : CALENDAR_RU.seriesReadOnly}
            </span>
          </p>
        ) : null}

        <section className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold">{CALENDAR_RU.upcomingOccurrences}</h2>
            {/*
             * Which date the notification was about. Shown whether or not that
             * date is still in the list below: a reminder opened the next
             * morning, or after an edit regenerated the occurrence rows, has
             * nothing left to highlight — and «Напоминание: 21 августа» is
             * still the answer to the question the reader arrived with.
             */}
            {remindedDate ? (
              <p className="text-xs text-muted-foreground" data-testid="reminded-date">
                {remindedDateGone
                  ? CALENDAR_RU.remindedDateGone
                  : CALENDAR_RU.remindedAbout(formatDateKeyLong(remindedDate))}
              </p>
            ) : null}
          </div>
          {occurrencesQuery.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : occurrences.length === 0 ? (
            <EmptyState
              compact
              title={CALENDAR_RU.emptyAgendaTitle}
              // A series with nothing ahead of it has either ended or is set to
              // repeat in a way that no longer produces dates — both of which
              // are fixed in the same place, the series itself.
              action={
                canEdit ? (
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={() => {
                      setFormOpen(true);
                    }}
                  >
                    <Pencil aria-hidden />
                    {COMMON.edit}
                  </Button>
                ) : (
                  <Button asChild variant="outline" className="h-11">
                    <Link to={ROUTES.calendar}>{CALENDAR_RU.backToCalendar}</Link>
                  </Button>
                )
              }
            />
          ) : (
            occurrences.map((occurrence) => {
              const reminded = occurrence.localDate === remindedDate;
              return (
                // The wrapper, rather than a prop on `EventRow`: the row is
                // shared with Сегодня and the agenda, and neither of those has
                // a notion of "the date you were sent here for".
                <div
                  key={occurrence.id}
                  className={cn(
                    'rounded-xl',
                    reminded && 'bg-muted/50 ring-2 ring-primary/30 ring-inset',
                  )}
                  {...(reminded ? { 'data-reminded': 'true' } : {})}
                >
                  <EventRow
                    occurrence={occurrence}
                    members={memberIndex}
                    timeZone={timeZone}
                    age={ageForOccurrence(occurrence, birthdayAnchors)}
                    onSelect={(selected) => {
                      setDetail(selected);
                      setDetailOpen(true);
                    }}
                  />
                </div>
              );
            })
          )}
        </section>
      </div>

      <EventDetailSheet
        occurrence={detail}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        members={memberIndex}
        birthdayAnchors={birthdayAnchors}
        timeZone={timeZone}
        onEdit={() => {
          setDetailOpen(false);
          setFormOpen(true);
        }}
      />

      <EventFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        members={members.data ?? []}
        seriesId={seriesId}
        occurrence={anchor}
        onSaved={followSaved}
      />

      <EditScopeDialog
        open={scopeOpen}
        onOpenChange={setScopeOpen}
        intent="delete"
        strings={CALENDAR_RU.scope}
        isPending={remove.isPending}
        onConfirm={doDelete}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={CALENDAR_RU.deleteConfirmTitle}
        description={CALENDAR_RU.deleteConfirmDescription}
        isPending={remove.isPending}
        onConfirm={() => {
          doDelete('all');
        }}
      />
    </>
  );
}
