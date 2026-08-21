import { sql } from 'drizzle-orm';

import type {
  AssignedVia,
  CalendarRange,
  OccurrenceStatus,
  Permission,
  RecurrenceSpec,
  RecurrenceView,
  TaskAssign,
  TaskComplete,
  TaskOccurrenceListQuery,
  TaskOccurrenceResponse,
  TaskOccurrenceUpdate,
  TaskSeriesCreate,
  TaskSeriesDelete,
  TaskSeriesListQuery,
  TaskSeriesResponse,
  TaskSeriesUpdate,
  TaskSkip,
  TaskTodayResponse,
  Visibility,
} from '@family/shared';

import type { Db, Executor } from '../../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import {
  recurrenceEngine,
  type FloatingDateTime,
  type SeriesRule,
} from '../../core/recurrence/engine.js';
import {
  HORIZON_DAYS,
  TASK_TARGET,
  createMaterializerPort,
  materializeDueThroughPort,
  materializeSeries,
  planSeries,
  type MaterializeResult,
  type OccurrenceDecorator,
  type SeriesSnapshot,
} from '../../core/recurrence/materializer.js';
import { loadRotationSnapshot } from '../chores/chores.service.js';
import { RotationRun, type RotationSnapshot } from '../chores/rotation.js';
import { emitIntent } from '../notifications/notifications.service.js';
import { deleteCommentsFor } from '../wall/comments.service.js';
import * as repo from './tasks.repository.js';
import type { ResolvedOccurrence, TaskViewer } from './tasks.repository.js';
import type { NewTaskSeriesRow, TaskSeriesRow } from './tasks.schema.js';

/**
 * Task & chore business rules. No HTTP knowledge (D8) — the routes translate
 * `AppError`s into responses.
 *
 * ## What this file is actually about
 *
 * A recurring thing is a **rule plus a materialized window** (D2). Almost every
 * bug in a calendar comes from one of four places, so each gets an explicit,
 * named path here rather than an `if` inside a general "update":
 *
 * | scope | `scheduling.md` | what it does |
 * |---|---|---|
 * | skip | §3.1 | status only. **Never** an EXDATE unless explicitly asked. |
 * | `this` | §3.2 | override columns + `is_exception`; the rule is untouched. |
 * | `this_and_future` | §3.3 | series split via `withUntilBefore`, history preserved. |
 * | `all` | §3.4 | in-place edit + re-materialization; exceptions survive. |
 *
 * ## Two invariants that everything else hangs off
 *
 * - **`occurrenceKey` never changes.** Moving an instance rewrites its
 *   timestamps; the key stays the floating local datetime the rule originally
 *   produced, which is what lets the next horizon extension recognise the moved
 *   row instead of resurrecting a phantom at the old slot (D2).
 * - **Overdue is derived.** It is `status = 'scheduled' AND due_at + grace <
 *   now`, computed in SQL on every read (§4). There is no column, no sweeper
 *   that writes one, and no status enum member for it.
 *
 * ## Eager materialization
 *
 * Every series write materializes that series **inside the same transaction**
 * (§2). A created chore that has no occurrences until 03:15 tomorrow is a chore
 * the family cannot see today, and a nightly job is not an acceptable latency
 * for "add задача на завтра".
 */

/* -------------------------------------------------------------------------- */
/* Actor & access (D4)                                                         */
/* -------------------------------------------------------------------------- */

/** Structurally satisfied by `AuthContext`, so routes just pass `req.auth`. */
export interface TaskActor {
  readonly userId: string;
  readonly timezone?: string | null;
  can(permission: Permission): boolean;
}

/**
 * The permission that means "may see `restricted` series".
 *
 * `restricted` exists to keep a doctor's appointment off the kids' wall, so the
 * gate is "is an adult". D4 forbids branching on `role ===`, and the catalog is
 * lead-owned and fixed, so this is expressed with the catalog entry that is
 * held by exactly adult/admin/owner. If a `task:read:restricted` is ever added,
 * this constant is the only line that changes.
 */
export const TASK_RESTRICTED_PERMISSION: Permission = 'task:update:any';

export function viewerOf(actor: TaskActor): TaskViewer {
  return {
    userId: actor.userId,
    canReadAny: actor.can('task:read:any'),
    canSeeRestricted: actor.can(TASK_RESTRICTED_PERMISSION),
  };
}

/**
 * Missing `task:read` entirely is **404, not 403** (D4): a caller who may not
 * read tasks at all should not learn from the status code that they exist.
 */
function requireRead(actor: TaskActor): void {
  if (!actor.can('task:read:own') && !actor.can('task:read:any')) throw notFound('Task');
}

/**
 * The pure mirror of {@link repo.visibilityPredicate}.
 *
 * Kept in lockstep with the SQL by the test suite rather than by discipline:
 * the filter that decides what a child can see is not something to have two
 * uncoordinated copies of.
 */
export function canReadOccurrence(
  viewer: TaskViewer,
  row: {
    visibility: Visibility;
    seriesCreatedById: string;
    assigneeId: string | null;
  },
): boolean {
  const mine = row.seriesCreatedById === viewer.userId || row.assigneeId === viewer.userId;

  const visibilityGate =
    row.visibility === 'household' ||
    mine ||
    (row.visibility === 'restricted' && viewer.canSeeRestricted);

  const scopeGate = viewer.canReadAny || row.visibility === 'household' || mine;

  return visibilityGate && scopeGate;
}

/** `own` write scope means "the series I created". `any` is unrestricted. */
function requireWrite(actor: TaskActor, series: TaskSeriesRow, base: 'update' | 'delete'): void {
  if (actor.can(`task:${base}:any` as Permission)) return;
  if (actor.can(`task:${base}:own` as Permission) && series.createdById === actor.userId) return;
  throw forbidden(`Missing permission: task:${base}:any`);
}

/* -------------------------------------------------------------------------- */
/* Derived state (§4)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `isOverdue` in one line, with no storage behind it.
 *
 * This is the JS twin of the SQL expression in the repository, and it exists
 * for the same reason `canReadOccurrence` does: so the rule can be tested
 * without Postgres, and so the two can be asserted equal.
 *
 * There is deliberately no `markOverdue`, no `overdue` status and no
 * `is_overdue` column anywhere in this module. A stored flag is wrong from the
 * moment it is written until a job repairs it, and the job would have to run
 * every minute to keep the dashboard honest.
 */
export function isOverdue(
  row: { status: OccurrenceStatus; dueAt: Date; graceMinutes: number },
  now: Date,
): boolean {
  if (row.status !== 'scheduled') return false;
  return row.dueAt.getTime() + row.graceMinutes * 60_000 < now.getTime();
}

/* -------------------------------------------------------------------------- */
/* Recurrence plumbing                                                         */
/* -------------------------------------------------------------------------- */

export function ruleOf(series: {
  rrule: string | null;
  dtstartLocal: string;
  timezone: string;
  rdatesLocal: string[];
  exdatesLocal: string[];
}): SeriesRule {
  return {
    rrule: series.rrule,
    dtstartLocal: series.dtstartLocal,
    timezone: series.timezone,
    rdatesLocal: series.rdatesLocal,
    exdatesLocal: series.exdatesLocal,
  };
}

/** Who the rule hands one occurrence to, given when it starts (D5). */
type AssigneePick = (startsAt: Date) => {
  assigneeId: string | null;
  assignedVia: AssignedVia | null;
};

export interface CompiledRecurrence {
  readonly rrule: string | null;
  readonly dtstartLocal: string;
  readonly timezone: string;
  readonly rdatesLocal: string[];
  readonly exdatesLocal: string[];
  readonly seriesEndsAt: Date | null;
}

/**
 * `RecurrenceSpec` → stored columns. The **only** writer of `rrule` text.
 *
 * `compile` is handed the series timezone on purpose: an `UNTIL` is serialised
 * in UTC (RFC 5545 §3.3.10), so compiling "до 31 декабря" without the zone
 * would silently shift the last occurrence by the offset.
 */
export function compileRecurrence(spec: RecurrenceSpec): CompiledRecurrence {
  const base = {
    dtstartLocal: spec.dtstartLocal,
    timezone: spec.timezone,
    rdatesLocal: [...spec.rdatesLocal],
    exdatesLocal: [...spec.exdatesLocal],
  };

  let rrule: string | null;
  switch (spec.mode) {
    case 'once':
      rrule = null;
      break;
    case 'preset':
      rrule = recurrenceEngine.compile(spec.preset, spec.ends, spec.dtstartLocal, spec.timezone);
      break;
    case 'raw':
      rrule = spec.rrule;
      break;
  }

  return {
    ...base,
    rrule,
    seriesEndsAt: recurrenceEngine.seriesEndsAt({ ...base, rrule }),
  };
}

/**
 * Does this compiled rule say anything the series does not already say?
 *
 * The edit sheet posts the whole form back, so a title change can arrive
 * carrying the very schedule it loaded. Answering "the schedule changed"
 * because a `recurrence` key is *present* — rather than because it *differs* —
 * re-materializes the window and hands every future occurrence a new id, which
 * is the difference between saving a title and losing a comment thread.
 */
export function recurrenceDiffers(series: TaskSeriesRow, next: CompiledRecurrence): boolean {
  const sameDates = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  return (
    series.rrule !== next.rrule ||
    series.dtstartLocal !== next.dtstartLocal ||
    series.timezone !== next.timezone ||
    !sameDates(series.rdatesLocal, next.rdatesLocal) ||
    !sameDates(series.exdatesLocal, next.exdatesLocal) ||
    (series.seriesEndsAt?.getTime() ?? null) !== (next.seriesEndsAt?.getTime() ?? null)
  );
}

/**
 * A series row as the generic materializer wants to see it (§2).
 *
 * `planSeries` is pure, so handing it this snapshot is how the edit path can
 * ask "which dates does the new rule owe?" before it decides which of the old
 * ones to delete.
 */
export function snapshotOf(series: TaskSeriesRow): SeriesSnapshot {
  return {
    id: series.id,
    rule: ruleOf(series),
    offsetMinutes: series.dueOffsetMinutes,
    seriesEndsAt: series.seriesEndsAt,
    materializedThrough: series.materializedThrough,
    archivedAt: series.archivedAt,
  };
}

export function recurrenceViewOf(series: TaskSeriesRow): RecurrenceView {
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

/**
 * Move one instance (§3.2).
 *
 * Returns the timestamp patch and **nothing else**. The absence of
 * `occurrenceKey` from this return type is load-bearing: it is what makes it
 * impossible for a move to change an instance's identity, which is what the
 * materializer's `ON CONFLICT (series_id, occurrence_key) DO NOTHING` relies on
 * to leave user edits alone (D2).
 */
export function planOccurrenceMove(
  startsLocal: FloatingDateTime,
  series: { timezone: string; dueOffsetMinutes: number },
): { startsAt: Date; dueAt: Date; localDate: string; startsLocal: string } {
  // `addWallClock(_, 0, _)` is also the canonicaliser: it returns the
  // normalized floating form, so `2026-09-08T9:00` never reaches a column.
  const start = recurrenceEngine.addWallClock(startsLocal, 0, series.timezone);
  const due = recurrenceEngine.addWallClock(startsLocal, series.dueOffsetMinutes, series.timezone);

  return {
    startsAt: start.instant,
    dueAt: due.instant,
    localDate: recurrenceEngine.localDateOf(start.local),
    startsLocal: start.local,
  };
}

/**
 * The series split of §3.3, as a pure plan.
 *
 * Two rules come out of this, and the interesting one is the *closing* rule:
 * `withUntilBefore` sets `UNTIL` one second before the anchor's instant, so the
 * old series stops immediately before the occurrence being edited and the
 * successor picks up from exactly there — no gap, no duplicated slot.
 */
export interface SeriesSplitPlan {
  readonly closingRrule: string;
  readonly closingSeriesEndsAt: Date | null;
  readonly successorRecurrence: CompiledRecurrence;
  /** Occurrences at or after this key are the successor's problem. */
  readonly fromKey: string;
}

export function planSeriesSplit(
  series: TaskSeriesRow,
  anchorKey: string,
  recurrence: RecurrenceSpec | undefined,
): SeriesSplitPlan {
  const rule = ruleOf(series);
  const closingRrule = recurrenceEngine.withUntilBefore(rule, anchorKey);

  const successorRecurrence =
    recurrence === undefined
      ? {
          rrule: series.rrule,
          // The successor is anchored at the occurrence being edited — or at
          // its new local start when the edit also moved it.
          dtstartLocal: anchorKey,
          timezone: series.timezone,
          rdatesLocal: [...series.rdatesLocal],
          exdatesLocal: [...series.exdatesLocal],
          seriesEndsAt: recurrenceEngine.seriesEndsAt({
            ...rule,
            dtstartLocal: anchorKey,
          }),
        }
      : compileRecurrence(recurrence);

  return {
    closingRrule,
    closingSeriesEndsAt: recurrenceEngine.seriesEndsAt({ ...rule, rrule: closingRrule }),
    successorRecurrence,
    fromKey: anchorKey,
  };
}

/* -------------------------------------------------------------------------- */
/* Completion (idempotency)                                                    */
/* -------------------------------------------------------------------------- */

export type CompletionOutcome = 'completed' | 'already_done' | 'conflict';

/**
 * What a completion request should do, given the row it lands on.
 *
 * Completion is the one action a user can fire twice by accident — a double
 * tap, a retry after a timeout, an offline outbox replaying on reconnect. So it
 * is idempotent by construction at three levels:
 *
 * 1. the conditional `WHERE status = 'scheduled'` in the repository, which
 *    updates zero rows the second time;
 * 2. this function, which turns "zero rows updated but the row is `done`" into
 *    a **success**, not an error — the client's intent was satisfied.
 *
 * There is no third guard any more and none is needed. Fairness counts rows
 * where `status = 'done'` (D5), and a row can only be done once, so a replayed
 * completion is arithmetically incapable of counting twice. The points ledger
 * needed a partial unique index to promise that; the occurrence row is the
 * promise.
 */
export function resolveCompletion(status: OccurrenceStatus): CompletionOutcome {
  switch (status) {
    case 'scheduled':
      return 'completed';
    case 'done':
      return 'already_done';
    case 'skipped':
    case 'cancelled':
      return 'conflict';
  }
}

/* -------------------------------------------------------------------------- */
/* Cross-module seams                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The rotation seam (D8).
 *
 * The chores module owns fairness. Tasks needs exactly three things from it,
 * and gets them through this port rather than by importing
 * `chores.repository.js` — a module never imports another module's repository.
 *
 * The *algorithm* is imported directly, because `chores/rotation.ts` is pure
 * domain logic with no I/O: this module drives a {@link RotationRun} in
 * ascending occurrence-key order so each pick folds itself straight back into
 * the winner's `committed` count before the next occurrence is considered (D5).
 * That accumulation has to happen inside one materialization pass, which is why
 * the port hands over a snapshot rather than answering one question at a time.
 *
 * **Expected implementation** (chores agent): a thin adapter over
 * `chores.repository.loadRotationRoster` + `findRotationById` + `setRotationCursor`.
 */
export interface RotationPort {
  /**
   * `task_series.rotation_id` carries no foreign key — a real FK would make the
   * tasks ⇄ chores import cycle bidirectional — so the service validates it
   * (`scheduling.md` §9).
   */
  exists(ex: Executor, rotationId: string): Promise<boolean>;
  /** The roster with `completed`/`committed`/`lastAssignedAt` already resolved. */
  loadSnapshot(
    ex: Executor,
    rotationId: string,
    options: { now: Date },
  ): Promise<RotationSnapshot | null>;
  /** Persist the advanced `round_robin` cursor after a pass. */
  saveCursor(ex: Executor, rotationId: string, cursor: number): Promise<void>;
}

export interface SwapPort {
  pendingSwapIds(ex: Executor, occurrenceIds: readonly string[]): Promise<Map<string, string>>;
}

/**
 * Default rotation port.
 *
 * `exists` and `saveCursor` are two-line statements with no domain logic in
 * them, so they are answered directly rather than left unimplemented — skipping
 * the §9 validation would be worse than the coupling.
 *
 * `loadSnapshot` delegates to `chores.service.loadRotationSnapshot`, so the
 * fairness maths keeps exactly one implementation. A rotation id that no longer
 * resolves yields `null` and the series falls back to `defaultAssigneeId` —
 * visible in `assigned_via`, never silent.
 */
export function createDefaultRotationPort(): RotationPort {
  return {
    async exists(ex, rotationId) {
      const rows = await ex.execute<{ id: string }>(
        sql`select id from rotations where id = ${rotationId} limit 1`,
      );
      return rows.length > 0;
    },
    loadSnapshot(ex, rotationId, options) {
      // Delegates to the chores **service**, not its repository (D8). Tasks
      // still drives `RotationRun` itself, because `committed` debt accumulates
      // across the occurrences of one materialization pass and only the
      // materializer knows that order — but the fairness query that produces
      // the snapshot has exactly one implementation, over in chores.
      return loadRotationSnapshot(ex, rotationId, options);
    },
    async saveCursor(ex, rotationId, cursor) {
      await ex.execute(sql`update rotations set cursor = ${cursor} where id = ${rotationId}`);
    },
  };
}

export function createDefaultSwapPort(): SwapPort {
  return {
    async pendingSwapIds(ex, occurrenceIds) {
      if (occurrenceIds.length === 0) return new Map();
      const rows = await ex.execute<{ id: string; occurrence_id: string }>(sql`
        select id, occurrence_id
        from chore_swaps
        where status = 'pending'
          and occurrence_id = any(${sql.param(occurrenceIds as string[])}::uuid[])
      `);
      return new Map(rows.map((r) => [r.occurrence_id, r.id]));
    },
  };
}

export interface TasksServiceDeps {
  readonly rotation?: RotationPort;
  readonly swaps?: SwapPort;
  /** Injected so tests and a deterministic nightly run share one clock. */
  readonly now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

export function toOccurrenceResponse(
  row: ResolvedOccurrence,
  pendingSwapId: string | null = null,
): TaskOccurrenceResponse {
  return {
    id: row.id,
    seriesId: row.seriesId,
    occurrenceKey: row.occurrenceKey,
    startsAt: row.startsAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    localDate: row.localDate,
    startsLocal: row.startsLocal,
    timezone: row.timezone,
    status: row.status,
    isException: row.isException,
    isOverdue: row.isOverdue,
    title: row.title,
    notes: row.notes,
    category: row.category,
    visibility: row.visibility,
    assigneeId: row.assigneeId,
    assignedVia: row.assignedVia,
    completedById: row.completedById,
    completedAt: row.completedAt?.toISOString() ?? null,
    skippedById: row.skippedById,
    skipReason: row.skipReason,
    pendingSwapId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Sorted descending, de-duplicated: `{60, 1440, 60}` becomes `{1440, 60}`.
 *
 * Not cosmetic. The dedupe key is `task_due_soon:<occurrenceId>:<offset>m`, so
 * a duplicated offset is *already* idempotent at the notification layer — but
 * it would still make `listDueReminders` return the same pair twice and the
 * sweep report an emission it did not make. Sorting furthest-first is what lets
 * the create sheet render «за день и за час» in the order a person says it,
 * without the UI re-sorting a value the server owns.
 */
function normalizeReminderOffsets(offsets: readonly number[] | undefined): number[] {
  return [...new Set(offsets ?? [])].sort((a, b) => b - a);
}

export function toSeriesResponse(series: TaskSeriesRow): TaskSeriesResponse {
  return {
    id: series.id,
    title: series.title,
    notes: series.notes,
    visibility: series.visibility,
    createdById: series.createdById,
    recurrence: recurrenceViewOf(series),
    dueOffsetMinutes: series.dueOffsetMinutes,
    graceMinutes: series.graceMinutes,
    rotationId: series.rotationId,
    defaultAssigneeId: series.defaultAssigneeId,
    category: series.category,
    autoCancelAfterDays: series.autoCancelAfterDays,
    reminderOffsets: series.reminderOffsets,
    supersedesSeriesId: series.supersedesSeriesId,
    archivedAt: series.archivedAt?.toISOString() ?? null,
    createdAt: series.createdAt.toISOString(),
    updatedAt: series.updatedAt.toISOString(),
  };
}

/** `YYYY-MM-DD` in a zone, without reaching for Temporal outside the engine. */
/**
 * «19.08 в 19:00» from a floating local timestamp.
 *
 * Notification copy is rendered from the intent payload, never from a fresh
 * read (D10), so the label has to be baked in at emit time — and it has to be
 * short: on iOS a push wears the app icon and nothing else, so the body is all
 * the reader gets. Returns an empty string for anything malformed; the renderer
 * drops empty parts rather than printing a stray separator.
 */
export function shortDueLabel(startsLocal: string): string {
  const [date, time] = startsLocal.split('T');
  if (!date || !time) return '';
  const [, month, day] = date.split('-');
  const clock = time.slice(0, 5);
  return day && month ? `${day}.${month} в ${clock}` : clock;
}

export function localDateIn(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/* -------------------------------------------------------------------------- */
/* The service                                                                 */
/* -------------------------------------------------------------------------- */

export class TasksService {
  private readonly rotation: RotationPort;
  private readonly swaps: SwapPort;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    deps: TasksServiceDeps = {},
  ) {
    this.rotation = deps.rotation ?? createDefaultRotationPort();
    this.swaps = deps.swaps ?? createDefaultSwapPort();
    this.now = deps.now ?? (() => new Date());
  }

  /* ------------------------------ series ------------------------------- */

  async createSeries(actor: TaskActor, input: TaskSeriesCreate): Promise<TaskSeriesResponse> {
    const now = this.now();
    const recurrence = compileRecurrence(input.recurrence);

    return this.db.transaction(async (tx) => {
      if (input.rotationId != null && !(await this.rotation.exists(tx, input.rotationId))) {
        throw badRequest('Неизвестная ротация', { rotationId: ['Ротация не найдена'] });
      }

      const values: NewTaskSeriesRow = {
        title: input.title,
        notes: input.notes ?? null,
        visibility: input.visibility,
        createdById: actor.userId,
        rrule: recurrence.rrule,
        dtstartLocal: recurrence.dtstartLocal,
        timezone: recurrence.timezone,
        rdatesLocal: recurrence.rdatesLocal,
        exdatesLocal: recurrence.exdatesLocal,
        seriesEndsAt: recurrence.seriesEndsAt,
        materializedThrough: null,
        dueOffsetMinutes: input.dueOffsetMinutes,
        graceMinutes: input.graceMinutes,
        rotationId: input.rotationId ?? null,
        defaultAssigneeId: input.defaultAssigneeId ?? null,
        category: input.category ?? null,
        autoCancelAfterDays: input.autoCancelAfterDays ?? null,
        reminderOffsets: normalizeReminderOffsets(input.reminderOffsets),
      };

      const series = await repo.insertSeries(tx, values);
      // Eagerly, in this transaction (§2). The occurrences commit with the
      // series row or not at all.
      await this.materialize(tx, series, now);
      return toSeriesResponse(series);
    });
  }

  async getSeries(actor: TaskActor, id: string): Promise<TaskSeriesResponse> {
    requireRead(actor);
    const series = await repo.findSeriesByIdForViewer(this.db, id, viewerOf(actor));
    if (!series) throw notFound('Task series');
    return toSeriesResponse(series);
  }

  async listSeries(
    actor: TaskActor,
    query: TaskSeriesListQuery,
  ): Promise<{ items: TaskSeriesResponse[]; nextCursor: string | null }> {
    requireRead(actor);
    const page = await repo.listSeries(this.db, {
      viewer: viewerOf(actor),
      includeArchived: query.includeArchived,
      rotationId: query.rotationId,
      category: query.category,
      recurring: query.recurring,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(toSeriesResponse), nextCursor: page.nextCursor };
  }

  /**
   * The three edit scopes (§3.2 – §3.4).
   *
   * Everything runs in one transaction that starts with `SELECT ... FOR UPDATE`
   * on the series, so a concurrent edit and the nightly materializer serialise
   * on the same row instead of interleaving a schedule change with an expansion
   * of the rule it just replaced.
   */
  async updateSeries(
    actor: TaskActor,
    id: string,
    input: TaskSeriesUpdate,
  ): Promise<TaskSeriesResponse> {
    requireRead(actor);
    const now = this.now();

    return this.db.transaction(async (tx) => {
      const series = await this.loadWritableSeries(tx, actor, id, 'update');

      if (input.rotationId != null && !(await this.rotation.exists(tx, input.rotationId))) {
        throw badRequest('Неизвестная ротация', { rotationId: ['Ротация не найдена'] });
      }

      switch (input.scope) {
        case 'this':
          return this.editThisOnly(tx, series, input);
        case 'this_and_future':
          return this.editThisAndFuture(tx, actor, series, input, now);
        case 'all':
          return this.editAll(tx, series, input, now);
      }
    });
  }

  /**
   * §3.2 — edit this one only.
   *
   * Writes `*Override` columns and `is_exception = true`. The rule is not
   * touched and `occurrenceKey` is not touched, so the next horizon extension
   * sees a key it already has and leaves the row alone.
   */
  private async editThisOnly(
    tx: Executor,
    series: TaskSeriesRow,
    input: TaskSeriesUpdate,
  ): Promise<TaskSeriesResponse> {
    const occurrence = await this.loadOccurrenceOfSeries(tx, series.id, input.occurrenceId);

    // Series-level settings have no per-occurrence override column, and
    // silently widening a `this` edit into an `all` edit is exactly the data
    // loss the explicit scope exists to prevent.
    const unsupported = (
      [
        'visibility',
        'dueOffsetMinutes',
        'graceMinutes',
        'rotationId',
        'defaultAssigneeId',
        'category',
        'autoCancelAfterDays',
        'reminderOffsets',
      ] as const
    ).filter((field) => input[field] !== undefined);

    if (unsupported.length > 0) {
      throw badRequest('Эти поля можно изменить только для всей серии', {
        scope: [`Недоступно для одного экземпляра: ${unsupported.join(', ')}`],
      });
    }

    const patch: repo.OccurrenceOverridePatch = {
      ...(input.title === undefined ? {} : { titleOverride: input.title }),
      ...(input.notes === undefined ? {} : { notesOverride: input.notes ?? null }),
    };

    await repo.applyOccurrenceOverride(tx, occurrence.id, patch);
    return toSeriesResponse(series);
  }

  /**
   * §3.3 — the series split, the only mutation that creates a row.
   *
   * 1. `UNTIL` on the old series lands just before the anchor's key.
   * 2. Old occurrences at or after the anchor that are **still `scheduled` and
   *    not exceptions** are deleted. Everything `done` / `skipped` and every
   *    hand-edited row stays: history is not rewritten, it is superseded.
   * 3. A successor is inserted with `supersedesSeriesId` pointing back, so
   *    "this chore has existed since March under three schedules" stays
   *    walkable.
   * 4. The successor is materialized eagerly, in this transaction.
   */
  private async editThisAndFuture(
    tx: Executor,
    actor: TaskActor,
    series: TaskSeriesRow,
    input: TaskSeriesUpdate,
    now: Date,
  ): Promise<TaskSeriesResponse> {
    const occurrence = await this.loadOccurrenceOfSeries(tx, series.id, input.occurrenceId);

    // A one-off has no future to split off; "this and future" is "all".
    if (series.rrule === null) return this.editAll(tx, series, input, now);

    const plan = planSeriesSplit(series, occurrence.occurrenceKey, input.recurrence);

    await repo.updateSeriesRow(tx, series.id, {
      rrule: plan.closingRrule,
      seriesEndsAt: plan.closingSeriesEndsAt,
    });

    const removed = await repo.deleteFutureScheduled(tx, {
      seriesId: series.id,
      fromKey: plan.fromKey,
    });
    await this.forgetComments(tx, removed);

    const successor = await repo.insertSeries(tx, {
      title: input.title ?? series.title,
      notes: input.notes === undefined ? series.notes : (input.notes ?? null),
      visibility: input.visibility ?? series.visibility,
      createdById: actor.userId,
      rrule: plan.successorRecurrence.rrule,
      dtstartLocal: plan.successorRecurrence.dtstartLocal,
      timezone: plan.successorRecurrence.timezone,
      rdatesLocal: plan.successorRecurrence.rdatesLocal,
      exdatesLocal: plan.successorRecurrence.exdatesLocal,
      seriesEndsAt: plan.successorRecurrence.seriesEndsAt,
      materializedThrough: null,
      dueOffsetMinutes: input.dueOffsetMinutes ?? series.dueOffsetMinutes,
      graceMinutes: input.graceMinutes ?? series.graceMinutes,
      rotationId: input.rotationId === undefined ? series.rotationId : (input.rotationId ?? null),
      defaultAssigneeId:
        input.defaultAssigneeId === undefined
          ? series.defaultAssigneeId
          : (input.defaultAssigneeId ?? null),
      category: input.category === undefined ? series.category : (input.category ?? null),
      autoCancelAfterDays:
        input.autoCancelAfterDays === undefined
          ? series.autoCancelAfterDays
          : (input.autoCancelAfterDays ?? null),
      reminderOffsets:
        input.reminderOffsets === undefined
          ? series.reminderOffsets
          : normalizeReminderOffsets(input.reminderOffsets),
      supersedesSeriesId: series.id,
    });

    await this.materialize(tx, successor, now);
    return toSeriesResponse(successor);
  }

  /**
   * §3.4 — edit all.
   *
   * Metadata-only changes delete nothing: `COALESCE(override, series_value)`
   * means every non-overridden occurrence picks the new title or note up for
   * free, and every override keeps winning.
   *
   * A **schedule** change re-plans the window and keeps every date the new rule
   * still produces — as the same row. Only the dates that genuinely stopped
   * existing are deleted. The watermark is pulled back to `now` rather than
   * cleared, because "all" means all *future*: clearing it would re-expand from
   * DTSTART and manufacture history that never happened.
   *
   * ## Presence is not change
   *
   * The edit sheet posts the whole field set back, changed or not, so
   * «переименовать дело» arrives carrying the deadline it loaded. Reading that
   * as a schedule change is what used to delete and regenerate every future
   * occurrence of a series nobody had rescheduled — and an occurrence id is a
   * URL, a comment thread, a pending swap and a notification dedupe key, so the
   * visible symptom («Дело сохранено», then «Задача не найдена» on the page the
   * user saved from) was the mildest of the four things it broke. Both flags
   * below therefore compare values, never presence.
   */
  private async editAll(
    tx: Executor,
    series: TaskSeriesRow,
    input: TaskSeriesUpdate,
    now: Date,
  ): Promise<TaskSeriesResponse> {
    const patch: Partial<NewTaskSeriesRow> = {};

    if (input.title !== undefined) patch.title = input.title;
    if (input.notes !== undefined) patch.notes = input.notes ?? null;
    if (input.visibility !== undefined) patch.visibility = input.visibility;
    if (input.dueOffsetMinutes !== undefined) patch.dueOffsetMinutes = input.dueOffsetMinutes;
    if (input.graceMinutes !== undefined) patch.graceMinutes = input.graceMinutes;
    if (input.rotationId !== undefined) patch.rotationId = input.rotationId ?? null;
    if (input.defaultAssigneeId !== undefined) {
      patch.defaultAssigneeId = input.defaultAssigneeId ?? null;
    }
    if (input.category !== undefined) patch.category = input.category ?? null;
    if (input.autoCancelAfterDays !== undefined) {
      patch.autoCancelAfterDays = input.autoCancelAfterDays ?? null;
    }
    if (input.reminderOffsets !== undefined) {
      patch.reminderOffsets = normalizeReminderOffsets(input.reminderOffsets);
    }

    const recurrence = input.recurrence === undefined ? null : compileRecurrence(input.recurrence);
    const scheduleChanged = recurrence !== null && recurrenceDiffers(series, recurrence);
    if (recurrence !== null && scheduleChanged) {
      patch.rrule = recurrence.rrule;
      patch.dtstartLocal = recurrence.dtstartLocal;
      patch.timezone = recurrence.timezone;
      patch.rdatesLocal = recurrence.rdatesLocal;
      patch.exdatesLocal = recurrence.exdatesLocal;
      patch.seriesEndsAt = recurrence.seriesEndsAt;
      patch.materializedThrough = now;
    }
    // A wall-clock offset change moves every future deadline, so it re-derives
    // the window even without a new rule. It moves `due_at`, though, not the
    // set of dates — so it deletes nothing.
    const offsetChanged =
      input.dueOffsetMinutes !== undefined && input.dueOffsetMinutes !== series.dueOffsetMinutes;

    // Who does it is not a schedule change — it deletes nothing and moves
    // nothing — but it does have to reach the rows already materialized.
    const assignmentChanged =
      (input.rotationId !== undefined && (input.rotationId ?? null) !== series.rotationId) ||
      (input.defaultAssigneeId !== undefined &&
        (input.defaultAssigneeId ?? null) !== series.defaultAssigneeId);

    const updated = await repo.updateSeriesRow(tx, series.id, patch);
    if (!updated) throw notFound('Task series');

    if (!scheduleChanged && !offsetChanged) {
      if (assignmentChanged) await this.reassignByRule(tx, updated, now);
      return toSeriesResponse(updated);
    }

    if (!scheduleChanged) {
      await repo.updateSeriesRow(tx, series.id, { materializedThrough: now });
    }
    const reloaded = await repo.findSeriesById(tx, series.id);
    if (!reloaded) throw notFound('Task series');

    // The same pure plan the materializer is about to run, computed here so the
    // delete below knows which keys the new rule still owes. It reads the row
    // just written, in this transaction, with the same `now` — so the two
    // expansions agree by construction rather than by luck.
    const plan = planSeries(snapshotOf(reloaded), { now });
    const keepKeys = plan.occurrences.map((occurrence) => occurrence.occurrenceKey);

    // Only the dates the new rule stopped producing. A surviving date keeps its
    // row, and the materializer's `ON CONFLICT DO NOTHING` then keeps it too:
    // same id, same assignee, same comment thread, same reminder dedupe key.
    const removed = await repo.deleteFutureScheduled(tx, {
      seriesId: reloaded.id,
      fromInstant: now,
      keepKeys,
    });
    await this.forgetComments(tx, removed);

    await this.materialize(tx, reloaded, now);

    // A kept row still holds instants derived from the old deadline offset or
    // the old timezone: `DO NOTHING` preserved its identity and its staleness
    // alike. This is the other half of that bargain.
    await repo.refreshScheduledInstants(
      tx,
      reloaded.id,
      plan.occurrences.map((occurrence) => ({
        occurrenceKey: occurrence.occurrenceKey,
        startsAt: occurrence.startsAt,
        derivedAt: occurrence.derivedAt,
        localDate: occurrence.localDate,
      })),
    );

    // An edit that changes the schedule *and* the roster walks the rotation
    // twice — once for the rows materialization created, once here for the ones
    // it kept. A `round_robin` cursor therefore ends a few positions further
    // along than it strictly needs to be, which costs a turn order and nothing
    // else; every other strategy is stateless between runs.
    if (assignmentChanged) await this.reassignByRule(tx, reloaded, now);

    return toSeriesResponse(reloaded);
  }

  /**
   * §3.5 — delete, in the same three scopes.
   *
   * `this` on a materialized row is `cancelled` **plus** an EXDATE: the state
   * is preserved and the calendar is clean. `all` archives — a hard delete is
   * only taken when the series has no completed occurrences at all, because
   * nothing anybody did is then being erased.
   */
  async deleteSeries(actor: TaskActor, id: string, input: TaskSeriesDelete): Promise<void> {
    requireRead(actor);
    const now = this.now();

    await this.db.transaction(async (tx) => {
      const series = await this.loadWritableSeries(tx, actor, id, 'delete');

      switch (input.scope) {
        case 'this': {
          const occurrence = await this.loadOccurrenceOfSeries(tx, series.id, input.occurrenceId);
          await repo.cancelIfScheduled(tx, occurrence.id);
          await this.addExdate(tx, series, occurrence.occurrenceKey);
          return;
        }

        case 'this_and_future': {
          const occurrence = await this.loadOccurrenceOfSeries(tx, series.id, input.occurrenceId);
          if (series.rrule === null) {
            await repo.archiveSeries(tx, series.id, now);
            return;
          }
          const plan = planSeriesSplit(series, occurrence.occurrenceKey, undefined);
          await repo.updateSeriesRow(tx, series.id, {
            rrule: plan.closingRrule,
            seriesEndsAt: plan.closingSeriesEndsAt,
          });
          const removed = await repo.deleteFutureScheduled(tx, {
            seriesId: series.id,
            fromKey: plan.fromKey,
          });
          await this.forgetComments(tx, removed);
          return;
        }

        case 'all': {
          const counts = await repo.countOccurrences(tx, series.id);
          if (counts.done === 0 && counts.skipped === 0) {
            const ids = await repo.listOccurrenceIds(tx, series.id);
            await this.forgetComments(tx, ids);
            await repo.deleteSeries(tx, series.id);
            return;
          }
          await repo.archiveSeries(tx, series.id, now);
          return;
        }
      }
    });
  }

  async archiveSeries(actor: TaskActor, id: string): Promise<TaskSeriesResponse> {
    requireRead(actor);
    return this.db.transaction(async (tx) => {
      const series = await this.loadWritableSeries(tx, actor, id, 'update');
      const archived = await repo.archiveSeries(tx, series.id, this.now());
      return toSeriesResponse(archived ?? series);
    });
  }

  /* --------------------------- occurrence reads ------------------------ */

  async listOccurrences(
    actor: TaskActor,
    query: TaskOccurrenceListQuery,
  ): Promise<{ items: TaskOccurrenceResponse[]; nextCursor: string | null }> {
    requireRead(actor);
    const now = this.now();

    const page = await repo.listOccurrences(this.db, {
      viewer: viewerOf(actor),
      now,
      seriesId: query.seriesId,
      // `assignee=me` is resolved server-side; a client never names itself.
      assigneeId: query.assignee === 'me' ? actor.userId : query.assigneeId,
      statuses: query.status,
      from: query.from,
      to: query.to,
      overdueOnly: query.overdueOnly,
      unassignedOnly: query.unassignedOnly,
      category: query.category,
      cursor: query.cursor,
      limit: query.limit,
    });

    return {
      items: await this.decorateWithSwaps(page.items),
      nextCursor: page.nextCursor,
    };
  }

  async calendar(actor: TaskActor, range: CalendarRange): Promise<TaskOccurrenceResponse[]> {
    requireRead(actor);
    const rows = await repo.findCalendarRange(this.db, {
      viewer: viewerOf(actor),
      from: range.from,
      to: range.to,
      now: this.now(),
    });
    return this.decorateWithSwaps(rows);
  }

  async getOccurrence(actor: TaskActor, id: string): Promise<TaskOccurrenceResponse> {
    requireRead(actor);
    const row = await repo.findOccurrenceById(this.db, id, {
      viewer: viewerOf(actor),
      now: this.now(),
    });
    if (!row) throw notFound('Task');
    const [decorated] = await this.decorateWithSwaps([row]);
    if (!decorated) throw notFound('Task');
    return decorated;
  }

  /** The Today dashboard, in one round trip. */
  async today(actor: TaskActor): Promise<TaskTodayResponse> {
    requireRead(actor);
    const now = this.now();
    const timezone = actor.timezone ?? (await this.familyTimezone());
    const date = localDateIn(now, timezone);
    const viewer = viewerOf(actor);

    const [mine, overdue, unassigned, familyDoneToday] = await Promise.all([
      repo.listOccurrences(this.db, {
        viewer,
        now,
        assigneeId: actor.userId,
        from: date,
        to: date,
        limit: 100,
      }),
      repo.findOverdue(this.db, { now, viewer, limit: 100 }),
      repo.listOccurrences(this.db, {
        viewer,
        now,
        from: date,
        to: date,
        statuses: ['scheduled'],
        unassignedOnly: true,
        limit: 100,
      }),
      repo.countDoneOn(this.db, date),
    ]);

    const [mineOut, overdueOut, unassignedOut] = await Promise.all([
      this.decorateWithSwaps(mine.items),
      this.decorateWithSwaps(overdue),
      this.decorateWithSwaps(unassigned.items),
    ]);

    return {
      date,
      timezone,
      mine: mineOut,
      overdue: overdueOut,
      unassigned: unassignedOut,
      familyDoneToday,
    };
  }

  /* ------------------------ occurrence mutations ----------------------- */

  /**
   * §3.2 at the occurrence endpoint: overrides and the move.
   *
   * A move rewrites `starts_at` / `due_at` / `local_date` / `starts_local` and
   * **never** `occurrence_key` — see {@link planOccurrenceMove}, whose return
   * type makes that structural rather than a matter of care.
   */
  async updateOccurrence(
    actor: TaskActor,
    id: string,
    input: TaskOccurrenceUpdate,
  ): Promise<TaskOccurrenceResponse> {
    requireRead(actor);

    return this.db.transaction(async (tx) => {
      const current = await this.loadWritableOccurrence(tx, actor, id, 'update');

      const patch: repo.OccurrenceOverridePatch = {
        ...(input.titleOverride === undefined
          ? {}
          : { titleOverride: input.titleOverride ?? null }),
        ...(input.notesOverride === undefined
          ? {}
          : { notesOverride: input.notesOverride ?? null }),
        ...(input.startsLocal === undefined
          ? {}
          : planOccurrenceMove(input.startsLocal, {
              timezone: current.timezone,
              dueOffsetMinutes: current.dueOffsetMinutes,
            })),
      };

      await repo.applyOccurrenceOverride(tx, id, patch);
      return this.reloadOccurrence(tx, actor, id);
    });
  }

  /**
   * Completion — idempotent.
   *
   * The conditional `WHERE status = 'scheduled'` is what makes an offline
   * replay or a double tap safe: the second attempt updates zero rows, so
   * {@link resolveCompletion} reports `already_done` and nothing is written
   * twice. That single row is also the whole fairness record now — the rotation
   * counts `done` occurrences (D5), so there is no second place for a duplicate
   * to land.
   *
   * The chore counts towards the **doer**, not the assignee — that is what
   * makes the fairness loop self-correcting: covering for your brother means
   * the rotation asks less of you next week, which is payment in time off
   * rather than in a score.
   */
  async complete(
    actor: TaskActor,
    id: string,
    input: TaskComplete,
  ): Promise<TaskOccurrenceResponse> {
    requireRead(actor);
    const now = this.now();

    const completedById = input.completedById ?? actor.userId;
    if (completedById !== actor.userId && !actor.can('task:complete:any')) {
      throw forbidden('Missing permission: task:complete:any');
    }

    const completedAt = input.completedAt === undefined ? now : new Date(input.completedAt);
    if (Number.isNaN(completedAt.getTime())) throw badRequest('Некорректная дата выполнения');
    if (completedAt.getTime() > now.getTime()) {
      throw badRequest('Нельзя отметить выполнение будущей датой', {
        completedAt: ['Дата выполнения не может быть в будущем'],
      });
    }

    const dispatch = await this.db.transaction(async (tx) => {
      const current = await this.loadReadableOccurrence(tx, actor, id);
      this.assertMayComplete(actor, current);

      switch (resolveCompletion(current.status)) {
        case 'already_done':
          // The client's intent is already satisfied. Not an error, and
          // emphatically not a second write.
          return null;
        case 'conflict':
          throw conflict('Задача уже закрыта или отменена');
        case 'completed':
          break;
      }

      const row = await repo.completeIfScheduled(tx, { id, completedById, completedAt });
      // Lost the race with a concurrent completion: somebody else's update
      // already flipped the row, so this request writes nothing.
      if (!row) return null;

      // Written on the caller's transaction, so a rolled-back completion can
      // never produce a notification (D10).
      const intent = await emitIntent(tx, {
        type: 'task_completed',
        audience: { everyone: true },
        actorId: actor.userId,
        entityType: 'task_occurrence',
        entityId: id,
        dedupeKey: `task_completed:${id}:${completedAt.toISOString()}`,
        payload: { title: current.title, completedById },
      });
      return intent.dispatch;
    });

    // Enqueued only after commit — a worker must never read a row that is not
    // there yet.
    if (dispatch) await dispatch();
    return this.reloadOccurrence(this.db, actor, id);
  }

  /**
   * Undo.
   *
   * One status flip and nothing else. Fairness reads `status = 'done'`, so
   * reopening the row removes it from every count in the same statement — no
   * compensating entries, no derived state to rewind (D5).
   */
  async uncomplete(actor: TaskActor, id: string): Promise<TaskOccurrenceResponse> {
    requireRead(actor);
    if (!actor.can('task:complete:any')) throw forbidden('Missing permission: task:complete:any');

    await this.db.transaction(async (tx) => {
      const current = await this.loadReadableOccurrence(tx, actor, id);

      const row = await repo.uncompleteIfDone(tx, id);
      if (!row) {
        if (current.status === 'scheduled') return; // already reopened — idempotent
        throw conflict('Задача не отмечена выполненной');
      }
    });

    return this.reloadOccurrence(this.db, actor, id);
  }

  /**
   * §3.1 — skip.
   *
   * A status change and nothing else. The row keeps its key, its assignee and
   * its place in history, because "Миша didn't do the bins on the 14th" is a
   * fact somebody may need next month.
   *
   * **An EXDATE is written only when `suppressFuture` is explicitly set.**
   * Skipping by writing an EXDATE would delete the slot from the rule, and with
   * it the evidence that it ever existed — which is precisely the audit trail
   * skip exists to preserve.
   */
  async skip(actor: TaskActor, id: string, input: TaskSkip): Promise<TaskOccurrenceResponse> {
    requireRead(actor);

    await this.db.transaction(async (tx) => {
      const current = await this.loadWritableOccurrence(tx, actor, id, 'update');

      const row = await repo.skipIfScheduled(tx, {
        id,
        skippedById: actor.userId,
        reason: input.reason ?? null,
      });
      if (!row && current.status !== 'skipped') throw conflict('Задача уже закрыта или отменена');

      if (input.suppressFuture) {
        const series = await repo.lockSeriesById(tx, current.seriesId);
        if (series) await this.addExdate(tx, series, current.occurrenceKey);
      }
    });

    return this.reloadOccurrence(this.db, actor, id);
  }

  async assign(actor: TaskActor, id: string, input: TaskAssign): Promise<TaskOccurrenceResponse> {
    requireRead(actor);
    if (!actor.can('task:assign:any')) throw forbidden('Missing permission: task:assign:any');

    const dispatch = await this.db.transaction(async (tx) => {
      const current = await this.loadReadableOccurrence(tx, actor, id);
      await repo.assignOccurrence(tx, {
        id,
        assigneeId: input.assigneeId,
        assignedVia: input.assigneeId === null ? null : 'manual',
      });

      /**
       * «Тебе поручили задачу» — the one person now carrying it.
       *
       * Silent in three cases, all of them deliberate: un-assigning is not news
       * for anybody; re-confirming the same assignee would notify them again on
       * every save; and assigning yourself needs no announcement (the fan-out
       * would suppress the actor anyway, but the dedupe key is per assignee, so
       * saying it here keeps the key honest).
       */
      if (input.assigneeId === null || input.assigneeId === current.assigneeId) return null;

      const intent = await emitIntent(tx, {
        type: 'task_assigned',
        audience: { users: [input.assigneeId] },
        actorId: actor.userId,
        entityType: 'task_occurrence',
        entityId: id,
        dedupeKey: `task_assigned:${id}:${input.assigneeId}`,
        payload: {
          occurrenceId: id,
          title: current.title,
          assigneeId: input.assigneeId,
          dueAt: current.dueAt.toISOString(),
          dueLabel: shortDueLabel(current.startsLocal),
        },
      });
      return intent.dispatch;
    });

    // Enqueued only after commit — a worker must never read a row that is not
    // there yet.
    if (dispatch) await dispatch();
    return this.reloadOccurrence(this.db, actor, id);
  }

  /** First claimer wins — the conditional update decides, not a read-then-write. */
  async claim(actor: TaskActor, id: string): Promise<TaskOccurrenceResponse> {
    requireRead(actor);
    if (!actor.can('task:complete:own') && !actor.can('task:complete:any')) {
      throw forbidden('Missing permission: task:complete:own');
    }

    await this.db.transaction(async (tx) => {
      await this.loadReadableOccurrence(tx, actor, id);
      const row = await repo.claimIfUnassigned(tx, { id, userId: actor.userId });
      if (!row) throw conflict('Задачу уже кто-то взял');
    });

    return this.reloadOccurrence(this.db, actor, id);
  }

  /* ------------------------- materialization (§2) ---------------------- */

  /**
   * Materialize one series, with the assignee decorator wired in.
   *
   * The decorator is the seam the generic materializer exposes for exactly this
   * (D5): it runs once per planned occurrence **in ascending key order**, so a
   * `weighted_balance` rotation can fold each pick back into that member's
   * committed debt before the next occurrence is decided. Assignment is written
   * once, here, and frozen — never recomputed on read.
   */
  async materialize(ex: Executor, series: TaskSeriesRow, now: Date): Promise<MaterializeResult> {
    const { decorate, run } = await this.assigneeDecorator(ex, series, now);
    const result = await materializeSeries(ex, TASK_TARGET, series.id, { now, decorate });

    // A `round_robin` walk is a tiny piece of mutable state, so the advanced
    // cursor commits with the occurrences it produced or not at all.
    if (run !== null && series.rotationId !== null && run.cursorMoved) {
      await this.rotation.saveCursor(ex, series.rotationId, run.cursor);
    }
    return result;
  }

  /**
   * Build the per-series decorator. Local state only — two series materializing
   * concurrently must not share a {@link RotationRun}, or their `committed`
   * accumulation would interleave and the schedule would stop being
   * reproducible.
   */
  private async assigneeDecorator(
    ex: Executor,
    series: TaskSeriesRow,
    now: Date,
  ): Promise<{ decorate: OccurrenceDecorator; pick: AssigneePick; run: RotationRun | null }> {
    let run: RotationRun | null = null;
    if (series.rotationId !== null) {
      const snapshot = await this.rotation.loadSnapshot(ex, series.rotationId, { now });
      if (snapshot) run = new RotationRun(snapshot);
    }

    const fallback = series.defaultAssigneeId;
    const manual: AssignedVia = 'manual';

    // Typed, because the same walk has to serve rows that do not exist yet
    // (the decorator, below) and rows that already do ({@link reassignByRule}).
    const pick: AssigneePick = (startsAt) => {
      if (run) {
        const chosen = run.assign(startsAt);
        if (chosen.userId !== null) {
          return { assigneeId: chosen.userId, assignedVia: chosen.assignedVia };
        }
        // `anyone`, or nobody eligible: leave it claimable rather than
        // silently handing it to the default assignee.
        return { assigneeId: null, assignedVia: null };
      }

      if (fallback !== null) return { assigneeId: fallback, assignedVia: manual };
      return { assigneeId: null, assignedVia: null };
    };

    const decorate: OccurrenceDecorator = (occurrence) => {
      const chosen = pick(occurrence.startsAt);
      return { assignee_id: chosen.assigneeId, assigned_via: chosen.assignedVia };
    };

    return { decorate, pick, run };
  }

  /**
   * Re-run the rule's assignment over the occurrences that already exist.
   *
   * Assignment is frozen at materialization and never recomputed on read (D5),
   * which is what stops a chore changing owner overnight. «Кто» is a series
   * setting, though, so changing it for the whole series has to reach the rows
   * already on the board — otherwise the change appears to do nothing until the
   * horizon extends past them, which is up to ninety days of doing nothing.
   *
   * This used to happen by accident: the edit sheet always posts the deadline,
   * the deadline always counted as a schedule change, and the regeneration that
   * followed re-decorated everything. Now that an edit keeps its occurrences,
   * the reassignment has to be asked for by name.
   */
  private async reassignByRule(tx: Executor, series: TaskSeriesRow, now: Date): Promise<void> {
    const rows = await repo.listFutureRuleAssigned(tx, series.id, now);
    if (rows.length === 0) return;

    const { pick, run } = await this.assigneeDecorator(tx, series, now);
    for (const row of rows) {
      await repo.setRuleAssignment(tx, row.id, pick(row.startsAt));
    }

    if (run !== null && series.rotationId !== null && run.cursorMoved) {
      await this.rotation.saveCursor(tx, series.rotationId, run.cursor);
    }
  }

  /**
   * The nightly horizon extension (`scheduler.materialize-all`).
   *
   * Each series gets its **own transaction**, so one poisoned rule cannot roll
   * back the whole family's calendar and the `FOR UPDATE` lock is held for one
   * series at a time. `now` is resolved once for the whole pass, so every
   * series in it shares a horizon.
   */
  async materializeAll(options: { now?: Date; limit?: number } = {}): Promise<MaterializeResult[]> {
    const now = options.now ?? this.now();
    const listPort = createMaterializerPort(this.db, TASK_TARGET);

    return materializeDueThroughPort(
      listPort,
      { now, ...(options.limit === undefined ? {} : { limit: options.limit }) },
      (seriesId, perSeriesOptions) =>
        this.db.transaction(async (tx) => {
          const series = await repo.lockSeriesById(tx, seriesId);
          if (!series) {
            return {
              seriesId,
              planned: 0,
              inserted: 0,
              materializedThrough: null,
              skipped: 'missing' as const,
            };
          }
          return this.materialize(tx, series, perSeriesOptions.now ?? now);
        }),
    );
  }

  /**
   * The opt-in auto-cancel sweep (§2, "Trimming").
   *
   * Only series that set `autoCancelAfterDays` are touched, and a swept row
   * becomes `cancelled` — never deleted. A fortnight of un-done dishes is
   * somebody's record of a fortnight of un-done dishes.
   */
  async autoCancelStale(now = this.now()): Promise<number> {
    const cancelled = await repo.autoCancelStale(this.db, now);
    return cancelled.length;
  }

  /* ------------------------------ helpers ------------------------------ */

  private async loadWritableSeries(
    tx: Executor,
    actor: TaskActor,
    id: string,
    base: 'update' | 'delete',
  ): Promise<TaskSeriesRow> {
    // Read scope first, and 404 — a caller who cannot see the series must not
    // learn it exists from a 403 (D4).
    const visible = await repo.findSeriesByIdForViewer(tx, id, viewerOf(actor));
    if (!visible) throw notFound('Task series');

    const series = await repo.lockSeriesById(tx, id);
    if (!series) throw notFound('Task series');

    requireWrite(actor, series, base);
    return series;
  }

  private async loadOccurrenceOfSeries(
    tx: Executor,
    seriesId: string,
    occurrenceId: string | undefined,
  ): Promise<ResolvedOccurrence> {
    if (occurrenceId === undefined) {
      throw badRequest('occurrenceId обязателен для этой операции');
    }
    const occurrence = await repo.findOccurrenceById(tx, occurrenceId);
    if (!occurrence || occurrence.seriesId !== seriesId) throw notFound('Task');
    return occurrence;
  }

  private async loadReadableOccurrence(
    tx: Executor,
    actor: TaskActor,
    id: string,
  ): Promise<ResolvedOccurrence> {
    const row = await repo.findOccurrenceById(tx, id, {
      viewer: viewerOf(actor),
      now: this.now(),
    });
    if (!row) throw notFound('Task');
    return row;
  }

  private async loadWritableOccurrence(
    tx: Executor,
    actor: TaskActor,
    id: string,
    base: 'update' | 'delete',
  ): Promise<ResolvedOccurrence> {
    const row = await this.loadReadableOccurrence(tx, actor, id);
    if (actor.can(`task:${base}:any` as Permission)) return row;
    if (
      actor.can(`task:${base}:own` as Permission) &&
      (row.seriesCreatedById === actor.userId || row.assigneeId === actor.userId)
    ) {
      return row;
    }
    throw forbidden(`Missing permission: task:${base}:any`);
  }

  private assertMayComplete(actor: TaskActor, row: ResolvedOccurrence): void {
    if (actor.can('task:complete:any')) return;
    if (!actor.can('task:complete:own')) throw forbidden('Missing permission: task:complete:own');
    // `:own` covers "mine" and "nobody's" — a child closing an unclaimed family
    // chore is exactly the participation the app is for.
    if (row.assigneeId === null || row.assigneeId === actor.userId) return;
    throw forbidden('Missing permission: task:complete:any');
  }

  private async reloadOccurrence(
    ex: Executor,
    actor: TaskActor,
    id: string,
  ): Promise<TaskOccurrenceResponse> {
    const row = await repo.findOccurrenceById(ex, id, {
      viewer: viewerOf(actor),
      now: this.now(),
    });
    if (!row) throw notFound('Task');
    const [decorated] = await this.decorateWithSwaps([row]);
    if (!decorated) throw notFound('Task');
    return decorated;
  }

  private async decorateWithSwaps(rows: ResolvedOccurrence[]): Promise<TaskOccurrenceResponse[]> {
    if (rows.length === 0) return [];
    const pending = await this.swaps.pendingSwapIds(
      this.db,
      rows.map((r) => r.id),
    );
    return rows.map((row) => toOccurrenceResponse(row, pending.get(row.id) ?? null));
  }

  /** Append an EXDATE, idempotently. A duplicate would be harmless but untidy. */
  private async addExdate(tx: Executor, series: TaskSeriesRow, key: string): Promise<void> {
    if (series.exdatesLocal.includes(key)) return;
    await repo.updateSeriesRow(tx, series.id, {
      exdatesLocal: [...series.exdatesLocal, key].sort(),
    });
  }

  /**
   * A hard-deleted occurrence must not leave its comments and reactions
   * dangling — nothing else would ever collect them, and the wall would render
   * a thread against an id that no longer resolves.
   */
  private async forgetComments(tx: Executor, occurrenceIds: readonly string[]): Promise<void> {
    for (const id of occurrenceIds) {
      await deleteCommentsFor(tx, 'task', id);
    }
  }

  /** The family default timezone, for callers who carry none of their own. */
  private async familyTimezone(): Promise<string> {
    const rows = await this.db.execute<{ timezone: string }>(
      sql`select timezone from family_settings limit 1`,
    );
    return rows[0]?.timezone ?? 'Europe/Moscow';
  }
}

/** The rolling window, re-exported so the jobs module has one source for it. */
export { HORIZON_DAYS };
