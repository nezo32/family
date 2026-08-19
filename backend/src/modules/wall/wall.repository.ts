import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';

import type { CommentableEntityType, ReactionSummary } from '@family/shared';

import type { Executor } from '../../core/db.js';
import { badRequest } from '../../core/errors.js';
import { kudos, type KudosRow, type NewKudosRow } from '../chores/chores.schema.js';
import {
  activityLog,
  comments,
  pollOptions,
  polls,
  pollVotes,
  posts,
  reactions,
  type ActivityLogRow,
  type CommentRow,
  type NewCommentRow,
  type NewPollRow,
  type NewPostRow,
  type PollOptionRow,
  type PollRow,
  type PollVoteRow,
  type PostRow,
} from './wall.schema.js';

/**
 * Data access for the family wall. No HTTP knowledge, no business rules (D8),
 * and every function takes the `Executor` first so a caller can run it inside
 * an open transaction.
 *
 * The feed queries deliberately avoid N+1: a page of posts is one query for the
 * rows, one grouped `count(*)` for the comment counts and one flat select for
 * the reactions, folded into summaries in memory. Three round trips for a page
 * of any size.
 */

/* -------------------------------------------------------------------------- */
/* Cursor pagination                                                           */
/* -------------------------------------------------------------------------- */

export interface Cursor {
  createdAt: Date;
  id: string;
}

export interface Timestamped {
  createdAt: Date;
  id: string;
}

/**
 * Keyset cursor over `(created_at, id)`.
 *
 * Opaque base64url so nothing client-side starts depending on the shape, and
 * `id` is in there because two rows can share a millisecond — an offset-based
 * cursor would then skip or repeat a row on every page boundary.
 */
export function encodeCursor(row: Timestamped): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf('|');
  if (sep <= 0) throw badRequest('Malformed cursor');
  const createdAt = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) throw badRequest('Malformed cursor');
  return { createdAt, id };
}

/**
 * Splits an over-fetched result (`limit + 1` rows) into a page plus the cursor
 * for the next one. Pure, so it is unit-testable without a database.
 */
export function toPage<T extends Timestamped>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: last ? encodeCursor(last) : null };
}

/** `(created_at, id) < (cursor)` — the descending keyset predicate. */
function olderThan(cursor: Cursor) {
  return or(
    lt(posts.createdAt, cursor.createdAt),
    and(eq(posts.createdAt, cursor.createdAt), lt(posts.id, cursor.id)),
  );
}

/* -------------------------------------------------------------------------- */
/* Posts                                                                       */
/* -------------------------------------------------------------------------- */

export type PostPatch = Partial<Pick<NewPostRow, 'title' | 'body' | 'pinnedUntil'>>;

export async function insertPost(exec: Executor, values: NewPostRow): Promise<PostRow> {
  const [row] = await exec.insert(posts).values(values).returning();
  if (!row) throw badRequest('posts insert returned no row');
  return row;
}

export async function findPostById(
  exec: Executor,
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<PostRow | null> {
  const where = options.includeDeleted
    ? eq(posts.id, id)
    : and(eq(posts.id, id), isNull(posts.deletedAt));
  const [row] = await exec.select().from(posts).where(where).limit(1);
  return row ?? null;
}

export async function updatePost(
  exec: Executor,
  id: string,
  patch: PostPatch,
): Promise<PostRow | null> {
  const [row] = await exec
    .update(posts)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
    .returning();
  return row ?? null;
}

export async function softDeletePost(exec: Executor, id: string): Promise<boolean> {
  const rows = await exec
    .update(posts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
    .returning({ id: posts.id });
  return rows.length > 0;
}

export interface ListPostsOptions {
  limit: number;
  cursor?: Cursor | undefined;
  type?: 'announcement' | 'system' | undefined;
  authorId?: string | undefined;
  /** Pinned posts are served as a separate head block, so keep them out here. */
  excludePinned?: boolean;
  now?: Date;
}

/** Live pinned posts. Small by construction — pins expire (`pinned_until`). */
export async function listPinnedPosts(
  exec: Executor,
  now: Date = new Date(),
  limit = 20,
): Promise<PostRow[]> {
  return exec
    .select()
    .from(posts)
    .where(and(isNull(posts.deletedAt), isNotNull(posts.pinnedUntil), gt(posts.pinnedUntil, now)))
    .orderBy(desc(posts.pinnedUntil), desc(posts.createdAt))
    .limit(limit);
}

/**
 * One page of the post stream, newest first. Fetch `limit + 1` and hand the
 * result to `toPage`.
 */
export async function listPosts(exec: Executor, options: ListPostsOptions): Promise<PostRow[]> {
  const now = options.now ?? new Date();
  const filters = [isNull(posts.deletedAt)];
  if (options.type) filters.push(eq(posts.type, options.type));
  if (options.authorId) filters.push(eq(posts.authorId, options.authorId));
  if (options.cursor) {
    const predicate = olderThan(options.cursor);
    if (predicate) filters.push(predicate);
  }
  if (options.excludePinned) {
    const notPinned = or(isNull(posts.pinnedUntil), lte(posts.pinnedUntil, now));
    if (notPinned) filters.push(notPinned);
  }

  return exec
    .select()
    .from(posts)
    .where(and(...filters))
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(options.limit);
}

/* -------------------------------------------------------------------------- */
/* Comments                                                                    */
/* -------------------------------------------------------------------------- */

export async function insertComment(exec: Executor, values: NewCommentRow): Promise<CommentRow> {
  const [row] = await exec.insert(comments).values(values).returning();
  if (!row) throw badRequest('comments insert returned no row');
  return row;
}

export async function findCommentById(
  exec: Executor,
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<CommentRow | null> {
  const where = options.includeDeleted
    ? eq(comments.id, id)
    : and(eq(comments.id, id), isNull(comments.deletedAt));
  const [row] = await exec.select().from(comments).where(where).limit(1);
  return row ?? null;
}

export async function updateCommentBody(
  exec: Executor,
  id: string,
  body: string,
): Promise<CommentRow | null> {
  const [row] = await exec
    .update(comments)
    .set({ body, updatedAt: new Date() })
    .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
    .returning();
  return row ?? null;
}

export async function softDeleteComment(exec: Executor, id: string): Promise<boolean> {
  const rows = await exec
    .update(comments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
    .returning({ id: comments.id });
  return rows.length > 0;
}

export interface ListCommentsOptions {
  entityType: CommentableEntityType;
  entityId: string;
  limit: number;
  cursor?: Cursor | undefined;
  order?: 'asc' | 'desc';
}

export async function listComments(
  exec: Executor,
  options: ListCommentsOptions,
): Promise<CommentRow[]> {
  const order = options.order ?? 'asc';
  const filters = [
    eq(comments.entityType, options.entityType),
    eq(comments.entityId, options.entityId),
    isNull(comments.deletedAt),
  ];
  if (options.cursor) {
    const { createdAt, id } = options.cursor;
    const predicate =
      order === 'asc'
        ? or(gt(comments.createdAt, createdAt), and(eq(comments.createdAt, createdAt), gt(comments.id, id)))
        : or(lt(comments.createdAt, createdAt), and(eq(comments.createdAt, createdAt), lt(comments.id, id)));
    if (predicate) filters.push(predicate);
  }

  return exec
    .select()
    .from(comments)
    .where(and(...filters))
    .orderBy(
      order === 'asc' ? asc(comments.createdAt) : desc(comments.createdAt),
      order === 'asc' ? asc(comments.id) : desc(comments.id),
    )
    .limit(options.limit);
}

/**
 * Live comment counts for a whole page of targets in one grouped query.
 *
 * Soft-deleted rows are excluded here and nowhere else, which is what keeps
 * "the comment vanished but the counter still says 3" from ever happening.
 */
export async function countComments(
  exec: Executor,
  entityType: CommentableEntityType,
  entityIds: readonly string[],
): Promise<Map<string, number>> {
  if (entityIds.length === 0) return new Map();
  const rows = await exec
    .select({ entityId: comments.entityId, total: count() })
    .from(comments)
    .where(
      and(
        eq(comments.entityType, entityType),
        inArray(comments.entityId, [...entityIds]),
        isNull(comments.deletedAt),
      ),
    )
    .groupBy(comments.entityId);

  return new Map(rows.map((r) => [r.entityId, Number(r.total)]));
}

/** Convenience so callers do not repeat the `?? 0`. */
export function commentCountOf(counts: Map<string, number>, entityId: string): number {
  return counts.get(entityId) ?? 0;
}

/**
 * The cleanup hook's write half: soft-delete every comment on one entity.
 * Returns how many rows were affected.
 */
export async function softDeleteCommentsFor(
  exec: Executor,
  entityType: string,
  entityId: string,
): Promise<number> {
  const rows = await exec
    .update(comments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(comments.entityType, entityType),
        eq(comments.entityId, entityId),
        isNull(comments.deletedAt),
      ),
    )
    .returning({ id: comments.id });
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* Reactions                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReactionFact {
  entityId: string;
  emoji: string;
  userId: string;
}

export async function findReaction(
  exec: Executor,
  entityType: CommentableEntityType,
  entityId: string,
  userId: string,
  emoji: string,
): Promise<{ id: string } | null> {
  const [row] = await exec
    .select({ id: reactions.id })
    .from(reactions)
    .where(
      and(
        eq(reactions.entityType, entityType),
        eq(reactions.entityId, entityId),
        eq(reactions.userId, userId),
        eq(reactions.emoji, emoji),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertReaction(
  exec: Executor,
  values: { entityType: CommentableEntityType; entityId: string; userId: string; emoji: string },
): Promise<void> {
  await exec.insert(reactions).values(values).onConflictDoNothing();
}

export async function deleteReactionById(exec: Executor, id: string): Promise<void> {
  await exec.delete(reactions).where(eq(reactions.id, id));
}

/** All reaction facts for a page of targets — one query, folded in memory. */
export async function loadReactions(
  exec: Executor,
  entityType: CommentableEntityType,
  entityIds: readonly string[],
): Promise<ReactionFact[]> {
  if (entityIds.length === 0) return [];
  return exec
    .select({
      entityId: reactions.entityId,
      emoji: reactions.emoji,
      userId: reactions.userId,
    })
    .from(reactions)
    .where(and(eq(reactions.entityType, entityType), inArray(reactions.entityId, [...entityIds])));
}

export async function deleteReactionsFor(
  exec: Executor,
  entityType: string,
  entityId: string,
): Promise<number> {
  const rows = await exec
    .delete(reactions)
    .where(and(eq(reactions.entityType, entityType), eq(reactions.entityId, entityId)))
    .returning({ id: reactions.id });
  return rows.length;
}

/**
 * Folds raw reaction rows into per-entity summaries. Pure — the interesting
 * part of the reaction pipeline is unit-tested without Postgres.
 *
 * Emoji are ordered by count desc, then by emoji, so two clients rendering the
 * same data always agree on the chip order.
 */
export function buildReactionSummaries(
  facts: readonly ReactionFact[],
  viewerId: string,
): Map<string, ReactionSummary[]> {
  const byEntity = new Map<string, Map<string, { count: number; reacted: boolean }>>();

  for (const fact of facts) {
    let entity = byEntity.get(fact.entityId);
    if (!entity) {
      entity = new Map();
      byEntity.set(fact.entityId, entity);
    }
    const current = entity.get(fact.emoji) ?? { count: 0, reacted: false };
    current.count += 1;
    if (fact.userId === viewerId) current.reacted = true;
    entity.set(fact.emoji, current);
  }

  const result = new Map<string, ReactionSummary[]>();
  for (const [entityId, emojis] of byEntity) {
    const summaries = [...emojis.entries()]
      .map(([emoji, agg]) => ({ emoji, count: agg.count, reacted: agg.reacted }))
      .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
    result.set(entityId, summaries);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Polls                                                                       */
/* -------------------------------------------------------------------------- */

export async function insertPoll(exec: Executor, values: NewPollRow): Promise<PollRow> {
  const [row] = await exec.insert(polls).values(values).returning();
  if (!row) throw badRequest('polls insert returned no row');
  return row;
}

export async function insertPollOptions(
  exec: Executor,
  pollId: string,
  labels: readonly string[],
): Promise<PollOptionRow[]> {
  return exec
    .insert(pollOptions)
    .values(labels.map((label, index) => ({ pollId, label, sortOrder: index })))
    .returning();
}

export async function findPollById(exec: Executor, id: string): Promise<PollRow | null> {
  const [row] = await exec.select().from(polls).where(eq(polls.id, id)).limit(1);
  return row ?? null;
}

/**
 * `SELECT ... FOR UPDATE` on the poll row.
 *
 * This is the lock that makes single-choice enforcement correct: two
 * simultaneous votes from the same user serialize on the parent row, so the
 * delete-then-insert in the service cannot interleave (household.md §3).
 */
export async function lockPoll(tx: Executor, id: string): Promise<PollRow | null> {
  const [row] = await tx.select().from(polls).where(eq(polls.id, id)).limit(1).for('update');
  return row ?? null;
}

export async function markPollClosed(
  exec: Executor,
  id: string,
  closedAt: Date,
): Promise<PollRow | null> {
  const [row] = await exec
    .update(polls)
    .set({ closedAt })
    .where(and(eq(polls.id, id), isNull(polls.closedAt)))
    .returning();
  return row ?? null;
}

export async function updatePollFields(
  exec: Executor,
  id: string,
  patch: Partial<Pick<NewPollRow, 'question' | 'closesAt'>>,
): Promise<PollRow | null> {
  const [row] = await exec.update(polls).set(patch).where(eq(polls.id, id)).returning();
  return row ?? null;
}

/** Polls are hard-deleted: options and votes cascade, and there is no history to keep. */
export async function deletePoll(exec: Executor, id: string): Promise<boolean> {
  const rows = await exec.delete(polls).where(eq(polls.id, id)).returning({ id: polls.id });
  return rows.length > 0;
}

export interface ListPollsOptions {
  limit: number;
  cursor?: Cursor | undefined;
  status?: 'all' | 'open' | 'closed';
  now?: Date;
}

export async function listPolls(exec: Executor, options: ListPollsOptions): Promise<PollRow[]> {
  const now = options.now ?? new Date();
  const filters = [];

  if (options.status === 'open') {
    const open = and(
      isNull(polls.closedAt),
      or(isNull(polls.closesAt), gt(polls.closesAt, now)),
    );
    if (open) filters.push(open);
  } else if (options.status === 'closed') {
    const closed = or(isNotNull(polls.closedAt), lte(polls.closesAt, now));
    if (closed) filters.push(closed);
  }

  if (options.cursor) {
    const { createdAt, id } = options.cursor;
    const predicate = or(
      lt(polls.createdAt, createdAt),
      and(eq(polls.createdAt, createdAt), lt(polls.id, id)),
    );
    if (predicate) filters.push(predicate);
  }

  return exec
    .select()
    .from(polls)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(polls.createdAt), desc(polls.id))
    .limit(options.limit);
}

export async function loadPollOptions(
  exec: Executor,
  pollIds: readonly string[],
): Promise<PollOptionRow[]> {
  if (pollIds.length === 0) return [];
  return exec
    .select()
    .from(pollOptions)
    .where(inArray(pollOptions.pollId, [...pollIds]))
    .orderBy(asc(pollOptions.sortOrder), asc(pollOptions.id));
}

export async function loadPollVotes(
  exec: Executor,
  pollIds: readonly string[],
): Promise<PollVoteRow[]> {
  if (pollIds.length === 0) return [];
  return exec.select().from(pollVotes).where(inArray(pollVotes.pollId, [...pollIds]));
}

export async function deleteVotesOf(
  tx: Executor,
  pollId: string,
  userId: string,
): Promise<number> {
  const rows = await tx
    .delete(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, userId)))
    .returning({ id: pollVotes.id });
  return rows.length;
}

export async function insertVotes(
  tx: Executor,
  pollId: string,
  userId: string,
  optionIds: readonly string[],
): Promise<void> {
  if (optionIds.length === 0) return;
  await tx
    .insert(pollVotes)
    .values(optionIds.map((optionId) => ({ pollId, userId, optionId })))
    .onConflictDoNothing();
}

/* -------------------------------------------------------------------------- */
/* Kudos (table owned by the chores module — see chores.schema.ts)             */
/* -------------------------------------------------------------------------- */

export async function insertKudos(exec: Executor, values: NewKudosRow): Promise<KudosRow> {
  const [row] = await exec.insert(kudos).values(values).returning();
  if (!row) throw badRequest('kudos insert returned no row');
  return row;
}

export interface ListKudosOptions {
  limit: number;
  cursor?: Cursor | undefined;
  toUserId?: string | undefined;
  fromUserId?: string | undefined;
  occurrenceId?: string | undefined;
}

export async function listKudos(exec: Executor, options: ListKudosOptions): Promise<KudosRow[]> {
  const filters = [];
  if (options.toUserId) filters.push(eq(kudos.toUserId, options.toUserId));
  if (options.fromUserId) filters.push(eq(kudos.fromUserId, options.fromUserId));
  if (options.occurrenceId) filters.push(eq(kudos.occurrenceId, options.occurrenceId));
  if (options.cursor) {
    const { createdAt, id } = options.cursor;
    const predicate = or(
      lt(kudos.createdAt, createdAt),
      and(eq(kudos.createdAt, createdAt), lt(kudos.id, id)),
    );
    if (predicate) filters.push(predicate);
  }

  return exec
    .select()
    .from(kudos)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(kudos.createdAt), desc(kudos.id))
    .limit(options.limit);
}

export interface KudosTotal {
  userId: string;
  received: number;
}

/** `received` per member, optionally windowed. One grouped query, never a loop. */
export async function kudosTotals(
  exec: Executor,
  options: { since?: Date | undefined } = {},
): Promise<KudosTotal[]> {
  const filters = [];
  if (options.since) filters.push(gte(kudos.createdAt, options.since));

  const rows = await exec
    .select({ userId: kudos.toUserId, received: count() })
    .from(kudos)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .groupBy(kudos.toUserId)
    .orderBy(desc(count()));

  return rows.map((r) => ({ userId: r.userId, received: Number(r.received) }));
}

/* -------------------------------------------------------------------------- */
/* Activity feed                                                               */
/* -------------------------------------------------------------------------- */

export interface ListActivityOptions {
  limit: number;
  cursor?: Cursor | undefined;
  actorId?: string | undefined;
  /** Prefix match is intentional: `task.` returns every task event. */
  verb?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export async function listActivity(
  exec: Executor,
  options: ListActivityOptions,
): Promise<ActivityLogRow[]> {
  const filters = [];
  if (options.actorId) filters.push(eq(activityLog.actorId, options.actorId));
  if (options.entityType) filters.push(eq(activityLog.entityType, options.entityType));
  if (options.entityId) filters.push(eq(activityLog.entityId, options.entityId));
  if (options.from) filters.push(gte(activityLog.createdAt, options.from));
  if (options.to) filters.push(lte(activityLog.createdAt, options.to));
  if (options.verb) {
    filters.push(
      options.verb.endsWith('.')
        ? sql`${activityLog.verb} like ${`${options.verb}%`}`
        : eq(activityLog.verb, options.verb),
    );
  }
  if (options.cursor) {
    const { createdAt, id } = options.cursor;
    const predicate = or(
      lt(activityLog.createdAt, createdAt),
      and(eq(activityLog.createdAt, createdAt), lt(activityLog.id, id)),
    );
    if (predicate) filters.push(predicate);
  }

  return exec
    .select()
    .from(activityLog)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(options.limit);
}
