import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { EditScope, EventOccurrenceResponse } from '@family/shared';
import { ChevronLeft, Info, MapPin, Pencil, Repeat, Trash2 } from 'lucide-react';
import { PageHeader } from '@/shared/components/PageHeader';
import { ErrorState } from '@/shared/components/ErrorState';
import { EmptyState } from '@/shared/components/EmptyState';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { Skeleton } from '@/shared/ui/skeleton';
import { useCan } from '@/shared/auth/use-can';
import { ROUTES } from '@/shared/lib/routes';
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
import { EditScopeDialog } from '../components/EditScopeDialog';
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
 * NOTE FOR THE SHELL OWNER: `app/router.tsx` currently registers `/calendar`
 * with an index child only, so this path 404s until a
 * `{ path: ':eventId', lazy: … }` child is added. Everything else in the
 * feature reaches this screen's content through the detail sheet meanwhile.
 */
export default function EventDetailPage() {
  const params = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const seriesId = params.eventId ?? '';

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

  const doDelete = (scope: EditScope): void => {
    remove.mutate(
      { scope, ...(scope === 'all' ? {} : { occurrenceId: occurrences[0]?.id }) },
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
          <h2 className="text-sm font-semibold">{CALENDAR_RU.upcomingOccurrences}</h2>
          {occurrencesQuery.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : occurrences.length === 0 ? (
            <EmptyState compact title={CALENDAR_RU.emptyAgendaTitle} />
          ) : (
            occurrences.map((occurrence) => (
              <EventRow
                key={occurrence.id}
                occurrence={occurrence}
                members={memberIndex}
                timeZone={timeZone}
                age={ageForOccurrence(occurrence, birthdayAnchors)}
                onSelect={(selected) => {
                  setDetail(selected);
                  setDetailOpen(true);
                }}
              />
            ))
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
        occurrence={occurrences[0]}
      />

      <EditScopeDialog
        open={scopeOpen}
        onOpenChange={setScopeOpen}
        mode="delete"
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
