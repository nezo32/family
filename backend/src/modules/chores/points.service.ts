import type { Permission, PointsAward, PointsBalance, PointsEntryResponse, PointsLedgerQuery } from '@family/shared';

import type { Db, Executor } from '../../core/db.js';
import { badRequest } from '../../core/errors.js';
import * as repo from './chores.repository.js';
import type { PointsLedgerRow } from './chores.schema.js';

/**
 * The points ledger (D5). Append-only, always.
 *
 * Three rules run through every line of this file:
 *
 * 1. **Points follow the doer, not the assignee.** `completedById` receives
 *    `chore_completed`; when the doer is not the assignee they additionally get
 *    `covered_for_other`. That is what makes the fairness loop self-correcting:
 *    covering for your brother raises *your* debt, so the rotation gives you
 *    less next week. The system pays you back in time off rather than in a
 *    leaderboard position.
 * 2. **Balances are `SUM(delta)`.** There is no cached balance column, and
 *    adding one would be a regression. A mistake is fixed with a compensating
 *    entry, never an UPDATE and never a DELETE.
 * 3. **Every automatic award is idempotent.** Completion is the one action a
 *    user can fire twice — double tap, retry after a timeout, an offline queue
 *    replaying on reconnect — so the two automatic reasons go through
 *    `points_ledger_award_once_uq` with `ON CONFLICT DO NOTHING`. The database
 *    refuses the second award rather than the service trying to be careful.
 */

/** The authenticated caller, as the chores services need it. */
export interface ChoreActor {
  readonly id: string;
  readonly displayName: string;
  can(permission: Permission): boolean;
}

/* -------------------------------------------------------------------------- */
/* Pure scoring rules — no database, so they are unit-testable without Postgres */
/* -------------------------------------------------------------------------- */

/** Fraction of the chore's points paid as an on-time bonus. */
export const ON_TIME_BONUS_RATE = 0.25;

/** Fraction paid to somebody who did a chore that was not theirs. */
export const COVER_BONUS_RATE = 0.5;

/**
 * On time means `completed_at <= due_at + grace_minutes`.
 *
 * Evaluated **once, at completion**, and then it is a fact in the ledger rather
 * than a derived flag — the same reasoning that keeps `overdue` out of the
 * status enum (`docs/architecture/scheduling.md` §4).
 */
export function isOnTime(completedAt: Date, dueAt: Date, graceMinutes: number): boolean {
  return completedAt.getTime() <= dueAt.getTime() + graceMinutes * 60_000;
}

/**
 * A zero-point chore earns no on-time bonus: a percentage of nothing is
 * nothing, and inventing a point here would make "worth 0 points" a lie.
 */
export function onTimeBonusFor(points: number): number {
  if (points <= 0) return 0;
  return Math.max(1, Math.round(points * ON_TIME_BONUS_RATE));
}

/**
 * Covering always earns something, even for a zero-point chore — the whole
 * signal we want to reward is "somebody stepped in", not the size of the job.
 */
export function coverBonusFor(points: number): number {
  return Math.max(1, Math.round(Math.max(points, 0) * COVER_BONUS_RATE));
}

/* -------------------------------------------------------------------------- */
/* Streaks                                                                     */
/* -------------------------------------------------------------------------- */

export interface StreakState {
  readonly current: number;
  readonly longest: number;
  readonly lastResolvedAt: Date | null;
}

/** One assigned occurrence reaching its deadline. */
export interface StreakEvent {
  /** The occurrence deadline — the resume point stored on `user_streaks`. */
  readonly resolvedAt: Date;
  readonly onTime: boolean;
}

export const EMPTY_STREAK: StreakState = { current: 0, longest: 0, lastResolvedAt: null };

/**
 * Fold one resolved occurrence into a streak.
 *
 * A streak counts **consecutive assigned occurrences resolved on time**, not
 * calendar days. A calendar-day streak punishes exactly the wrong people: a
 * child whose only chore is "вынести мусор по средам" would break their streak
 * six days out of seven for doing everything asked of them.
 *
 * Events at or before `lastResolvedAt` are ignored, which makes replaying the
 * same completion — or re-running the maintenance sweep over an overlapping
 * window — a no-op.
 */
export function applyStreakEvent(state: StreakState, event: StreakEvent): StreakState {
  if (state.lastResolvedAt !== null && event.resolvedAt.getTime() <= state.lastResolvedAt.getTime()) {
    return state;
  }
  const current = event.onTime ? state.current + 1 : 0;
  return {
    current,
    longest: Math.max(state.longest, current),
    lastResolvedAt: event.resolvedAt,
  };
}

/** Fold a batch, oldest first. Used by the nightly streak maintenance job. */
export function foldStreak(state: StreakState, events: readonly StreakEvent[]): StreakState {
  return events.reduce(applyStreakEvent, state);
}

/* -------------------------------------------------------------------------- */
/* Completion booking                                                          */
/* -------------------------------------------------------------------------- */

export interface CompletionBooking {
  readonly occurrenceId: string;
  /** Whoever actually did it. Receives every award below. */
  readonly completedById: string;
  /** Whoever was supposed to do it. NULL for an unassigned/claimed chore. */
  readonly assigneeId: string | null;
  readonly points: number;
  readonly dueAt: Date;
  readonly graceMinutes: number;
  readonly completedAt: Date;
  /** Sweetener from an accepted swap, paid by the asker on completion. */
  readonly swap?: { readonly fromUserId: string; readonly bonusPoints: number } | undefined;
}

export interface CompletionAwards {
  readonly onTime: boolean;
  readonly basePoints: number;
  readonly onTimeBonus: number;
  readonly coverBonus: number;
  readonly swapBonus: number;
  /** Total credited to the doer. */
  readonly total: number;
  /** Ledger rows actually written — empty on a replay. */
  readonly entries: readonly PointsLedgerRow[];
}

export class PointsService {
  constructor(private readonly db: Db) {}

  /**
   * Book every ledger row a completion implies, inside the caller's
   * transaction.
   *
   * Safe to call twice: the two guarded reasons collide on
   * `points_ledger_award_once_uq`, and the two unguarded ones
   * (`covered_for_other`, `swap_bonus`) are checked explicitly first because
   * the partial index deliberately excludes them — an adult must stay able to
   * award discretionary points twice.
   */
  async bookCompletion(ex: Executor, input: CompletionBooking): Promise<CompletionAwards> {
    const onTime = isOnTime(input.completedAt, input.dueAt, input.graceMinutes);
    const entries: PointsLedgerRow[] = [];

    const basePoints = Math.max(input.points, 0);
    if (basePoints > 0) {
      const row = await repo.insertLedgerEntry(ex, {
        userId: input.completedById,
        delta: basePoints,
        reason: 'chore_completed',
        occurrenceId: input.occurrenceId,
      });
      if (row) entries.push(row);
    }

    const onTimeBonus = onTime ? onTimeBonusFor(basePoints) : 0;
    if (onTimeBonus > 0) {
      const row = await repo.insertLedgerEntry(ex, {
        userId: input.completedById,
        delta: onTimeBonus,
        reason: 'on_time_bonus',
        occurrenceId: input.occurrenceId,
      });
      if (row) entries.push(row);
    }

    let coverBonus = 0;
    const covered = input.assigneeId !== null && input.assigneeId !== input.completedById;
    if (covered) {
      const existing = await repo.findLedgerEntry(
        ex,
        input.occurrenceId,
        input.completedById,
        'covered_for_other',
      );
      if (!existing) {
        coverBonus = coverBonusFor(basePoints);
        const row = await repo.insertLedgerEntry(ex, {
          userId: input.completedById,
          delta: coverBonus,
          reason: 'covered_for_other',
          occurrenceId: input.occurrenceId,
        });
        if (row) entries.push(row);
        else coverBonus = 0;
      }
    }

    // The swap sweetener is a *transfer*, so it is booked as a pair: the whole
    // ledger has to stay a closed system or the family total drifts upward
    // every time somebody trades a chore.
    let swapBonus = 0;
    if (input.swap && input.swap.bonusPoints > 0 && input.swap.fromUserId !== input.completedById) {
      const existing = await repo.findLedgerEntry(
        ex,
        input.occurrenceId,
        input.completedById,
        'swap_bonus',
      );
      if (!existing) {
        swapBonus = input.swap.bonusPoints;
        const credit = await repo.insertLedgerEntry(ex, {
          userId: input.completedById,
          delta: swapBonus,
          reason: 'swap_bonus',
          occurrenceId: input.occurrenceId,
          note: 'Бонус за обмен',
        });
        const debit = await repo.insertLedgerEntry(ex, {
          userId: input.swap.fromUserId,
          delta: -swapBonus,
          reason: 'swap_bonus',
          occurrenceId: input.occurrenceId,
          note: 'Бонус за обмен',
        });
        if (credit) entries.push(credit);
        if (debit) entries.push(debit);
        if (!credit) swapBonus = 0;
      }
    }

    return {
      onTime,
      basePoints,
      onTimeBonus,
      coverBonus,
      swapBonus,
      total: basePoints + onTimeBonus + coverBonus + swapBonus,
      entries,
    };
  }

  /**
   * Undo a completion with **compensating entries**, never a delete.
   *
   * The ledger is append-only, so "убрать очки" is expressed as an equal and
   * opposite `penalty` row that carries the original occurrence id. History
   * keeps showing that the chore was booked and then reversed, which is the
   * honest record and the one an adult can explain to a child.
   */
  async reverseCompletion(
    ex: Executor,
    occurrenceId: string,
    userId: string,
    reversedById: string,
  ): Promise<number> {
    const reasons = ['chore_completed', 'on_time_bonus', 'covered_for_other', 'swap_bonus'] as const;
    let reversed = 0;
    for (const reason of reasons) {
      const entry = await repo.findLedgerEntry(ex, occurrenceId, userId, reason);
      if (!entry || entry.delta === 0) continue;
      await repo.insertLedgerEntryAlways(ex, {
        userId,
        delta: -entry.delta,
        reason: 'penalty',
        occurrenceId,
        awardedById: reversedById,
        note: `Отмена: ${reason}`,
      });
      reversed += entry.delta;
    }
    return reversed;
  }

  /* ------------------------------ manual ------------------------------- */

  /**
   * A discretionary award or penalty. Deliberately **outside** the double-award
   * guard: an adult may award the same thing twice on purpose, and second-
   * guessing them at the database level would be wrong.
   */
  async award(actor: ChoreActor, input: PointsAward): Promise<PointsEntryResponse> {
    if (input.delta === 0) throw badRequest('delta не может быть нулевым');
    const row = await repo.insertLedgerEntryAlways(this.db, {
      userId: input.userId,
      delta: input.delta,
      reason: input.reason,
      awardedById: actor.id,
      note: input.note ?? null,
    });
    return toLedgerResponse(row, null);
  }

  /* ------------------------------ reads -------------------------------- */

  async balanceFor(userId: string, windowDays: number, now = new Date()): Promise<PointsBalance> {
    const from = new Date(now.getTime() - windowDays * 86_400_000);
    const [balance, windowTotal, streak] = await Promise.all([
      repo.sumBalance(this.db, userId),
      repo.sumBalance(this.db, userId, { from }),
      repo.findStreak(this.db, userId),
    ]);
    return {
      userId,
      balance,
      windowTotal,
      currentStreak: streak?.current ?? 0,
      longestStreak: streak?.longest ?? 0,
    };
  }

  async listLedger(
    query: PointsLedgerQuery,
  ): Promise<{ items: PointsEntryResponse[]; nextCursor: string | null }> {
    const rows = await repo.listLedger(this.db, {
      limit: query.limit,
      cursor: query.cursor ? repo.decodeCursor(query.cursor) : undefined,
      userId: query.userId,
      reasons: query.reason,
      from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
      to: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
    });
    const page = repo.toPage(rows, query.limit);
    return {
      items: page.items.map((row) => toLedgerResponse(row, row.occurrenceTitle)),
      nextCursor: page.nextCursor,
    };
  }

  /* ------------------------------ streaks ------------------------------ */

  /**
   * Fold one just-resolved occurrence into a member's streak.
   *
   * Called from the completion path so the dashboard is right immediately; the
   * nightly job below repairs anything the live path missed (a skipped chore
   * nobody touched, a crash between the two writes).
   */
  async recordStreakEvent(ex: Executor, userId: string, event: StreakEvent): Promise<StreakState> {
    const existing = await repo.findStreak(ex, userId);
    const state: StreakState = existing
      ? {
          current: existing.current,
          longest: existing.longest,
          lastResolvedAt: existing.lastResolvedAt,
        }
      : EMPTY_STREAK;

    const next = applyStreakEvent(state, event);
    if (next === state) return state;

    await repo.upsertStreak(ex, {
      userId,
      current: next.current,
      longest: next.longest,
      lastResolvedAt: next.lastResolvedAt,
    });
    return next;
  }

  /**
   * Rebuild a member's streak from the occurrences that have come due since
   * their stored resume point.
   *
   * `user_streaks` is the one derived value this codebase stores, and it is
   * only tolerable because of this function: the table is a cache, fully
   * rebuildable from `task_occurrences`, so a bug here loses nothing permanent.
   */
  async refreshStreak(
    ex: Executor,
    userId: string,
    until = new Date(),
    limit = 500,
  ): Promise<StreakState> {
    const existing = await repo.findStreak(ex, userId);
    const state: StreakState = existing
      ? {
          current: existing.current,
          longest: existing.longest,
          lastResolvedAt: existing.lastResolvedAt,
        }
      : EMPTY_STREAK;

    const rows = await repo.listStreakEvents(ex, userId, {
      after: state.lastResolvedAt,
      until,
      limit,
    });
    if (rows.length === 0) return state;

    const events: StreakEvent[] = rows.map((row) => ({
      resolvedAt: row.dueAt,
      // A skipped chore is not a failure anybody caused — but it is not an
      // on-time completion either, so it breaks the run. Skip is the escape
      // valve, not a free pass.
      onTime:
        row.status === 'done' &&
        row.completedAt !== null &&
        isOnTime(row.completedAt, row.dueAt, row.graceMinutes),
    }));

    const next = foldStreak(state, events);
    await repo.upsertStreak(ex, {
      userId,
      current: next.current,
      longest: next.longest,
      lastResolvedAt: next.lastResolvedAt,
    });
    return next;
  }
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

export function toLedgerResponse(
  row: PointsLedgerRow,
  occurrenceTitle: string | null,
): PointsEntryResponse {
  return {
    id: row.id,
    userId: row.userId,
    delta: row.delta,
    reason: row.reason,
    occurrenceId: row.occurrenceId,
    occurrenceTitle,
    awardedById: row.awardedById,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}
