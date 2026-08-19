import { pgEnum, text, timestamp } from 'drizzle-orm/pg-core';

import { emptyTextArray } from '../../db/base.js';

/**
 * The recurrence spine shared by `task_series` and `event_series` (D2).
 *
 * This module owns no tables of its own — it owns the *shape* of a recurring
 * series and the enums that both the task and the event modules need. Spread
 * `recurrenceColumns()` into any table that repeats.
 *
 * ## The time model (D2 — the most important rule in the repo)
 *
 * A series is a statement about the **wall clock**, not about an instant.
 * "Every Monday at 09:00" stays 09:00 across a DST transition, across a change
 * to Russian time law, and while the family is travelling. Therefore:
 *
 * - `dtstartLocal` is a **floating** local datetime (`2026-09-07T09:00:00`) —
 *   no offset, no `Z`. It is never a `timestamptz` and never converted at rest.
 * - `timezone` is the IANA id (`Europe/Moscow`) that resolves that wall clock
 *   to an instant *at materialization time*, using the tzdb rules in force for
 *   the target date. Never hardcode an offset.
 * - `rrule` is the RRULE line **without** DTSTART (`FREQ=WEEKLY;BYDAY=MO`).
 *   The engine supplies DTSTART from `dtstartLocal` + `timezone`. NULL means
 *   this is a one-off: exactly one occurrence, at `dtstartLocal`.
 *
 * Resolved UTC instants live only on the occurrence rows. If you ever find
 * yourself storing an instant on a series, you have reintroduced the bug this
 * decision exists to prevent.
 */

/**
 * Who may see a series and the occurrences it spawns.
 *
 * - `household` — everyone in the family (the default; D1 means "household"
 *   is just "everybody", there is no tenant to scope to).
 * - `private`   — only the creator and the assignee.
 * - `restricted`— adults and admins only; hidden from teens/children. Used for
 *   things like doctor appointments that the kids should not see on the wall.
 *
 * Visibility is a *read filter*, not a permission. `task:read:any` still goes
 * through the RBAC matrix (D4) first; this narrows what that permission sees.
 */
export { visibility } from '../../db/enums.js';

/**
 * Lifecycle of a single materialized instance.
 *
 * - `scheduled` — materialized and pending. The only status that can be overdue.
 * - `done`      — somebody completed it (not necessarily the assignee — D5).
 * - `skipped`   — deliberately not done this time; the series continues.
 * - `cancelled` — removed from the calendar (single-instance deletion, or the
 *   auto-cancel sweeper past `autoCancelAfterDays`).
 *
 * Note what is **not** here: `overdue`. Overdue is `status = 'scheduled' AND
 * due_at < now()` — a derived predicate, never a stored state. See
 * `docs/architecture/scheduling.md`.
 */
export const occurrenceStatus = pgEnum('occurrence_status', [
  'scheduled',
  'done',
  'skipped',
  'cancelled',
]);

/**
 * The recurrence columns every series table carries. Spread into the table
 * definition:
 *
 * ```ts
 * export const taskSeries = pgTable('task_series', {
 *   id: primaryId(),
 *   ...recurrenceColumns(),
 * });
 * ```
 */
export const recurrenceColumns = () => ({
  /**
   * RRULE line **without** DTSTART, e.g. `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH`.
   * NULL => one-off: a single occurrence at `dtstartLocal`.
   *
   * The UI never authors this directly; it posts a `recurrencePreset` from
   * `@family/shared` which the service compiles to this string. The raw form
   * exists for ICS imports.
   */
  rrule: text(),

  /**
   * Floating local wall clock: `YYYY-MM-DDTHH:mm:ss`. **Never** an instant,
   * never with an offset or a `Z`. This is the anchor the engine expands from.
   */
  dtstartLocal: text().notNull(),

  /** IANA timezone id, e.g. `Europe/Moscow`. Resolves the wall clock. */
  timezone: text().notNull(),

  /**
   * Extra floating local datetimes bolted onto the expansion (RFC 5545 RDATE).
   * Same format as `dtstartLocal`.
   */
  rdatesLocal: text().array().notNull().default(emptyTextArray),

  /**
   * Floating local datetimes removed from the expansion (RFC 5545 EXDATE).
   * Written when a user deletes a single future instance that has not been
   * materialized yet; a materialized instance is `cancelled` instead, so its
   * per-occurrence state survives.
   */
  exdatesLocal: text().array().notNull().default(emptyTextArray),

  /**
   * Denormalized last instant this series can ever produce, computed from
   * COUNT/UNTIL at write time. NULL => infinite.
   *
   * Purely an optimisation: it lets the materializer skip exhausted series with
   * an index predicate instead of expanding the rule to find out.
   */
  seriesEndsAt: timestamp({ withTimezone: true }),

  /**
   * Watermark: every occurrence with a start at or before this instant has been
   * materialized. NULL => never materialized. The nightly job selects on this
   * column, which is why the partial index on it exists in each series table.
   */
  materializedThrough: timestamp({ withTimezone: true }),
});
