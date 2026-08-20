import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId, timestamps } from '../../db/base.js';
import { users } from '../identity/users.schema.js';
import {
  occurrenceStatus,
  recurrenceColumns,
  visibility,
} from '../scheduling/recurrence.schema.js';

/**
 * Calendar events. Structurally identical to tasks (same recurrence spine, same
 * series/occurrence split, same `occurrenceKey` identity) but a different
 * domain: events have a duration and attendees, tasks have a deadline and an
 * assignee. Keeping them as two tables instead of one polymorphic table keeps
 * both sets of columns `NOT NULL` where they should be.
 *
 * ## Birthdays
 *
 * There is deliberately **no `birthdays` table**. A birthday is a yearly event
 * series generated from `users.birth_date` by the `birthday-sync` job:
 * `FREQ=YEARLY`, `isAllDay = true`, `dtstartLocal` = the next occurrence of the
 * date at `00:00:00`, `timezone` = the family timezone. The job is idempotent
 * on `(sourceKind, sourceRef) = ('user_birthday', user.id)`; see
 * `docs/architecture/scheduling.md`. A second table would mean a second
 * calendar read path, a second notification path and a second ICS exporter for
 * a row that is already a perfectly ordinary yearly event.
 */

/** Where a generated series came from, so the sync job can find its own rows again. */
export const eventSourceKind = pgEnum('event_source_kind', [
  'manual',
  'user_birthday',
  'imported_ics',
]);

export const rsvpStatus = pgEnum('rsvp_status', ['pending', 'yes', 'no', 'maybe']);

export const eventSeries = pgTable(
  'event_series',
  {
    id: primaryId(),

    title: text().notNull(),
    description: text(),
    location: text(),

    visibility: visibility().notNull().default('household'),

    createdById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    ...recurrenceColumns(),

    /**
     * Wall-clock duration. `endsAt` is `zdt.add({ minutes })` on the *local*
     * start, never `instant + n * 60000`: a 60-minute meeting that spans the
     * autumn fall-back is still 60 minutes on the wall, which is what the
     * family means.
     */
    durationMinutes: integer().notNull().default(60),

    /** All-day events ignore `durationMinutes` and render in the date band. */
    isAllDay: boolean().notNull().default(false),

    /**
     * Minutes **before** start at which to fire a reminder, e.g. `{1440, 30}`.
     * Empty => no reminders. The notification job reads this and enqueues
     * against the occurrence, so a moved occurrence reschedules its reminders.
     */
    reminderOffsets: integer()
      .array()
      .notNull()
      .default(sql`'{}'::int[]`),

    /** Hex accent for the calendar chip. NULL => fall back to the creator colour. */
    color: text(),
    category: text(),

    /** How this series got here. Generated series are owned by their job (see above). */
    sourceKind: eventSourceKind().notNull().default('manual'),
    /** Stable external key for generated/imported series, e.g. the user id or the ICS UID. */
    sourceRef: text(),

    /** See `taskSeries.supersedesSeriesId` — the "edit all future" split chain. */
    supersedesSeriesId: uuid().references((): AnyPgColumn => eventSeries.id, {
      onDelete: 'set null',
    }),

    archivedAt: timestamp({ withTimezone: true }),

    ...timestamps(),
  },
  (t) => [
    /** Same partial materializer index as `task_series`. */
    index('event_series_materializer_idx')
      .on(t.materializedThrough)
      .where(sql`${t.archivedAt} is null and ${t.rrule} is not null`),
    index('event_series_created_by_idx').on(t.createdById),
    index('event_series_supersedes_idx').on(t.supersedesSeriesId),
    /**
     * Idempotency for the birthday/ICS sync jobs: one generated series per
     * source row. Partial so that the many manual series (NULL `sourceRef`) do
     * not collide.
     */
    uniqueIndex('event_series_source_uq')
      .on(t.sourceKind, t.sourceRef)
      .where(sql`${t.sourceRef} is not null`),
  ],
);

export const eventOccurrences = pgTable(
  'event_occurrences',
  {
    id: primaryId(),

    seriesId: uuid()
      .notNull()
      .references(() => eventSeries.id, { onDelete: 'cascade' }),

    /** Immutable identity — see `taskOccurrences.occurrenceKey`. */
    occurrenceKey: text().notNull(),

    startsAt: timestamp({ withTimezone: true }).notNull(),
    /** `startsAt` + `durationMinutes`, added in wall-clock terms. */
    endsAt: timestamp({ withTimezone: true }).notNull(),

    localDate: date().notNull(),
    startsLocal: text().notNull(),

    status: occurrenceStatus().notNull().default('scheduled'),
    isException: boolean().notNull().default(false),

    titleOverride: text(),
    descriptionOverride: text(),
    locationOverride: text(),
    /** NULL => inherit `eventSeries.isAllDay`. */
    isAllDayOverride: boolean(),

    ...createdAt(),
  },
  (t) => [
    /** Idempotent materialization — see `task_occurrences_series_key_uq`. */
    uniqueIndex('event_occurrences_series_key_uq').on(t.seriesId, t.occurrenceKey),

    /** The month/week grid reads a local date range; this is its index. */
    index('event_occurrences_local_date_idx').on(t.localDate),

    /** Agenda / "what is next" queries. Partial: cancelled events are noise. */
    index('event_occurrences_starts_idx')
      .on(t.startsAt)
      .where(sql`${t.status} <> 'cancelled'`),

    index('event_occurrences_series_starts_idx').on(t.seriesId, t.startsAt),
  ],
);

export const eventAttendees = pgTable(
  'event_attendees',
  {
    id: primaryId(),

    /**
     * Attendance is per **occurrence**, not per series: "I can make it this
     * Thursday but not next" is the normal case. The service fans a series-level
     * invite out across the materialized window.
     */
    occurrenceId: uuid()
      .notNull()
      .references(() => eventOccurrences.id, { onDelete: 'cascade' }),

    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    rsvp: rsvpStatus().notNull().default('pending'),
    respondedAt: timestamp({ withTimezone: true }),

    ...createdAt(),
  },
  (t) => [
    uniqueIndex('event_attendees_occurrence_user_uq').on(t.occurrenceId, t.userId),
    /** "My calendar" / "awaiting my answer". */
    index('event_attendees_user_idx').on(t.userId, t.rsvp),
  ],
);

export type EventSeriesRow = typeof eventSeries.$inferSelect;
export type NewEventSeriesRow = typeof eventSeries.$inferInsert;
export type EventOccurrenceRow = typeof eventOccurrences.$inferSelect;
export type NewEventOccurrenceRow = typeof eventOccurrences.$inferInsert;
export type EventAttendeeRow = typeof eventAttendees.$inferSelect;
export type NewEventAttendeeRow = typeof eventAttendees.$inferInsert;
