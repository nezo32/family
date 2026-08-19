import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';

import type { Executor } from '../../core/db.js';
import { badRequest } from '../../core/errors.js';
import {
  taskOccurrences,
  taskSeries,
  type NewTaskSeriesRow,
  type TaskOccurrenceRow,
  type TaskSeriesRow,
} from './tasks.schema.js';

/**
 * Task data access. No HTTP knowledge, no business rules (D8).
 *
 * Every function takes an {@link Executor} first, so the service can run any of
 * them inside the transaction that also writes the series row — which is what
 * "materialize eagerly on every series write, inside the same transaction"
 * (`scheduling.md` §2) actually requires.
 *
 * Three things this file is deliberately strict about:
 *
 * 1. **`COALESCE(override, series_value)` is resolved in SQL**, never in JS
 *    (`scheduling.md` §3.2). Nothing above this layer ever sees a raw
 *    `*_override` column, so no caller can forget the fallback — and the
 *    calendar read stays one query instead of a projection loop.
 * 2. **Overdue is a derived predicate, never a column** (§4). It is computed
 *    per row as `status = 'scheduled' AND due_at + grace < now`, and the sweep
 *    query is shaped so the partial index
 *    `task_occurrences_overdue_idx (due_at) WHERE status = 'scheduled'` can
 *    drive it.
 * 3. **`occurrence_key` is never in an update set.** Moving an instance rewrites
 *    `starts_at` / `due_at` / `local_date` / `starts_local` and nothing else
 *    (D2); there is no function here that can change an instance's identity.
 */

/* -------------------------------------------------------------------------- */
/* Viewer & visibility                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Everything the row filter needs about the caller. Built by the service from
 * `AuthContext` so the repository never touches the permission catalog.
 */
export interface TaskViewer {
  readonly userId: string;
  /** Holds `task:read:any` — otherwise the caller is limited to `:own`. */
  readonly canReadAny: boolean;
  /** May see `restricted` series (adults and admins). */
  readonly canSeeRestricted: boolean;
}

/**
 * The row-visibility predicate, as SQL.
 *
 * Two independent gates, applied to the *series* the occurrence belongs to:
 *
 * - **visibility** — `household` is everyone's; `private` is the creator's and
 *   the assignee's; `restricted` additionally admits adults.
 * - **read scope** (D4) — a `:own` caller also sees `household` rows, because a
 *   shared calendar that hides "мусор — Миша" from Миша's little sister is not
 *   a family calendar. `:any` drops this gate.
 *
 * The gates overlap for today's role matrix, and that is on purpose: each one
 * is independently sufficient to keep a child out of a `restricted` doctor's
 * appointment, so a future role that holds one permission and not the other
 * cannot open a hole.
 *
 * Filtering happens **in SQL**, not after the fetch, so "does this row exist"
 * never leaks through a different error shape or a timing difference (D4:
 * 404, not 403).
 */
export function visibilityPredicate(viewer: TaskViewer): SQL {
  const mine = or(
    eq(taskSeries.createdById, viewer.userId),
    eq(taskOccurrences.assigneeId, viewer.userId),
  );

  const visibilityGate = or(
    eq(taskSeries.visibility, 'household'),
    mine,
    viewer.canSeeRestricted ? eq(taskSeries.visibility, 'restricted') : sql`false`,
  );

  const scopeGate = viewer.canReadAny
    ? sql`true`
    : or(eq(taskSeries.visibility, 'household'), mine);

  // `or(...)` is only `undefined` for an empty argument list; both calls above
  // pass at least two, so the non-null assertions the compiler wants are
  // avoided by folding through `and()` instead.
  return and(visibilityGate, scopeGate) ?? sql`true`;
}

/* -------------------------------------------------------------------------- */
/* Projections                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * An occurrence with its series values already folded in. This is the only
 * shape that leaves this module — the override columns stay behind.
 */
export interface ResolvedOccurrence {
  id: string;
  seriesId: string;
  occurrenceKey: string;
  startsAt: Date;
  dueAt: Date;
  localDate: string;
  startsLocal: string;
  status: TaskOccurrenceRow['status'];
  isException: boolean;
  /** Derived here and now. There is no column behind this (§4). */
  isOverdue: boolean;
  title: string;
  notes: string | null;
  points: number;
  category: string | null;
  visibility: TaskSeriesRow['visibility'];
  timezone: string;
  graceMinutes: number;
  dueOffsetMinutes: number;
  seriesCreatedById: string;
  rotationId: string | null;
  assigneeId: string | null;
  assignedVia: TaskOccurrenceRow['assignedVia'];
  completedById: string | null;
  completedAt: Date | null;
  skippedById: string | null;
  skipReason: string | null;
  createdAt: Date;
}

/** `now` as a bound parameter when the caller pins the clock, else `now()`. */
function nowExpr(now: Date | undefined): SQL {
  return now === undefined ? sql`now()` : sql`${now}::timestamptz`;
}

/**
 * `status = 'scheduled' AND due_at + grace_minutes < now` — the whole of §4.
 *
 * `make_interval(mins => …)` rather than string concatenation because the grace
 * is a column, and building an interval by pasting text around it is how a
 * NULL or a negative value turns into a syntax error at 03:00.
 */
function overdueExpr(now: Date | undefined): SQL<boolean> {
  return sql<boolean>`(
    ${taskOccurrences.status} = 'scheduled'
    and ${taskOccurrences.dueAt} + make_interval(mins => ${taskSeries.graceMinutes}) < ${nowExpr(now)}
  )`;
}

/**
 * The resolved projection. `title`/`notes`/`points` are
 * `COALESCE(override, series_value)` — resolved once, here, in SQL.
 */
function occurrenceSelection(now: Date | undefined) {
  return {
    id: taskOccurrences.id,
    seriesId: taskOccurrences.seriesId,
    occurrenceKey: taskOccurrences.occurrenceKey,
    startsAt: taskOccurrences.startsAt,
    dueAt: taskOccurrences.dueAt,
    localDate: taskOccurrences.localDate,
    startsLocal: taskOccurrences.startsLocal,
    status: taskOccurrences.status,
    isException: taskOccurrences.isException,
    isOverdue: overdueExpr(now),
    title: sql<string>`coalesce(${taskOccurrences.titleOverride}, ${taskSeries.title})`,
    notes: sql<string | null>`coalesce(${taskOccurrences.notesOverride}, ${taskSeries.notes})`,
    points:
      sql<number>`coalesce(${taskOccurrences.pointsOverride}, ${taskSeries.points})`.mapWith(Number),
    category: taskSeries.category,
    visibility: taskSeries.visibility,
    timezone: taskSeries.timezone,
    graceMinutes: taskSeries.graceMinutes,
    dueOffsetMinutes: taskSeries.dueOffsetMinutes,
    seriesCreatedById: taskSeries.createdById,
    rotationId: taskSeries.rotationId,
    assigneeId: taskOccurrences.assigneeId,
    assignedVia: taskOccurrences.assignedVia,
    completedById: taskOccurrences.completedById,
    completedAt: taskOccurrences.completedAt,
    skippedById: taskOccurrences.skippedById,
    skipReason: taskOccurrences.skipReason,
    createdAt: taskOccurrences.createdAt,
  };
}

function selectOccurrences(ex: Executor, now: Date | undefined) {
  return ex
    .select(occurrenceSelection(now))
    .from(taskOccurrences)
    .innerJoin(taskSeries, eq(taskSeries.id, taskOccurrences.seriesId));
}

/* -------------------------------------------------------------------------- */
/* Keyset cursors                                                              */
/* -------------------------------------------------------------------------- */

interface Cursor {
  /** Sort key, as text. */
  readonly v: string;
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('Malformed cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Cursor).v !== 'string' ||
    typeof (parsed as Cursor).id !== 'string'
  ) {
    throw badRequest('Malformed cursor');
  }
  return parsed as Cursor;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/** Splits an over-fetched `limit + 1` result into a page plus its cursor. */
function paginate<T>(rows: T[], limit: number, key: (row: T) => Cursor): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(key(last)) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Series                                                                      */
/* -------------------------------------------------------------------------- */

export async function insertSeries(ex: Executor, values: NewTaskSeriesRow): Promise<TaskSeriesRow> {
  const [row] = await ex.insert(taskSeries).values(values).returning();
  if (!row) throw new Error('insert into task_series returned no row');
  return row;
}

export async function findSeriesById(
  ex: Executor,
  id: string,
): Promise<TaskSeriesRow | undefined> {
  const [row] = await ex.select().from(taskSeries).where(eq(taskSeries.id, id)).limit(1);
  return row;
}

/**
 * `SELECT ... FOR UPDATE`. Every mutation path takes this first, so a
 * concurrent edit and the nightly materializer serialise on the same row rather
 * than interleaving a schedule change with an expansion of the old rule.
 */
export async function lockSeriesById(
  ex: Executor,
  id: string,
): Promise<TaskSeriesRow | undefined> {
  const [row] = await ex
    .select()
    .from(taskSeries)
    .where(eq(taskSeries.id, id))
    .limit(1)
    .for('update');
  return row;
}

export async function updateSeriesRow(
  ex: Executor,
  id: string,
  patch: Partial<NewTaskSeriesRow>,
): Promise<TaskSeriesRow | undefined> {
  const [row] = await ex
    .update(taskSeries)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(taskSeries.id, id))
    .returning();
  return row;
}

export async function archiveSeries(
  ex: Executor,
  id: string,
  at: Date,
): Promise<TaskSeriesRow | undefined> {
  return updateSeriesRow(ex, id, { archivedAt: at });
}

/** Hard delete. Only ever called for a series with no completion history. */
export async function deleteSeries(ex: Executor, id: string): Promise<void> {
  await ex.delete(taskSeries).where(eq(taskSeries.id, id));
}

export interface SeriesOccurrenceCounts {
  readonly total: number;
  readonly done: number;
  readonly skipped: number;
  readonly exceptions: number;
}

/** Drives the "hard delete or archive?" decision in §3.5. One grouped query. */
export async function countOccurrences(
  ex: Executor,
  seriesId: string,
): Promise<SeriesOccurrenceCounts> {
  const [row] = await ex
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      done: sql<number>`count(*) filter (where ${taskOccurrences.status} = 'done')`.mapWith(Number),
      skipped:
        sql<number>`count(*) filter (where ${taskOccurrences.status} = 'skipped')`.mapWith(Number),
      exceptions:
        sql<number>`count(*) filter (where ${taskOccurrences.isException})`.mapWith(Number),
    })
    .from(taskOccurrences)
    .where(eq(taskOccurrences.seriesId, seriesId));

  return row ?? { total: 0, done: 0, skipped: 0, exceptions: 0 };
}

export interface SeriesListParams {
  readonly viewer: TaskViewer;
  readonly includeArchived: boolean;
  readonly rotationId?: string | undefined;
  readonly category?: string | undefined;
  /** `true` recurring only, `false` one-offs only, omitted both. */
  readonly recurring?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * Series list, keyset paginated on `(created_at, id)` descending.
 *
 * The visibility gate needs `task_occurrences.assignee_id`, which a series does
 * not carry, so "am I the assignee of any of its instances" is an EXISTS
 * subquery rather than a join — a join would multiply a 90-row series into 90
 * result rows and quietly break the page size.
 */
export async function listSeries(
  ex: Executor,
  params: SeriesListParams,
): Promise<Page<TaskSeriesRow>> {
  const { viewer } = params;

  const assignedToMe = sql`exists (
    select 1 from ${taskOccurrences}
    where ${taskOccurrences.seriesId} = ${taskSeries.id}
      and ${taskOccurrences.assigneeId} = ${viewer.userId}
  )`;
  const mine = or(eq(taskSeries.createdById, viewer.userId), assignedToMe);

  const visibilityGate = or(
    eq(taskSeries.visibility, 'household'),
    mine,
    viewer.canSeeRestricted ? eq(taskSeries.visibility, 'restricted') : sql`false`,
  );
  const scopeGate = viewer.canReadAny
    ? sql`true`
    : or(eq(taskSeries.visibility, 'household'), mine);

  const filters: SQL[] = [visibilityGate, scopeGate].filter((f): f is SQL => f !== undefined);

  if (!params.includeArchived) filters.push(isNull(taskSeries.archivedAt));
  if (params.rotationId !== undefined) filters.push(eq(taskSeries.rotationId, params.rotationId));
  if (params.category !== undefined) filters.push(eq(taskSeries.category, params.category));
  if (params.recurring === true) filters.push(sql`${taskSeries.rrule} is not null`);
  if (params.recurring === false) filters.push(isNull(taskSeries.rrule));

  const cursor = decodeCursor(params.cursor);
  if (cursor) {
    filters.push(
      sql`(${taskSeries.createdAt}, ${taskSeries.id}) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await ex
    .select()
    .from(taskSeries)
    .where(and(...filters))
    .orderBy(desc(taskSeries.createdAt), desc(taskSeries.id))
    .limit(params.limit + 1);

  return paginate(rows, params.limit, (row) => ({
    v: row.createdAt.toISOString(),
    id: row.id,
  }));
}

/* -------------------------------------------------------------------------- */
/* Occurrence reads                                                            */
/* -------------------------------------------------------------------------- */

export async function findOccurrenceById(
  ex: Executor,
  id: string,
  options: { viewer?: TaskViewer | undefined; now?: Date | undefined } = {},
): Promise<ResolvedOccurrence | undefined> {
  const filters: SQL[] = [eq(taskOccurrences.id, id)];
  if (options.viewer) filters.push(visibilityPredicate(options.viewer));

  const [row] = await selectOccurrences(ex, options.now)
    .where(and(...filters))
    .limit(1);
  return row;
}

/** The raw row, for internal transitions that must not go through the join. */
export async function findOccurrenceRow(
  ex: Executor,
  id: string,
): Promise<TaskOccurrenceRow | undefined> {
  const [row] = await ex
    .select()
    .from(taskOccurrences)
    .where(eq(taskOccurrences.id, id))
    .limit(1);
  return row;
}

export interface OccurrenceListParams {
  readonly viewer: TaskViewer;
  readonly now?: Date | undefined;
  readonly seriesId?: string | undefined;
  readonly assigneeId?: string | undefined;
  readonly statuses?: ReadonlyArray<TaskOccurrenceRow['status']> | undefined;
  /** Local calendar dates, inclusive. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly overdueOnly?: boolean | undefined;
  readonly unassignedOnly?: boolean | undefined;
  readonly category?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

function occurrenceFilters(params: OccurrenceListParams): SQL[] {
  const filters: SQL[] = [visibilityPredicate(params.viewer)];

  if (params.seriesId !== undefined) filters.push(eq(taskOccurrences.seriesId, params.seriesId));
  if (params.assigneeId !== undefined) {
    filters.push(eq(taskOccurrences.assigneeId, params.assigneeId));
  }
  if (params.statuses !== undefined && params.statuses.length > 0) {
    filters.push(inArray(taskOccurrences.status, [...params.statuses]));
  }
  if (params.from !== undefined) filters.push(gte(taskOccurrences.localDate, params.from));
  if (params.to !== undefined) filters.push(lte(taskOccurrences.localDate, params.to));
  if (params.unassignedOnly === true) filters.push(isNull(taskOccurrences.assigneeId));
  if (params.category !== undefined) filters.push(eq(taskSeries.category, params.category));
  if (params.overdueOnly === true) {
    // Index-sargable prefilter first (grace is never negative, so
    // `due_at + grace < now` implies `due_at < now`), exact predicate second.
    filters.push(eq(taskOccurrences.status, 'scheduled'));
    if (params.now !== undefined) filters.push(lt(taskOccurrences.dueAt, params.now));
    else filters.push(sql`${taskOccurrences.dueAt} < now()`);
    filters.push(overdueExpr(params.now));
  }

  return filters;
}

/** Occurrence list, keyset paginated on `(starts_at, id)` ascending. */
export async function listOccurrences(
  ex: Executor,
  params: OccurrenceListParams,
): Promise<Page<ResolvedOccurrence>> {
  const filters = occurrenceFilters(params);

  const cursor = decodeCursor(params.cursor);
  if (cursor) {
    filters.push(
      sql`(${taskOccurrences.startsAt}, ${taskOccurrences.id}) > (${cursor.v}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await selectOccurrences(ex, params.now)
    .where(and(...filters))
    .orderBy(asc(taskOccurrences.startsAt), asc(taskOccurrences.id))
    .limit(params.limit + 1);

  return paginate(rows, params.limit, (row) => ({
    v: row.startsAt.toISOString(),
    id: row.id,
  }));
}

export interface CalendarRangeParams {
  readonly viewer: TaskViewer;
  readonly from: string;
  readonly to: string;
  readonly now?: Date | undefined;
  readonly statuses?: ReadonlyArray<TaskOccurrenceRow['status']> | undefined;
}

/**
 * The calendar grid read: a bounded **local date** window, unpaginated.
 *
 * `local_date` is the denormalized column precisely so this query is an index
 * range scan on `task_occurrences_local_date_idx` instead of a per-row timezone
 * conversion of `starts_at`. The span is capped by the contract (400 days), so
 * "unpaginated" is bounded by construction.
 */
export async function findCalendarRange(
  ex: Executor,
  params: CalendarRangeParams,
): Promise<ResolvedOccurrence[]> {
  const filters: SQL[] = [
    gte(taskOccurrences.localDate, params.from),
    lte(taskOccurrences.localDate, params.to),
    visibilityPredicate(params.viewer),
  ];
  if (params.statuses !== undefined && params.statuses.length > 0) {
    filters.push(inArray(taskOccurrences.status, [...params.statuses]));
  }

  return selectOccurrences(ex, params.now)
    .where(and(...filters))
    .orderBy(asc(taskOccurrences.startsAt), asc(taskOccurrences.id));
}

/**
 * The overdue sweep (§4).
 *
 * Shaped so the partial index `task_occurrences_overdue_idx` drives it: the
 * `status = 'scheduled'` equality matches the index predicate and
 * `due_at < now` is a range scan on the indexed column. The per-series grace is
 * then applied as an exact filter on the handful of rows that survive.
 */
export async function findOverdue(
  ex: Executor,
  params: { now: Date; viewer?: TaskViewer | undefined; limit?: number | undefined },
): Promise<ResolvedOccurrence[]> {
  const filters: SQL[] = [
    eq(taskOccurrences.status, 'scheduled'),
    lt(taskOccurrences.dueAt, params.now),
    overdueExpr(params.now),
  ];
  if (params.viewer) filters.push(visibilityPredicate(params.viewer));

  return selectOccurrences(ex, params.now)
    .where(and(...filters))
    .orderBy(asc(taskOccurrences.dueAt), asc(taskOccurrences.id))
    .limit(params.limit ?? 500);
}

/** Reminder window: still scheduled, due inside `[from, to]`. */
export async function findDueBetween(
  ex: Executor,
  params: { from: Date; to: Date; limit?: number | undefined },
): Promise<ResolvedOccurrence[]> {
  return selectOccurrences(ex, params.from)
    .where(
      and(
        eq(taskOccurrences.status, 'scheduled'),
        gte(taskOccurrences.dueAt, params.from),
        lt(taskOccurrences.dueAt, params.to),
      ),
    )
    .orderBy(asc(taskOccurrences.dueAt), asc(taskOccurrences.id))
    .limit(params.limit ?? 500);
}

/** "How much did the family close today?" — one scalar for the dashboard. */
export async function countDoneOn(ex: Executor, localDate: string): Promise<number> {
  const [row] = await ex
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(taskOccurrences)
    .where(and(eq(taskOccurrences.localDate, localDate), eq(taskOccurrences.status, 'done')));
  return row?.n ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Occurrence transitions                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The idempotent completion write.
 *
 * `WHERE status = 'scheduled'` is the entire double-award guard at this layer:
 * a double tap, a retried request or an offline outbox replaying the same
 * mutation updates **zero** rows the second time, so the service knows not to
 * book the ledger again (D5). Returning `undefined` means "somebody already
 * closed this" — not an error.
 */
export async function completeIfScheduled(
  ex: Executor,
  params: { id: string; completedById: string; completedAt: Date },
): Promise<TaskOccurrenceRow | undefined> {
  const [row] = await ex
    .update(taskOccurrences)
    .set({
      status: 'done',
      completedById: params.completedById,
      completedAt: params.completedAt,
    })
    .where(and(eq(taskOccurrences.id, params.id), eq(taskOccurrences.status, 'scheduled')))
    .returning();
  return row;
}

/** The mirror image: only a `done` row can be reopened, and only once. */
export async function uncompleteIfDone(
  ex: Executor,
  id: string,
): Promise<TaskOccurrenceRow | undefined> {
  const [row] = await ex
    .update(taskOccurrences)
    .set({ status: 'scheduled', completedById: null, completedAt: null })
    .where(and(eq(taskOccurrences.id, id), eq(taskOccurrences.status, 'done')))
    .returning();
  return row;
}

/**
 * Skip — a **status change only** (§3.1).
 *
 * The row survives with its assignee, its key and its history intact. It is
 * never an EXDATE and never a delete: "Миша didn't do the bins on the 14th" is
 * a fact somebody may need next month, and destroying it to tidy the calendar
 * is how an audit trail disappears.
 */
export async function skipIfScheduled(
  ex: Executor,
  params: { id: string; skippedById: string; reason: string | null },
): Promise<TaskOccurrenceRow | undefined> {
  const [row] = await ex
    .update(taskOccurrences)
    .set({ status: 'skipped', skippedById: params.skippedById, skipReason: params.reason })
    .where(and(eq(taskOccurrences.id, params.id), eq(taskOccurrences.status, 'scheduled')))
    .returning();
  return row;
}

export async function cancelIfScheduled(
  ex: Executor,
  id: string,
): Promise<TaskOccurrenceRow | undefined> {
  const [row] = await ex
    .update(taskOccurrences)
    .set({ status: 'cancelled' })
    .where(and(eq(taskOccurrences.id, id), eq(taskOccurrences.status, 'scheduled')))
    .returning();
  return row;
}

export async function assignOccurrence(
  ex: Executor,
  params: {
    id: string;
    assigneeId: string | null;
    assignedVia: TaskOccurrenceRow['assignedVia'];
  },
): Promise<TaskOccurrenceRow | undefined> {
  const [row] = await ex
    .update(taskOccurrences)
    .set({
      assigneeId: params.assigneeId,
      assignedVia: params.assignedVia,
      // A hand-assignment diverges from what the rotation would have produced,
      // so the materializer must keep its hands off this row from now on.
      isException: true,
    })
    .where(eq(taskOccurrences.id, params.id))
    .returning();
  return row;
}

/** First claimer wins: conditional on the row still being free and open. */
export async function claimIfUnassigned(
  ex: Executor,
  params: { id: string; userId: string },
): Promise<TaskOccurrenceRow | undefined> {
  const [row] = await ex
    .update(taskOccurrences)
    .set({ assigneeId: params.userId, assignedVia: 'claimed', isException: true })
    .where(
      and(
        eq(taskOccurrences.id, params.id),
        eq(taskOccurrences.status, 'scheduled'),
        isNull(taskOccurrences.assigneeId),
      ),
    )
    .returning();
  return row;
}

/**
 * "Edit this one only" (§3.2).
 *
 * Writes the override columns and the moved timestamps, and always sets
 * `is_exception = true` — the materializer's hands-off flag and the UI's
 * «изменено» badge.
 *
 * **`occurrenceKey` is deliberately absent from this signature.** A move
 * rewrites `starts_at` / `due_at` / `local_date` / `starts_local`; the identity
 * of the instance is the datetime the rule originally produced and it never
 * changes (D2). If it could, the next horizon extension would fail to recognise
 * the moved row and resurrect a phantom at the old slot.
 */
export interface OccurrenceOverridePatch {
  readonly titleOverride?: string | null;
  readonly notesOverride?: string | null;
  readonly pointsOverride?: number | null;
  readonly startsAt?: Date;
  readonly dueAt?: Date;
  readonly localDate?: string;
  readonly startsLocal?: string;
}

export async function applyOccurrenceOverride(
  ex: Executor,
  id: string,
  patch: OccurrenceOverridePatch,
): Promise<TaskOccurrenceRow | undefined> {
  const [row] = await ex
    .update(taskOccurrences)
    .set({ ...patch, isException: true })
    .where(eq(taskOccurrences.id, id))
    .returning();
  return row;
}

/* -------------------------------------------------------------------------- */
/* Bulk maintenance                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Clear the future half of a series so it can be re-materialized (§3.3, §3.4).
 *
 * Only `scheduled`, non-exception rows are removed. Everything `done`,
 * `skipped` or hand-edited stays exactly where it is — that is the difference
 * between changing a schedule and rewriting history.
 */
export async function deleteFutureScheduled(
  ex: Executor,
  params: { seriesId: string; fromKey?: string | undefined; fromInstant?: Date | undefined },
): Promise<number> {
  const filters: SQL[] = [
    eq(taskOccurrences.seriesId, params.seriesId),
    eq(taskOccurrences.status, 'scheduled'),
    eq(taskOccurrences.isException, false),
  ];
  if (params.fromKey !== undefined) {
    filters.push(gte(taskOccurrences.occurrenceKey, params.fromKey));
  }
  if (params.fromInstant !== undefined) {
    filters.push(gte(taskOccurrences.startsAt, params.fromInstant));
  }

  const rows = await ex
    .delete(taskOccurrences)
    .where(and(...filters))
    .returning({ id: taskOccurrences.id });
  return rows.length;
}

/**
 * The opt-in auto-cancel sweep (§2, "Trimming").
 *
 * `scheduled` rows more than `auto_cancel_after_days` past their deadline
 * become `cancelled`. Never deleted: a fortnight of un-done dishes is somebody's
 * record of a fortnight of un-done dishes. A NULL `auto_cancel_after_days`
 * means the series nags forever, which is why this is opt-in per series.
 */
export async function autoCancelStale(
  ex: Executor,
  now: Date,
  limit = 1000,
): Promise<Array<{ id: string; seriesId: string }>> {
  return ex.execute<{ id: string; seriesId: string }>(sql`
    update ${taskOccurrences} o
    set status = 'cancelled'
    from ${taskSeries} s
    where s.id = o.series_id
      and o.status = 'scheduled'
      and s.auto_cancel_after_days is not null
      and o.due_at + make_interval(days => s.auto_cancel_after_days) < ${now}
      and o.id in (
        select o2.id
        from ${taskOccurrences} o2
        join ${taskSeries} s2 on s2.id = o2.series_id
        where o2.status = 'scheduled'
          and s2.auto_cancel_after_days is not null
          and o2.due_at + make_interval(days => s2.auto_cancel_after_days) < ${now}
        limit ${limit}
      )
    returning o.id as "id", o.series_id as "seriesId"
  `);
}
