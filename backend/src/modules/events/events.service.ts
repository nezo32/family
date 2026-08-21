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
import { badRequest, conflict, forbidden, internal, notFound } from '../../core/errors.js';
import {
  DEFAULT_MAX_COUNT,
  recurrenceEngine,
  type SeriesRule,
} from '../../core/recurrence/engine.js';
import { HORIZON_DAYS } from '../../core/recurrence/materializer.js';
import {
  dispatchAfterCommit,
  emitIntent,
  type NotificationAudience,
} from '../notifications/notifications.service.js';
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

/** Only ever used to walk a horizon forward — never for wall-clock arithmetic. */
const MS_PER_DAY = 86_400_000;

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
  if (!series) throw notFound('Event');
  return series;
}

async function loadVisibleOccurrence(
  x: Executor,
  id: string,
  viewerId: string,
): Promise<repo.OccurrenceWithSeries> {
  const row = await repo.findVisibleOccurrence(x, id, viewerId);
  if (!row) throw notFound('Event');
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
  await repo.materializeEventSeries(x, seriesId);
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

/**
 * Who may hear that an event exists.
 *
 * Deliberately the same rule `canViewEvent` enforces on reads, expressed as an
 * audience: a `household` event is family news, while a `private` or
 * `restricted` one is addressed only to the people who can already see it —
 * announcing «Новое событие: Приём у врача» to the children would leak exactly
 * what `restricted` exists to hide. The RBAC filter in the fan-out then drops
 * anyone without `event:read` on top of this.
 */
export function eventAudience(
  series: Pick<EventSeriesRow, 'visibility' | 'createdById'>,
  attendeeIds: readonly string[],
): NotificationAudience | null {
  if (series.visibility === 'household') return { everyone: true };

  const recipients = [
    ...new Set(
      [series.createdById, ...attendeeIds].filter((userId) =>
        canViewEvent(userId, series, attendeeIds),
      ),
    ),
  ];
  // Only the author can see it — and the author is the actor, so there is
  // nobody left to tell.
  return recipients.length > 0 ? { users: recipients } : null;
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

  const { detail, dispatch } = await db.transaction(async (tx) => {
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
    const attendeeIds = await repo.listSeriesAttendeeIds(tx, series.id);

    // «Новое событие» — `low` priority in the catalog and in-app only by
    // default, because a calendar entry three weeks out is not worth a buzz.
    // The `event_reminder` closer to the day is the one that interrupts.
    const audience = eventAudience(fresh, attendeeIds);
    const intent = audience
      ? await emitIntent(tx, {
          type: 'event_created',
          audience,
          actorId: actor.userId,
          entityType: 'event_series',
          entityId: fresh.id,
          dedupeKey: `event_created:${fresh.id}`,
          payload: {
            eventId: fresh.id,
            seriesId: fresh.id,
            title: fresh.title,
            actorName: actor.displayName,
            startsLabel: fresh.dtstartLocal.slice(0, 16).replace('T', ' '),
            location: fresh.location,
            isAllDay: fresh.isAllDay,
          },
        })
      : null;

    return {
      detail: { series: fresh, attendeeIds },
      dispatch: intent?.dispatch ?? null,
    };
  });

  // After the commit, never inside it.
  if (dispatch) await dispatchAfterCommit([dispatch]);
  return detail;
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
    if (!series) throw notFound('Event');

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
  if (!target || target.occurrence.seriesId !== series.id) throw notFound('Event occurrence');

  const patch: repo.OccurrencePatch = { isException: true };
  if (input.title !== undefined) patch.titleOverride = input.title;
  if (input.description !== undefined) patch.descriptionOverride = input.description ?? null;
  if (input.location !== undefined) patch.locationOverride = input.location ?? null;
  if (input.isAllDay !== undefined) patch.isAllDayOverride = input.isAllDay;

  if (input.durationMinutes !== undefined || input.isAllDay !== undefined) {
    const allDay = input.isAllDay ?? target.occurrence.isAllDayOverride ?? series.isAllDay;
    const requested = input.durationMinutes ?? series.durationMinutes;
    const minutes = allDay ? allDayDurationMinutes(requested) : requested;
    const times = resolveOccurrenceTimes(target.occurrence.startsLocal, minutes, series.timezone);
    patch.endsAt = times.endsAt;
  }

  await repo.updateOccurrenceRow(x, target.occurrence.id, patch);

  if (input.attendeeIds !== undefined) {
    await repo.removeAttendeesExcept(x, [target.occurrence.id], input.attendeeIds);
    await repo.addAttendees(x, [target.occurrence.id], input.attendeeIds);
  }
}

/**
 * What an `all` edit actually asks of the schedule.
 *
 * The predecessor of this function asked «is `recurrence`, `durationMinutes` or
 * `isAllDay` *present* in the body?» — and the form posts all three on every
 * save, renames included. Presence is not change: a corrected typo arrived
 * looking exactly like a reschedule, took the reschedule path, and deleted the
 * whole future of the series. So the request is compiled first and **compared**
 * with what is stored.
 *
 * The two answers are deliberately separate, because they are different
 * questions:
 *
 * - `keysChanged` — the rule moved, so *which local dates exist* may differ;
 * - `spanChanged` — only how long each occurrence lasts moved. Every date
 *   survives; turning a one-hour dinner into a two-hour one un-invites nobody.
 */
interface ScheduleIntent {
  readonly schedule: CompiledSchedule;
  readonly durationMinutes: number;
  readonly isAllDay: boolean;
  readonly keysChanged: boolean;
  readonly spanChanged: boolean;
}

/** RDATE/EXDATE lists are sets — a reordering is not a change. */
function sameLocalDates(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function resolveScheduleIntent(series: EventSeriesRow, input: EventSeriesUpdate): ScheduleIntent {
  const isAllDay = input.isAllDay ?? series.isAllDay;
  const spec = input.recurrence;
  const schedule: CompiledSchedule =
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
  const durationMinutes = isAllDay ? allDayDurationMinutes(requested) : requested;

  return {
    schedule,
    durationMinutes,
    isAllDay,
    keysChanged:
      schedule.rrule !== series.rrule ||
      schedule.dtstartLocal !== series.dtstartLocal ||
      schedule.timezone !== series.timezone ||
      !sameLocalDates(schedule.rdatesLocal, series.rdatesLocal) ||
      !sameLocalDates(schedule.exdatesLocal, series.exdatesLocal),
    spanChanged: durationMinutes !== series.durationMinutes || isAllDay !== series.isAllDay,
  };
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
 * every non-overridden occurrence picks the new title up for free — and, since
 * {@link resolveScheduleIntent} compares rather than sniffs, a rename really is
 * a metadata-only edit even though the form posts the schedule alongside it.
 *
 * A genuine schedule change **re-times** the future occurrences instead of
 * deleting them (see {@link reconcileFutureOccurrences}); past occurrences are
 * never touched by any scope.
 */
async function applyToAll(
  x: Executor,
  series: EventSeriesRow,
  input: EventSeriesUpdate,
): Promise<void> {
  const patch = metadataPatch(input);
  const intent = resolveScheduleIntent(series, input);
  const rescheduled = intent.keysChanged || intent.spanChanged;

  if (rescheduled) {
    patch.rrule = intent.schedule.rrule;
    patch.dtstartLocal = intent.schedule.dtstartLocal;
    patch.timezone = intent.schedule.timezone;
    patch.rdatesLocal = intent.schedule.rdatesLocal;
    patch.exdatesLocal = intent.schedule.exdatesLocal;
    patch.seriesEndsAt = recomputeSeriesEnd(intent.schedule);
    patch.isAllDay = intent.isAllDay;
    patch.durationMinutes = intent.durationMinutes;
    if (intent.keysChanged) {
      // The rule can now produce dates inside a window the watermark calls
      // done, so the watermark has to go back or they are never materialized.
      // A pure span change adds no dates, so it leaves the watermark alone.
      patch.materializedThrough = null;
    }
  }

  await repo.updateSeriesRow(x, series.id, patch);

  if (rescheduled) {
    const cutoff = localDateTimeIn(new Date(), intent.schedule.timezone);
    await reconcileFutureOccurrences(x, series.id, intent.schedule, intent.durationMinutes, cutoff);
  }

  await materializeAndInvite(x, series.id, input.attendeeIds ?? []);

  if (input.attendeeIds !== undefined) {
    const occurrenceIds = await repo.listOccurrenceIdsOfSeries(x, series.id);
    await repo.removeAttendeesExcept(x, occurrenceIds, input.attendeeIds);
  }
}

/** One occurrence row and the slot the edited rule now wants it on. */
interface OccurrenceMove {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Bring the future occurrences of a series in line with an edited schedule
 * **without throwing away the answers on the dates that survive it**.
 *
 * This used to be one `DELETE ... WHERE occurrence_key >= now` followed by a
 * re-materialization. `event_attendees.occurrence_id` is `ON DELETE CASCADE`,
 * so every «приду» and every «не приду» on every future date went with the
 * rows, and the re-invite that followed brought the guest list back at the
 * column default, `pending`. Moving a weekly dinner from 18:00 to 19:00 is not
 * a reason to ask the family again — it is the same dinner, and the same
 * people are coming to it.
 *
 * ## Telling a surviving date from a vanished one
 *
 * The identity of an occurrence is `occurrence_key`, the floating local slot
 * the rule produced. It is *not* usable as the match here, because the key
 * carries the time of day: 18:00 → 19:00 rewrites every key in the series even
 * though not one date moved, and matching on the key would call all of them
 * vanished — which is the very data loss this function exists to stop.
 *
 * What survives a re-timing is the **local date**. So the old slots of a date
 * are paired with the new slots of that same date, in clock order:
 *
 * - paired → the row is re-timed in place, keeping its id and with it its
 *   `event_attendees` rows and their answers;
 * - an old slot with no new partner → the rule genuinely stopped producing it,
 *   so the row goes and its answers cascade away with it. That is right: there
 *   is nothing left to come to;
 * - a new slot with no old partner → left to the materializer on the next line.
 *
 * `done`, `cancelled` and hand-edited (`is_exception`) rows are outside all of
 * this, exactly as before — history is not rewritten.
 */
export async function reconcileFutureOccurrences(
  x: Executor,
  seriesId: string,
  schedule: CompiledSchedule,
  durationMinutes: number,
  cutoffKey: string,
): Promise<void> {
  const timezone = schedule.timezone;
  const existing = await repo.listFutureScheduledOccurrences(x, seriesId, cutoffKey);

  /**
   * The expansion window has to reach every row we are about to judge. A row
   * beyond the horizon that the new rule *does* still produce would otherwise
   * look like one it dropped, and be deleted with its answers.
   */
  const from = recurrenceEngine.toInstant(cutoffKey, timezone);
  const horizon = new Date(Date.now() + HORIZON_DAYS * MS_PER_DAY);
  const last = existing[existing.length - 1];
  const to =
    last === undefined
      ? horizon
      : new Date(
          Math.max(
            horizon.getTime(),
            recurrenceEngine.toInstant(last.occurrenceKey, timezone).getTime(),
          ),
        );

  const planned = recurrenceEngine
    .expand(
      {
        rrule: schedule.rrule,
        dtstartLocal: schedule.dtstartLocal,
        timezone,
        rdatesLocal: schedule.rdatesLocal,
        exdatesLocal: schedule.exdatesLocal,
      },
      {
        from,
        to,
        // The cap must clear the rows being judged. Truncating the expansion at
        // the 1000th slot of a `FREQ=HOURLY` import would make slot 1001
        // indistinguishable from one the rule dropped, and delete it.
        maxCount: Math.max(DEFAULT_MAX_COUNT, existing.length + 1),
      },
    )
    .filter((key) => key >= cutoffKey);

  interface DateBucket {
    readonly rows: EventOccurrenceRow[];
    readonly slots: string[];
  }
  const byDate = new Map<string, DateBucket>();
  const bucketOf = (key: string): DateBucket => {
    const date = recurrenceEngine.localDateOf(key);
    let bucket = byDate.get(date);
    if (!bucket) {
      bucket = { rows: [], slots: [] };
      byDate.set(date, bucket);
    }
    return bucket;
  };
  // Both lists arrive sorted — the rows by `ORDER BY occurrence_key`, the slots
  // from the expander — so pairing by position is pairing in clock order.
  for (const row of existing) bucketOf(row.occurrenceKey).rows.push(row);
  for (const key of planned) bucketOf(key).slots.push(key);

  const doomed: string[] = [];
  const moves: OccurrenceMove[] = [];
  for (const { rows, slots } of byDate.values()) {
    for (const [index, row] of rows.entries()) {
      const slot = slots[index];
      if (slot === undefined) doomed.push(row.id);
      else moves.push({ id: row.id, from: row.occurrenceKey, to: slot });
    }
  }

  // Deletes first: they free slots a survivor may be moving onto.
  await repo.deleteOccurrencesByIds(x, doomed);

  const retime = async (move: OccurrenceMove): Promise<void> => {
    const times = resolveOccurrenceTimes(move.to, durationMinutes, timezone);
    await repo.retimeOccurrence(x, move.id, { occurrenceKey: move.to, ...times });
  };

  // A slot that did not move still needs its span recomputed — that is the
  // whole of a duration-only edit.
  for (const move of moves) {
    if (move.from === move.to) await retime(move);
  }

  /**
   * A slot that *did* move has to wait for the slot it is moving onto to be
   * vacated: `event_occurrences_series_key_uq` is not deferrable, so a row
   * cannot take 19:00 while another row of the same day still holds it.
   * Applying the unblocked moves first always makes progress — were every
   * remaining move blocked, that day's old and new key sets would be equal, and
   * pairing two equal sorted sets by position yields only no-ops, which the
   * loop above has already dealt with.
   */
  let pending = moves.filter((move) => move.from !== move.to);
  const held = new Set(pending.map((move) => move.from));
  while (pending.length > 0) {
    const free = pending.filter((move) => !held.has(move.to));
    if (free.length === 0) throw internal('Reschedule could not order the occurrence moves');
    for (const move of free) {
      held.delete(move.from);
      await retime(move);
    }
    const done = new Set(free.map((move) => move.id));
    pending = pending.filter((move) => !done.has(move.id));
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
  if (!anchor || anchor.occurrence.seriesId !== series.id) throw notFound('Event occurrence');

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

  const attendeeIds = input.attendeeIds ?? (await repo.listSeriesAttendeeIds(x, series.id));
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
    if (!series) throw notFound('Event');
    const now = new Date();

    switch (input.scope) {
      case 'this': {
        if (input.occurrenceId === undefined) throw badRequest('occurrenceId обязателен');
        const target = await repo.findOccurrenceById(tx, input.occurrenceId);
        if (!target || target.occurrence.seriesId !== series.id) {
          throw notFound('Event occurrence');
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
          throw notFound('Event occurrence');
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
        await repo.deleteFutureScheduledOccurrences(tx, series.id, anchor.occurrence.occurrenceKey);
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
  if (!mapped) throw notFound('Event');
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
      input.isAllDayOverride ?? row.occurrence.isAllDayOverride ?? row.series.isAllDay;
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
    return toOccurrenceResponse(updated, row.series, attendees.get(id) ?? [], actor.userId);
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
  const timezone = timezoneOverride ?? actor.timezone ?? (await repo.getFamilyTimezone(db));
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
