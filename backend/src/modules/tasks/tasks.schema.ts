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
import { occurrenceStatus, recurrenceColumns, visibility } from '../scheduling/recurrence.schema.js';

/**
 * Tasks & chores — the rule (`task_series`) and its materialized instances
 * (`task_occurrences`), per D2.
 *
 * A one-off task is a series with `rrule = NULL` and exactly one occurrence.
 * There is no separate "simple task" table: one shape means one set of routes
 * and one completion path.
 */

/** How the assignee of an occurrence came to be the assignee. */
export const assignedVia = pgEnum('assigned_via', ['rotation', 'manual', 'swap', 'claimed']);

export const taskSeries = pgTable(
  'task_series',
  {
    id: primaryId(),

    title: text().notNull(),
    notes: text(),

    visibility: visibility().notNull().default('household'),

    createdById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    ...recurrenceColumns(),

    /**
     * Minutes from the occurrence start to its deadline. 0 => due at start.
     * Applied as **wall-clock** arithmetic on the local start, not as
     * `instant + n * 60000`, so a chore due "by end of day" stays end of day
     * across a DST boundary.
     */
    dueOffsetMinutes: integer().notNull().default(0),

    /**
     * Slack after `dueAt` before a completion stops counting as on time. Drives
     * the `on_time_bonus` ledger entry and the overdue badge, nothing else.
     */
    graceMinutes: integer().notNull().default(0),

    /**
     * Rotation that picks the assignee at materialization time (D5).
     *
     * Deliberately a bare `uuid` and **not** a foreign key: the chores module
     * imports this module (`chore_swaps` and `kudos` reference
     * `task_occurrences`), so a real FK here would make that import cycle
     * bidirectional. Referential integrity for this column is enforced in the
     * service layer. NULL => not rotated; use `defaultAssigneeId`.
     */
    rotationId: uuid(),

    /** Used when `rotationId` is NULL, or when the rotation yields nobody. */
    defaultAssigneeId: uuid().references(() => users.id, { onDelete: 'set null' }),

    /** Free-form grouping (кухня, уроки). Not an enum — families invent their own. */
    category: text(),

    /**
     * Sweep `scheduled` occurrences to `cancelled` this many days past `dueAt`.
     * NULL => never auto-cancel; the task nags forever. Keeps a dead daily
     * chore from accumulating 90 red rows on the dashboard.
     */
    autoCancelAfterDays: integer(),

    /**
     * The "edit all future" chain. An edit-this-and-future split closes the old
     * series with an UNTIL and creates a new one whose `supersedesSeriesId`
     * points back at the old row, so history stays walkable and the old
     * occurrences keep their completion state.
     */
    supersedesSeriesId: uuid().references((): AnyPgColumn => taskSeries.id, {
      onDelete: 'set null',
    }),

    /** Soft stop. Archived series are never materialized and never listed. */
    archivedAt: timestamp({ withTimezone: true }),

    ...timestamps(),
  },
  (t) => [
    /**
     * The driving index for the materializer. Partial, because the nightly job
     * only ever asks "which live recurring series have a watermark below the
     * horizon?" — one-offs and archived series must not bloat it.
     */
    index('task_series_materializer_idx')
      .on(t.materializedThrough)
      .where(sql`${t.archivedAt} is null and ${t.rrule} is not null`),
    index('task_series_created_by_idx').on(t.createdById),
    index('task_series_rotation_idx').on(t.rotationId),
    index('task_series_supersedes_idx').on(t.supersedesSeriesId),
  ],
);

export const taskOccurrences = pgTable(
  'task_occurrences',
  {
    id: primaryId(),

    seriesId: uuid()
      .notNull()
      .references(() => taskSeries.id, { onDelete: 'cascade' }),

    /**
     * **The immutable identity of an instance**: the floating local datetime
     * the rule originally produced (`2026-09-07T09:00:00`).
     *
     * Moving an occurrence rewrites `startsAt` / `dueAt` / `localDate` /
     * `startsLocal` and never this column. Re-running the materializer
     * therefore recognises the moved row as the same instance instead of
     * resurrecting a duplicate at the original slot. Together with the unique
     * index below, this is the whole idempotency guarantee.
     */
    occurrenceKey: text().notNull(),

    /** Resolved UTC instant of `occurrenceKey` in the series timezone. */
    startsAt: timestamp({ withTimezone: true }).notNull(),
    /** `startsAt` + `dueOffsetMinutes`, added in wall-clock terms. */
    dueAt: timestamp({ withTimezone: true }).notNull(),

    /** Denormalized local calendar date — the calendar grid queries this. */
    localDate: date().notNull(),
    /**
     * Denormalized current local start, `YYYY-MM-DDTHH:mm:ss`. Diverges from
     * `occurrenceKey` once an instance has been moved.
     */
    startsLocal: text().notNull(),

    status: occurrenceStatus().notNull().default('scheduled'),

    /**
     * TRUE once this row diverges from its rule — moved, retitled, reassigned
     * by hand, repointed. The materializer refuses to touch exceptions, which
     * is what makes "edit this one only" survive the next horizon extension.
     */
    isException: boolean().notNull().default(false),

    titleOverride: text(),
    notesOverride: text(),

    /** Frozen at materialization (D5). Never recomputed on read. */
    assigneeId: uuid().references(() => users.id, { onDelete: 'set null' }),
    assignedVia: assignedVia(),

    /**
     * Whoever actually did it — may differ from `assigneeId`, and that
     * difference is the point: the rotation counts a chore towards the person
     * who actually did it, not the one it was handed to (D5).
     */
    completedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    completedAt: timestamp({ withTimezone: true }),

    skippedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    skipReason: text(),

    ...createdAt(),
  },
  (t) => [
    /**
     * Idempotent materialization. The job writes with
     * `ON CONFLICT (series_id, occurrence_key) DO NOTHING`, so re-running it —
     * after a crash, twice concurrently, or over an already-materialized
     * window — cannot duplicate a row or clobber per-occurrence state.
     */
    uniqueIndex('task_occurrences_series_key_uq').on(t.seriesId, t.occurrenceKey),

    /** Calendar grid / day view. */
    index('task_occurrences_local_date_idx').on(t.localDate),

    /** "My open tasks, soonest first." Partial: done/skipped rows are dead weight. */
    index('task_occurrences_assignee_due_idx')
      .on(t.assigneeId, t.dueAt)
      .where(sql`${t.status} = 'scheduled'`),

    /** The overdue sweep and the red-badge count. Overdue is derived, never stored. */
    index('task_occurrences_overdue_idx').on(t.dueAt).where(sql`${t.status} = 'scheduled'`),

    /** Series detail view and the horizon trim. */
    index('task_occurrences_series_starts_idx').on(t.seriesId, t.startsAt),
  ],
);

export type TaskSeriesRow = typeof taskSeries.$inferSelect;
export type NewTaskSeriesRow = typeof taskSeries.$inferInsert;
export type TaskOccurrenceRow = typeof taskOccurrences.$inferSelect;
export type NewTaskOccurrenceRow = typeof taskOccurrences.$inferInsert;
