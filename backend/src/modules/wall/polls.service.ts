import type {
  CreatePoll,
  ListPollsQuery,
  PollResponse,
  UpdatePoll,
  VotePoll,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import type { Executor } from '../../core/db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { recordActivityEvent } from './activity.service.js';
import { deleteCommentsFor } from './comments.service.js';
import * as repo from './wall.repository.js';
import type { PollOptionRow, PollRow, PollVoteRow } from './wall.schema.js';

/**
 * Polls — the "shared decision" half of the positive loop. Deliberately not a
 * chat feature: a poll is a question with an answer set, and everybody sees who
 * picked what (the family is small; open ballots are the point).
 *
 * Two rules live here rather than in the schema, on purpose (household.md §3):
 *
 * - **Single choice.** `poll_votes` is unique on `(poll_id, user_id, option_id)`
 *   so that multi-choice polls work at all. `allow_multiple = false` is
 *   enforced in `castVote` with `SELECT ... FOR UPDATE` on the poll row
 *   followed by delete-then-insert.
 * - **Results are computed, never stored.** `computePollResults` is pure, so
 *   the tally is unit-testable without a database and can never drift from the
 *   votes.
 */

/* -------------------------------------------------------------------------- */
/* Pure logic                                                                  */
/* -------------------------------------------------------------------------- */

export interface PollClosureState {
  closedAt: Date | null;
  closesAt: Date | null;
}

/**
 * A poll is closed when it was closed by hand (`closedAt`) **or** its soft
 * deadline has passed. The deadline counts immediately — waiting for the
 * sweeper job to stamp `closedAt` would let a late vote through.
 */
export function isPollClosed(poll: PollClosureState, now: Date = new Date()): boolean {
  if (poll.closedAt !== null) return true;
  return poll.closesAt !== null && poll.closesAt.getTime() <= now.getTime();
}

/** Voting after `closesAt` or after `closedAt` is a `CONFLICT`, not a 403. */
export function assertPollOpen(poll: PollClosureState, now: Date = new Date()): void {
  if (isPollClosed(poll, now)) throw conflict('Poll is closed');
}

export interface VoteWrite {
  optionIds: string[];
  /** Always true: a re-vote replaces the caller's previous selection. */
  replacePrevious: true;
}

/**
 * Validates a ballot against the poll's own rules. Pure: no lock, no I/O.
 *
 * Single-choice polls take exactly one option — a client sending two is a bug
 * we refuse loudly rather than silently keeping the first.
 */
export function resolveVoteWrite(
  poll: Pick<PollRow, 'allowMultiple'>,
  optionIds: readonly string[],
  validOptionIds: ReadonlySet<string>,
): VoteWrite {
  const unique = [...new Set(optionIds)];
  if (unique.length === 0) throw badRequest('At least one option is required');

  const unknown = unique.filter((id) => !validOptionIds.has(id));
  if (unknown.length > 0) throw badRequest('Option does not belong to this poll');

  if (!poll.allowMultiple && unique.length > 1) {
    throw badRequest('This poll accepts a single option', {
      optionIds: ['В этом опросе можно выбрать только один вариант'],
    });
  }

  return { optionIds: unique, replacePrevious: true };
}

/**
 * The tally. Computed from the rows every time — there is no cached count
 * column, for the same reason there is no cached goal balance (D6).
 */
export function computePollResults(
  poll: PollRow,
  options: readonly PollOptionRow[],
  votes: readonly Pick<PollVoteRow, 'pollId' | 'optionId' | 'userId'>[],
  viewerId: string,
  now: Date = new Date(),
): PollResponse {
  const ownOptions = options
    .filter((o) => o.pollId === poll.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const ownVotes = votes.filter((v) => v.pollId === poll.id);

  const votersByOption = new Map<string, string[]>();
  const allVoters = new Set<string>();
  const mine: string[] = [];

  for (const vote of ownVotes) {
    allVoters.add(vote.userId);
    const voters = votersByOption.get(vote.optionId);
    if (voters) {
      if (!voters.includes(vote.userId)) voters.push(vote.userId);
    } else {
      votersByOption.set(vote.optionId, [vote.userId]);
    }
    if (vote.userId === viewerId && !mine.includes(vote.optionId)) mine.push(vote.optionId);
  }

  return {
    id: poll.id,
    question: poll.question,
    allowMultiple: poll.allowMultiple,
    closesAt: poll.closesAt ? poll.closesAt.toISOString() : null,
    closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
    isClosed: isPollClosed(poll, now),
    createdById: poll.createdById,
    options: ownOptions.map((option) => {
      const voters = votersByOption.get(option.id) ?? [];
      return {
        id: option.id,
        label: option.label,
        sortOrder: option.sortOrder,
        voteCount: voters.length,
        voterIds: voters,
      };
    }),
    totalVoters: allVoters.size,
    myOptionIds: mine,
    createdAt: poll.createdAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

/** Hydrates a page of polls with options and votes in two queries, not 2×N. */
export async function hydratePolls(
  exec: Executor,
  pollRows: readonly PollRow[],
  viewerId: string,
  now: Date = new Date(),
): Promise<PollResponse[]> {
  if (pollRows.length === 0) return [];
  const ids = pollRows.map((p) => p.id);
  const [options, votes] = await Promise.all([
    repo.loadPollOptions(exec, ids),
    repo.loadPollVotes(exec, ids),
  ]);
  return pollRows.map((poll) => computePollResults(poll, options, votes, viewerId, now));
}

export async function getPoll(
  exec: Executor,
  auth: AuthContext,
  pollId: string,
): Promise<PollResponse> {
  const poll = await repo.findPollById(exec, pollId);
  if (!poll) throw notFound('Poll');
  const [hydrated] = await hydratePolls(exec, [poll], auth.userId);
  if (!hydrated) throw notFound('Poll');
  return hydrated;
}

export async function listPolls(
  exec: Executor,
  auth: AuthContext,
  query: ListPollsQuery,
): Promise<{ items: PollResponse[]; nextCursor: string | null }> {
  const rows = await repo.listPolls(exec, {
    limit: query.limit + 1,
    cursor: query.cursor ? repo.decodeCursor(query.cursor) : undefined,
    status: query.status,
  });
  const page = repo.toPage(rows, query.limit);
  return { items: await hydratePolls(exec, page.items, auth.userId), nextCursor: page.nextCursor };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export async function createPoll(
  exec: Executor,
  auth: AuthContext,
  input: CreatePoll,
): Promise<PollResponse> {
  if (!auth.can('poll:create')) throw forbidden('Missing permission: poll:create');

  const labels = input.options.map((o) => o.trim()).filter((o) => o.length > 0);
  if (new Set(labels).size !== labels.length) throw badRequest('Poll options must be distinct');
  if (labels.length < 2) throw badRequest('A poll needs at least two options');

  const closesAt = input.closesAt ? new Date(input.closesAt) : null;
  if (closesAt && closesAt.getTime() <= Date.now()) {
    throw badRequest('closesAt must be in the future');
  }

  return exec.transaction(async (tx) => {
    const poll = await repo.insertPoll(tx, {
      question: input.question.trim(),
      allowMultiple: input.allowMultiple,
      closesAt,
      createdById: auth.userId,
    });
    const options = await repo.insertPollOptions(tx, poll.id, labels);

    await recordActivityEvent(tx, {
      actorId: auth.userId,
      actor: { name: auth.displayName },
      verb: 'poll.created',
      payload: { question: poll.question },
      entityType: 'poll',
      entityId: poll.id,
    });

    return computePollResults(poll, options, [], auth.userId);
  });
}

/**
 * Edit or close.
 *
 * Closing is **one-way** — `updatePollSchema` has no `reopen`, on purpose: a
 * poll that can reopen is a poll whose result nobody trusts. It takes either
 * `poll:close` as the author, or the moderator override `post:delete:any`.
 */
export async function updatePoll(
  exec: Executor,
  auth: AuthContext,
  pollId: string,
  input: UpdatePoll,
): Promise<PollResponse> {
  const poll = await repo.findPollById(exec, pollId);
  if (!poll) throw notFound('Poll');

  const isAuthor = poll.createdById === auth.userId;
  const isModerator = auth.can('post:delete:any');

  if (input.close === true) {
    if (!((isAuthor && auth.can('poll:close')) || isModerator)) {
      throw forbidden('Only the author (poll:close) or a moderator may close a poll');
    }
    if (poll.closedAt !== null) throw conflict('Poll is already closed');

    return exec.transaction(async (tx) => {
      const closed = await repo.markPollClosed(tx, pollId, new Date());
      // The conditional update lost the race with a concurrent close.
      if (!closed) throw conflict('Poll is already closed');

      await recordActivityEvent(tx, {
        actorId: auth.userId,
        actor: { name: auth.displayName },
        verb: 'poll.closed',
        payload: { question: closed.question },
        entityType: 'poll',
        entityId: closed.id,
      });

      const [hydrated] = await hydratePolls(tx, [closed], auth.userId);
      if (!hydrated) throw notFound('Poll');
      return hydrated;
    });
  }

  if (!(isAuthor || isModerator)) throw forbidden('Only the author may edit a poll');

  const patch: { question?: string; closesAt?: Date | null } = {};
  if (input.question !== undefined) patch.question = input.question.trim();
  if (input.closesAt !== undefined)
    patch.closesAt = input.closesAt ? new Date(input.closesAt) : null;
  if (Object.keys(patch).length === 0) return getPoll(exec, auth, pollId);

  const updated = await repo.updatePollFields(exec, pollId, patch);
  if (!updated) throw notFound('Poll');
  const [hydrated] = await hydratePolls(exec, [updated], auth.userId);
  if (!hydrated) throw notFound('Poll');
  return hydrated;
}

/**
 * Hard delete: options and votes cascade, and a poll carries no history worth
 * preserving. Comments attached to it are cleaned up by the caller's
 * `deleteCommentsFor` hook — see `wall.service.ts`.
 */
export async function deletePoll(exec: Executor, auth: AuthContext, pollId: string): Promise<void> {
  const poll = await repo.findPollById(exec, pollId);
  if (!poll) throw notFound('Poll');
  const mayDelete = poll.createdById === auth.userId || auth.can('post:delete:any');
  if (!mayDelete) throw forbidden('Missing permission: post:delete:any');

  await exec.transaction(async (tx) => {
    await deleteCommentsFor(tx, 'poll', pollId);
    await repo.deletePoll(tx, pollId);
  });
}

/**
 * Cast (or replace) a ballot.
 *
 * The whole transaction: lock the poll row, re-read its state under the lock,
 * refuse a closed poll, drop the caller's previous votes, insert the new ones.
 * The lock is what makes two simultaneous taps from the same phone converge on
 * one selection instead of leaving two rows in a single-choice poll.
 */
export async function castVote(
  exec: Executor,
  auth: AuthContext,
  pollId: string,
  input: VotePoll,
  now: Date = new Date(),
): Promise<PollResponse> {
  if (!auth.can('poll:vote')) throw forbidden('Missing permission: poll:vote');

  return exec.transaction(async (tx) => {
    const poll = await repo.lockPoll(tx, pollId);
    if (!poll) throw notFound('Poll');
    assertPollOpen(poll, now);

    const options = await repo.loadPollOptions(tx, [pollId]);
    const valid = new Set(options.map((o) => o.id));
    const write = resolveVoteWrite(poll, input.optionIds, valid);

    await repo.deleteVotesOf(tx, pollId, auth.userId);
    await repo.insertVotes(tx, pollId, auth.userId, write.optionIds);

    const votes = await repo.loadPollVotes(tx, [pollId]);
    return computePollResults(poll, options, votes, auth.userId, now);
  });
}

/**
 * Used by the nightly sweeper to stamp `closed_at` on polls whose deadline has
 * passed. Voting is already refused by `assertPollOpen`; this only makes the
 * stored state match what every reader already computes.
 */
export async function closeExpiredPoll(
  exec: Executor,
  pollId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const poll = await repo.findPollById(exec, pollId);
  if (!poll || poll.closedAt !== null) return false;
  if (!isPollClosed(poll, now)) return false;
  try {
    return (await repo.markPollClosed(exec, pollId, now)) !== null;
  } catch (error) {
    if (AppError.isAppError(error)) throw error;
    return false;
  }
}
