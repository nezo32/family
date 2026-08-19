import type { SwapCreate, SwapListQuery, SwapRespond, SwapResponse, SwapStatus } from '@family/shared';

import type { Db, Executor } from '../../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import {
  dispatchAfterCommit,
  emitIntent,
  type NotificationAudience,
} from '../notifications/notifications.service.js';
import * as repo from './chores.repository.js';
import type { ChoreSwapRow } from './chores.schema.js';
import type { ChoreActor } from './points.service.js';
import { isBlackedOut } from './rotation.js';

/**
 * Chore swaps: "поменяемся?".
 *
 * Two invariants carry this whole file.
 *
 * **One live offer per occurrence.** Enforced by the partial unique index
 * `chore_swaps_one_pending_uq`, not by a read-then-write in the service. Two
 * taps on a flaky mobile connection are the normal case, not the edge case, and
 * a check-then-insert loses that race every time. The insert uses
 * `ON CONFLICT DO NOTHING`; an empty result becomes a clean `409`.
 *
 * **Acceptance rewrites the assignee and nothing else.** No points move here,
 * because no points have been earned yet — they follow the doer at completion
 * (D5). That is also why an accepted swap is cheap to get wrong and easy to
 * undo: the only thing it changed is a foreign key on one row.
 *
 * ## Who may accept
 *
 * A teen or child may *request* a swap freely — that is the participation the
 * app wants. Accepting is gated on `chore:swap:accept`, which every active
 * member holds: taking on a chore somebody offered is volunteering for work,
 * not escaping it, so it needs no adult gatekeeper. Fairness still
 * self-corrects because points follow whoever actually does the job (D5).
 *
 * Acting on a swap addressed to *somebody else* is a different act and still
 * requires `task:assign:any`.
 *
 * Declining and cancelling need no such gate: withdrawing an offer or saying
 * "не могу" is not a handoff.
 */

/**
 * The notification types this module raises. A strict subset of the
 * `notification_type` enum — the catalog is closed on purpose (D10), so adding
 * one here is a code change plus a migration, which is the review we want.
 */
export type ChoreIntentType = 'chore_swap_requested' | 'chore_swap_answered' | 'kudos_received';

export interface ChoreIntent {
  readonly type: ChoreIntentType;
  readonly actorId: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  /** Stable, caller-computed. The dedupe guard and the BullMQ job id (D10). */
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
  /**
   * Who is told. **Never optional and never `{}`** — an unset audience is
   * stored as `{}`, which the fan-out reads as `{ everyone: true }`.
   */
  readonly audience: NotificationAudience;
}

/**
 * The queue hand-off the emitter defers to its caller.
 *
 * Emission happens on the caller's transaction so a rolled-back swap cannot
 * notify anybody; the *enqueue* has to wait for the commit, or the worker reads
 * a row that is not there yet. Returning the thunk is what makes that ordering
 * the caller's explicit decision instead of an easy thing to forget.
 */
export type IntentDispatch = () => Promise<void>;

/** Injected so tests exercise the decision without needing Redis. */
export type ChoreIntentEmitter = (ex: Executor, intent: ChoreIntent) => Promise<IntentDispatch>;

export interface SwapsServiceOptions {
  readonly now?: () => Date;
  readonly emitIntent?: ChoreIntentEmitter;
}

export class SwapsService {
  private readonly now: () => Date;
  private readonly emitIntent: ChoreIntentEmitter;

  constructor(
    private readonly db: Db,
    options: SwapsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.emitIntent = options.emitIntent ?? emitChoreIntent;
  }

  /* ------------------------------ request ------------------------------ */

  async request(actor: ChoreActor, input: SwapCreate): Promise<SwapResponse> {
    const { response, dispatch } = await this.db.transaction(async (tx) => {
      const occurrence = await repo.findOccurrence(tx, input.occurrenceId);
      if (!occurrence) throw notFound('Occurrence');

      if (occurrence.status !== 'scheduled') {
        throw conflict('Обменять можно только запланированную задачу');
      }

      // Only the person carrying the chore may offer it away — plus an adult
      // acting on their behalf ("Миша заболел, отдай его мусор Лизе").
      const isAssignee = occurrence.assigneeId === actor.id;
      if (!isAssignee && !actor.can('task:assign:any')) {
        throw forbidden('Обменять можно только свою задачу');
      }
      if (occurrence.assigneeId === null) {
        throw badRequest('Задача ещё никому не назначена — её можно просто взять');
      }
      if (input.toUserId === occurrence.assigneeId) {
        throw badRequest('Нельзя обменяться задачей с самим собой');
      }

      if (input.toUserId !== undefined) {
        await this.assertCanTake(tx, input.toUserId, occurrence.rotationId, occurrence.startsAt);
      }

      const row = await repo.insertSwap(tx, {
        occurrenceId: input.occurrenceId,
        fromUserId: occurrence.assigneeId,
        toUserId: input.toUserId ?? null,
        message: input.message ?? null,
        bonusPoints: input.bonusPoints,
        // Default to the chore's own deadline: an offer that outlives the chore
        // is noise, and one that expires earlier surprises the asker.
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : occurrence.dueAt,
      });

      // The partial unique index rejected it — there is already a live offer.
      if (!row) throw conflict('По этой задаче уже есть активное предложение обмена');

      const dispatch = await this.emitIntent(tx, {
        type: 'chore_swap_requested',
        actorId: actor.id,
        entityType: 'task_occurrence',
        entityId: row.occurrenceId,
        dedupeKey: `chore_swap_requested:${row.id}`,
        payload: {
          swapId: row.id,
          occurrenceId: row.occurrenceId,
          title: occurrence.title,
          occurrenceTitle: occurrence.title,
          dueAt: occurrence.dueAt.toISOString(),
          fromUserId: row.fromUserId,
          actorName: actor.displayName,
          fromUserName: actor.displayName,
          toUserId: row.toUserId,
          bonusPoints: row.bonusPoints,
          message: row.message,
          isOpenOffer: row.toUserId === null,
        },
        // An open offer goes to the whole family; a directed one to one person.
        // `{ everyone: true }` is spelled out rather than left to the column
        // default, so "everyone" is always a decision somebody made.
        audience: row.toUserId === null ? { everyone: true } : { users: [row.toUserId] },
      });

      return { response: toSwapResponse(row, occurrence.title, occurrence.dueAt), dispatch };
    });

    await dispatchAfterCommit([dispatch]);
    return response;
  }

  /* ------------------------------ respond ------------------------------ */

  async respond(actor: ChoreActor, swapId: string, input: SwapRespond): Promise<SwapResponse> {
    const { response, dispatch } = await this.db.transaction(async (tx) => {
      const swap = await repo.findSwapById(tx, swapId);
      if (!swap) throw notFound('Swap');

      const occurrence = await repo.findOccurrence(tx, swap.occurrenceId);
      if (!occurrence) throw notFound('Occurrence');

      const isAddressed = swap.toUserId === null || swap.toUserId === actor.id;
      if (!isAddressed && !actor.can('task:assign:any')) {
        // 404 rather than 403: outside the caller's read scope, they should not
        // learn that this swap exists (D4).
        throw notFound('Swap');
      }
      if (swap.fromUserId === actor.id && input.accept) {
        throw badRequest('Нельзя принять собственное предложение');
      }

      if (input.accept) {
        // Taking on a chore somebody offered is volunteering for work, not
        // escaping it, so it needs no adult gatekeeper — children hold
        // `chore:swap:accept` too. Fairness still self-corrects because points
        // follow whoever actually does the job (D5).
        if (!actor.can('chore:swap:accept')) {
          throw forbidden('Missing permission: chore:swap:accept');
        }
        const taker = swap.toUserId ?? actor.id;
        await this.assertCanTake(tx, taker, occurrence.rotationId, occurrence.startsAt);

        const updated = await repo.transitionSwap(tx, swapId, 'accepted', {
          respondedById: actor.id,
          respondedAt: this.now(),
        });
        // Somebody else answered first. One winner, one 409 — never two
        // reassignments of the same chore.
        if (!updated) throw conflict('Это предложение уже обработано');

        const reassigned = await repo.reassignOccurrence(tx, swap.occurrenceId, taker, 'swap');
        if (!reassigned) throw conflict('Задача больше не запланирована');

        const dispatch = await this.emitAnswered(
          tx,
          actor,
          updated,
          occurrence.title,
          occurrence.dueAt,
          'accepted',
        );
        return {
          response: toSwapResponse(updated, occurrence.title, occurrence.dueAt),
          dispatch,
        };
      }

      const updated = await repo.transitionSwap(tx, swapId, 'declined', {
        respondedById: actor.id,
        respondedAt: this.now(),
      });
      if (!updated) throw conflict('Это предложение уже обработано');

      const dispatch = await this.emitAnswered(
        tx,
        actor,
        updated,
        occurrence.title,
        occurrence.dueAt,
        'declined',
      );
      return { response: toSwapResponse(updated, occurrence.title, occurrence.dueAt), dispatch };
    });

    await dispatchAfterCommit([dispatch]);
    return response;
  }

  /* ------------------------------- cancel ------------------------------ */

  async cancel(actor: ChoreActor, swapId: string): Promise<SwapResponse> {
    const { response, dispatch } = await this.db.transaction(async (tx) => {
      const swap = await repo.findSwapById(tx, swapId);
      if (!swap) throw notFound('Swap');
      if (swap.fromUserId !== actor.id && !actor.can('task:assign:any')) {
        throw forbidden('Отменить предложение может только тот, кто его создал');
      }

      const occurrence = await repo.findOccurrence(tx, swap.occurrenceId);
      const updated = await repo.transitionSwap(tx, swapId, 'cancelled', {
        respondedById: actor.id,
        respondedAt: this.now(),
      });
      if (!updated) throw conflict('Это предложение уже обработано');

      const title = occurrence?.title ?? '';
      const dueAt = occurrence?.dueAt ?? updated.createdAt;
      const dispatch = await this.emitAnswered(tx, actor, updated, title, dueAt, 'cancelled');
      return { response: toSwapResponse(updated, title, dueAt), dispatch };
    });

    await dispatchAfterCommit([dispatch]);
    return response;
  }

  /* ------------------------------- expire ------------------------------ */

  /**
   * Sweep pending offers past `expires_at`.
   *
   * Bulk and conditional, so running it twice — or concurrently with a human
   * accepting the very last one — cannot expire something that is no longer
   * pending. No intent is emitted: "нас никто не подхватил" is not news worth a
   * push, and notification fatigue is the failure mode that kills these apps
   * (D11).
   */
  async expireDue(ex: Executor = this.db, now = this.now()): Promise<number> {
    const expired = await repo.expirePendingSwaps(ex, now);
    return expired.length;
  }

  /* -------------------------------- list ------------------------------- */

  async list(
    actor: ChoreActor,
    query: SwapListQuery,
  ): Promise<{ items: SwapResponse[]; nextCursor: string | null }> {
    const rows = await repo.listSwaps(this.db, {
      limit: query.limit,
      cursor: query.cursor ? repo.decodeCursor(query.cursor) : undefined,
      statuses: query.status,
      direction: query.direction,
      userId: actor.id,
      seeEverything: actor.can('task:read:any'),
    });
    const page = repo.toPage(rows, query.limit);
    return {
      items: page.items.map((row) => toSwapResponse(row, row.occurrenceTitle, row.occurrenceDueAt)),
      nextCursor: page.nextCursor,
    };
  }

  /* ------------------------------ internals ---------------------------- */

  /**
   * Eligibility for taking a chore over.
   *
   * Deliberately the *same* rule the rotation uses (`rotation.ts`): an active
   * member with a positive weight who is not blacked out at the occurrence
   * instant. A swap that hands the bins to somebody on holiday is exactly the
   * assignment the rotation refused to make, and letting it in through the side
   * door would make blackouts advisory.
   */
  private async assertCanTake(
    ex: Executor,
    userId: string,
    rotationId: string | null,
    at: Date,
  ): Promise<void> {
    const blackouts = await repo.findBlackoutsForUsers(ex, [userId], {
      from: at,
      to: new Date(at.getTime() + 1),
    });
    if (isBlackedOut(blackouts.get(userId) ?? [], at)) {
      throw conflict('В это время участник недоступен');
    }

    if (rotationId === null) return;
    const members = await repo.findRotationMembers(ex, rotationId);
    // A series may name a rotation that has since lost its members; treat an
    // empty roster as "no constraint" rather than blocking every swap.
    if (members.length === 0) return;

    const member = members.find((m) => m.userId === userId);
    if (!member || !member.active || Number(member.weight) <= 0) {
      throw conflict('Участник не входит в это дежурство');
    }
  }

  private async emitAnswered(
    ex: Executor,
    actor: ChoreActor,
    swap: ChoreSwapRow,
    occurrenceTitle: string,
    dueAt: Date,
    outcome: Extract<SwapStatus, 'accepted' | 'declined' | 'cancelled'>,
  ): Promise<IntentDispatch> {
    // The asker always wants to know. On a cancel the counterparty does too.
    const recipients = new Set<string>([swap.fromUserId]);
    if (swap.toUserId !== null) recipients.add(swap.toUserId);
    recipients.delete(actor.id);

    return this.emitIntent(ex, {
      type: 'chore_swap_answered',
      actorId: actor.id,
      entityType: 'task_occurrence',
      entityId: swap.occurrenceId,
      dedupeKey: `chore_swap_answered:${swap.id}:${outcome}`,
      payload: {
        swapId: swap.id,
        occurrenceId: swap.occurrenceId,
        title: occurrenceTitle,
        occurrenceTitle,
        dueAt: dueAt.toISOString(),
        outcome,
        accepted: outcome === 'accepted',
        respondedById: actor.id,
        actorName: actor.displayName,
        respondedByName: actor.displayName,
        fromUserId: swap.fromUserId,
        toUserId: swap.toUserId,
      },
      audience: { users: [...recipients] },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Intent emission                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Hands a chore intent to the notifications service (D8: a cross-module
 * *service* call, never a repository or schema one).
 *
 * This used to insert into `notification_intents` by hand with a hardcoded
 * `priority: 'normal'`. `chore_swap_requested` is `high` in the catalog, and
 * per D11 only `high`/`critical` have an escalation deadline at all — so every
 * «поменяемся?» that nobody answered sat there forever instead of escalating.
 * The priority now comes from `NOTIFICATION_TYPE_DEFAULT_PRIORITY`, which is
 * `emitIntent`'s default, so there is nothing here to get out of step.
 */
export async function emitChoreIntent(
  ex: Executor,
  intent: ChoreIntent,
): Promise<IntentDispatch> {
  const result = await emitIntent(ex, {
    type: intent.type,
    audience: intent.audience,
    actorId: intent.actorId,
    entityType: intent.entityType,
    entityId: intent.entityId,
    payload: intent.payload,
    dedupeKey: intent.dedupeKey,
  });
  return result.dispatch;
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

export function toSwapResponse(
  row: ChoreSwapRow,
  occurrenceTitle: string,
  occurrenceDueAt: Date,
): SwapResponse {
  return {
    id: row.id,
    occurrenceId: row.occurrenceId,
    occurrenceTitle,
    occurrenceDueAt: occurrenceDueAt.toISOString(),
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    status: row.status,
    message: row.message,
    bonusPoints: row.bonusPoints,
    respondedById: row.respondedById,
    respondedAt: row.respondedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
