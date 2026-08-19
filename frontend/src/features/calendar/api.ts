import type {
  EventOccurrenceResponse,
  EventRsvp,
  EventSeriesCreate,
  EventSeriesDelete,
  EventSeriesResponse,
  EventSeriesUpdate,
  PublicUser,
} from '@family/shared';
import { api } from '@/shared/api/client';

/**
 * Typed fetchers for the Календарь feature.
 *
 * Endpoints follow §8 of `docs/architecture/scheduling.md`. The one addition is
 * `GET /events/feed` — the metadata call that hands the caller its personal,
 * signed `feed.ics` URL. See the note on `CalendarFeed` below.
 */

/* -------------------------------------------------------------------------- */
/* Query keys                                                                 */
/* -------------------------------------------------------------------------- */

export interface CalendarRange {
  from: string;
  to: string;
}

export const calendarKeys = {
  all: ['calendar'] as const,
  grids: () => [...calendarKeys.all, 'grid'] as const,
  grid: (range: CalendarRange) => [...calendarKeys.grids(), range] as const,
  seriesAll: () => [...calendarKeys.all, 'series'] as const,
  seriesList: (filters: EventSeriesListFilters) =>
    [...calendarKeys.seriesAll(), 'list', filters] as const,
  seriesDetail: (id: string) => [...calendarKeys.seriesAll(), 'detail', id] as const,
  occurrences: (filters: OccurrenceFilters) =>
    [...calendarKeys.all, 'occurrences', filters] as const,
  members: () => [...calendarKeys.all, 'members'] as const,
  feed: () => [...calendarKeys.all, 'feed'] as const,
};

/* -------------------------------------------------------------------------- */
/* Response shaping                                                           */
/* -------------------------------------------------------------------------- */

/**
 * List endpoints in this codebase answer either with a bare array or with the
 * `paginatedSchema` envelope, depending on whether they paginate. Normalising
 * here keeps every caller from re-deciding.
 */
function toItems<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)) {
    return (raw as { items: T[] }).items;
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Calendar grid                                                              */
/* -------------------------------------------------------------------------- */

export interface CalendarQuery extends CalendarRange {
  /** Viewer timezone. Always sent explicitly so the grid is not device-local. */
  timezone?: string;
  category?: string;
  attendeeId?: string;
  includeCancelled?: boolean;
}

/** `GET /events/calendar` — the month / agenda read. Bounded, unpaginated. */
export async function fetchCalendar(
  query: CalendarQuery,
  signal?: AbortSignal,
): Promise<EventOccurrenceResponse[]> {
  const raw = await api.get<unknown>('/events/calendar', {
    query: {
      from: query.from,
      to: query.to,
      timezone: query.timezone,
      category: query.category,
      attendeeId: query.attendeeId,
      includeCancelled: query.includeCancelled,
    },
    ...(signal ? { signal } : {}),
  });
  return toItems<EventOccurrenceResponse>(raw);
}

/* -------------------------------------------------------------------------- */
/* Series                                                                     */
/* -------------------------------------------------------------------------- */

export interface EventSeriesListFilters {
  sourceKind?: 'manual' | 'user_birthday' | 'imported_ics';
  category?: string;
  includeArchived?: boolean;
  limit?: number;
}

export async function fetchEventSeriesList(
  filters: EventSeriesListFilters,
  signal?: AbortSignal,
): Promise<EventSeriesResponse[]> {
  const raw = await api.get<unknown>('/events/series', {
    query: {
      sourceKind: filters.sourceKind,
      category: filters.category,
      includeArchived: filters.includeArchived,
      limit: filters.limit ?? 100,
    },
    ...(signal ? { signal } : {}),
  });
  return toItems<EventSeriesResponse>(raw);
}

export function fetchEventSeries(id: string, signal?: AbortSignal): Promise<EventSeriesResponse> {
  return api.get<EventSeriesResponse>(`/events/series/${id}`, { ...(signal ? { signal } : {}) });
}

export function createEventSeries(body: EventSeriesCreate): Promise<EventSeriesResponse> {
  return api.post<EventSeriesResponse>('/events/series', body);
}

export function updateEventSeries(
  id: string,
  body: EventSeriesUpdate,
): Promise<EventSeriesResponse> {
  return api.patch<EventSeriesResponse>(`/events/series/${id}`, body);
}

/** `DELETE` carries a body here: the edit scope has no safe default (D2 §3.5). */
export function deleteEventSeries(id: string, body: EventSeriesDelete): Promise<void> {
  return api.del<void>(`/events/series/${id}`, { body });
}

/* -------------------------------------------------------------------------- */
/* Occurrences                                                                */
/* -------------------------------------------------------------------------- */

export interface OccurrenceFilters {
  seriesId?: string;
  attendeeId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function fetchOccurrences(
  filters: OccurrenceFilters,
  signal?: AbortSignal,
): Promise<EventOccurrenceResponse[]> {
  const raw = await api.get<unknown>('/events/occurrences', {
    query: {
      seriesId: filters.seriesId,
      attendeeId: filters.attendeeId,
      from: filters.from,
      to: filters.to,
      limit: filters.limit ?? 50,
    },
    ...(signal ? { signal } : {}),
  });
  return toItems<EventOccurrenceResponse>(raw);
}

export function setRsvp(occurrenceId: string, body: EventRsvp): Promise<EventOccurrenceResponse> {
  return api.put<EventOccurrenceResponse>(`/events/occurrences/${occurrenceId}/rsvp`, body);
}

export function cancelOccurrence(occurrenceId: string): Promise<void> {
  return api.post<void>(`/events/occurrences/${occurrenceId}/cancel`);
}

/* -------------------------------------------------------------------------- */
/* Members (for attendees and avatars)                                        */
/* -------------------------------------------------------------------------- */

/**
 * `GET /members` (identity module). Callers with `member:update:any` get the
 * richer admin row; we only ever read the public projection's fields, so one
 * type covers both serializers.
 */
export async function fetchFamilyMembers(signal?: AbortSignal): Promise<PublicUser[]> {
  const raw = await api.get<unknown>('/members', { ...(signal ? { signal } : {}) });
  return toItems<PublicUser>(raw);
}

/* -------------------------------------------------------------------------- */
/* ICS subscription                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The personal ICS feed.
 *
 * `GET /events/feed.ics` is the feed itself and is authenticated by a signed
 * token in the URL (it is fetched by Apple's calendar daemon, which carries no
 * session). This call is how the app learns that URL. The response is kept
 * deliberately loose — `url` is what we render, `token` is accepted so the
 * panel still works if the backend hands out the token alone.
 */
export interface CalendarFeedResponse {
  url?: string;
  feedUrl?: string;
  token?: string;
}

export interface CalendarFeed {
  /** Absolute `https://…/api/events/feed.ics?token=…` URL. */
  url: string;
  /** The same URL with the `webcal://` scheme — what iOS opens natively. */
  webcalUrl: string;
}

export async function fetchCalendarFeed(signal?: AbortSignal): Promise<CalendarFeed> {
  const raw = await api.get<CalendarFeedResponse>('/events/feed', {
    ...(signal ? { signal } : {}),
  });
  const url = absoluteFeedUrl(raw);
  return { url, webcalUrl: url.replace(/^https?:/, 'webcal:') };
}

function absoluteFeedUrl(raw: CalendarFeedResponse): string {
  const candidate = raw.url ?? raw.feedUrl;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  if (candidate) {
    return candidate.startsWith('http') ? candidate : `${origin}${candidate}`;
  }
  if (raw.token) {
    return `${origin}/api/events/feed.ics?token=${encodeURIComponent(raw.token)}`;
  }
  return '';
}
