import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  EventOccurrenceResponse,
  EventRsvp,
  EventSeriesCreate,
  EventSeriesDelete,
  EventSeriesResponse,
  EventSeriesUpdate,
  PublicUser,
} from '@family/shared';
import { useMe } from '@/shared/auth/use-me';
import { getFamilyTimeZone } from '@/shared/lib/format';
import { notify } from '@/shared/lib/toast';
import {
  calendarKeys,
  cancelOccurrence,
  createEventSeries,
  deleteEventSeries,
  fetchCalendar,
  fetchCalendarFeed,
  fetchEventSeries,
  fetchEventSeriesList,
  fetchFamilyMembers,
  fetchOccurrences,
  setRsvp,
  updateEventSeries,
  type CalendarFeed,
  type CalendarRange,
  type OccurrenceFilters,
} from './api';
import { addMonthsToMonthKey, birthdayAge, todayKey, type MonthKey } from './calendar-model';
import { CALENDAR_RU } from './locale';

/* -------------------------------------------------------------------------- */
/* Viewport & view preference                                                 */
/* -------------------------------------------------------------------------- */

export type CalendarView = 'month' | 'agenda';

const VIEW_STORAGE_KEY = 'family.calendar.view';
const PHONE_QUERY = '(max-width: 767px)';

/**
 * A 7×5 grid of tiny dots is useless on a 390 px screen, so the agenda is the
 * default on a phone and the month grid the default on a desktop. An explicit
 * choice is remembered and beats both.
 *
 * `localStorage` is fine here: this is a display preference, not a credential —
 * D3's ban is about tokens (the theme provider stores its setting the same way).
 */
export function isPhoneViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches) {
    return true;
  }
  return window.innerWidth > 0 && window.innerWidth <= 767;
}

function readStoredView(): CalendarView | null {
  try {
    const value = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return value === 'month' || value === 'agenda' ? value : null;
  } catch {
    return null;
  }
}

export function useCalendarView(): [CalendarView, (view: CalendarView) => void] {
  const [view, setView] = useState<CalendarView>(
    () => readStoredView() ?? (isPhoneViewport() ? 'agenda' : 'month'),
  );

  const choose = useCallback((next: CalendarView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Private mode / quota. The choice simply does not survive a reload.
    }
  }, []);

  return [view, choose];
}

/** Live phone/desktop flag, for layout decisions that cannot be pure CSS. */
export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(isPhoneViewport);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = (): void => {
      setIsPhone(isPhoneViewport());
    };
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  return isPhone;
}

/* -------------------------------------------------------------------------- */
/* Timezone                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The family timezone (D2). Every date this feature renders resolves through
 * this value, never through the device clock: a parent in Bangkok must see the
 * time the family at home will sit down to dinner.
 */
export function useFamilyTimeZone(): string {
  const { data: me } = useMe();
  return me?.family?.timezone ?? getFamilyTimeZone();
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export function useCalendarOccurrences(
  range: CalendarRange,
): UseQueryResult<EventOccurrenceResponse[]> {
  const timezone = useFamilyTimeZone();
  return useQuery({
    queryKey: calendarKeys.grid(range),
    queryFn: ({ signal }) => fetchCalendar({ ...range, timezone }, signal),
    staleTime: 30_000,
  });
}

export function useEventSeries(id: string | undefined): UseQueryResult<EventSeriesResponse> {
  return useQuery({
    queryKey: calendarKeys.seriesDetail(id ?? ''),
    queryFn: ({ signal }) => fetchEventSeries(id ?? '', signal),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useSeriesOccurrences(
  filters: OccurrenceFilters,
  enabled = true,
): UseQueryResult<EventOccurrenceResponse[]> {
  return useQuery({
    queryKey: calendarKeys.occurrences(filters),
    queryFn: ({ signal }) => fetchOccurrences(filters, signal),
    enabled,
    staleTime: 30_000,
  });
}

export function useFamilyMembers(): UseQueryResult<PublicUser[]> {
  return useQuery({
    queryKey: calendarKeys.members(),
    queryFn: ({ signal }) => fetchFamilyMembers(signal),
    staleTime: 10 * 60_000,
  });
}

/** `userId -> member`, for attendee avatars and the attendee picker. */
export function useMemberIndex(): Map<string, PublicUser> {
  const { data } = useFamilyMembers();
  return useMemo(() => new Map((data ?? []).map((member) => [member.id, member])), [data]);
}

/**
 * Birthday series, keyed by series id, carrying the anchor year.
 *
 * There is no `birthdays` resource (scheduling §6) — a birthday is an ordinary
 * yearly series whose `dtstartLocal` holds the birth year. That is the only
 * place the age can come from, since `publicUser` deliberately withholds
 * `birthDate` from other members.
 */
export function useBirthdayAnchors(): Map<string, string> {
  const { data } = useQuery({
    queryKey: calendarKeys.seriesList({ sourceKind: 'user_birthday' }),
    queryFn: ({ signal }) => fetchEventSeriesList({ sourceKind: 'user_birthday' }, signal),
    staleTime: 60 * 60_000,
  });
  return useMemo(
    () => new Map((data ?? []).map((series) => [series.id, series.recurrence.dtstartLocal])),
    [data],
  );
}

/** Age turned on a birthday occurrence, or `null` when the year is unknown. */
export function ageForOccurrence(
  occurrence: Pick<EventOccurrenceResponse, 'seriesId' | 'occurrenceKey' | 'sourceKind'>,
  anchors: Map<string, string>,
): number | null {
  if (occurrence.sourceKind !== 'user_birthday') return null;
  const anchor = anchors.get(occurrence.seriesId);
  return anchor ? birthdayAge(occurrence.occurrenceKey, anchor) : null;
}

export function useCalendarFeed(enabled = true): UseQueryResult<CalendarFeed> {
  return useQuery({
    queryKey: calendarKeys.feed(),
    queryFn: ({ signal }) => fetchCalendarFeed(signal),
    enabled,
    staleTime: 60 * 60_000,
    retry: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

function useInvalidateCalendar(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
  }, [queryClient]);
}

export function useCreateEvent() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (body: EventSeriesCreate) => createEventSeries(body),
    onSuccess: () => {
      invalidate();
      notify.success(CALENDAR_RU.createdToast);
    },
    onError: (error: unknown) => {
      notify.error(error);
    },
  });
}

export function useUpdateEvent(seriesId: string) {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (body: EventSeriesUpdate) => updateEventSeries(seriesId, body),
    onSuccess: () => {
      invalidate();
      notify.success(CALENDAR_RU.updatedToast);
    },
    onError: (error: unknown) => {
      notify.error(error);
    },
  });
}

export function useDeleteEvent(seriesId: string) {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (body: EventSeriesDelete) => deleteEventSeries(seriesId, body),
    onSuccess: () => {
      invalidate();
      notify.success(CALENDAR_RU.deletedToast);
    },
    onError: (error: unknown) => {
      notify.error(error);
    },
  });
}

export function useSetRsvp() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: ({ occurrenceId, ...body }: { occurrenceId: string } & EventRsvp) =>
      setRsvp(occurrenceId, body),
    onSuccess: () => {
      invalidate();
      notify.success(CALENDAR_RU.rsvpSaved);
    },
    onError: (error: unknown) => {
      notify.error(error);
    },
  });
}

export function useCancelOccurrence() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (occurrenceId: string) => cancelOccurrence(occurrenceId),
    onSuccess: () => {
      invalidate();
      notify.success(CALENDAR_RU.deletedToast);
    },
    onError: (error: unknown) => {
      notify.error(error);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Month navigation                                                           */
/* -------------------------------------------------------------------------- */

export interface MonthNavigation {
  monthKey: MonthKey;
  goToPrevious: () => void;
  goToNext: () => void;
  goToToday: () => void;
}

/** Month cursor for the grid, anchored on today in the **family** timezone. */
export function useMonthNavigation(): MonthNavigation {
  const timeZone = useFamilyTimeZone();
  const [monthKey, setMonthKey] = useState<MonthKey>(() => todayKey(timeZone).slice(0, 7));

  const goToPrevious = useCallback(() => {
    setMonthKey((current) => addMonthsToMonthKey(current, -1));
  }, []);
  const goToNext = useCallback(() => {
    setMonthKey((current) => addMonthsToMonthKey(current, 1));
  }, []);
  const goToToday = useCallback(() => {
    setMonthKey(todayKey(timeZone).slice(0, 7));
  }, [timeZone]);

  return { monthKey, goToPrevious, goToNext, goToToday };
}
