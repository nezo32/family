import { sql, type SQL } from 'drizzle-orm';

/**
 * Helpers for interpolating values into **raw** `sql` templates.
 *
 * ## Why this exists
 *
 * `drizzle-orm/postgres-js` replaces postgres.js's serializers *and* parsers for
 * the date/time OIDs (1082, 1083, 1114, 1184) with the identity function,
 * because Drizzle does that conversion itself at the column level. A value that
 * goes through a typed Drizzle column is therefore fine.
 *
 * A value interpolated into a raw `sql` template is not. It reaches postgres.js's
 * wire encoder unconverted, and encoding a JS `Date` throws:
 *
 *     TypeError: The "string" argument must be of type string ...
 *                Received an instance of Date
 *
 * The failure is invisible in unit tests, which never reach a real driver, and
 * it lands at query time — so it surfaced as a 500 on endpoints that had already
 * committed their write. It killed every occurrence read, chore rotation
 * creation, the weekly digest, every notification receipt ack, event reminders
 * and streak refresh.
 *
 * ## Rule
 *
 * **Any `Date` (or timestamp-typed value) inside a raw `sql` template must go
 * through `ts()`.** Prefer a typed Drizzle query where you can; use these when
 * the query genuinely needs raw SQL.
 */

/**
 * Bind a timestamp into a raw `sql` template.
 *
 * Sends ISO-8601 text with an explicit cast, which Postgres parses to exactly
 * the same instant while giving the driver a plain string to encode.
 */
export function ts(value: Date): SQL {
  return sql`${value.toISOString()}::timestamptz`;
}

/** `ts()` for a value that may be absent. */
export function tsOrNull(value: Date | null | undefined): SQL {
  return value ? ts(value) : sql`null::timestamptz`;
}

/** `now()` evaluated by Postgres — no client clock, nothing to encode. */
export const nowSql: SQL = sql`now()`;

/**
 * Bind a calendar date (no time) into a raw `sql` template.
 *
 * Same driver problem, different Postgres type: a `date` column compared
 * against a `timestamptz` silently widens the comparison.
 */
export function dateOnly(value: string): SQL {
  return sql`${value}::date`;
}

/**
 * Bind an arbitrary value, converting a `Date` if that is what it turns out to
 * be. Use when a helper is generic over column values and cannot know the type
 * up front — prefer `ts()` when you do know.
 */
export function bindValue(value: unknown): SQL {
  if (value instanceof Date) return ts(value);
  return sql`${value ?? null}`;
}
