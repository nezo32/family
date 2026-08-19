import { sql } from 'drizzle-orm';

import type {
  AssignedVia,
  CalendarRange,
  OccurrenceStatus,
  Permission,
  RecurrenceEnd,
  RecurrencePreset,
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
  type ExtraColumnValue,
  type MaterializeResult,
  type OccurrenceDecorator,
} from '../../core/recurrence/materializer.js';
import { PointsService } from '../chores/points.service.js';
import { RotationRun, type RotationSnapshot } from '../chores/rotation.js';
import { deleteCommentsFor } from '../wall/comments.service.js';
import { notificationIntents } from '../notifications/notifications.schema.js';
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
    preset: (decompiled?.preset ?? null) as RecurrencePreset | null,
    ends: (decompiled?.ends ?? null) as RecurrenceEnd | null,
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
 *    a **success**, not an error — the client's intent was satisfied;
 * 3. `points_ledger_award_once_uq`, the database's own refusal to book a second
 *    `chore_completed` for the same (occurrence, user) (D5).
 *
 * Only outcome `'completed'` books points. That is the whole double-award fix.
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
 * ascending occurrence-key order so each pick folds its own points back into
 * the winner's `committed` debt before the next occurrence is considered (D5).
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
  /** The roster with `earned`/`committed`/`lastAssignedAt` already resolved. */
  loadSnapshot(
    ex: Executor,
    rotationId: string,
    options: { now: Date },
  ): Promise<RotationSnapshot | null>;
  /** Persist the advanced `round_robin` cursor after a pass. */
  saveCursor(ex: Executor, rotationId: string, cursor: number): Promise<void>;
}

/** Points booking. Satisfied as-is by `chores/points.service.ts`. */
export interface PointsPort {
  bookCompletion(
    ex: Executor,
    input: {
      occurrenceId: string;
      completedById: string;
      assigneeId: string | null;
      points: number;
      dueAt: Date;
      graceMinutes: number;
      completedAt: Date;
    },
  ): Promise<unknown>;
  reverseCompletion(
    ex: Executor,
    occurrenceId: string,
    userId: string,
    reversedById: string,
  ): Promise<number>;
}

/** The swap badge on an occurrence card. Owned by chores; read-only here. */
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
 * `loadSnapshot` returns `null`: the debt query it needs
 * (`loadRotationRoster`) lives in the chores **repository**, and reproducing it
 * here would duplicate the fairness maths — the one thing that must have
 * exactly one implementation. Until the chores module exposes it through a
 * service, a rotated series falls back to `defaultAssigneeId`, and the
 * fallback is visible in `assigned_via`.
 */
export function createDefaultRotationPort(): RotationPort {
  return {
    async exists(ex, rotationId) {
      const rows = await ex.execute<{ id: string }>(
        sql`select id from rotations where id = ${rotationId} limit 1`,
      );
      return rows.length > 0;
    },
    loadSnapshot() {
      return Promise.resolve(null);
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
  readonly points?: PointsPort;
  readonly swaps?: SwapPort;
  /** Injected so tests and a deterministic nightly run share one clock. */
  readonly now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* Notification intents (D10)                                                  */
/* -------------------------------------------------------------------------- */

export type TaskIntentType = 'task_assigned' | 'task_due_soon' | 'task_overdue' | 'task_completed';

export interface TaskIntent {
  readonly type: TaskIntentType;
  readonly actorId: string | null;
  readonly occurrenceId: string;
  readonly dedupeKey: string;
  readonly priority: 'low' | 'normal' | 'high';
  readonly audience: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

export interface QueuedIntent {
  readonly intentId: string;
  readonly dedupeKey: string;
}

/**
 * Stage intents **inside the caller's transaction**, so an intent can never
 * outlive a rolled-back task write.
 *
 * `ON CONFLICT (dedupe_key) DO NOTHING` on the partial unique index is what
 * makes the overdue sweep idempotent per occurrence: the sweep runs every
 * fifteen minutes and a task stays overdue for days, but the family is told
 * exactly once.
 */
export async function stageIntents(
  ex: Executor,
  intents: readonly TaskIntent[],
): Promise<QueuedIntent[]> {
  if (intents.length === 0) return [];

  const rows = await ex
    .insert(notificationIntents)
    .values(
      intents.map((intent) => ({
        type: intent.type,
        actorId: intent.actorId,
        entityType: 'task_occurrence',
        entityId: intent.occurrenceId,
        payload: intent.payload,
        audience: intent.audience,
        dedupeKey: intent.dedupeKey,
        priority: intent.priority,
      })),
    )
    .onConflictDoNothing({
      target: notificationIntents.dedupeKey,
      // The unique index is partial; Postgres needs the predicate to infer it.
      where: sql`dedupe_key is not null`,
    })
    .returning({ id: notificationIntents.id, dedupeKey: notificationIntents.dedupeKey });

  return rows.flatMap((row) =>
    row.dedupeKey === null ? [] : [{ intentId: row.id, dedupeKey: row.dedupeKey }],
  );
}

/**
 * Hand the staged intents to BullMQ **after** the transaction commits.
 *
 * A queue outage must not fail a committed task write: the intent rows are
 * durable and the dispatcher's own sweep picks them up later.
 */
export async function flushIntents(queued: readonly QueuedIntent[]): Promise<void> {
  if (queued.length === 0) return;

  // Imported lazily: `core/queue/queues.js` pulls in BullMQ and ioredis at
  // module load, and reading a task should never open a Redis socket.
  const { enqueue } = await import('../../core/queue/queues.js');

  for (const item of queued) {
    try {
      await enqueue('notification.dispatch', { intentId: item.intentId }, { jobId: item.dedupeKey });
    } catch (error) {
      console.warn(
        `[tasks] failed to enqueue notification dispatch for intent ${item.intentId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
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
    points: row.points,
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
    points: series.points,
    category: series.category,
    autoCancelAfterDays: series.autoCancelAfterDays,
    supersedesSeriesId: series.supersedesSeriesId,
    archivedAt: series.archivedAt?.toISOString() ?? null,
    createdAt: series.createdAt.toISOString(),
    updatedAt: series.updatedAt.toISOString(),
  };
}

/** `YYYY-MM-DD` in a zone, without reaching for Temporal outside the engine. */
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
  private readonly points: PointsPort;
  private readonly swaps: SwapPort;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    deps: TasksServiceDeps = {},
  ) {
    this.rotation = deps.rotation ?? createDefaultRotationPort();
    this.points = deps.points ?? new PointsService(db);
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
        points: input.points,
        category: input.category ?? null,
        autoCancelAfterDays: input.autoCancelAfterDays ?? null,
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
      ...(input.points === undefined ? {} : { pointsOverride: input.points }),
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
      points: input.points ?? series.points,
      category: input.category === undefined ? series.category : (input.category ?? null),
      autoCancelAfterDays:
        input.autoCancelAfterDays === undefined
          ? series.autoCancelAfterDays
          : (input.autoCancelAfterDays ?? null),
      supersedesSeriesId: series.id,
    });

    await this.materialize(tx, successor, now);
    return toSeriesResponse(successor);
  }

  /**
   * §3.4 — edit all.
   *
   * Metadata-only changes delete nothing: `COALESCE(override, series_value)`
   * means every non-overridden occurrence picks the new title or point value up
   * for free, and every override keeps winning.
   *
   * A **schedule** change deletes the future `scheduled`, non-exception rows
   * and re-materializes. The watermark is pulled back to `now` rather than
   * cleared, because "all" means all *future*: clearing it would re-expand from
   * DTSTART and manufacture history that never happened.
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
    if (input.points !== undefined) patch.points = input.points;
    if (input.category !== undefined) patch.category = input.category ?? null;
    if (input.autoCancelAfterDays !== undefined) {
      patch.autoCancelAfterDays = input.autoCancelAfterDays ?? null;
    }

    const scheduleChanged = input.recurrence !== undefined;
    if (input.recurrence !== undefined) {
      const recurrence = compileRecurrence(input.recurrence);
      patch.rrule = recurrence.rrule;
      patch.dtstartLocal = recurrence.dtstartLocal;
      patch.timezone = recurrence.timezone;
      patch.rdatesLocal = recurrence.rdatesLocal;
      patch.exdatesLocal = recurrence.exdatesLocal;
      patch.seriesEndsAt = recurrence.seriesEndsAt;
      patch.materializedThrough = now;
    }
    // A wall-clock offset change moves every future deadline, so it is a
    // schedule change even without a new rule.
    const offsetChanged = input.dueOffsetMinutes !== undefined;

    const updated = await repo.updateSeriesRow(tx, series.id, patch);
    if (!updated) throw notFound('Task series');

    if (scheduleChanged || offsetChanged) {
      const removed = await repo.deleteFutureScheduled(tx, {
        seriesId: series.id,
        fromInstant: now,
      });
      await this.forgetComments(tx, removed);
      if (!scheduleChanged) {
        await repo.updateSeriesRow(tx, series.id, { materializedThrough: now });
      }
      const reloaded = await repo.findSeriesById(tx, series.id);
      if (reloaded) await this.materialize(tx, reloaded, now);
      return toSeriesResponse(reloaded ?? updated);
    }

    return toSeriesResponse(updated);
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
        ...(input.titleOverride === undefined ? {} : { titleOverride: input.titleOverride ?? null }),
        ...(input.notesOverride === undefined ? {} : { notesOverride: input.notesOverride ?? null }),
        ...(input.pointsOverride === undefined
          ? {}
          : { pointsOverride: input.pointsOverride ?? null }),
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
   * Completion — idempotent, and the only path that books points.
   *
   * The conditional `WHERE status = 'scheduled'` is what makes an offline
   * replay or a double tap safe: the second attempt updates zero rows, so
   * {@link resolveCompletion} reports `already_done` and the ledger is never
   * touched a second time. `points_ledger_award_once_uq` backs that up in the
   * database (D5), because a service being careful is not a guarantee.
   *
   * Points follow the **doer**, not the assignee — that is what makes the
   * fairness loop self-correcting.
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

    const queued = await this.db.transaction(async (tx) => {
      const current = await this.loadReadableOccurrence(tx, actor, id);
      this.assertMayComplete(actor, current);

      switch (resolveCompletion(current.status)) {
        case 'already_done':
          // The client's intent is already satisfied. Not an error, and
          // emphatically not a second award.
          return [];
        case 'conflict':
          throw conflict('Задача уже закрыта или отменена');
        case 'completed':
          break;
      }

      const row = await repo.completeIfScheduled(tx, { id, completedById, completedAt });
      // Lost the race with a concurrent completion: somebody else's update
      // already flipped the row, so this request books nothing.
      if (!row) return [];

      await this.points.bookCompletion(tx, {
        occurrenceId: id,
        completedById,
        assigneeId: row.assigneeId,
        points: current.points,
        dueAt: current.dueAt,
        graceMinutes: current.graceMinutes,
        completedAt,
      });

      return stageIntents(tx, [
        {
          type: 'task_completed',
          actorId: actor.userId,
          occurrenceId: id,
          dedupeKey: `task_completed:${id}:${completedAt.toISOString()}`,
          priority: 'low',
          audience: { everyone: true },
          payload: { title: current.title, completedById, points: current.points },
        },
      ]);
    });

    await flushIntents(queued);
    return this.reloadOccurrence(this.db, actor, id);
  }

  /** Undo. Compensating ledger entries, never a delete — the ledger is append-only. */
  async uncomplete(actor: TaskActor, id: string): Promise<TaskOccurrenceResponse> {
    requireRead(actor);
    if (!actor.can('task:complete:any')) throw forbidden('Missing permission: task:complete:any');

    await this.db.transaction(async (tx) => {
      const current = await this.loadReadableOccurrence(tx, actor, id);
      const previousDoer = current.completedById;

      const row = await repo.uncompleteIfDone(tx, id);
      if (!row) {
        if (current.status === 'scheduled') return; // already reopened — idempotent
        throw conflict('Задача не отмечена выполненной');
      }
      if (previousDoer !== null) {
        await this.points.reverseCompletion(tx, id, previousDoer, actor.userId);
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

    await this.db.transaction(async (tx) => {
      await this.loadReadableOccurrence(tx, actor, id);
      await repo.assignOccurrence(tx, {
        id,
        assigneeId: input.assigneeId,
        assignedVia: input.assigneeId === null ? null : 'manual',
      });
    });

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
  ): Promise<{ decorate: OccurrenceDecorator; run: RotationRun | null }> {
    let run: RotationRun | null = null;
    if (series.rotationId !== null) {
      const snapshot = await this.rotation.loadSnapshot(ex, series.rotationId, { now });
      if (snapshot) run = new RotationRun(snapshot);
    }

    const fallback = series.defaultAssigneeId;
    const points = series.points;
    const manual: AssignedVia = 'manual';

    const decorate: OccurrenceDecorator = (occurrence) => {
      if (run) {
        const pick = run.assign(occurrence.startsAt, points);
        if (pick.userId !== null) {
          return { assignee_id: pick.userId, assigned_via: pick.assignedVia };
        }
        // `anyone`, or nobody eligible: leave it claimable rather than
        // silently handing it to the default assignee.
        return { assignee_id: null, assigned_via: null };
      }

      if (fallback !== null) return { assignee_id: fallback, assigned_via: manual };
      return { assignee_id: null, assigned_via: null };
    };

    return { decorate, run };
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
      viewer: viewerOf(a