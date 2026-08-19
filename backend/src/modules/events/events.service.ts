import type {
  EventAttendeesUpdate,
  EventCalendarQuery,
  EventOccurrenceListQuery,
  EventOccurrenceResponse,
  EventOccurrenceUpdate,
  EventRsvp,
  EventSeriesCreate,
  EventSeriesDelete,
  EventSeriesListQuery,
  EventSeriesResponse,
  EventSeriesUpdate,
  EventTodayResponse,
  RecurrenceSpec,
  RecurrenceView,
  Rsvp,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import type { Db, Executor } from '../../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { recurrenceEngine, type SeriesRule } from '../../core/recurrence/engine.js';
import { EVENT_TARGET, materializeSeries } from '../../core/recurrence/materializer.js';
import * as repo from './events.repository.js';
import type { EventOccurrenceRow, EventSeriesRow } from './events.schema.js';
import {
  addLocalDays,
  buildIcsCalendar,
  icsEtag,
  mintFeedToken,
  parseFeedToken,
  sequenceFor,
  uidFor,
  type IcsEvent,
} from './ics.service.js';

/**
 * Calendar business rules (D8: no HTTP knowledge here).
 *
 * The four mutation semantics are the same four tasks use, because they are the
 * same problem — see `docs/architecture/scheduling.md` §3. The two things that
 * are *specific* to events, and that this file exists to get right:
 *
 * ## 1. An all-day event is a date range in the family timezone
 *
 * Not "midnight UTC to midnight UTC", and not "the instant of local midnight
 * plus 86 400 000 ms". A birthday on 7 September is the local calendar day
 * `2026-09-07`, whatever the offset was that day and whatever offset the reader
 * is in. So an all-day series is anchored at local `T00:00:00`, its duration is
 * a whole number of **wall-clock days**, and both ends are resolved through the
 * zone with `engine.toInstant` / `engine.addWallClock`.
 *
 * Get this wrong and every all-day event west of UTC displays one day early —
 * the single most-reported bug in every calendar product ever shipped.
 *
 * ## 2. The end of a timed event is wall-clock arithmetic
 *
 * `endsAt = engine.addWallClock(startLocal, durationMinutes, tz)`, never
 * `startsAt.getTime() + minutes * 60_000`. A 60-minute event beginning at 23:30
 * on the night the clocks go back ends at 00:30 local — which is 120 real
 * minutes later. The family means the wall clock (D2), so the wall clock is
 * what we compute with.
 */

type TemporalApi = NonNullable<typeof globalThis.Temporal>;

function temporal(): TemporalApi {
  const api = globalThis.Temporal;
  if (!api) {
    throw new Error('Temporal is not available — call installTemporal() from core/temporal.js');
  }
  return api;
}

/** Minutes in one wall-clock day. All-day durations are multiples of this. */
export const MINUTES_PER_DAY = 1440;

/* -------------------------------------------------------------------------- */
/* Pure helpers — the interesting rules, testable without Postgres             */
/* -------------------------------------------------------------------------- */

/** Local calendar date (`YYYY-MM-DD`) of an instant, in a given zone. */
export function localDateIn(instant: Date, timezone: string): string {
  return temporal()
    .Instant.fromEpochMilliseconds(instant.getTime())
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
}

/** Floating local wall clock of an instant, in a given zone. */
export function localDateTimeIn(instant: Date, timezone: string): string {
  return temporal()
    .Instant.fromEpochMilliseconds(instant.getTime())
    .toZonedDateTimeISO(timezone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' });
}

/** Force a floating local datetime to midnight — the all-day anchor. */
export function toMidnight(local: string): string {
  return `${local.slice(0, 10)}T00:00:00`;
}

/**
 * Normalise the stored duration of an all-day event to whole wall-clock days.
 *
 * `durationMinutes = 0` on an all-day series means "one day", not "zero
 * length": the materializer would otherwise write `endsAt === startsAt` and the
 * ICS exporter would emit `DTEND == DTSTART`, which most clients render as a
 * zero-length event that vanishes from the all-day band.
 */
export function allDayDurationMinutes(minutes: number): number {
  const days = Math.max(1, Math.ceil((minutes || 0) / MINUTES_PER_DAY));
  return days * MINUTES_PER_DAY;
}

/**
 * The occurrence timestamps for a local start.
 *
 * The **only** place in the module that turns a wall clock into instants, so
 * there is exactly one line to audit for the DST rules.
 */
export function resolveOccurrenceTimes(
  startLocal: string,
  durationMinutes: number,
  timezone: string,
): { startsAt: Date; endsAt: Date; localDate: string; startsLocal: string } {
  const normalized = recurrenceEngine.localDateOf(startLocal);
  const startsAt = recurrenceEngine.toInstant(startLocal, timezone);
  // Wall clock, not epoch milliseconds. See the file header.
  const end = recurrenceEngine.addWallClock(startLocal, durationMinutes, timezone);
  return {
    startsAt,
    endsAt: end.instant,
    localDate: normalized,
    startsLocal: startLocal,
  };
}

export interface CompiledSchedule {
  readonly rrule: string | null;
  readonly dtstartLocal: string;
  readonly timezone: string;
  readonly rdatesLocal: string[];
  readonly exdatesLocal: string[];
}

/**
 * `RecurrenceSpec` → the columns of the recurrence spine.
 *
 * `engine.compile` is handed the series timezone on purpose: `UNTIL` is
 * serialised as a **UTC** instant (RFC 5545 §3.3.10), so compiling
 * "до 31 декабря" without the zone would silently bind the rule to UTC midnight
 * and drop or add a final occurrence for every family that is not on UTC.
 */
export function compileSchedule(spec: RecurrenceSpec, isAllDay: boolean): CompiledSchedule {
  const anchor = isAllDay ? toMidnight(spec.dtstartLocal) : spec.dtstartLocal;
  const rdatesLocal = spec.rdatesLocal.map((d) => (isAllDay ? toMidnight(d) : d));
  const exdatesLocal = spec.exdatesLocal.map((d) => (isAllDay ? toMidnight(d) : d));

  let rrule: string | null;
  switch (spec.mode) {
    case 'once':
      rrule = null;
      break;
    case 'preset':
      rrule = recurrenceEngine.compile(spec.preset, spec.ends, anchor, spec.timezone);
      break;
    case 'raw':
      rrule = spec.rrule;
      break;
  }

  return { rrule, dtstartLocal: anchor, timezone: spec.timezone, rdatesLocal, exdatesLocal };
}

export function ruleOf(series: EventSeriesRow): SeriesRule {
  return {
    rrule: series.rrule,
    dtstartLocal: series.dtstartLocal,
    timezone: series.timezone,
    rdatesLocal: series.rdatesLocal,
    exdatesLocal: series.exdatesLocal,
  };
}

/**
 * The JS mirror of the SQL visibility predicate in the repository.
 *
 * Kept in sync by unit tests rather than by hope: the SQL is what protects the
 * list endpoints, this is what protects everything that already holds rows in
 * memory (the ICS feed, the reminder fan-out).
 */
export function canViewEvent(
  viewerId: string,
  series: Pick<EventSeriesRow, 'visibility' | 'createdById'>,
  attendeeIds: readonly string[],
): boolean {
  switch (series.visibility) {
    case 'household':
      return true;
    case 'private':
      return series.createdById === viewerId;
    case 'restricted':
      return series.createdById === viewerId || attendeeIds.includes(viewerId);
  }
}

/** Resolution is always `COALESCE(override, series_value)` (§3.2). */
export function resolveOccurrence(
  occurrence: EventOccurrenceRow,
  series: EventSeriesRow,
): {
  title: string;
  description: string | null;
  location: string | null;
  isAllDay: boolean;
} {
  return {
    title: occurrence.titleOverride ?? series.title,
    description: occurrence.descriptionOverride ?? series.description,
    location: occurrence.locationOverride ?? series.location,
    isAllDay: occurrence.isAllDayOverride ?? series.isAllDay,
  };
}

/* -------------------------------------------------------------------------- */
/* Response mapping                                                            */
/* -------------------------------------------------------------------------- */

export function toRecurrenceView(series: EventSeriesRow): RecurrenceView {
  const rule = ruleOf(series);
  const decompiled =
    series.rrule === null ? null : recurrenceEngine.decompile(series.rrule, series.timezone);

  return {
    rrule: series.rrule,
    dtstartLocal: series.dtstartLocal,
    timezone: series.timezone,
    rdatesLocal: series.rdatesLocal,
    exdatesLocal: series.exdatesLocal,
    seriesEndsAt: series.seriesEndsAt?.toISOString() ?? null,
    materializedThrough: series.materializedThrough?.toISOString() ?? null,
    preset: decompiled?.preset ?? null,
    ends: decompiled?.ends ?? null,
    summary: recurrenceEngine.describe(rule),
  };
}

export function toSeriesResponse(series: EventSeriesRow): EventSeriesResponse {
  return {
    id: series.id,
    title: series.title,
    description: series.description,
    location: series.location,
    visibility: series.visibility,
    createdById: series.createdById,
    recurrence: toRecurrenceView(series),
    durationMinutes: series.durationMinutes,
    isAllDay: series.isAllDay,
    reminderOffsets: series.reminderOffsets,
    color: series.color,
    category: series.category,
    sourceKind: series.sourceKind,
    // Generated series are owned by their job: editing one here would be undone
    // by the next sync. The client edits the profile / the import instead.
    isReadOnly: series.sourceKind !== 'manual',
    supersedesSeriesId: series.supersedesSeriesId,
    archivedAt: series.archivedAt?.toISOString() ?? null,
    createdAt: series.createdAt.toISOString(),
    updatedAt: series.updatedAt.toISOString(),
  };
}

export function toOccurrenceResponse(
  occurrence: EventOccurrenceRow,
  series: EventSeriesRow,
  attendees: ReadonlyArray<{ userId: string; rsvp: Rsvp; respondedAt: Date | null }>,
  viewerId: string,
): EventOccurrenceResponse {
  const resolved = resolveOccurrence(occurrence, series);
  const mine = attendees.find((a) => a.userId === viewerId);
  return {
    id: occurrence.id,
    seriesId: occurrence.seriesId,
    occurrenceKey: occurrence.occurrenceKey,
    startsAt: occurrence.startsAt.toISOString(),
    endsAt: occurrence.endsAt.toISOString(),
    localDate: occurrence.localDate,
    startsLocal: occurrence.startsLocal,
    timezone: series.timezone,
    status: occurrence.status,
    isException: occurrence.isException,
    title: resolved.title,
    description: resolved.description,
    location: resolved.location,
    isAllDay: resolved.isAllDay,
    color: series.color,
    category: series.category,
    visibility: series.visibility,
    sourceKind: series.sourceKind,
    attendees: attendees.map((a) => ({
      userId: a.userId,
      rsvp: a.rsvp,
      respondedAt: a.respondedAt?.toISOString() ?? null,
    })),
    myRsvp: mine?.rsvp ?? null,
    createdAt: occurrence.createdAt.toISOString(),
  };
}

async function hydrate(
  x: Executor,
  rows: readonly repo.OccurrenceWithSeries[],
  viewerId: string,
): Promise<EventOccurrenceResponse[]> {
  if (rows.length === 0) return [];
  // One query for the whole page — never one per row.
  const attendees = await repo.loadAttendees(
    x,
    rows.map((r) => r.occurrence.id),
  );
  return rows.map((r) =>
    toOccurrenceResponse(r.occurrence, r.series, attendees.get(r.occurrence.id) ?? [], viewerId),
  );
}

/* -------------------------------------------------------------------------- */
/* Authorization helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Write authorization for a series the caller can already *read*.
 *
 * 403, not 404, on purpose: D4 reserves 404 for "outside your read scope", and
 * pretending a visible event does not exist because you may not edit it makes
 * the UI unable to explain itself.
 */
function assertCanMutate(actor: AuthContext, series: EventSeriesRow, base: string): void {
  const scope = actor.scopeFor(base);
  if (scope === 'any') return;
  if (scope === 'own' && series.createdById === actor.userId) return;
  throw forbidden(`Missing permission: ${base}:any`, {
    seriesId: series.id,
    createdById: series.createdById,
  });
}

/** Generated series (birthdays, ICS imports) are read-only — §8 says 409. */
function assertNotGenerated(series: EventSeriesRow): void {
  if (series.sourceKind !== 'manual') {
    throw conflict(
      'Эта серия создаётся автоматически — измените источник, а не событие',
      'CONFLICT',
    );
  }
}

async function loadVisibleSeries(
  x: Executor,
  id: string,
  viewerId: string,
): Promise<EventSeriesRow> {
  const series = await repo.findVisibleSeries(x, id, viewerId);
  // 404, never 403: the caller must not be able to tell "hidden" from "absent".
  if (!series) throw notFound('Событие');
  return series;
}

async function loadVisibleOccurrence(
  x: Executor,
  id: string,
  viewerId: string,
): Promise<repo.OccurrenceWithSeries> {
  const row = await repo.findVisibleOccurrence(x, id, viewerId);
  if (!row) throw notFound('Событие');
  return row;
}

/* -------------------------------------------------------------------------- */
/* Materialization + attendee fan-out                                          */
/* -------------------------------------------------------------------------- */

/**
 * Materialize eagerly, inside the caller's transaction (§2 trigger 2), then fan
 * the invite list out over whatever that produced.
 *
 * Both halves are idempotent: the occurrence insert is
 * `ON CONFLICT (series_id, occurrence_key) DO NOTHING` and the attendee insert
 * is `ON CONFLICT (occurrence_id, user_id) DO NOTHING`, so a retried write
 * never duplicates a row and never resets somebody's RSVP.
 */
async function materializeAndInvite(
  x: Executor,
  seriesId: string,
  attendeeIds: readonly string[],
  fromKey?: string,
): Promise<void> {
  await materializeSeries(x, EVENT_TARGET, seriesId);
  if (attendeeIds.length === 0) return;
  const occurrenceIds = await repo.listOccurrenceIdsOfSeries(x, seriesId, fromKey);
  await repo.addAttendees(x, occurrenceIds, attendeeIds);
}

function recomputeSeriesEnd(schedule: CompiledSchedule): Date | null {
  return recurrenceEngine.seriesEndsAt({
    rrule: schedule.rrule,
    dtstartLocal: schedule.dtstartLocal,
    timezone: schedule.timezone,
    rdatesLocal: schedule.rdatesLocal,
    exdatesLocal: schedule.exdatesLocal,
  });
}

/* -------------------------------------------------------------------------- */
/* Series CRUD                                                                 */
/* -------------------------------------------------------------------------- */

export interface SeriesDetail {
  readonly series: EventSeriesRow;
  readonly attendeeIds: string[];
}

export async function createSeries(
  db: Db,
  actor: AuthContext,
  input: EventSeriesCreate,
): Promise<SeriesDetail> {
  const isAllDay = input.isAllDay;
  const schedule = compileSchedule(input.recurrence, isAllDay);
  const durationMinutes = isAllDay
    ? allDayDurationMinutes(input.durationMinutes)
    : input.durationMinutes;

  return db.transaction(async (tx) => {
    const series = await repo.insertSeries(tx, {
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      visibility: input.visibility,
      createdById: actor.userId,
      rrule: schedule.rrule,
      dtstartLocal: schedule.dtstartLocal,
      timezone: schedule.timezone,
      rdatesLocal: schedule.rdatesLocal,
      exdatesLocal: schedule.exdatesLocal,
      seriesEndsAt: recomputeSeriesEnd(schedule),
      durationMinutes,
      isAllDay,
      reminderOffsets: input.reminderOffsets,
      color: input.color ?? null,
      category: input.category ?? null,
      sourceKind: 'manual',
    });

    await materializeAndInvite(tx, series.id, input.attendeeIds);

    const fresh = (await repo.findSeriesById(tx, series.id)) ?? series;
    return { series: fresh, attendeeIds: await repo.listSeriesAttendeeIds(tx, series.id) };
  });
}

export async function getSeries(db: Db, actor: AuthContext, id: string): Promise<SeriesDetail> {
  const series = await loadVisibleSeries(db, id, actor.userId);
  return { series, attendeeIds: await repo.listSeriesAttendeeIds(db, id) };
}

export async function listSeries(
  db: Db,
  actor: AuthContext,
  query: EventSeriesListQuery,
): Promise<repo.Page<EventSeriesRow>> {
  return repo.listSeries(db, actor.userId, {
    cursor: query.cursor,
    limit: query.limit,
    includeArchived: query.includeArchived,
    category: query.category,
    sourceKind: query.sourceKind,
  });
}

/**
 * The four mutation semantics (§3). `scope` is required by the contract, so
 * there is no default to get wrong here.
 */
export async function updateSeries(
  db: Db,
  actor: AuthContext,
  id: string,
  input: EventSeriesUpdate,
): Promise<SeriesDetail> {
  return db.transaction(async (tx) => {
    const visible = await loadVisibleSeries(tx, id, actor.userId);
    assertCanMutate(actor, visible, 'event:update');
    assertNotGenerated(visible);

    const series = await repo.lockSeriesById(tx, id);
    if (!series) throw notFound('Событие');

    switch (input.scope) {
      case 'this':
        await applyThisOnly(tx, series, input);
        break;
      case 'this_and_future':
        return splitSeries(tx, actor, series, input);
      case 'all':
        await applyToAll(tx, series, input);
        break;
    }

    const fresh = (await repo.findSeriesById(tx, id)) ?? series;
    return { series: fresh, attendeeIds: await repo.listSeriesAttendeeIds(tx, id) };
  });
}

/** §3.2 — override columns on the one occurrence; the rule is untouched. */
async function applyThisOnly(
  x: Executor,
  series: EventSeriesRow,
  input: EventSeriesUpdate,
): Promise<void> {
  if (input.occurrenceId === undefined) throw badRequest('occurrenceId обязателен');
  const target = await repo.findOccurrenceById(x, input.occurrenceId);
  if (!target || target.occurrence.seriesId !== series.id) throw notFound('Экземпляр события');

  const patch: repo.OccurrencePatch = { isException: true };
  if (input.title !== undefined) patch.titleOverride = input.title;
  if (input.description !== undefined) patch.descriptionOverride = input.description ?? null;
  if (input.location !== undefined) patch.locationOverride = input.location ?? null;
  if (input.isAllDay !== undefined) patch.isAllDayOverride = input.isAllDay;

  if (input.durationMinutes !== undefined || input.isAllDay !== undefined) {
    const allDay = input.isAllDay ?? (target.occurrence.isAllDayOverride ?? series.isAllDay);
    const requested = input.durationMinutes ?? series.durationMinutes;
    const minutes = allDay ? allDayDurationMinutes(requested) : requested;
    const times = resolveOccurrenceTimes(
      target.occurrence.startsLocal,
      minutes,
      series.timezone,
    );
    patch.endsAt = times.endsAt;
  }

  await repo.updateOccurrenceRow(x, target.occurrence.id, patch);

  if (input.attendeeIds !== undefined) {
    await repo.removeAttendeesExcept(x, [target.occurrence.id], input.attendeeIds);
    await repo.addAttendees(x, [target.occurrence.id], input.attendeeIds);
  }
}

/** True when the edit changes *when* the event happens, not just what it says. */
function touchesSchedule(input: EventSeriesUpdate): boolean {
  return (
    input.recurrence !== undefined ||
    input.durationMinutes !== undefined ||
    input.isAllDay !== undefined
  );
}

function metadataPatch(input: EventSeriesUpdate): repo.SeriesPatch {
  const patch: repo.SeriesPatch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description ?? null;
  if (input.location !== undefined) patch.location = input.location ?? null;
  if (input.visibility !== undefined) patch.visibility = input.visibility;
  if (input.reminderOffsets !== undefined) patch.reminderOffsets = input.reminderOffsets;
  if (input.color !== undefined) patch.color = input.color ?? null;
  if (input.category !== undefined) patch.category = input.category ?? null;
  return patch;
}

/**
 * §3.4 — edit the series in place.
 *
 * Metadata-only edits delete nothing: `COALESCE(override, series_value)` means
 * every non-overridden occurrence picks the new title up for free. A *schedule*
 * change drops the future `scheduled`, non-exception rows and re-materializes;
 * past occurrences are never touched by any scope.
 */
async function applyToAll(
  x: Executor,
  series: EventSeriesRow,
  input: EventSeriesUpdate,
): Promise<void> {
  const patch = metadataPatch(input);
  const isAllDay = input.isAllDay ?? series.isAllDay;

  if (touchesSchedule(input)) {
    const spec = input.recurrence;
    const schedule =
      spec === undefined
        ? {
            rrule: series.rrule,
            dtstartLocal: isAllDay ? toMidnight(series.dtstartLocal) : series.dtstartLocal,
            timezone: series.timezone,
            rdatesLocal: series.rdatesLocal,
            exdatesLocal: series.exdatesLocal,
          }
        : compileSchedule(spec, isAllDay);

    const requested = input.durationMinutes ?? series.durationMinutes;
    patch.rrule = schedule.rrule;
    patch.dtstartLocal = schedule.dtstartLocal;
    patch.timezone = schedule.timezone;
    patch.rdatesLocal = schedule.rdatesLocal;
    patch.exdatesLocal = schedule.exdatesLocal;
    patch.seriesEndsAt = recomputeSeriesEnd(schedule);
    patch.isAllDay = isAllDay;
    patch.durationMinutes = isAllDay ? allDayDurationMinutes(requested) : requested;
    // Re-materialize from scratch: the watermark has to go back or the
    // materializer will consider the window already done.
    patch.materializedThrough = null;
  } else if (input.durationMinutes !== undefined) {
    patch.durationMinutes = input.durationMinutes;
  }

  await repo.updateSeriesRow(x, series.id, patch);

  if (touchesSchedule(input)) {
    const cutoff = localDateTimeIn(new Date(), series.timezone);
    await repo.deleteFutureScheduledOccurrences(x, series.id, cutoff);
  }

  await materializeAndInvite(x, series.id, input.attendeeIds ?? []);

  if (input.attendeeIds !== undefined) {
    const occurrenceIds = await repo.listOccurrenceIdsOfSeries(x, series.id);
    await repo.removeAttendeesExcept(x, occurrenceIds, input.attendeeIds);
  }
}

/**
 * §3.3 — the series split. The only mutation that creates a row.
 *
 * 1. `UNTIL` on the old series is set to just before the anchor key
 *    (`engine.withUntilBefore`, which is the primitive that exists for this).
 * 2. Future `scheduled`, non-exception occurrences are deleted. Anything done,
 *    skipped, cancelled or hand-edited stays — history is not rewritten.
 * 3. A successor series carries the edited fields, anchored at the anchor key,
 *    with `supersedesSeriesId` pointing back so the chain stays walkable.
 */
async function splitSeries(
  x: Executor,
  actor: AuthContext,
  series: EventSeriesRow,
  input: EventSeriesUpdate,
): Promise<SeriesDetail> {
  if (input.occurrenceId === undefined) throw badRequest('occurrenceId обязателен');
  const anchor = await repo.findOccurrenceById(x, input.occurrenceId);
  if (!anchor || anchor.occurrence.seriesId !== series.id) throw notFound('Экземпляр события');

  const anchorKey = anchor.occurrence.occurrenceKey;
  const rule = ruleOf(series);
  if (rule.rrule === null) {
    throw badRequest('Одиночное событие нельзя разделить — используйте scope "all"');
  }

  const truncated = recurrenceEngine.withUntilBefore(rule, anchorKey);
  await repo.updateSeriesRow(x, series.id, {
    rrule: truncated,
    seriesEndsAt: recurrenceEngine.seriesEndsAt({ ...rule, rrule: truncated }),
  });
  await repo.deleteFutureScheduledOccurrences(x, series.id, anchorKey);

  const isAllDay = input.isAllDay ?? series.isAllDay;
  const successorSpec = input.recurrence;
  const schedule =
    successorSpec === undefined
      ? {
          rrule: series.rrule,
          // The successor starts at the anchor, not at the original DTSTART.
          dtstartLocal: isAllDay ? toMidnight(anchorKey) : anchorKey,
          timezone: series.timezone,
          rdatesLocal: [] as string[],
          exdatesLocal: series.exdatesLocal.filter((d) => d >= anchorKey),
        }
      : compileSchedule(successorSpec, isAllDay);

  const requested = input.durationMinutes ?? series.durationMinutes;
  const successor = await repo.insertSeries(x, {
    title: input.title ?? series.title,
    description: input.description === undefined ? series.description : (input.description ?? null),
    location: input.location === undefined ? series.location : (input.location ?? null),
    visibility: input.visibility ?? series.visibility,
    createdById: actor.userId,
    rrule: schedule.rrule,
    dtstartLocal: schedule.dtstartLocal,
    timezone: schedule.timezone,
    rdatesLocal: schedule.rdatesLocal,
    exdatesLocal: schedule.exdatesLocal,
    seriesEndsAt: recomputeSeriesEnd(schedule),
    durationMinutes: isAllDay ? allDayDurationMinutes(requested) : requested,
    isAllDay,
    reminderOffsets: input.reminderOffsets ?? series.reminderOffsets,
    color: input.color === undefined ? series.color : (input.color ?? null),
    category: input.category === undefined ? series.category : (input.category ?? null),
    sourceKind: 'manual',
    supersedesSeriesId: series.id,
  });

  const attendeeIds =
    input.attendeeIds ?? (await repo.listSeriesAttendeeIds(x, series.id));
  await materializeAndInvite(x, successor.id, attendeeIds);

  const fresh = (await repo.findSeriesById(x, successor.id)) ?? successor;
  return { series: fresh, attendeeIds: await repo.listSeriesAttendeeIds(x, successor.id) };
}

/** §3.5 — delete, in the same three scopes. */
export async function deleteSeries(
  db: Db,
  actor: AuthContext,
  id: string,
  input: EventSeriesDelete,
): Promise<{ archived: boolean; deleted: boolean }> {
  return db.transaction(async (tx) => {
    const visible = await loadVisibleSeries(tx, id, actor.userId);
    assertCanMutate(actor, visible, 'event:delete');

    const series = await repo.lockSeriesById(tx, id);
    if (!series) throw notFound('Событие');
    const now = new Date();

    switch (input.scope) {
      case 'this': {
        if (input.occurrenceId === undefined) throw badRequest('occurrenceId обязателен');
        const target = await repo.findOccurrenceById(tx, input.occurrenceId);
        if (!target || target.occurrence.seriesId !== series.id) {
          throw notFound('Экземпляр события');
        }
        // State preserved, calendar clean: cancel the row AND add an EXDATE, so
        // a later re-materialization cannot resurrect the slot.
        await repo.updateOccurrenceRow(tx, target.occurrence.id, { status: 'cancelled' });
        const key = target.occurrence.occurrenceKey;
        if (!series.exdatesLocal.includes(key)) {
          await repo.updateSeriesRow(tx, series.id, {
            exdatesLocal: [...series.exdatesLocal, key],
          });
        }
        return { archived: false, deleted: false };
      }

      case 'this_and_future': {
        if (input.occurrenceId === undefined) throw badRequest('occurrenceId обязателен');
        const anchor = await repo.findOccurrenceById(tx, input.occurrenceId);
        if (!anchor || anchor.occurrence.seriesId !== series.id) {
          throw notFound('Экземпляр события');
        }
        const rule = ruleOf(series);
        if (rule.rrule === null) {
          await repo.archiveSeries(tx, series.id, now);
          await repo.cancelFutureOccurrences(tx, series.id, now);
          return { archived: true, deleted: false };
        }
        const truncated = recurrenceEngine.withUntilBefore(rule, anchor.occurrence.occurrenceKey);
        await repo.updateSeriesRow(tx, series.id, {
          rrule: truncated,
          seriesEndsAt: recurrenceEngine.seriesEndsAt({ ...rule, rrule: truncated }),
        });
        await repo.deleteFutureScheduledOccurrences(
          tx,
          series.id,
          anchor.occurrence.occurrenceKey,
        );
        return { archived: false, deleted: false };
      }

      case 'all': {
        // A hard delete is only offered when nothing is on the record; otherwise
        // the series is archived so the history survives.
        const hasHistory = await repo.seriesHasHistory(tx, series.id);
        if (!hasHistory) {
          await repo.deleteSeries(tx, series.id);
          return { archived: false, deleted: true };
        }
        await repo.archiveSeries(tx, series.id, now);
        await repo.cancelFutureOccurrences(tx, series.id, now);
        return { archived: true, deleted: false };
      }
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Occurrences                                                                 */
/* -------------------------------------------------------------------------- */

export async function getOccurrence(
  db: Db,
  actor: AuthContext,
  id: string,
): Promise<EventOccurrenceResponse> {
  const row = await loadVisibleOccurrence(db, id, actor.userId);
  const [mapped] = await hydrate(db, [row], actor.userId);
  if (!mapped) throw notFound('Событие');
  return mapped;
}

/**
 * Move / resize / override one instance.
 *
 * `occurrenceKey` is **never** written here. Dragging Tuesday's appointment to
 * Wednesday changes `startsAt`/`endsAt`/`localDate`/`startsLocal`; the key stays
 * at the slot the rule produced, which is what stops the next horizon extension
 * from re-creating a phantom on Tuesday (§1).
 */
export async function updateOccurrence(
  db: Db,
  actor: AuthContext,
  id: string,
  input: EventOccurrenceUpdate,
): Promise<EventOccurrenceResponse> {
  return db.transaction(async (tx) => {
    const row = await loadVisibleOccurrence(tx, id, actor.userId);
    assertCanMutate(actor, row.series, 'event:update');

    const patch: repo.OccurrencePatch = { isException: true };
    if (input.titleOverride !== undefined) patch.titleOverride = input.titleOverride ?? null;
    if (input.descriptionOverride !== undefined) {
      patch.descriptionOverride = input.descriptionOverride ?? null;
    }
    if (input.locationOverride !== undefined) {
      patch.locationOverride = input.locationOverride ?? null;
    }
    if (input.isAllDayOverride !== undefined) {
      patch.isAllDayOverride = input.isAllDayOverride ?? null;
    }

    const isAllDay =
      (input.isAllDayOverride ?? row.occurrence.isAllDayOverride) ?? row.series.isAllDay;
    const movedTo = input.startsLocal ?? row.occurrence.startsLocal;
    const startLocal = isAllDay ? toMidnight(movedTo) : movedTo;
    const requested = input.durationMinutes ?? row.series.durationMinutes;
    const minutes = isAllDay ? allDayDurationMinutes(requested) : requested;

    if (
      input.startsLocal !== undefined ||
      input.durationMinutes !== undefined ||
      input.isAllDayOverride !== undefined
    ) {
      const times = resolveOccurrenceTimes(startLocal, minutes, row.series.timezone);
      patch.startsAt = times.startsAt;
      patch.endsAt = times.endsAt;
      patch.localDate = times.localDate;
      patch.startsLocal = times.startsLocal;
    }

    const updated = await repo.updateOccurrenceRow(tx, id, patch);
    const attendees = await repo.loadAttendees(tx, [id]);
    return toOccurrenceResponse(
      updated,
      row.series,
      attendees.get(id) ?? [],
      actor.userId,
    );
  });
}

export async function cancelOccurrence(
  db: Db,
  actor: AuthContext,
  id: string,
): Promise<EventOccurrenceResponse> {
  return db.transaction(async (tx) => {
    const row = await loadVisibleOccurrence(tx, id, actor.userId);
    assertCanMutate(actor, row.series, 'event:delete');
    const updated = await repo.updateOccurrenceRow(tx, id, { status: 'cancelled' });
    const attendees = await repo.loadAttendees(tx, [id]);
    return toOccurrenceResponse(updated, row.series, attendees.get(id) ?? [], actor.userId);
  });
}

export async function listOccurrences(
  db: Db,
  actor: AuthContext,
  query: EventOccurrenceListQuery,
): Promise<{ items: EventOccurrenceResponse[]; nextCursor: string | null }> {
  const page = await repo.listOccurrences(db, {
    viewerId: actor.userId,
    cursor: query.cursor,
    limit: query.limit,
    seriesId: query.seriesId,
    attendeeId: query.attendeeId,
    status: query.status,
    from: query.from,
    to: query.to,
  });
  return { items: await hydrate(db, page.items, actor.userId), nextCursor: page.nextCursor };
}

/**
 * The month/week grid. Filters on the **local date** window, which is what the
 * grid means — see the repository header.
 */
export async function getCalendar(
  db: Db,
  actor: AuthContext,
  query: EventCalendarQuery,
): Promise<{ timezone: string; items: EventOccurrenceResponse[] }> {
  const timezone = query.timezone ?? actor.timezone ?? (await repo.getFamilyTimezone(db));
  const rows = await repo.listOccurrencesInLocalRange(db, {
    viewerId: actor.userId,
    from: query.from,
    to: query.to,
    category: query.category,
    attendeeId: query.attendeeId,
    includeCancelled: query.includeCancelled,
  });
  return { timezone, items: await hydrate(db, rows, actor.userId) };
}

/** The Today dashboard agenda strip: today, tomorrow, and "answer me". */
export async function getToday(
  db: Db,
  actor: AuthContext,
  timezoneOverride?: string,
): Promise<EventTodayResponse> {
  const timezone =
    timezoneOverride ?? actor.timezone ?? (await repo.getFamilyTimezone(db));
  const today = localDateIn(new Date(), timezone);
  const tomorrow = addLocalDays(today, 1);
  const horizon = addLocalDays(today, 30);

  const [window, pending] = await Promise.all([
    repo.listOccurrencesInLocalRange(db, {
      viewerId: actor.userId,
      from: today,
      to: tomorrow,
    }),
    repo.listOccurrencesInLocalRange(db, {
      viewerId: actor.userId,
      from: today,
      to: horizon,
      attendeeId: actor.userId,
    }),
  ]);

  const mappedWindow = await hydrate(db, window, actor.userId);
  const mappedPending = await hydrate(db, pending, actor.userId);

  return {
    date: today,
    timezone,
    today: mappedWindow.filter((o) => o.localDate === today),
    tomorrow: mappedWindow.filter((o) => o.localDate === tomorrow),
    awaitingMyRsvp: mappedPending.filter((o) => o.myRsvp === 'pending'),
  };
}

/* -------------------------------------------------------------------------- */
/* RSVP & attendees                                                            */
/* -------------------------------------------------------------------------- */

export async function setRsvp(
  db: Db,
  actor: AuthContext,
  occurrenceId: string,
  input: EventRsvp,
): Promise<EventOccurrenceResponse> {
  const targetUserId = input.userId ?? actor.userId;
  // Answering for somebody else (a parent answering for a child) is a
  // different, stronger capability than answering for yourself.
  if (targetUserId !== actor.userId && actor.scopeFor('event:update') !== 'any') {
    throw forbidden('Missing permission: event:update:any');
  }

  return db.transaction(async (tx) => {
    const row = await loadVisibleOccurrence(tx, occurrenceId, actor.userId);
    const now = new Date();

    const targets = input.applyToFuture
      ? (
          await repo.listOccurrences(tx, {
            viewerId: actor.userId,
            limit: 500,
            seriesId: row.occurrence.seriesId,
          })
        ).items
          .filter((r) => r.occurrence.startsAt >= row.occurrence.startsAt)
          .map((r) => r.occurrence.id)
      : [row.occurrence.id];

    for (const id of targets) {
      await repo.upsertRsvp(tx, id, targetUserId, input.rsvp, now);
    }

    const attendees = await repo.loadAttendees(tx, [occurrenceId]);
    return toOccurrenceResponse(
      row.occurrence,
      row.series,
      attendees.get(occurrenceId) ?? [],
      actor.userId,
    );
  });
}

/**
 * Replace the invite list of a series.
 *
 * The contract carries a `scope` but no `occurrenceId`, so the anchor is
 * derived: `all` is every occurrence, `this_and_future` is everything from now
 * on, and `this` is the next upcoming occurrence — which is what "пригласить
 * только на ближайшую встречу" means in the UI.
 */
export async function setAttendees(
  db: Db,
  actor: AuthContext,
  seriesId: string,
  input: EventAttendeesUpdate,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const series = await loadVisibleSeries(tx, seriesId, actor.userId);
    assertCanMutate(actor, series, 'event:update');

    const all = await repo.listOccurrencesOfSeries(tx, seriesId);
    const now = new Date();
    let targets: string[];
    switch (input.scope) {
      case 'all':
        targets = all.map((o) => o.id);
        break;
      case 'this_and_future':
        targets = all.filter((o) => o.startsAt >= now).map((o) => o.id);
        break;
      case 'this': {
        const next = all.find((o) => o.startsAt >= now) ?? all.at(-1);
        targets = next ? [next.id] : [];
        break;
      }
    }

    await repo.removeAttendeesExcept(tx, targets, input.attendeeIds);
    await repo.addAttendees(tx, targets, input.attendeeIds);
    return repo.listSeriesAttendeeIds(tx, seriesId);
  });
}

/* -------------------------------------------------------------------------- */
/* The ICS feed                                                                */
/* -------------------------------------------------------------------------- */

/** How far the subscribed feed looks back and forward, in local days. */
export const FEED_PAST_DAYS = 60;
export const FEED_FUTURE_DAYS = 365;

export interface FeedResult {
  readonly body: string;
  readonly etag: string;
  readonly timezone: string;
}

/**
 * Authenticate a feed request from the URL token alone.
 *
 * Two independent checks, and both must pass:
 *
 * 1. the HMAC verifies (the string is one of ours and was not tampered with);
 * 2. the epoch inside it still equals the user's **current** revocation epoch.
 *
 * (2) is the revocation. A user who rotates their link bumps the epoch, and
 * every URL ever handed out — including one that leaked into a shared Google
 * Calendar or a browser history — stops verifying immediately.
 */
export async function authenticateFeedToken(db: Db, token: string): Promise<string | null> {
  const parsed = parseFeedToken(token);
  if (parsed === null) return null;

  const user = await repo.findUserById(db, parsed.userId);
  // A suspended or rejected member loses the feed at the same moment they lose
  // the app; the token must not outlive the account status.
  if (!user || user.status !== 'active') return null;

  const epoch = await repo.getFeedRevocationEpoch(db, parsed.userId);
  if (epoch !== parsed.revocationEpochMs) return null;

  return parsed.userId;
}

/** The user's current (deterministic) feed token. */
export async function getFeedToken(db: Db, userId: string): Promise<string> {
  return mintFeedToken(userId, await repo.getFeedRevocationEpoch(db, userId));
}

/** Rotate: invalidate every existing URL and return the replacement token. */
export async function rotateFeedToken(db: Db, actor: AuthContext, userId: string): Promise<string> {
  if (userId !== actor.userId && actor.scopeFor('event:update') !== 'any') {
    throw forbidden('Missing permission: event:update:any');
  }
  return db.transaction(async (tx) => {
    const previous = await repo.getFeedRevocationEpoch(tx, userId);
    // Strictly monotonic: two rotations inside the same millisecond must still
    // produce two different tokens, or the second one silently no-ops.
    const at = new Date(Math.max(Date.now(), previous + 1));
    const epoch = await repo.recordFeedRevocation(tx, userId, actor.userId, at);
    return mintFeedToken(userId, epoch);
  });
}

/**
 * Render the subscribed calendar for one user.
 *
 * The window is bounded (`FEED_PAST_DAYS` … `FEED_FUTURE_DAYS`) rather than
 * "everything": iOS refetches the whole document on every poll, and an
 * unbounded feed grows without limit for a document nobody ever scrolls back
 * through.
 */
export async function buildFeedForUser(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<FeedResult> {
  const [timezone, familyName] = await Promise.all([
    repo.getFamilyTimezone(db),
    repo.getFamilyName(db),
  ]);

  const today = localDateIn(now, timezone);
  const rows = await repo.listOccurrencesInLocalRange(db, {
    viewerId: userId,
    from: addLocalDays(today, -FEED_PAST_DAYS),
    to: addLocalDays(today, FEED_FUTURE_DAYS),
    includeCancelled: false,
  });

  const events: IcsEvent[] = rows.map(({ occurrence, series }) => {
    const resolved = resolveOccurrence(occurrence, series);
    const startLocalDate = occurrence.localDate;
    // Whole wall-clock days, rounded up — an all-day series always stores a
    // multiple of 1440, but an imported one might not.
    const days = Math.max(1, Math.round(series.durationMinutes / MINUTES_PER_DAY));

    return {
      uid: uidFor(series.id, occurrence.occurrenceKey),
      sequence: sequenceFor(series.createdAt, series.updatedAt),
      summary: resolved.title,
      description: resolved.description,
      location: resolved.location,
      isAllDay: resolved.isAllDay,
      startLocalDate,
      // EXCLUSIVE end (RFC 5545 §3.8.2.2): one day means +1, not +0.
      endLocalDateExclusive: addLocalDays(startLocalDate, days),
      startsAt: occurrence.startsAt,
      endsAt: occurrence.endsAt,
      status: occurrence.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
      categories: series.category ? [series.category] : [],
      reminderOffsets: series.reminderOffsets,
      // Stable timestamps, not `new Date()`: a DTSTAMP that moves on every
      // request would change the body — and therefore the ETag — on every poll,
      // which defeats `If-None-Match` and makes the phone re-download hourly.
      dtstamp: series.updatedAt,
      created: occurrence.createdAt,
      lastModified: series.updatedAt,
    };
  });

  const body = buildIcsCalendar({
    name: `Календарь — ${familyName}`,
    description: 'Семейный календарь: события, дни рождения и напоминания',
    timezone,
    events,
  });

  return { body, etag: icsEtag(body), timezone };
}

/* -------------------------------------------------------------------------- */
/* Re-exports used by the routes                                               */
/* -------------------------------------------------------------------------- */

export { repo as eventsRepository };
