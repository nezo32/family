import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { EventSourceKind, Rsvp } from '@family/shared';

import type { Executor } from '../../core/db.js';
import { internal } from '../../core/errors.js';
import { ts } from '../../core/sql.js';
import {
  decodeTimestampCursor,
  encodeTimestampCursor,
  type Page,
  type TimestampCursor,
} from '../../core/pagination.js';
import {
  materializeThroughPort,
  type MaterializeOptions,
  type MaterializeResult,
  type MaterializerPort,
  type SeriesSnapshot,
} from '../../core/recurrence/materializer.js';
import { auditLog, familySettings } from '../identity/identity.schema.js';
import { users } from '../identity/users.schema.js';
import {
  eventAttendees,
  eventOccurrences,
  eventSeries,
  type EventAttendeeRow,
  type EventOccurrenceRow,
  type EventSeriesRow,
  type NewEventSeriesRow,
} from './events.schema.js';

/**
 * Calendar data access. No HTTP knowledge, no business rules (D8).
 *
 * Every function takes an {@link Executor} first so the same call works on the
 * pool handle or inside an open transaction — the series-split and the eager
 * materialization in `events.service.ts` need the latter.
 *
 * ## Two things this file exists to get right
 *
 * **1. The calendar grid reads a local-date window.** A month view is a
 * statement about local dates, not about instants: the cell labelled «7 сентября»
 * must contain exactly the occurrences whose *local* date is `2026-09-07`, no
 * matter what the offset was that day. So the grid query filters on the
 * denormalized `local_date` column (`event_occurrences_local_date_idx`) and
 * never on `starts_at BETWEEN <two instants>`. Filtering on instants is how a
 * 00:30 event lands in yesterday's cell for half the year.
 *
 * **2. No N+1 on attendees.** A page of occurrences costs one query for the
 * rows (joined to their series, so the resolution of
 * `COALESCE(override, series_value)` needs no second read) and exactly one more
 * for every attendee of every row on the page — see {@link loadAttendees}.
 *
 * ## Visibility
 *
 * `visibility` is a **read filter**, applied after the RBAC check (D4), and it
 * is applied *in SQL*. Fetching a row and then comparing in JS leaks existence
 * through the error shape; filtering in the predicate means an invisible event
 * is indistinguishable from a missing one, which is what "404, not 403" means.
 *
 * - `household`  — everybody.
 * - `private`    — the creator only.
 * - `restricted` — the creator plus the explicit participant list in
 *   `event_attendees` (see the enum doc in `src/db/enums.ts`).
 */

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

/** An occurrence together with the series row its values resolve against. */
export interface OccurrenceWithSeries {
  readonly occurrence: EventOccurrenceRow;
  readonly series: EventSeriesRow;
}

export interface SeriesPatch {
  title?: string;
  description?: string | null;
  location?: string | null;
  visibility?: EventSeriesRow['visibility'];
  durationMinutes?: number;
  isAllDay?: boolean;
  reminderOffsets?: number[];
  color?: string | null;
  category?: string | null;
  rrule?: string | null;
  dtstartLocal?: string;
  timezone?: string;
  rdatesLocal?: string[];
  exdatesLocal?: string[];
  seriesEndsAt?: Date | null;
  materializedThrough?: Date | null;
  archivedAt?: Date | null;
}

export interface OccurrencePatch {
  titleOverride?: string | null;
  descriptionOverride?: string | null;
  locationOverride?: string | null;
  isAllDayOverride?: boolean | null;
  startsAt?: Date;
  endsAt?: Date;
  localDate?: string;
  startsLocal?: string;
  status?: EventOccurrenceRow['status'];
  isException?: boolean;
}

export interface CalendarFilters {
  readonly viewerId: string;
  /** Inclusive local date, `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive local date, `YYYY-MM-DD`. */
  readonly to: string;
  readonly category?: string | undefined;
  readonly attendeeId?: string | undefined;
  readonly includeCancelled?: boolean | undefined;
  readonly limit?: number | undefined;
}

/** One `(occurrence, reminderOffset)` pair whose lead time has just elapsed. */
export interface DueReminder {
  readonly occurrenceId: string;
  readonly seriesId: string;
  readonly offsetMinutes: number;
  readonly startsAt: Date;
  readonly localDate: string;
  readonly title: string;
  readonly visibility: EventSeriesRow['visibility'];
  readonly createdById: string;
  readonly isAllDay: boolean;
  readonly attendeeIds: string[];
}

export interface BirthdayCandidate {
  readonly id: string;
  readonly displayName: string;
  /** `YYYY-MM-DD`, or null once the user clears it. */
  readonly birthDate: string | null;
  readonly status: string;
}

/** Rows per multi-row INSERT. Keeps the bound-parameter count well under PG's cap. */
const INSERT_CHUNK = 200;

/** Default cap on a single calendar-window read. */
const CALENDAR_LIMIT = 2000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* -------------------------------------------------------------------------- */
/* Visibility predicates                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Can this viewer see this *occurrence*?
 *
 * Attendance is per occurrence (see `event_attendees`), so a `restricted`
 * series that invited somebody to this Thursday and not to the next one hides
 * the next one from them — which is the behaviour the column exists for.
 */
export function occurrenceVisibleTo(viewerId: string): SQL {
  const clause = or(
    eq(eventSeries.visibility, 'household'),
    eq(eventSeries.createdById, viewerId),
    and(
      eq(eventSeries.visibility, 'restricted'),
      sql`exists (
        select 1 from ${eventAttendees}
        where ${eventAttendees.occurrenceId} = ${eventOccurrences.id}
          and ${eventAttendees.userId} = ${viewerId}
      )`,
    ),
  );
  if (clause === undefined) throw internal('occurrenceVisibleTo produced an empty predicate');
  return clause;
}

/** Can this viewer see this *series*? Restricted ⇒ attendee of any occurrence. */
export function seriesVisibleTo(viewerId: string): SQL {
  const clause = or(
    eq(eventSeries.visibility, 'household'),
    eq(eventSeries.createdById, viewerId),
    and(
      eq(eventSeries.visibility, 'restricted'),
      sql`exists (
        select 1 from ${eventOccurrences}
        join ${eventAttendees} on ${eventAttendees.occurrenceId} = ${eventOccurrences.id}
        where ${eventOccurrences.seriesId} = ${eventSeries.id}
          and ${eventAttendees.userId} = ${viewerId}
      )`,
    ),
  );
  if (clause === undefined) throw internal('seriesVisibleTo produced an empty predicate');
  return clause;
}

/* -------------------------------------------------------------------------- */
/* Family settings                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The family timezone (D1 singleton). Every series that does not carry its own
 * anchor zone inherits this, and the ICS feed labels itself with it.
 */
export async function getFamilyTimezone(x: Executor): Promise<string> {
  const [row] = await x.select({ timezone: familySettings.timezone }).from(familySettings).limit(1);
  return row?.timezone ?? 'Europe/Moscow';
}

export async function getFamilyName(x: Executor): Promise<string> {
  const [row] = await x
    .select({ familyName: familySettings.familyName })
    .from(familySettings)
    .limit(1);
  return row?.familyName ?? 'Семья';
}

/* -------------------------------------------------------------------------- */
/* Series                                                                      */
/* -------------------------------------------------------------------------- */

export async function insertSeries(x: Executor, row: NewEventSeriesRow): Promise<EventSeriesRow> {
  const [created] = await x.insert(eventSeries).values(row).returning();
  if (!created) throw internal('event_series insert returned no row');
  return created;
}

export async function findSeriesById(x: Executor, id: string): Promise<EventSeriesRow | null> {
  const [row] = await x.select().from(eventSeries).where(eq(eventSeries.id, id)).limit(1);
  return row ?? null;
}

/** `SELECT ... FOR UPDATE` — serialises a split against a concurrent edit. */
export async function lockSeriesById(x: Executor, id: string): Promise<EventSeriesRow | null> {
  const [row] = await x
    .select()
    .from(eventSeries)
    .where(eq(eventSeries.id, id))
    .limit(1)
    .for('update');
  return row ?? null;
}

/**
 * The read used by every `GET .../series/:id`. Returns `null` — never a row the
 * caller may not see — so the route can answer 404 without branching.
 */
export async function findVisibleSeries(
  x: Executor,
  id: string,
  viewerId: string,
): Promise<EventSeriesRow | null> {
  const [row] = await x
    .select()
    .from(eventSeries)
    .where(and(eq(eventSeries.id, id), seriesVisibleTo(viewerId)))
    .limit(1);
  return row ?? null;
}

export async function findSeriesBySource(
  x: Executor,
  sourceKind: EventSourceKind,
  sourceRef: string,
): Promise<EventSeriesRow | null> {
  const [row] = await x
    .select()
    .from(eventSeries)
    .where(and(eq(eventSeries.sourceKind, sourceKind), eq(eventSeries.sourceRef, sourceRef)))
    .limit(1);
  return row ?? null;
}

export async function listSeriesBySource(
  x: Executor,
  sourceKind: EventSourceKind,
): Promise<EventSeriesRow[]> {
  return x
    .select()
    .from(eventSeries)
    .where(and(eq(eventSeries.sourceKind, sourceKind), isNotNull(eventSeries.sourceRef)));
}

export interface ListSeriesQuery {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly includeArchived: boolean;
  readonly category?: string | undefined;
  readonly sourceKind?: EventSourceKind | undefined;
}

export type { Page };

/**
 * Keyset cursor over `(created_at, id)` — `core/pagination.ts`.
 *
 * The `createdAt|id` string this module used to encode is gone; the codec is
 * the shared `{ v, id }` JSON form, which is what every list endpoint speaks
 * now. The forgiving `null` on an unreadable cursor is unchanged — events was
 * already one of the three modules that got that right.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  return encodeTimestampCursor({ createdAt, id });
}

export function decodeCursor(cursor: string): TimestampCursor | null {
  return decodeTimestampCursor(cursor);
}

export async function listSeries(
  x: Executor,
  viewerId: string,
  query: ListSeriesQuery,
): Promise<Page<EventSeriesRow>> {
  const filters: SQL[] = [seriesVisibleTo(viewerId)];
  if (!query.includeArchived) filters.push(isNull(eventSeries.archivedAt));
  if (query.category !== undefined) filters.push(eq(eventSeries.category, query.category));
  if (query.sourceKind !== undefined) filters.push(eq(eventSeries.sourceKind, query.sourceKind));

  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    if (decoded !== null) {
      const after = or(
        lt(eventSeries.createdAt, decoded.createdAt),
        and(eq(eventSeries.createdAt, decoded.createdAt), lt(eventSeries.id, decoded.id)),
      );
      if (after !== undefined) filters.push(after);
    }
  }

  const rows = await x
    .select()
    .from(eventSeries)
    .where(and(...filters))
    .orderBy(desc(eventSeries.createdAt), desc(eventSeries.id))
    .limit(query.limit + 1);

  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null;
  return { items, nextCursor };
}

export async function updateSeriesRow(
  x: Executor,
  id: string,
  patch: SeriesPatch,
): Promise<EventSeriesRow> {
  const [row] = await x
    .update(eventSeries)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(eventSeries.id, id))
    .returning();
  if (!row) throw internal('event_series update affected no row');
  return row;
}

export async function archiveSeries(x: Executor, id: string, at: Date): Promise<void> {
  await x
    .update(eventSeries)
    .set({ archivedAt: at, updatedAt: at })
    .where(and(eq(eventSeries.id, id), isNull(eventSeries.archivedAt)));
}

export async function deleteSeries(x: Executor, id: string): Promise<void> {
  await x.delete(eventSeries).where(eq(eventSeries.id, id));
}

/** Does this series have any occurrence a user actually interacted with? */
export async function seriesHasHistory(x: Executor, id: string): Promise<boolean> {
  const [row] = await x
    .select({ id: eventOccurrences.id })
    .from(eventOccurrences)
    .where(
      and(
        eq(eventOccurrences.seriesId, id),
        inArray(eventOccurrences.status, ['done', 'skipped', 'cancelled']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Occurrences                                                                 */
/* -------------------------------------------------------------------------- */

export async function findOccurrenceById(
  x: Executor,
  id: string,
): Promise<OccurrenceWithSeries | null> {
  const [row] = await x
    .select({ occurrence: eventOccurrences, series: eventSeries })
    .from(eventOccurrences)
    .innerJoin(eventSeries, eq(eventSeries.id, eventOccurrences.seriesId))
    .where(eq(eventOccurrences.id, id))
    .limit(1);
  return row ?? null;
}

export async function findVisibleOccurrence(
  x: Executor,
  id: string,
  viewerId: string,
): Promise<OccurrenceWithSeries | null> {
  const [row] = await x
    .select({ occurrence: eventOccurrences, series: eventSeries })
    .from(eventOccurrences)
    .innerJoin(eventSeries, eq(eventSeries.id, eventOccurrences.seriesId))
    .where(and(eq(eventOccurrences.id, id), occurrenceVisibleTo(viewerId)))
    .limit(1);
  return row ?? null;
}

/**
 * The month/week/agenda read.
 *
 * Filters on `local_date` (the denormalized calendar-grid column) rather than
 * on `starts_at`, so the window means exactly what the grid means. One query,
 * series joined in; attendees come from {@link loadAttendees}.
 */
export async function listOccurrencesInLocalRange(
  x: Executor,
  filters: CalendarFilters,
): Promise<OccurrenceWithSeries[]> {
  const where: SQL[] = [
    gte(eventOccurrences.localDate, filters.from),
    lte(eventOccurrences.localDate, filters.to),
    isNull(eventSeries.archivedAt),
    occurrenceVisibleTo(filters.viewerId),
  ];
  if (filters.includeCancelled !== true) {
    where.push(sql`${eventOccurrences.status} <> 'cancelled'`);
  }
  if (filters.category !== undefined) {
    where.push(eq(eventSeries.category, filters.category));
  }
  if (filters.attendeeId !== undefined) {
    where.push(
      sql`exists (
        select 1 from ${eventAttendees}
        where ${eventAttendees.occurrenceId} = ${eventOccurrences.id}
          and ${eventAttendees.userId} = ${filters.attendeeId}
      )`,
    );
  }

  return x
    .select({ occurrence: eventOccurrences, series: eventSeries })
    .from(eventOccurrences)
    .innerJoin(eventSeries, eq(eventSeries.id, eventOccurrences.seriesId))
    .where(and(...where))
    .orderBy(asc(eventOccurrences.startsAt), asc(eventOccurrences.id))
    .limit(filters.limit ?? CALENDAR_LIMIT);
}

export interface ListOccurrencesQuery {
  readonly viewerId: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly seriesId?: string | undefined;
  readonly attendeeId?: string | undefined;
  readonly status?: ReadonlyArray<EventOccurrenceRow['status']> | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export async function listOccurrences(
  x: Executor,
  query: ListOccurrencesQuery,
): Promise<Page<OccurrenceWithSeries>> {
  const where: SQL[] = [occurrenceVisibleTo(query.viewerId)];
  if (query.seriesId !== undefined) where.push(eq(eventOccurrences.seriesId, query.seriesId));
  if (query.from !== undefined) where.push(gte(eventOccurrences.localDate, query.from));
  if (query.to !== undefined) where.push(lte(eventOccurrences.localDate, query.to));
  if (query.status !== undefined && query.status.length > 0) {
    where.push(inArray(eventOccurrences.status, [...query.status]));
  }
  if (query.attendeeId !== undefined) {
    where.push(
      sql`exists (
        select 1 from ${eventAttendees}
        where ${eventAttendees.occurrenceId} = ${eventOccurrences.id}
          and ${eventAttendees.userId} = ${query.attendeeId}
      )`,
    );
  }
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    if (decoded !== null) {
      const after = or(
        gt(eventOccurrences.startsAt, decoded.createdAt),
        and(eq(eventOccurrences.startsAt, decoded.createdAt), gt(eventOccurrences.id, decoded.id)),
      );
      if (after !== undefined) where.push(after);
    }
  }

  const rows = await x
    .select({ occurrence: eventOccurrences, series: eventSeries })
    .from(eventOccurrences)
    .innerJoin(eventSeries, eq(eventSeries.id, eventOccurrences.seriesId))
    .where(and(...where))
    .orderBy(asc(eventOccurrences.startsAt), asc(eventOccurrences.id))
    .limit(query.limit + 1);

  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > query.limit && last
      ? encodeCursor(last.occurrence.startsAt, last.occurrence.id)
      : null;
  return { items, nextCursor };
}

export async function listOccurrencesOfSeries(
  x: Executor,
  seriesId: string,
): Promise<EventOccurrenceRow[]> {
  return x
    .select()
    .from(eventOccurrences)
    .where(eq(eventOccurrences.seriesId, seriesId))
    .orderBy(asc(eventOccurrences.occurrenceKey));
}

export async function findOccurrenceByKey(
  x: Executor,
  seriesId: string,
  occurrenceKey: string,
): Promise<EventOccurrenceRow | null> {
  const [row] = await x
    .select()
    .from(eventOccurrences)
    .where(
      and(
        eq(eventOccurrences.seriesId, seriesId),
        eq(eventOccurrences.occurrenceKey, occurrenceKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function updateOccurrenceRow(
  x: Executor,
  id: string,
  patch: OccurrencePatch,
): Promise<EventOccurrenceRow> {
  const [row] = await x
    .update(eventOccurrences)
    .set(patch)
    .where(eq(eventOccurrences.id, id))
    .returning();
  if (!row) throw internal('event_occurrences update affected no row');
  return row;
}

/**
 * The delete half of the §3.3 series split.
 *
 * **Only `scheduled`, non-exception rows at or after the anchor key.** A `done`
 * or `cancelled` occurrence is history and an exception is a deliberate user
 * edit; rewriting either is the data loss the explicit `scope` exists to
 * prevent.
 */
export async function deleteFutureScheduledOccurrences(
  x: Executor,
  seriesId: string,
  fromKey: string,
): Promise<number> {
  const rows = await x
    .delete(eventOccurrences)
    .where(
      and(
        eq(eventOccurrences.seriesId, seriesId),
        gte(eventOccurrences.occurrenceKey, fromKey),
        eq(eventOccurrences.status, 'scheduled'),
        eq(eventOccurrences.isException, false),
      ),
    )
    .returning({ id: eventOccurrences.id });
  return rows.length;
}

/** `scheduled` future rows become `cancelled` — used by "delete all". */
export async function cancelFutureOccurrences(
  x: Executor,
  seriesId: string,
  fromInstant: Date,
): Promise<number> {
  const rows = await x
    .update(eventOccurrences)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(eventOccurrences.seriesId, seriesId),
        gte(eventOccurrences.startsAt, fromInstant),
        eq(eventOccurrences.status, 'scheduled'),
      ),
    )
    .returning({ id: eventOccurrences.id });
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* Materialization                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A typed Drizzle implementation of the core {@link MaterializerPort}.
 *
 * The algorithm — the watermark, the `ON CONFLICT DO NOTHING` idempotency, the
 * exception protection — is entirely the core one; only the four SQL statements
 * are ours. Two reasons to supply them:
 *
 * 1. **It is the seam the core module was built for.** `materializeThroughPort`
 *    exists precisely so a domain can bring its own persistence.
 *
 * 2. **`createMaterializerPort` cannot bind a `Date`.** It composes raw
 *    `sql` fragments and hands `Date` objects to `db.execute()`; drizzle-orm
 *    0.44 passes an untyped param straight through, and postgres.js's Bind
 *    step then throws `The "string" argument must be of type string ... Received
 *    an instance of Date`. Going through the query builder means the column
 *    types are known, so `timestamptz` values are serialised properly.
 *    **Flagged for the lead** — `task_occurrences` will hit the identical bug
 *    the moment the tasks module materializes against a real database.
 */
export function createEventMaterializerPort(x: Executor): MaterializerPort {
  return {
    async lockSeries(seriesId: string): Promise<SeriesSnapshot | null> {
      const row = await lockSeriesById(x, seriesId);
      if (row === null) return null;
      return {
        id: row.id,
        rule: {
          rrule: row.rrule,
          dtstartLocal: row.dtstartLocal,
          timezone: row.timezone,
          rdatesLocal: row.rdatesLocal,
          exdatesLocal: row.exdatesLocal,
        },
        // For events the wall-clock offset from the start is the duration.
        offsetMinutes: row.durationMinutes,
        seriesEndsAt: row.seriesEndsAt,
        materializedThrough: row.materializedThrough,
        archivedAt: row.archivedAt,
      };
    },

    async insertOccurrences(occurrences, extras): Promise<number> {
      if (occurrences.length === 0) return 0;
      // Events have no frozen per-occurrence columns to decorate (that is the
      // tasks module's `assignee_id` / `assigned_via` pair, D5), so a decorator
      // here would be silently dropped. Refuse instead.
      if (extras.some((extra) => Object.keys(extra).length > 0)) {
        throw internal('The event materializer port does not support decorators');
      }

      let inserted = 0;
      const rows = occurrences.map((o) => ({
        seriesId: o.seriesId,
        occurrenceKey: o.occurrenceKey,
        startsAt: o.startsAt,
        endsAt: o.derivedAt,
        localDate: o.localDate,
        startsLocal: o.startsLocal,
      }));

      for (const batch of chunk(rows, INSERT_CHUNK)) {
        // The whole idempotency guarantee: a key that already exists is left
        // exactly as the user last edited it (§2).
        const written = await x
          .insert(eventOccurrences)
          .values(batch)
          .onConflictDoNothing({
            target: [eventOccurrences.seriesId, eventOccurrences.occurrenceKey],
          })
          .returning({ id: eventOccurrences.id });
        inserted += written.length;
      }
      return inserted;
    },

    async advanceWatermark(seriesId: string, through: Date): Promise<void> {
      // Conditional, so the watermark only ever moves forward even if two
      // passes race.
      await x
        .update(eventSeries)
        .set({ materializedThrough: through })
        .where(
          and(
            eq(eventSeries.id, seriesId),
            or(
              isNull(eventSeries.materializedThrough),
              lt(eventSeries.materializedThrough, through),
            ),
          ),
        );
    },

    async listDueSeriesIds(horizon: Date, limit: number): Promise<string[]> {
      const rows = await x
        .select({ id: eventSeries.id })
        .from(eventSeries)
        .where(
          and(
            isNull(eventSeries.archivedAt),
            isNotNull(eventSeries.rrule),
            or(
              isNull(eventSeries.materializedThrough),
              lt(eventSeries.materializedThrough, horizon),
            ),
            or(
              isNull(eventSeries.seriesEndsAt),
              isNull(eventSeries.materializedThrough),
              gt(eventSeries.seriesEndsAt, eventSeries.materializedThrough),
            ),
          ),
        )
        .orderBy(asc(sql`${eventSeries.materializedThrough} nulls first`), asc(eventSeries.id))
        .limit(limit);
      return rows.map((r) => r.id);
    },
  };
}

/**
 * Materialize one event series through the port above.
 *
 * Takes the caller's `Executor`, which is how "eagerly on every series write,
 * inside the same transaction as the write" is expressed: pass the open `Tx`
 * and the occurrences commit or roll back with the series row.
 */
export function materializeEventSeries(
  x: Executor,
  seriesId: string,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  return materializeThroughPort(createEventMaterializerPort(x), seriesId, options);
}

/* -------------------------------------------------------------------------- */
/* Attendees & RSVP                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Attendees for a whole page of occurrences in **one** query.
 *
 * This is the reason it takes an array. A per-row call inside a `.map()` turns
 * a month view into ~120 round trips, and the month view is the screen the
 * family opens most.
 */
export async function loadAttendees(
  x: Executor,
  occurrenceIds: readonly string[],
): Promise<Map<string, EventAttendeeRow[]>> {
  const out = new Map<string, EventAttendeeRow[]>();
  if (occurrenceIds.length === 0) return out;

  const rows = await x
    .select()
    .from(eventAttendees)
    .where(inArray(eventAttendees.occurrenceId, [...occurrenceIds]))
    .orderBy(asc(eventAttendees.occurrenceId), asc(eventAttendees.userId));

  for (const row of rows) {
    const bucket = out.get(row.occurrenceId);
    if (bucket) bucket.push(row);
    else out.set(row.occurrenceId, [row]);
  }
  return out;
}

/** Invite `userIds` to every listed occurrence. Existing rows keep their RSVP. */
export async function addAttendees(
  x: Executor,
  occurrenceIds: readonly string[],
  userIds: readonly string[],
): Promise<void> {
  if (occurrenceIds.length === 0 || userIds.length === 0) return;
  const values = occurrenceIds.flatMap((occurrenceId) =>
    userIds.map((userId) => ({ occurrenceId, userId })),
  );
  for (const batch of chunk(values, INSERT_CHUNK)) {
    await x
      .insert(eventAttendees)
      .values(batch)
      // The unique index is what makes a re-run of the fan-out free, and it is
      // also what stops a re-invite from resetting somebody's «нет» to pending.
      .onConflictDoNothing({
        target: [eventAttendees.occurrenceId, eventAttendees.userId],
      });
  }
}

export async function removeAttendeesExcept(
  x: Executor,
  occurrenceIds: readonly string[],
  keepUserIds: readonly string[],
): Promise<void> {
  if (occurrenceIds.length === 0) return;
  const where: SQL[] = [inArray(eventAttendees.occurrenceId, [...occurrenceIds])];
  if (keepUserIds.length > 0) {
    where.push(sql`${eventAttendees.userId} <> all(${[...keepUserIds]}::uuid[])`);
  }
  await x.delete(eventAttendees).where(and(...where));
}

export async function upsertRsvp(
  x: Executor,
  occurrenceId: string,
  userId: string,
  rsvp: Rsvp,
  at: Date,
): Promise<EventAttendeeRow> {
  const [row] = await x
    .insert(eventAttendees)
    .values({ occurrenceId, userId, rsvp, respondedAt: at })
    .onConflictDoUpdate({
      target: [eventAttendees.occurrenceId, eventAttendees.userId],
      set: { rsvp, respondedAt: at },
    })
    .returning();
  if (!row) throw internal('event_attendees upsert returned no row');
  return row;
}

/** Distinct attendees across every occurrence of a series. */
export async function listSeriesAttendeeIds(x: Executor, seriesId: string): Promise<string[]> {
  const rows = await x
    .selectDistinct({ userId: eventAttendees.userId })
    .from(eventAttendees)
    .innerJoin(eventOccurrences, eq(eventOccurrences.id, eventAttendees.occurrenceId))
    .where(eq(eventOccurrences.seriesId, seriesId));
  return rows.map((r) => r.userId);
}

/** Occurrence ids of a series, optionally only those at or after a key. */
export async function listOccurrenceIdsOfSeries(
  x: Executor,
  seriesId: string,
  fromKey?: string,
): Promise<string[]> {
  const where: SQL[] = [eq(eventOccurrences.seriesId, seriesId)];
  if (fromKey !== undefined) where.push(gte(eventOccurrences.occurrenceKey, fromKey));
  const rows = await x
    .select({ id: eventOccurrences.id })
    .from(eventOccurrences)
    .where(and(...where));
  return rows.map((r) => r.id);
}

/* -------------------------------------------------------------------------- */
/* Users (birthday sync)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everybody who could have a birthday event, including those whose `birthDate`
 * is now NULL — the sync has to archive their series, so it must see them.
 */
export async function listBirthdayCandidates(x: Executor): Promise<BirthdayCandidate[]> {
  return x
    .select({
      id: users.id,
      displayName: users.displayName,
      birthDate: users.birthDate,
      status: users.status,
    })
    .from(users)
    .orderBy(asc(users.sortOrder), asc(users.id));
}

export async function findUserById(x: Executor, id: string): Promise<BirthdayCandidate | null> {
  const [row] = await x
    .select({
      id: users.id,
      displayName: users.displayName,
      birthDate: users.birthDate,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ?? null;
}

/* -------------------------------------------------------------------------- */
/* ICS feed token revocation                                                   */
/* -------------------------------------------------------------------------- */

/** The audit action a feed-link rotation writes. */
export const FEED_REVOKE_ACTION = 'calendar:feed_revoked';

/**
 * The revocation epoch a user's feed token is bound to, in epoch milliseconds
 * (`0` = never revoked).
 *
 * The token is a stateless HMAC over `(userId, epoch)`, so bumping the epoch
 * changes the only URL that verifies — which is what makes a leaked calendar
 * link revocable without a token table. See `ics.service.ts` for the full
 * design and its trade-off.
 *
 * `audit_log` is append-only and already the home of "who did what to whom", so
 * the epoch is `MAX(created_at)` over this user's revocation rows. No secret is
 * ever written here — only the instant.
 */
export async function getFeedRevocationEpoch(x: Executor, userId: string): Promise<number> {
  const [row] = await x
    .select({ createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.action, FEED_REVOKE_ACTION), eq(auditLog.targetId, userId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row ? row.createdAt.getTime() : 0;
}

/**
 * Revoke every feed URL this user has ever been given, by moving the epoch to
 * `at`. Returns the new epoch so the caller can mint the replacement link.
 */
export async function recordFeedRevocation(
  x: Executor,
  userId: string,
  actorId: string,
  at: Date,
): Promise<number> {
  await x.insert(auditLog).values({
    actorId,
    action: FEED_REVOKE_ACTION,
    targetType: 'user',
    targetId: userId,
    metadata: {},
    createdAt: at,
  });
  return at.getTime();
}

/* -------------------------------------------------------------------------- */
/* Reminders                                                                   */
/* -------------------------------------------------------------------------- */

interface DueReminderRow {
  [column: string]: unknown;
  occurrence_id: string;
  series_id: string;
  offset_minutes: number | string;
  starts_at: Date | string;
  local_date: string;
  title: string;
  visibility: EventSeriesRow['visibility'];
  created_by_id: string;
  is_all_day: boolean;
  attendee_ids: string[] | null;
}

/**
 * Every `(occurrence, reminderOffset)` pair whose lead time elapsed inside
 * `(now - lookbackMinutes, now]`.
 *
 * `reminder_offsets` is an `int[]`, so the pairs come from a
 * `CROSS JOIN LATERAL unnest(...)` — one row per reminder, which is exactly the
 * grain the dedupe key needs.
 *
 * The lower bound matters: without it, a worker that was down for a day would
 * come back and fire every reminder it missed at once. With it, a long outage
 * silently drops stale reminders — a notification about an event that started
 * two hours ago is noise, and D10's real failure mode is fatigue.
 */
export async function listDueReminders(
  x: Executor,
  options: { now: Date; lookbackMinutes: number; limit: number },
): Promise<DueReminder[]> {
  const rows = await x.execute<DueReminderRow>(sql`
    select
      o.id                as occurrence_id,
      o.series_id         as series_id,
      ro.offset_minutes   as offset_minutes,
      o.starts_at         as starts_at,
      o.local_date        as local_date,
      coalesce(o.title_override, s.title)        as title,
      s.visibility        as visibility,
      s.created_by_id     as created_by_id,
      coalesce(o.is_all_day_override, s.is_all_day) as is_all_day,
      coalesce(
        (select array_agg(a.user_id) from event_attendees a where a.occurrence_id = o.id),
        '{}'::uuid[]
      ) as attendee_ids
    from event_occurrences o
    join event_series s on s.id = o.series_id
    cross join lateral unnest(s.reminder_offsets) as ro(offset_minutes)
    where o.status = 'scheduled'
      and s.archived_at is null
      and o.starts_at > ${ts(options.now)}
      and o.starts_at - make_interval(mins => ro.offset_minutes) <= ${ts(options.now)}
      and o.starts_at - make_interval(mins => ro.offset_minutes) >
          ${ts(new Date(options.now.getTime() - options.lookbackMinutes * 60_000))}
    order by o.starts_at asc
    limit ${options.limit}
  `);

  return rows.map((row) => ({
    occurrenceId: row.occurrence_id,
    seriesId: row.series_id,
    offsetMinutes:
      typeof row.offset_minutes === 'number'
        ? row.offset_minutes
        : Number.parseInt(row.offset_minutes, 10),
    startsAt: row.starts_at instanceof Date ? row.starts_at : new Date(row.starts_at),
    localDate: row.local_date,
    title: row.title,
    visibility: row.visibility,
    createdById: row.created_by_id,
    isAllDay: row.is_all_day,
    attendeeIds: row.attendee_ids ?? [],
  }));
}
