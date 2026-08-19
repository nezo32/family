import { sql, type SQL, type SQLChunk } from 'drizzle-orm';

import type { Executor } from '../db.js';
import { AppError } from '../errors.js';
import {
  recurrenceEngine,
  type FloatingDateTime,
  type SeriesRule,
  type TimeZoneId,
} from './engine.js';

/**
 * The generic materializer (D2, `docs/architecture/scheduling.md` §2).
 *
 * `task_series`/`task_occurrences` and `event_series`/`event_occurrences` share
 * the same recurrence spine, the same `occurrence_key` identity and the same
 * idempotency guarantee, so they share this one implementation, parameterised
 * by a {@link MaterializerTarget}.
 *
 * ## The whole guarantee in one line
 *
 * `UNIQUE (series_id, occurrence_key)` + `ON CONFLICT DO NOTHING`.
 *
 * Because `occurrence_key` is the *original* floating local datetime and never
 * changes when a user moves, retitles or reassigns an instance, re-running this
 * over an already-materialized window is a no-op:
 *
 * - a crash halfway leaves a consistent prefix — `materialized_through` only
 *   advances on commit, so the next run finishes the job;
 * - two workers racing on one series produce one winner — the `FOR UPDATE`
 *   serialises the watermark and the loser's inserts conflict away;
 * - a `done`, `skipped` or `is_exception` row is never touched, because its key
 *   already exists. That is what makes "edit this one only" survive the next
 *   horizon extension.
 *
 * The layering is deliberate: {@link planSeries} is **pure** (it is where every
 * interesting rule lives and it needs no database), {@link MaterializerPort} is
 * the thin SQL seam, and {@link materializeSeries} wires the two together.
 */

/** Rolling window, in days, that occurrences are materialized ahead into (D2). */
export const HORIZON_DAYS = 90;

/**
 * Deliberate re-materialization overlap. Costs a handful of no-op conflicts and
 * removes an entire class of boundary bug around DST and clock skew.
 */
const OVERLAP_DAYS = 1;

const MS_PER_DAY = 86_400_000;

/** Rows per INSERT statement. Keeps the parameter count well under PG's limit. */
const INSERT_CHUNK = 250;

/** Series scanned by one `materializeAllDue()` pass. */
const DEFAULT_DUE_LIMIT = 500;

/* -------------------------------------------------------------------------- */
/* Target description                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The two table pairs differ in exactly two column names, so that is all the
 * parameterisation this needs. Named rather than typed-table-generic on
 * purpose: a Drizzle-generic version needs `any` in three places to keep the
 * insert type open, and `any` is banned (CONVENTIONS §4).
 */
export interface MaterializerTarget {
  readonly kind: 'task' | 'event';
  readonly seriesTable: string;
  readonly occurrenceTable: string;
  /** Series column holding the wall-clock minute offset from the start. */
  readonly offsetMinutesColumn: string;
  /** Occurrence column that receives `start + offset` (`due_at` / `ends_at`). */
  readonly derivedInstantColumn: string;
}

export const TASK_TARGET: MaterializerTarget = {
  kind: 'task',
  seriesTable: 'task_series',
  occurrenceTable: 'task_occurrences',
  offsetMinutesColumn: 'due_offset_minutes',
  derivedInstantColumn: 'due_at',
};

export const EVENT_TARGET: MaterializerTarget = {
  kind: 'event',
  seriesTable: 'event_series',
  occurrenceTable: 'event_occurrences',
  offsetMinutesColumn: 'duration_minutes',
  derivedInstantColumn: 'ends_at',
};

/* -------------------------------------------------------------------------- */
/* Data shapes                                                                 */
/* -------------------------------------------------------------------------- */

/** Everything the planner needs from a series row — and nothing else. */
export interface SeriesSnapshot {
  readonly id: string;
  readonly rule: SeriesRule;
  /** `dueOffsetMinutes` for tasks, `durationMinutes` for events. */
  readonly offsetMinutes: number;
  readonly seriesEndsAt: Date | null;
  readonly materializedThrough: Date | null;
  readonly archivedAt: Date | null;
}

export interface PlannedOccurrence {
  readonly seriesId: string;
  /** The immutable identity of the instance. */
  readonly occurrenceKey: FloatingDateTime;
  readonly startsAt: Date;
  /** `due_at` for tasks, `ends_at` for events. Wall-clock arithmetic (D2). */
  readonly derivedAt: Date;
  readonly localDate: string;
  readonly startsLocal: FloatingDateTime;
  readonly timezone: TimeZoneId;
}

/** A value a caller may inject into an occurrence row (assignee, ...). */
export type ExtraColumnValue = string | number | boolean | Date | null;

/**
 * Per-row columns the domain layer adds — this is the seam the tasks module
 * uses to write the frozen `assignee_id` / `assigned_via` pair (D5). It is
 * called once per planned occurrence, in ascending key order, so a rotation can
 * accumulate `committed` debt across the run and stay deterministic.
 */
export type OccurrenceDecorator = (
  occurrence: PlannedOccurrence,
  index: number,
) => Promise<Record<string, ExtraColumnValue>> | Record<string, ExtraColumnValue>;

export interface MaterializeOptions {
  /** Injected for tests and for a deterministic nightly run. */
  readonly now?: Date;
  readonly horizonDays?: number;
  /** Hard cap handed to `engine.expand`. */
  readonly maxCount?: number;
  readonly decorate?: OccurrenceDecorator;
}

export type SkipReason = 'missing' | 'archived' | 'one_off_done' | null;

export interface MaterializationPlan {
  readonly seriesId: string;
  /** Start of the expansion window — the watermark minus the overlap. */
  readonly from: Date;
  readonly horizon: Date;
  /** The value `materialized_through` is advanced to on commit. */
  readonly materializedThrough: Date;
  readonly occurrences: readonly PlannedOccurrence[];
  readonly skipped: SkipReason;
}

export interface MaterializeResult {
  readonly seriesId: string;
  readonly planned: number;
  /** Rows actually written. `planned - inserted` is the no-op conflict count. */
  readonly inserted: number;
  readonly materializedThrough: Date | null;
  readonly skipped: SkipReason;
}

/* -------------------------------------------------------------------------- */
/* The pure planner                                                            */
/* -------------------------------------------------------------------------- */

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * MS_PER_DAY);
}

/**
 * Decide which occurrences a series owes, without touching the database.
 *
 * Generation starts at `materialized_through - 1 day` (or at DTSTART for a
 * never-materialized series) and never earlier: **history is not regenerated**.
 * Anything before the watermark either already exists — in which case the
 * unique index would reject it anyway — or was deliberately removed.
 */
export function planSeries(
  series: SeriesSnapshot,
  options: MaterializeOptions = {},
): MaterializationPlan {
  const now = options.now ?? new Date();
  const horizon = addDays(now, options.horizonDays ?? HORIZON_DAYS);

  const empty = (skipped: SkipReason, from: Date): MaterializationPlan => ({
    seriesId: series.id,
    from,
    horizon,
    materializedThrough: series.materializedThrough ?? from,
    occurrences: [],
    skipped,
  });

  const anchor =
    series.materializedThrough ??
    recurrenceEngine.toInstant(series.rule.dtstartLocal, series.rule.timezone);
  const from = addDays(anchor, -OVERLAP_DAYS);

  // An archived series is never materialized and never listed.
  if (series.archivedAt !== null) return empty('archived', from);

  // The watermark only ever moves forward.
  const materializedThrough =
    series.materializedThrough !== null && series.materializedThrough > horizon
      ? series.materializedThrough
      : horizon;

  const keys = recurrenceEngine.expand(series.rule, {
    from,
    to: horizon,
    ...(options.maxCount === undefined ? {} : { maxCount: options.maxCount }),
  });

  const tz = series.rule.timezone;
  const occurrences: PlannedOccurrence[] = keys.map((key) => {
    const startsAt = recurrenceEngine.toInstant(key, tz);
    const derived = recurrenceEngine.addWallClock(key, series.offsetMinutes, tz);
    return {
      seriesId: series.id,
      occurrenceKey: key,
      startsAt,
      derivedAt: derived.instant,
      localDate: recurrenceEngine.localDateOf(key),
      // Freshly materialized rows have not been moved, so the current local
      // start is the key. A user drag later changes this and never the key.
      startsLocal: key,
      timezone: tz,
    };
  });

  return {
    seriesId: series.id,
    from,
    horizon,
    materializedThrough,
    occurrences,
    skipped: null,
  };
}

/** Run the decorator over a plan, producing the extra columns for each row. */
export async function decoratePlan(
  occurrences: readonly PlannedOccurrence[],
  decorate: OccurrenceDecorator | undefined,
): Promise<Array<Record<string, ExtraColumnValue>>> {
  if (decorate === undefined) return occurrences.map(() => ({}));
  const out: Array<Record<string, ExtraColumnValue>> = [];
  for (const [index, occurrence] of occurrences.entries()) {
    out.push(await decorate(occurrence, index));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The persistence seam                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The only four things the materializer does to a database. Kept behind an
 * interface so the interesting behaviour — idempotency, watermark movement,
 * exception protection — is testable without Postgres.
 */
export interface MaterializerPort {
  /** `SELECT ... FOR UPDATE`, so a concurrent write serialises behind us. */
  lockSeries(seriesId: string): Promise<SeriesSnapshot | null>;
  /**
   * `INSERT ... ON CONFLICT (series_id, occurrence_key) DO NOTHING`.
   * Returns the number of rows actually written.
   */
  insertOccurrences(
    occurrences: readonly PlannedOccurrence[],
    extras: ReadonlyArray<Record<string, ExtraColumnValue>>,
  ): Promise<number>;
  advanceWatermark(seriesId: string, through: Date): Promise<void>;
  listDueSeriesIds(horizon: Date, limit: number): Promise<string[]>;
}

interface SeriesRow {
  /** `execute<T>()` requires a row shape it can index; the named fields below
   *  are what we actually read. */
  [column: string]: unknown;
  id: string;
  rrule: string | null;
  dtstart_local: string;
  timezone: string;
  rdates_local: string[] | null;
  exdates_local: string[] | null;
  series_ends_at: Date | string | null;
  materialized_through: Date | string | null;
  archived_at: Date | string | null;
  offset_minutes: number | string | null;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function toInt(value: number | string | null): number {
  if (value === null) return 0;
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function rowToSnapshot(row: SeriesRow): SeriesSnapshot {
  return {
    id: row.id,
    rule: {
      rrule: row.rrule,
      dtstartLocal: row.dtstart_local,
      timezone: row.timezone,
      rdatesLocal: row.rdates_local ?? [],
      exdatesLocal: row.exdates_local ?? [],
    },
    offsetMinutes: toInt(row.offset_minutes),
    seriesEndsAt: toDate(row.series_ends_at),
    materializedThrough: toDate(row.materialized_through),
    archivedAt: toDate(row.archived_at),
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Bind a value into a raw `sql` fragment.
 *
 * `drizzle-orm@0.44` hands raw-SQL parameters straight to postgres.js without
 * the per-column encoders a typed query builder would apply, and postgres.js
 * refuses a JS `Date` in a Bind message — it throws
 * `The "string" argument must be of type string ... Received an instance of Date`.
 * Every `timestamptz` in this file therefore goes over the wire as an ISO-8601
 * string with an explicit cast, which Postgres parses identically.
 *
 * Without this the materializer throws on the first insert against a real
 * database, meaning no task or event occurrence is ever created — the tests
 * pass because they run against an in-memory port.
 */
function bind(value: ExtraColumnValue | Date | null | undefined): SQL {
  if (value instanceof Date) return sql`${value.toISOString()}::timestamptz`;
  return sql`${value ?? null}`;
}

/** The thin Postgres implementation of {@link MaterializerPort}. */
export function createMaterializerPort(
  exec: Executor,
  target: MaterializerTarget,
): MaterializerPort {
  const seriesTable = sql.identifier(target.seriesTable);
  const occurrenceTable = sql.identifier(target.occurrenceTable);
  const offsetColumn = sql.identifier(target.offsetMinutesColumn);
  const derivedColumn = sql.identifier(target.derivedInstantColumn);

  return {
    async lockSeries(seriesId: string): Promise<SeriesSnapshot | null> {
      const rows = await exec.execute<SeriesRow>(sql`
        select
          id,
          rrule,
          dtstart_local,
          timezone,
          rdates_local,
          exdates_local,
          series_ends_at,
          materialized_through,
          archived_at,
          ${offsetColumn} as offset_minutes
        from ${seriesTable}
        where id = ${seriesId}
        for update
      `);
      const row = rows[0];
      return row === undefined ? null : rowToSnapshot(row);
    },

    async insertOccurrences(occurrences, extras): Promise<number> {
      if (occurrences.length === 0) return 0;
      if (extras.length !== occurrences.length) {
        throw new AppError('INTERNAL_ERROR', 'Decorator produced the wrong number of rows');
      }

      // One INSERT needs one uniform column list, so take the union of every
      // decorator key and fill the gaps with NULL.
      const extraColumns = [...new Set(extras.flatMap((e) => Object.keys(e)))].sort();
      const columns: SQLChunk[] = [
        sql.identifier('series_id'),
        sql.identifier('occurrence_key'),
        sql.identifier('starts_at'),
        derivedColumn,
        sql.identifier('local_date'),
        sql.identifier('starts_local'),
        ...extraColumns.map((name) => sql.identifier(name)),
      ];
      const columnList = sql.join(columns, sql`, `);

      let inserted = 0;
      const indices = occurrences.map((_, i) => i);

      for (const batch of chunk(indices, INSERT_CHUNK)) {
        const tuples = batch.map((i) => {
          // `occurrences` and `extras` are index-aligned and `i` comes from
          // their own index list, so both lookups are total.
          const o = occurrences[i] as PlannedOccurrence;
          const extra = extras[i] as Record<string, ExtraColumnValue>;
          const values: SQLChunk[] = [
            sql`${o.seriesId}`,
            sql`${o.occurrenceKey}`,
            bind(o.startsAt),
            bind(o.derivedAt),
            sql`${o.localDate}`,
            sql`${o.startsLocal}`,
            ...extraColumns.map((name) => bind(extra[name])),
          ];
          return sql`(${sql.join(values, sql`, `)})`;
        });

        const result = await exec.execute<{ id: string }>(sql`
          insert into ${occurrenceTable} (${columnList})
          values ${sql.join(tuples, sql`, `)}
          on conflict (series_id, occurrence_key) do nothing
          returning id
        `);
        inserted += result.length;
      }

      return inserted;
    },

    async advanceWatermark(seriesId: string, through: Date): Promise<void> {
      await exec.execute(sql`
        update ${seriesTable}
        set materialized_through = ${bind(through)}
        where id = ${seriesId}
          and (materialized_through is null or materialized_through < ${bind(through)})
      `);
    },

    async listDueSeriesIds(horizon: Date, limit: number): Promise<string[]> {
      const rows = await exec.execute<{ id: string }>(sql`
        select id
        from ${seriesTable}
        where archived_at is null
          and rrule is not null
          and (materialized_through is null or materialized_through < ${bind(horizon)})
          and (
            series_ends_at is null
            or materialized_through is null
            or series_ends_at > materialized_through
          )
        order by materialized_through asc nulls first, id asc
        limit ${limit}
      `);
      return rows.map((r) => r.id);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Materialize one series through a port. This is the whole algorithm; the
 * Postgres port and the in-memory test double both drive it.
 */
export async function materializeThroughPort(
  port: MaterializerPort,
  seriesId: string,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const series = await port.lockSeries(seriesId);
  if (series === null) {
    return {
      seriesId,
      planned: 0,
      inserted: 0,
      materializedThrough: null,
      skipped: 'missing',
    };
  }

  const plan = planSeries(series, options);
  if (plan.skipped !== null) {
    return {
      seriesId,
      planned: 0,
      inserted: 0,
      materializedThrough: series.materializedThrough,
      skipped: plan.skipped,
    };
  }

  const extras = await decoratePlan(plan.occurrences, options.decorate);
  const inserted = await port.insertOccurrences(plan.occurrences, extras);

  // Same transaction as the inserts: the watermark advancing is what makes a
  // crash safe, so it must never commit ahead of the rows it vouches for.
  await port.advanceWatermark(seriesId, plan.materializedThrough);

  return {
    seriesId,
    planned: plan.occurrences.length,
    inserted,
    materializedThrough: plan.materializedThrough,
    skipped: null,
  };
}

/**
 * Materialize one series.
 *
 * The caller supplies the `Executor`, which is how "eagerly on every series
 * write, inside the same transaction as the write" (§2) is expressed: pass the
 * open `Tx` and the occurrences commit or roll back with the series row.
 */
export function materializeSeries(
  exec: Executor,
  target: MaterializerTarget,
  seriesId: string,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  return materializeThroughPort(createMaterializerPort(exec, target), seriesId, options);
}

export interface MaterializeAllOptions extends MaterializeOptions {
  /** Maximum series touched by one pass. */
  readonly limit?: number;
}

/**
 * The due-series sweep, with the transaction boundary left to the caller.
 *
 * `now` is resolved **once** and passed down, so every series in one pass
 * shares a horizon. A pass that recomputed `now` per series would give the last
 * series a later horizon than the first, and the difference would show up as a
 * one-occurrence jitter at the edge of the window on every run.
 */
export async function materializeDueThroughPort(
  listPort: MaterializerPort,
  options: MaterializeAllOptions,
  perSeries: (seriesId: string, options: MaterializeOptions) => Promise<MaterializeResult>,
): Promise<MaterializeResult[]> {
  const now = options.now ?? new Date();
  const horizon = addDays(now, options.horizonDays ?? HORIZON_DAYS);
  const limit = options.limit ?? DEFAULT_DUE_LIMIT;

  const ids = await listPort.listDueSeriesIds(horizon, limit);

  const results: MaterializeResult[] = [];
  for (const id of ids) {
    results.push(await perSeries(id, { ...options, now }));
  }
  return results;
}

/**
 * The nightly `scheduling:materialize` pass for one table pair.
 *
 * Each series gets **its own transaction** so that one poisoned rule cannot
 * roll back the whole family's calendar, and so the `FOR UPDATE` lock is held
 * for one series at a time rather than for the length of the run.
 */
export function materializeAllDue(
  exec: Executor,
  target: MaterializerTarget,
  options: MaterializeAllOptions = {},
): Promise<MaterializeResult[]> {
  return materializeDueThroughPort(
    createMaterializerPort(exec, target),
    options,
    (seriesId, perSeriesOptions) =>
      exec.transaction((tx) => materializeSeries(tx, target, seriesId, perSeriesOptions)),
  );
}
