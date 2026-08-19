import type {
  BlackoutCreate,
  BlackoutResponse,
  FairnessMember,
  FairnessQuery,
  FairnessSummaryResponse,
  KudosCreate,
  KudosResponse,
  RotationCreate,
  RotationPreviewResponse,
  RotationResponse,
  RotationStrategy,
  RotationUpdate,
} from '@family/shared';

import type { Db, Executor } from '../../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import type {
  ExtraColumnValue,
  OccurrenceDecorator,
  PlannedOccurrence,
} from '../../core/recurrence/materializer.js';
import * as repo from './chores.repository.js';
import type { KudosRow, RotationMemberRow, RotationRow, UserBlackoutRow } from './chores.schema.js';
import { PointsService, type ChoreActor } from './points.service.js';
import {
  previewAssignments as previewRotationPicks,
  RotationRun,
  type RotationCandidate,
  type RotationSnapshot,
} from './rotation.js';
import { emitChoreIntent, SwapsService, type ChoreIntentEmitter } from './swaps.service.js';

export type { ChoreActor } from './points.service.js';

/**
 * Chore fairness business rules (D5). No HTTP knowledge (D8).
 *
 * This service owns three things that must not drift apart:
 *
 * 1. **The rotation seam.** {@link RotationPort} is how the tasks module gets an
 *    assignee at materialization time. Tasks never imports this repository —
 *    it takes the port, calls it inside its own transaction, and writes the
 *    frozen `assignee_id` / `assigned_via` pair the port hands back.
 * 2. **Completion.** Idempotent, points to the doer, auto-kudos when somebody
 *    covered, streaks folded forward.
 * 3. **The neutral load bar.** {@link fairnessSummary} reports each member
 *    against *their own* fair share. There is no rank field anywhere in the
 *    chain, and there must never be one: a sibling leaderboard generates
 *    arguments, not chores (D5).
 */

const MS_PER_DAY = 86_400_000;

/** How far ahead blackouts are pre-loaded for an assignment run (the horizon). */
const DEFAULT_RUN_HORIZON_DAYS = 100;

/* -------------------------------------------------------------------------- */
/* The rotation seam — the public API of this module                           */
/* -------------------------------------------------------------------------- */

/** What the rotation decided for one occurrence. */
export interface RotationAssignment {
  /** NULL for the `anyone` strategy and when nobody is eligible — claimable. */
  readonly assigneeId: string | null;
  /** `'rotation'` when somebody was picked, NULL otherwise. */
  readonly assignedVia: 'rotation' | null;
  /** The winner's debt at the moment of the pick, for the audit trail. */
  readonly debt: number | null;
}

/**
 * One materialization pass over one rotation.
 *
 * Open it *before* the materializer runs, hand {@link assign} to the `decorate`
 * seam, and {@link commit} it afterwards inside the same transaction. `assign`
 * is deliberately **synchronous**: everything it needs (roster, ledger totals,
 * blackouts across the whole horizon) is loaded up front, so the decorator adds
 * no per-occurrence round trip inside the series' `FOR UPDATE` lock.
 */
export interface AssignmentRun {
  readonly rotationId: string;
  readonly strategy: RotationStrategy;
  /** Pick the assignee for one occurrence and fold the result back into the run. */
  assign(at: Date, points: number): RotationAssignment;
  /** Persist the advanced `round_robin` cursor. No-op for other strategies. */
  commit(ex: Executor): Promise<void>;
}

export interface OpenRunOptions {
  /** Planning instant. Defaults to now. */
  readonly now?: Date;
  /** Materialization horizon; blackouts are loaded through it. */
  readonly through?: Date;
  /** Overrides the rotation's own `balanceWindowDays`. */
  readonly windowDays?: number;
}

/**
 * The seam the tasks module calls. Implemented by {@link ChoresService}.
 *
 * Typical use from the tasks materializer, inside its own transaction:
 *
 * ```ts
 * const run = await rotations.openAssignmentRun(tx, series.rotationId, { now });
 * await materializeSeries(tx, TASK_TARGET, series.id, {
 *   now,
 *   decorate: rotationDecorator(run, series.points),
 * });
 * await run.commit(tx);
 * ```
 */
export interface RotationPort {
  /**
   * `task_series.rotation_id` has no database foreign key (it would make the
   * tasks ⇄ chores import cycle bidirectional), so the tasks service validates
   * it through here instead.
   */
  rotationExists(ex: Executor, rotationId: string): Promise<boolean>;
  openAssignmentRun(
    ex: Executor,
    rotationId: string,
    options?: OpenRunOptions,
  ): Promise<AssignmentRun>;
}

/**
 * Adapt an {@link AssignmentRun} to the materializer's `decorate` seam.
 *
 * The decorator is called once per planned occurrence **in ascending key
 * order**, which is exactly what the debt accumulation needs: each pick raises
 * that member's `committed` before the next occurrence is considered, so one
 * pass cannot hand a single person the whole horizon.
 */
export function rotationDecorator(
  run: AssignmentRun,
  points: number | ((occurrence: PlannedOccurrence) => number),
): OccurrenceDecorator {
  return (occurrence: PlannedOccurrence): Record<string, ExtraColumnValue> => {
    const value = typeof points === 'function' ? points(occurrence) : points;
    const decision = run.assign(occurrence.startsAt, value);
    return { assignee_id: decision.assigneeId, assigned_via: decision.assignedVia };
  };
}

/* -------------------------------------------------------------------------- */
/* Completion                                                                  */
/* -------------------------------------------------------------------------- */

export interface CompleteChoreInput {
  /** Whoever actually did it. Defaults to the caller (D5: points follow them). */
  readonly completedById?: string;
  readonly completedAt?: Date;
}

export interface ChoreCompletionResult {
  readonly occurrenceId: string;
  readonly completedById: string;
  readonly completedAt: Date;
  /** TRUE when this call was a replay — no second award was made. */
  readonly alreadyCompleted: boolean;
  readonly onTime: boolean;
  readonly pointsAwarded: number;
  /** The assignee they covered for, when the doer is somebody else. */
  readonly coveredFor: string | null;
  readonly currentStreak: number;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export interface ChoresServiceOptions {
  readonly now?: () => Date;
  readonly emitIntent?: ChoreIntentEmitter;
}

export class ChoresService implements RotationPort {
  readonly points: PointsService;
  readonly swaps: SwapsService;
  private readonly now: () => Date;
  private readonly emitIntent: ChoreIntentEmitter;

  constructor(
    private readonly db: Db,
    options: ChoresServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.emitIntent = options.emitIntent ?? emitChoreIntent;
    this.points = new PointsService(db);
    this.swaps = new SwapsService(db, {
      ...(options.now ? { now: options.now } : {}),
      ...(options.emitIntent ? { emitIntent: options.emitIntent } : {}),
    });
  }

  /* ---------------------------- rotation seam --------------------------- */

  async rotationExists(ex: Executor, rotationId: string): Promise<boolean> {
    return (await repo.findRotationById(ex, rotationId)) !== undefined;
  }

  async openAssignmentRun(
    ex: Executor,
    rotationId: string,
    options: OpenRunOptions = {},
  ): Promise<AssignmentRun> {
    const rotation = await repo.findRotationById(ex, rotationId);
    if (!rotation) throw notFound('Rotation');

    const now = options.now ?? this.now();
    const through = options.through ?? new Date(now.getTime() + DEFAULT_RUN_HORIZON_DAYS * MS_PER_DAY);
    const candidates = await repo.loadRotationRoster(ex, rotationId, {
      now,
      through,
      windowDays: options.windowDays ?? rotation.balanceWindowDays,
    });

    const run = new RotationRun({
      strategy: rotation.strategy,
      cursor: rotation.cursor,
      members: candidates,
    });

    return {
      rotationId,
      strategy: rotation.strategy,
      assign: (at, points) => {
        const pick = run.assign(at, points);
        return { assigneeId: pick.userId, assignedVia: pick.assignedVia, debt: pick.debt };
      },
      commit: async (writeEx: Executor) => {
        // Only `round_robin` carries state across runs; skipping the UPDATE for
        // the others keeps the rotation row out of the hot transaction.
        if (!run.cursorMoved) return;
        await repo.setRotationCursor(writeEx, rotationId, run.cursor);
      },
    };
  }

  /* ------------------------------ rotations ---------------------------- */

  async createRotation(input: RotationCreate): Promise<RotationResponse> {
    return this.db.transaction(async (tx) => {
      const rotation = await repo.insertRotation(tx, {
        name: input.name,
        strategy: input.strategy,
        balanceWindowDays: input.balanceWindowDays,
      });
      const members = await repo.replaceRotationMembers(tx, rotation.id, input.members);
      return toRotationResponse(rotation, members, 0);
    });
  }

  async listRotations(query: {
    limit: number;
    cursor?: string | undefined;
    strategy?: RotationStrategy | undefined;
  }): Promise<{ items: RotationResponse[]; nextCursor: string | null }> {
    const rows = await repo.listRotations(this.db, {
      limit: query.limit,
      cursor: query.cursor ? repo.decodeCursor(query.cursor) : undefined,
      ...(query.strategy ? { strategy: query.strategy } : {}),
    });
    const page = repo.toPage(rows, query.limit);
    if (page.items.length === 0) return { items: [], nextCursor: page.nextCursor };

    // One query for every rotation's members rather than one per rotation.
    const members = await repo.findRotationMembersFor(
      this.db,
      page.items.map((r) => r.id),
    );
    const byRotation = new Map<string, RotationMemberRow[]>();
    for (const member of members) {
      const list = byRotation.get(member.rotationId) ?? [];
      list.push(member);
      byRotation.set(member.rotationId, list);
    }

    const counts = await Promise.all(
      page.items.map((r) => repo.countSeriesUsingRotation(this.db, r.id)),
    );

    return {
      items: page.items.map((rotation, index) =>
        toRotationResponse(rotation, byRotation.get(rotation.id) ?? [], counts[index] ?? 0),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async getRotation(id: string): Promise<RotationResponse> {
    const rotation = await repo.findRotationById(this.db, id);
    if (!rotation) throw notFound('Rotation');
    const [members, seriesCount] = await Promise.all([
      repo.findRotationMembers(this.db, id),
      repo.countSeriesUsingRotation(this.db, id),
    ]);
    return toRotationResponse(rotation, members, seriesCount);
  }

  /**
   * Update a rotation.
   *
   * `reassignFuture` is off by default and that default is load-bearing (D5):
   * assignment is frozen at materialization, so a rotation change normally
   * affects only occurrences materialized *after* it. Silently reshuffling next
   * week's chores because somebody edited a weight destroys trust instantly.
   * When an adult does ask for it, the reassignment walks the still-`scheduled`
   * future occurrences in start order through the same run object, so the
   * result is identical to what a fresh materialization would have produced.
   */
  async updateRotation(id: string, input: RotationUpdate): Promise<RotationResponse> {
    return this.db.transaction(async (tx) => {
      const existing = await repo.lockRotation(tx, id);
      if (!existing) throw notFound('Rotation');

      const patch: repo.RotationPatch = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.strategy !== undefined) patch.strategy = input.strategy;
      if (input.balanceWindowDays !== undefined) patch.balanceWindowDays = input.balanceWindowDays;
      // A member-set change invalidates the round-robin index into it.
      if (input.members !== undefined) patch.cursor = 0;

      const rotation = (await repo.updateRotation(tx, id, patch)) ?? existing;
      const members =
        input.members !== undefined
          ? await repo.replaceRotationMembers(tx, id, input.members)
          : await repo.findRotationMembers(tx, id);

      if (input.reassignFuture) await this.reassignFuture(tx, rotation);

      const seriesCount = await repo.countSeriesUsingRotation(tx, id);
      return toRotationResponse(rotation, members, seriesCount);
    });
  }

  async deleteRotation(id: string): Promise<void> {
    const rotation = await repo.findRotationById(this.db, id);
    if (!rotation) throw notFound('Rotation');
    const seriesCount = await repo.countSeriesUsingRotation(this.db, id);
    if (seriesCount > 0) {
      // `task_series.rotation_id` has no FK, so this check *is* the referential
      // integrity for that column.
      throw conflict('Дежурство используется задачами — сначала отвяжите их');
    }
    await repo.deleteRotation(this.db, id);
  }

  /**
   * "Who would this rotation pick, and why?"
   *
   * Exists so fairness is auditable rather than magic — the UI shows it when a
   * member asks why they got the bins again. It runs the *same* code path as
   * materialization, so what it shows is what would actually happen.
   */
  async previewRotation(
    id: string,
    query: { at?: string | undefined; count: number },
  ): Promise<RotationPreviewResponse> {
    const rotation = await repo.findRotationById(this.db, id);
    if (!rotation) throw notFound('Rotation');

    const at = query.at ? new Date(query.at) : this.now();
    const through = new Date(at.getTime() + (query.count + 1) * MS_PER_DAY);
    const candidates = await repo.loadRotationRoster(this.db, id, {
      now: at,
      through,
      windowDays: rotation.balanceWindowDays,
    });

    const snapshot: RotationSnapshot = {
      strategy: rotation.strategy,
      cursor: rotation.cursor,
      members: candidates,
    };
    const steps = previewRotationPicks(snapshot, { at, count: query.count });

    const picks: RotationPreviewResponse['picks'] = [];
    for (const step of steps) {
      if (step.pick.userId === null) continue;
      const standing = step.standings.find((s) => s.userId === step.pick.userId);
      if (!standing) continue;
      picks.push({
        userId: standing.userId,
        debt: round4(standing.debt),
        earned: Math.round(standing.earned),
        committed: Math.round(standing.committed),
        weight: standing.weight.toFixed(2),
        eligible: true,
        reason: null,
      });
    }

    // Append everyone who was passed over, so "why not me?" has an answer on
    // the same screen. Evaluated at the first instant of the preview window.
    const first = steps[0];
    if (first) {
      for (const standing of first.standings) {
        if (standing.eligible) continue;
        picks.push({
          userId: standing.userId,
          debt: Number.isFinite(standing.debt) ? round4(standing.debt) : 0,
          earned: Math.round(standing.earned),
          committed: Math.round(standing.committed),
          weight: standing.weight.toFixed(2),
          eligible: false,
          reason: standing.reason,
        });
      }
    }

    return { rotationId: id, strategy: rotation.strategy, picks };
  }

  private async reassignFuture(ex: Executor, rotation: RotationRow): Promise<void> {
    const now = this.now();
    const occurrences = await repo.listFutureRotationOccurrences(ex, rotation.id, now);
    if (occurrences.length === 0) return;

    const last = occurrences.at(-1);
    const run = await this.openAssignmentRun(ex, rotation.id, {
      now,
      through: new Date((last?.startsAt ?? now).getTime() + MS_PER_DAY),
    });

    for (const occurrence of occurrences) {
      const decision = run.assign(occurrence.startsAt, occurrence.points);
      if (decision.assigneeId === null) continue;
      await repo.reassignOccurrence(ex, occurrence.id, decision.assigneeId, 'manual');
    }
    await run.commit(ex);
  }

  /* ------------------------------ blackouts ---------------------------- */

  async createBlackout(actor: ChoreActor, input: BlackoutCreate): Promise<BlackoutResponse> {
    const userId = input.userId ?? actor.id;
    if (userId !== actor.id && !actor.can('task:assign:any')) {
      throw forbidden('Отпуск другому участнику отмечает взрослый');
    }
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (startsAt >= endsAt) throw badRequest('Начало должно быть раньше окончания');

    const row = await repo.insertBlackout(this.db, {
      userId,
      startsAt,
      endsAt,
      reason: input.reason ?? null,
    });
    return toBlackoutResponse(row);
  }

  async listBlackouts(
    actor: ChoreActor,
    query: { limit: number; cursor?: string | undefined; userId?: string | undefined; includePast: boolean },
  ): Promise<{ items: BlackoutResponse[]; nextCursor: string | null }> {
    // Without `:any` a caller only ever sees their own windows — 404-by-absence
    // rather than 403 (D4).
    const scopedUserId = actor.can('task:read:any') ? query.userId : actor.id;
    const rows = await repo.listBlackouts(this.db, {
      limit: query.limit,
      cursor: query.cursor ? repo.decodeCursor(query.cursor) : undefined,
      ...(scopedUserId ? { userId: scopedUserId } : {}),
      includePast: query.includePast,
      now: this.now(),
    });
    const page = repo.toPage(rows, query.limit);
    return { items: page.items.map(toBlackoutResponse), nextCursor: page.nextCursor };
  }

  async deleteBlackout(actor: ChoreActor, id: string): Promise<void> {
    const row = await repo.findBlackoutById(this.db, id);
    if (!row) throw notFound('Blackout');
    const mayManageOthers = actor.can('task:update:any') || actor.can('task:assign:any');
    if (row.userId !== actor.id && !mayManageOthers) {
      throw notFound('Blackout');
    }
    await repo.deleteBlackout(this.db, id);
  }

  /* ------------------------------ fairness ----------------------------- */

  /**
   * «Нагрузка за неделю» — the neutral load bar.
   *
   * Every member is compared to *their own* fair share (`weight / Σweight`),
   * never to each other. `imbalance` is a single family-level number precisely
   * so the fix is a family conversation rather than a ranking, and there is no
   * sort by load anywhere in this method. If a future change adds one, it is
   * re-litigating D5.
   */
  async fairnessSummary(query: FairnessQuery): Promise<FairnessSummaryResponse> {
    const to = this.now();
    const from = new Date(to.getTime() - query.windowDays * MS_PER_DAY);

    const roster: Array<{ userId: string; weight: number }> = query.rotationId
      ? (await repo.findRotationMembers(this.db, query.rotationId))
          .filter((m) => m.active)
          .map((m) => ({ userId: m.userId, weight: Number(m.weight) }))
      : (await repo.listChoreMemberWeights(this.db)).map((m) => ({
          userId: m.userId,
          weight: Number(m.weight),
        }));

    const rows = await repo.loadFairnessRows(
      this.db,
      roster.map((m) => m.userId),
      { from, to },
    );
    const byUser = new Map(rows.map((row) => [row.userId, row]));

    const totalWeight = roster.reduce((sum, m) => sum + Math.max(m.weight, 0), 0);
    const loads = roster.map((m) => {
      const row = byUser.get(m.userId);
      return (row?.earned ?? 0) + (row?.committed ?? 0);
    });
    const totalLoad = loads.reduce((sum, load) => sum + load, 0);

    const members: FairnessMember[] = roster.map((m, index) => {
      const row = byUser.get(m.userId);
      const load = loads[index] ?? 0;
      const fairShare = totalWeight > 0 ? Math.max(m.weight, 0) / totalWeight : 0;
      // With no load at all, everybody is exactly at their fair share. Reporting
      // 0 % would render as "nobody is doing anything", which is true but reads
      // as an accusation on an empty week.
      const actualShare = totalLoad > 0 ? load / totalLoad : fairShare;
      return {
        userId: m.userId,
        weight: m.weight.toFixed(2),
        completed: row?.completed ?? 0,
        committed: Math.round(row?.committed ?? 0),
        earned: Math.round(row?.earned ?? 0),
        debt: m.weight > 0 ? round4(load / m.weight) : 0,
        fairShare: round4(fairShare),
        actualShare: round4(actualShare),
        coveredForOthers: row?.coveredForOthers ?? 0,
      };
    });

    const ratios = members
      .filter((m) => m.fairShare > 0)
      .map((m) => m.actualShare / m.fairShare);
    const imbalance =
      ratios.length < 2 ? 0 : round4(Math.max(...ratios) - Math.min(...ratios));

    return {
      windowDays: query.windowDays,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      rotationId: query.rotationId ?? null,
      members,
      imbalance,
    };
  }

  /* -------------------------------- kudos ------------------------------ */

  async giveKudos(actor: ChoreActor, input: KudosCreate): Promise<KudosResponse> {
    if (input.toUserId === actor.id) throw badRequest('Нельзя поблагодарить самого себя');

    const row = await this.db.transaction(async (tx) => {
      const inserted = await repo.insertKudos(tx, {
        fromUserId: actor.id,
        toUserId: input.toUserId,
        occurrenceId: input.occurrenceId ?? null,
        emoji: input.emoji,
        message: input.message ?? null,
      });
      if (!inserted) throw conflict('Вы уже отправили такую благодарность');

      await this.emitIntent(tx, {
        type: 'kudos_received',
        actorId: actor.id,
        entityType: inserted.occurrenceId === null ? null : 'task_occurrence',
        entityId: inserted.occurrenceId,
        dedupeKey: `kudos_received:${inserted.id}`,
        payload: {
          kudosId: inserted.id,
          fromUserId: actor.id,
          fromUserName: actor.displayName,
          toUserId: inserted.toUserId,
          emoji: inserted.emoji,
          message: inserted.message,
          occurrenceId: inserted.occurrenceId,
        },
        audience: { users: [inserted.toUserId] },
      });
      return inserted;
    });

    return toKudosResponse(row);
  }

  async listKudos(query: {
    limit: number;
    cursor?: string | undefined;
    toUserId?: string | undefined;
    occurrenceId?: string | undefined;
  }): Promise<{ items: KudosResponse[]; nextCursor: string | null }> {
    const rows = await repo.listKudos(this.db, {
      limit: query.limit,
      cursor: query.cursor ? repo.decodeCursor(query.cursor) : undefined,
      ...(query.toUserId ? { toUserId: query.toUserId } : {}),
      ...(query.occurrenceId ? { occurrenceId: query.occurrenceId } : {}),
    });
    const page = repo.toPage(rows, query.limit);
    return { items: page.items.map(toKudosResponse), nextCursor: page.nextCursor };
  }

  /* ----------------------------- completion ---------------------------- */

  /**
   * Complete a chore. **Idempotent.**
   *
   * The status transition is a conditional UPDATE (`WHERE status =
   * 'scheduled'`), so a double tap, an offline queue replaying on reconnect or
   * a retry after a timeout produces exactly one winner. Losing that race is
   * not an error — it is the normal second delivery of the same intent — so the
   * loser gets the same success payload with `alreadyCompleted: true` and no
   * second award. The ledger is guarded independently by
   * `points_ledger_award_once_uq`, so even a torn write cannot double-pay.
   *
   * Points go to `completedById`, never to `assigneeId` (D5).
   */
  async completeChore(
    actor: ChoreActor,
    occurrenceId: string,
    input: CompleteChoreInput = {},
  ): Promise<ChoreCompletionResult> {
    const completedById = input.completedById ?? actor.id;
    if (completedById !== actor.id && !actor.can('task:complete:any')) {
      throw forbidden('Отметить выполнение за другого может взрослый');
    }
    const completedAt = input.completedAt ?? this.now();

    return this.db.transaction(async (tx) => {
      const occurrence = await repo.findOccurrence(tx, occurrenceId);
      if (!occurrence) throw notFound('Occurrence');
      if (occurrence.status === 'cancelled' || occurrence.status === 'skipped') {
        throw conflict('Эту задачу уже нельзя отметить выполненной');
      }

      const won = await repo.markOccurrenceDone(tx, occurrenceId, completedById, completedAt);
      if (!won) {
        // Somebody (possibly this very request, a moment ago) got there first.
        const current = await repo.findOccurrence(tx, occurrenceId);
        if (!current || current.status !== 'done') throw conflict('Задача изменилась, повторите');
        const streak = await repo.findStreak(tx, current.completedById ?? completedById);
        return {
          occurrenceId,
          completedById: current.completedById ?? completedById,
          completedAt: current.completedAt ?? completedAt,
          alreadyCompleted: true,
          onTime: false,
          pointsAwarded: 0,
          coveredFor: null,
          currentStreak: streak?.current ?? 0,
        };
      }

      const swap = await repo.findAcceptedSwapForOccurrence(tx, occurrenceId);
      const awards = await this.points.bookCompletion(tx, {
        occurrenceId,
        completedById,
        assigneeId: occurrence.assigneeId,
        points: occurrence.points,
        dueAt: occurrence.dueAt,
        graceMinutes: occurrence.graceMinutes,
        completedAt,
        ...(swap && swap.bonusPoints > 0
          ? { swap: { fromUserId: swap.fromUserId, bonusPoints: swap.bonusPoints } }
          : {}),
      });

      const coveredFor =
        occurrence.assigneeId !== null && occurrence.assigneeId !== completedById
          ? occurrence.assigneeId
          : null;

      // Somebody covered for somebody else: say thank you automatically, from
      // the person who was let off. Kudos carry no points on purpose (D5), so
      // this cannot be farmed — it is a nudge towards the family wall, not a
      // second currency.
      if (coveredFor !== null) {
        await repo.insertKudos(tx, {
          fromUserId: coveredFor,
          toUserId: completedById,
          occurrenceId,
          emoji: '\u{1F64F}',
          message: 'Спасибо, что подменил(а)!',
        });
      }

      // The streak belongs to whoever the chore was *assigned* to: it measures
      // "my queue got resolved on time", which is the thing `listStreakEvents`
      // can rebuild from `task_occurrences`. An unassigned (claimed) chore has
      // no queue to be consistent with, so it does not move any streak.
      let currentStreak = 0;
      const streakOwner = occurrence.assigneeId;
      if (streakOwner !== null) {
        const state = await this.points.recordStreakEvent(tx, streakOwner, {
          resolvedAt: occurrence.dueAt,
          onTime: awards.onTime,
        });
        if (streakOwner === completedById) currentStreak = state.current;
      }
      if (currentStreak === 0 && streakOwner !== completedById) {
        const streak = await repo.findStreak(tx, completedById);
        currentStreak = streak?.current ?? 0;
      }

      return {
        occurrenceId,
        completedById,
        completedAt,
        alreadyCompleted: false,
        onTime: awards.onTime,
        pointsAwarded: awards.total,
        coveredFor,
        currentStreak,
      };
    });
  }

  /**
   * Reopen a completed chore, correcting the ledger with **compensating
   * entries** rather than deletes (D5).
   */
  async uncompleteChore(actor: ChoreActor, occurrenceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const occurrence = await repo.findOccurrence(tx, occurrenceId);
      if (!occurrence) throw notFound('Occurrence');
      if (occurrence.status !== 'done') throw conflict('Задача не отмечена выполненной');

      const doer = occurrence.completedById;
      const reopened = await repo.markOccurrenceScheduled(tx, occurrenceId);
      if (!reopened) throw conflict('Задача изменилась, повторите');
      if (doer === null) return;

      await this.points.reverseCompletion(tx, occurrenceId, doer, actor.id);

      // The streak folded this occurrence in already, and the fold is only ever
      // forward. Rewind the resume point and refold, keeping `longest` — a
      // record somebody actually set is not undone by an administrative fix.
      const owner = occurrence.assigneeId ?? doer;
      const existing = await repo.findStreak(tx, owner);
      await repo.upsertStreak(tx, {
        userId: owner,
        current: 0,
        longest: existing?.longest ?? 0,
        lastResolvedAt: null,
      });
      await this.points.refreshStreak(tx, owner, this.now());
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

export function toRotationResponse(
  rotation: RotationRow,
  members: readonly RotationMemberRow[],
  seriesCount: number,
): RotationResponse {
  return {
    id: rotation.id,
    name: rotation.name,
    strategy: rotation.strategy,
    balanceWindowDays: rotation.balanceWindowDays,
    cursor: rotation.cursor,
    members: members.map((m) => ({
      userId: m.userId,
      weight: m.weight,
      position: m.position,
      active: m.active,
    })),
    seriesCount,
    createdAt: rotation.createdAt.toISOString(),
    updatedAt: rotation.updatedAt.toISOString(),
  };
}

export function toBlackoutResponse(row: UserBlackoutRow): BlackoutResponse {
  return {
    id: row.id,
    userId: row.userId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toKudosResponse(row: KudosRow): KudosResponse {
  return {
    id: row.id,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    occurrenceId: row.occurrenceId,
    emoji: row.emoji,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Re-exported for the tasks module so it never has to reach into `rotation.ts`. */
export type { RotationCandidate, RotationSnapshot };
