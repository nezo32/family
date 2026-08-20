import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  notInArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import type { CommentableEntityType, ReactionSummary } from '@family/shared';

import type { Executor } from '../../core/db.js';
import {
  decodeTimestampCursor,
  encodeTimestampCursor,
  toTimestampPage,
  type Timestamped,
  type TimestampCursor,
} from '../../core/pagination.js';

import { badRequest } from '../../core/errors.js';
import { kudos, type KudosRow, type NewKudosRow } from '../chores/chores.schema.js';
import { familySettings, type FamilySettingsRow } from '../identity/identity.schema.js';
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

export type Cursor = TimestampCursor;
export type { Timestamped };

/**
 * Opaque keyset cursor over `(created_at, id)` — `core/pagination.ts`.
 *
 * The codec used to be written out here (and in six other modules) as
 * `base64url("iso|id")` that **threw `400 Malformed cursor`** on anything it
 * could not read. It is the shared `{ v, id }` JSON form now, and a stale
 * cursor quietly restarts at the first page instead of erroring — a bookmarked
 * page-2 link is not the user doing something wrong.
 */
export function encodeCursor(row: Timestamped): string {
  return encodeTimestampCursor(row);
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  return decodeTimestampCursor(raw) ?? undefined;
}

/** Splits an over-fetched `limit + 1` result into a page plus the next cursor. */
export function toPage<T extends Timestamped>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  return toTimestampPage(rows, limit);
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
  /** The wall horizon (§D7.11): only rows created strictly after it. */
  since?: Date | undefined;
  now?: Date;
}

/**
 * Live pinned posts. Small by construction — pins expire (`pinned_until`).
 *
 * `since` is why «Очистить доску» can clear the pins without a destructive
 * write: a pin older than the horizon simply stops being returned, and the
 * undo puts it back. Setting `pinned_until = null` instead would take the
 * expiry date with it and there would be nothing to restore.
 */
export async function listPinnedPosts(
  exec: Executor,
  now: Date = new Date(),
  limit = 20,
  since?: Date,
): Promise<PostRow[]> {
  const filters = [
    isNull(posts.deletedAt),
    isNotNull(posts.pinnedUntil),
    gt(posts.pinnedUntil, now),
  ];
  if (since) filters.push(gt(posts.createdAt, since));
  return exec
    .select()
    .from(posts)
    .where(and(...filters))
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
  if (options.since) filters.push(gt(posts.createdAt, options.since));

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
        ? or(
            gt(comments.createdAt, createdAt),
            and(eq(comments.createdAt, createdAt), gt(comments.id, id)),
          )
        : or(
            lt(comments.createdAt, createdAt),
            and(eq(comments.createdAt, createdAt), lt(comments.id, id)),
          );
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
 *
 * Returns the **ids**, not a count. The count is all the caller used to need;
 * media changed that — a comment's photos hang off the comment's own id, and
 * the only way to detach them in the same transaction is to know which comments
 * were just hit.
 */
export async function softDeleteCommentsFor(
  exec: Executor,
  entityType: string,
  entityId: string,
): Promise<string[]> {
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
  return rows.map((row) => row.id);
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

/**
 * All reaction facts for a page of targets — one query, folded in memory.
 *
 * Ordered by `created_at`, because the summary carries the reactor **ids** now
 * (§D7.7) and the chip draws them as discs: "who reacted first" is a stable,
 * meaningful order that two clients cannot disagree about, and an unordered
 * select would shuffle the faces between refetches.
 */
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
    .where(and(eq(reactions.entityType, entityType), inArray(reactions.entityId, [...entityIds])))
    .orderBy(asc(reactions.createdAt), asc(reactions.id));
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
  const byEntity = new Map<string, Map<string, { userIds: string[]; reacted: boolean }>>();

  for (const fact of facts) {
    let entity = byEntity.get(fact.entityId);
    if (!entity) {
      entity = new Map();
      byEntity.set(fact.entityId, entity);
    }
    const current = entity.get(fact.emoji) ?? { userIds: [], reacted: false };
    // The unique index makes a duplicate impossible, but folding defensively
    // costs nothing and keeps the discs honest if it ever stops being true.
    if (!current.userIds.includes(fact.userId)) current.userIds.push(fact.userId);
    if (fact.userId === viewerId) current.reacted = true;
    entity.set(fact.emoji, current);
  }

  const result = new Map<string, ReactionSummary[]>();
  for (const [entityId, emojis] of byEntity) {
    const summaries = [...emojis.entries()]
      .map(([emoji, agg]) => ({
        emoji,
        count: agg.userIds.length,
        reacted: agg.reacted,
        // The faces. `count` is `userIds.length` and stays in the contract for
        // non-UI consumers; Стена draws these and never the digit (§D7.7).
        userIds: agg.userIds,
      }))
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
  /**
   * The wall horizon (§D7.11). Deliberately **not** applied to open polls by
   * the feed: a clear collapses the wall to exactly what still needs
   * answering, so it must never silently cancel a question nobody answered.
   */
  since?: Date | undefined;
  now?: Date;
}

export async function listPolls(exec: Executor, options: ListPollsOptions): Promise<PollRow[]> {
  const now = options.now ?? new Date();
  const filters = [];

  if (options.status === 'open') {
    const open = and(isNull(polls.closedAt), or(isNull(polls.closesAt), gt(polls.closesAt, now)));
    if (open) filters.push(open);
  } else if (options.status === 'closed') {
    const closed = or(isNotNull(polls.closedAt), lte(polls.closesAt, now));
    if (closed) filters.push(closed);
  }

  if (options.since) filters.push(gt(polls.createdAt, options.since));

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
  return exec
    .select()
    .from(pollVotes)
    .where(inArray(pollVotes.pollId, [...pollIds]));
}

export async function deleteVotesOf(tx: Executor, pollId: string, userId: string): Promise<number> {
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
  /** The wall horizon (§D7.11) — feed visibility only; nothing is un-thanked. */
  since?: Date | undefined;
}

export async function listKudos(exec: Executor, options: ListKudosOptions): Promise<KudosRow[]> {
  const filters = [];
  if (options.since) filters.push(gt(kudos.createdAt, options.since));
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
  /** Verb prefixes the caller may not see, e.g. `['goal.']`. */
  deniedVerbPrefixes?: string[];
  limit: number;
  cursor?: Cursor | undefined;
  actorId?: string | undefined;
  /** Prefix match is intentional: `task.` returns every task event. */
  verb?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  /**
   * The wall horizon (§D7.11). Applied by the **feed** only: `/activity` is
   * the family's own log and other modules read it, so clearing the wall
   * hides activity from Стена without touching the log itself.
   */
  since?: Date | undefined;
  /** Exact verbs to leave out — see the note in the query below. */
  excludeVerbs?: readonly string[] | undefined;
}

export async function listActivity(
  exec: Executor,
  options: ListActivityOptions,
): Promise<ActivityLogRow[]> {
  const filters = [];
  if (options.since) filters.push(gt(activityLog.createdAt, options.since));
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
  /**
   * Verb families the caller may not read, excluded in SQL rather than after
   * the fact so the page size and cursor stay honest. A `goal.*` summary bakes
   * the amount into its frozen Russian sentence and copies it into `metadata`,
   * so letting one row through is a finance disclosure.
   */
  /**
   * Verbs the **feed** already draws as a card of their own.
   *
   * `/activity` is unaffected — it is the family's own log and other modules
   * read it. But once a post, a poll and a kudos are each a card in the
   * stream (§D7.13 gaps 1 and 3), their activity rows say the same thing a
   * second time, 40px below the thing they describe: «Благодарность 🙏: Мама
   * → Лиза» directly under the Спасибо card that already draws both people.
   */
  if (options.excludeVerbs && options.excludeVerbs.length > 0) {
    filters.push(notInArray(activityLog.verb, [...options.excludeVerbs]));
  }

  for (const prefix of options.deniedVerbPrefixes ?? []) {
    filters.push(sql`${activityLog.verb} not like ${`${prefix}%`}`);
    // ...and the generic verbs that merely *point* at a denied entity.
    filters.push(
      sql`not (${activityLog.entityType} = ${prefix.replace(/\.$/, '')} and ${activityLog.verb} = 'comment.added')`,
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

/* -------------------------------------------------------------------------- */
/* The wall horizon — «Очистить доску» (§D7.11)                                */
/* -------------------------------------------------------------------------- */

/**
 * Clearing the wall is a **horizon, not a delete**: `family_settings`
 * (the singleton family row, D1) carries `wall_cleared_at`, and the feed
 * returns only rows created after it. Nothing is destroyed — no post, no
 * comment, no reaction, no kudos, no poll, no activity row.
 *
 * The table belongs to the identity module, so this reads its **schema**
 * directly rather than calling its repository (D8, and exactly what
 * `comments.service.ts` does for tasks, events and goals).
 */
export async function getFamilySettingsRow(exec: Executor): Promise<FamilySettingsRow> {
  const [existing] = await exec.select().from(familySettings).limit(1);
  if (existing) return existing;

  // The singleton carries a unique index plus a CHECK, so this insert races
  // harmlessly: whoever loses simply re-reads the winner's row.
  await exec
    .insert(familySettings)
    .values({ singleton: true })
    .onConflictDoNothing({ target: familySettings.singleton });

  const [created] = await exec.select().from(familySettings).limit(1);
  if (!created) throw badRequest('family_settings singleton could not be created');
  return created;
}

/** `null` when the wall has never been cleared, which is the common case. */
export async function getWallHorizon(exec: Executor): Promise<Date | null> {
  const [row] = await exec
    .select({ at: familySettings.wallClearedAt })
    .from(familySettings)
    .limit(1);
  return row?.at ?? null;
}

/** Writes the horizon. `null` is a legitimate value — it is what undo restores. */
export async function setWallHorizon(
  exec: Executor,
  settingsId: string,
  at: Date | null,
): Promise<void> {
  await exec
    .update(familySettings)
    .set({ wallClearedAt: at, updatedAt: new Date() })
    .where(eq(familySettings.id, settingsId));
}

/**
 * Stamps the horizon from the **database** clock and hands the value back.
 *
 * This is not a nicety. Every `created_at` on this wall is written by Postgres
 * (`defaultNow()`), while `new Date()` is the API process's clock, and the two
 * are not the same clock: measured on this machine, Postgres runs ~240 ms
 * ahead of Node. A horizon taken from the app clock therefore left rows the
 * user had just watched disappear *still on the wall*, because their
 * `created_at` was a quarter of a second "in the future" — a clear that looks
 * broken, non-deterministically, and only for whatever was posted in the last
 * few hundred milliseconds. Inside a transaction `now()` is the transaction's
 * start time, so the marker post stamped one millisecond later survives it.
 */
export async function setWallHorizonNow(exec: Executor, settingsId: string): Promise<Date> {
  const [row] = await exec
    .update(familySettings)
    .set({ wallClearedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(familySettings.id, settingsId))
    .returning({ at: familySettings.wallClearedAt });
  if (!row?.at) throw badRequest('family_settings horizon write returned no row');
  return row.at;
}
