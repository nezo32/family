import { eq, inArray, sql } from 'drizzle-orm';

import type {
  ActivityItem,
  CreatePost,
  KudosCreate,
  KudosResponse,
  ListActivityQuery,
  ListPostsQuery,
  PostResponse,
  UpdatePost,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import type { Db, Executor } from '../../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { enqueue } from '../../core/queue/queues.js';
import { kudos, type KudosRow } from '../chores/chores.schema.js';
import { users } from '../identity/users.schema.js';
import { notificationIntents } from '../notifications/notifications.schema.js';
import { recordActivityEvent } from './activity.service.js';
import { deleteCommentsFor } from './comments.service.js';
import * as repo from './wall.repository.js';
import type { ActivityLogRow, PostRow } from './wall.schema.js';

/**
 * The family wall: announcements, kudos and the merged timeline.
 *
 * The product reason this module exists at all: an app that contains only
 * obligations reads as a work tracker and the teenagers leave first.
 * Recognition (kudos) and shared decisions (polls) are the loop that makes
 * somebody open the app voluntarily. It is **not** a chat — we do not compete
 * with Telegram, so there are no threads, no typing indicators and no DMs.
 */

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

export function isPinned(post: Pick<PostRow, 'pinnedUntil'>, now: Date = new Date()): boolean {
  return post.pinnedUntil !== null && post.pinnedUntil.getTime() > now.getTime();
}

export function toPostResponse(
  row: PostRow,
  commentCount: number,
  reactions: PostResponse['reactions'],
  now: Date = new Date(),
): PostResponse {
  return {
    id: row.id,
    authorId: row.authorId,
    type: row.type,
    title: row.title,
    body: row.body,
    pinnedUntil: row.pinnedUntil ? row.pinnedUntil.toISOString() : null,
    isPinned: isPinned(row, now),
    commentCount,
    reactions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toActivityItem(row: ActivityLogRow): ActivityItem {
  return {
    id: row.id,
    actorId: row.actorId,
    verb: row.verb,
    entityType: row.entityType,
    entityId: row.entityId,
    summary: row.summary,
    metadata: row.metadata,
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

/**
 * Hydrates a page of posts with comment counts and reaction summaries.
 *
 * Two extra queries for the whole page — never one per row. This is the reason
 * `countComments` and `loadReactions` take an array of ids.
 */
export async function hydratePosts(
  exec: Executor,
  rows: readonly PostRow[],
  viewerId: string,
  now: Date = new Date(),
): Promise<PostResponse[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [counts, facts] = await Promise.all([
    repo.countComments(exec, 'post', ids),
    repo.loadReactions(exec, 'post', ids),
  ]);
  const summaries = repo.buildReactionSummaries(facts, viewerId);
  return rows.map((row) =>
    toPostResponse(row, repo.commentCountOf(counts, row.id), summaries.get(row.id) ?? [], now),
  );
}

/* -------------------------------------------------------------------------- */
/* Notification intents (D10)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Writes an intent row and asks the notifications worker to fan it out.
 *
 * Two independent idempotency guards, because both halves can be retried:
 * `dedupeKey` collapses duplicate rows at the database, and the BullMQ `jobId`
 * collapses duplicate dispatch jobs. A retried request therefore notifies the
 * family exactly once.
 *
 * Enqueueing is deliberately fail-soft: Redis being down must not turn a posted
 * announcement into a 500. The row is already committed, and the maintenance
 * sweep re-dispatches undelivered intents.
 */
async function emitIntent(
  exec: Executor,
  intent: {
    type: 'announcement_posted' | 'kudos_received';
    actorId: string | null;
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
    dedupeKey: string;
    priority?: 'low' | 'normal' | 'high';
  },
): Promise<void> {
  const [row] = await exec
    .insert(notificationIntents)
    .values({
      type: intent.type,
      actorId: intent.actorId,
      entityType: intent.entityType,
      entityId: intent.entityId,
      payload: intent.payload,
      dedupeKey: intent.dedupeKey,
      priority: intent.priority ?? 'normal',
    })
    // The dedupe index is **partial** (`where dedupe_key is not null`), so the
    // predicate has to be repeated here or Postgres refuses to match it.
    .onConflictDoNothing({
      target: notificationIntents.dedupeKey,
      where: sql`${notificationIntents.dedupeKey} is not null`,
    })
    .returning({ id: notificationIntents.id });

  // Lost the dedupe race: somebody already created this intent, and the job for
  // it is already queued. Nothing to do.
  if (!row) return;

  try {
    await enqueue(
      'notification.dispatch',
      { intentId: row.id },
      { jobId: `notification.dispatch:${row.id}` },
    );
  } catch (error) {
    console.error('failed to enqueue notification.dispatch', {
      intentId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Announcements                                                               */
/* -------------------------------------------------------------------------- */

/** A short, safe headline for the activity feed when a post has no title. */
export function postHeadline(post: { title?: string | null; body: string }): string {
  const title = post.title?.trim();
  if (title) return title;
  const firstLine = post.body.trim().split('\n')[0]?.trim() ?? '';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
}

export async function createAnnouncement(
  db: Db,
  auth: AuthContext,
  input: CreatePost,
): Promise<PostResponse> {
  if (!auth.can('post:create')) throw forbidden('Missing permission: post:create');

  const pinnedUntil = input.pinnedUntil ? new Date(input.pinnedUntil) : null;
  if (pinnedUntil && !auth.can('post:pin')) throw forbidden('Missing permission: post:pin');

  const post = await db.transaction(async (tx) => {
    const row = await repo.insertPost(tx, {
      authorId: auth.userId,
      type: 'announcement',
      title: input.title?.trim() ?? null,
      body: input.body.trim(),
      pinnedUntil,
    });

    await recordActivityEvent(tx, {
      actorId: auth.userId,
      actor: { name: auth.displayName },
      verb: 'post.created',
      payload: { title: postHeadline(row) },
      entityType: 'post',
      entityId: row.id,
    });

    await emitIntent(tx, {
      type: 'announcement_posted',
      actorId: auth.userId,
      entityType: 'post',
      entityId: row.id,
      payload: {
        postId: row.id,
        authorName: auth.displayName,
        title: postHeadline(row),
        excerpt: row.body.slice(0, 200),
        pinned: isPinned(row),
      },
      dedupeKey: `announcement_posted:${row.id}`,
    });

    return row;
  });

  return toPostResponse(post, 0, []);
}

/**
 * Editing is scoped exactly like deleting: the author, or a holder of
 * `post:delete:any`. There is no separate `post:update` permission
 * (household.md §1, footnote ¹).
 */
export async function updateAnnouncement(
  db: Db,
  auth: AuthContext,
  postId: string,
  input: UpdatePost,
): Promise<PostResponse> {
  const scope = auth.scopeFor('post:delete');
  if (!scope) throw forbidden('Missing permission: post:delete:own');

  const existing = await repo.findPostById(db, postId);
  if (!existing) throw notFound('Post');
  if (scope === 'own' && existing.authorId !== auth.userId) {
    // The post is readable, the edit is not allowed: 403, not 404 (D4).
    throw forbidden('Missing permission: post:delete:any');
  }
  if (existing.type === 'system') throw badRequest('System posts cannot be edited');

  const patch: repo.PostPatch = {};
  if (input.title !== undefined) patch.title = input.title?.trim() ?? null;
  if (input.body !== undefined) patch.body = input.body.trim();
  if (input.pinnedUntil !== undefined) {
    if (!auth.can('post:pin')) throw forbidden('Missing permission: post:pin');
    patch.pinnedUntil = input.pinnedUntil ? new Date(input.pinnedUntil) : null;
  }

  const updated = Object.keys(patch).length > 0 ? await repo.updatePost(db, postId, patch) : existing;
  if (!updated) throw notFound('Post');
  const [hydrated] = await hydratePosts(db, [updated], auth.userId);
  if (!hydrated) throw notFound('Post');
  return hydrated;
}

/**
 * Pin (or unpin, with `pinnedUntil: null`).
 *
 * Pinning carries an expiry rather than a boolean flag: "закреплено до"
 * self-clears, whereas a flag stays pinned forever because nobody remembers to
 * come back and unpin it.
 */
export async function setPin(
  db: Db,
  auth: AuthContext,
  postId: string,
  pinnedUntil: string | null,
): Promise<PostResponse> {
  if (!auth.can('post:pin')) throw forbidden('Missing permission: post:pin');

  const existing = await repo.findPostById(db, postId);
  if (!existing) throw notFound('Post');

  const until = pinnedUntil ? new Date(pinnedUntil) : null;
  if (until && until.getTime() <= Date.now()) throw badRequest('pinnedUntil must be in the future');

  const updated = await db.transaction(async (tx) => {
    const row = await repo.updatePost(tx, postId, { pinnedUntil: until });
    if (!row) throw notFound('Post');
    if (until) {
      await recordActivityEvent(tx, {
        actorId: auth.userId,
        actor: { name: auth.displayName },
        verb: 'post.pinned',
        payload: { title: postHeadline(row) },
        entityType: 'post',
        entityId: row.id,
      });
    }
    return row;
  });

  const [hydrated] = await hydratePosts(db, [updated], auth.userId);
  if (!hydrated) throw notFound('Post');
  return hydrated;
}

/**
 * Soft delete, plus the polymorphic cleanup the database cannot do for us
 * (household.md §3) — the comments and reactions attached to this post go with
 * it, in the same transaction.
 */
export async function deletePost(db: Db, auth: AuthContext, postId: string): Promise<void> {
  const scope = auth.scopeFor('post:delete');
  if (!scope) throw forbidden('Missing permission: post:delete:own');

  const existing = await repo.findPostById(db, postId);
  if (!existing) throw notFound('Post');
  if (scope === 'own' && existing.authorId !== auth.userId) {
    throw forbidden('Missing permission: post:delete:any');
  }

  await db.transaction(async (tx) => {
    await repo.softDeletePost(tx, postId);
    await deleteCommentsFor(tx, 'post', postId);
  });
}

export async function getPost(db: Db, auth: AuthContext, postId: string): Promise<PostResponse> {
  const row = await repo.findPostById(db, postId);
  if (!row) throw notFound('Post');
  const [hydrated] = await hydratePosts(db, [row], auth.userId);
  if (!hydrated) throw notFound('Post');
  return hydrated;
}

export async function listPosts(
  db: Db,
  auth: AuthContext,
  query: ListPostsQuery,
): Promise<{ items: PostResponse[]; nextCursor: string | null }> {
  const now = new Date();
  const cursor = query.cursor ? repo.decodeCursor(query.cursor) : undefined;

  // Pinned posts are a head block, not part of the stream: keeping them out of
  // the keyset means page 2 does not repeat them.
  const pinned =
    query.pinnedFirst && !cursor ? await repo.listPinnedPosts(db, now) : ([] as PostRow[]);

  const rows = await repo.listPosts(db, {
    limit: query.limit + 1,
    cursor,
    type: query.type,
    authorId: query.authorId,
    excludePinned: query.pinnedFirst,
    now,
  });

  const page = repo.toPage(rows, query.limit);
  const items = await hydratePosts(db, [...pinned, ...page.items], auth.userId, now);
  return { items, nextCursor: page.nextCursor };
}

/* -------------------------------------------------------------------------- */
/* Kudos                                                                       */
/* -------------------------------------------------------------------------- */

/** Postgres `unique_violation`. Exported so the mapping is unit-tested. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/**
 * Give kudos.
 *
 * Uses the `kudos` table owned by the chores module — kudos are peer
 * recognition, deliberately **not** points (D5 warns against a sibling
 * leaderboard), so nothing here touches `points_ledger`.
 *
 * `UNIQUE (from_user_id, occurrence_id, emoji)` makes a double tap a `409`
 * rather than a second row: it is a like, not a tally.
 */
export async function giveKudos(
  db: Db,
  auth: AuthContext,
  input: KudosCreate,
): Promise<KudosResponse> {
  if (!auth.can('kudos:give')) throw forbidden('Missing permission: kudos:give');
  if (input.toUserId === auth.userId) throw badRequest('You cannot give kudos to yourself');

  const [recipient] = await db
    .select({ id: users.id, displayName: users.displayName, status: users.status })
    .from(users)
    .where(eq(users.id, input.toUserId))
    .limit(1);
  if (!recipient || recipient.status !== 'active') throw notFound('User');

  try {
    return await db.transaction(async (tx) => {
      const row = await repo.insertKudos(tx, {
        fromUserId: auth.userId,
        toUserId: input.toUserId,
        occurrenceId: input.occurrenceId ?? null,
        emoji: input.emoji,
        message: input.message?.trim() ?? null,
      });

      await recordActivityEvent(tx, {
        actorId: auth.userId,
        actor: { name: auth.displayName },
        verb: 'kudos.given',
        payload: { toName: recipient.displayName, emoji: row.emoji },
        entityType: 'kudos',
        entityId: row.id,
        metadata: { toUserId: row.toUserId, occurrenceId: row.occurrenceId, emoji: row.emoji },
      });

      await emitIntent(tx, {
        type: 'kudos_received',
        actorId: auth.userId,
        entityType: 'kudos',
        entityId: row.id,
        payload: {
          kudosId: row.id,
          toUserId: row.toUserId,
          fromName: auth.displayName,
          emoji: row.emoji,
          message: row.message,
        },
        dedupeKey: `kudos_received:${row.id}`,
      });

      return toKudosResponse(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('You have already given this kudos', 'ALREADY_EXISTS');
    }
    throw error;
  }
}

export async function listKudos(
  db: Db,
  query: { limit: number; cursor?: string | undefined; toUserId?: string; occurrenceId?: string },
): Promise<{ items: KudosResponse[]; nextCursor: string | null }> {
  const rows = await repo.listKudos(db, {
    limit: query.limit + 1,
    cursor: query.cursor ? repo.decodeCursor(query.cursor) : undefined,
    toUserId: query.toUserId,
    occurrenceId: query.occurrenceId,
  });
  const page = repo.toPage(rows, query.limit);
  return { items: page.items.map(toKudosResponse), nextCursor: page.nextCursor };
}

export interface KudosTotalsRow {
  userId: string;
  displayName: string;
  received: number;
}

/**
 * Per-member kudos totals.
 *
 * Every active member appears, including those with zero: a list that only
 * shows the top few is a leaderboard, which is exactly what D5 says not to
 * build.
 */
export async function kudosTotals(
  db: Db,
  options: { since?: Date } = {},
): Promise<KudosTotalsRow[]> {
  const [totals, members] = await Promise.all([
    repo.kudosTotals(db, { since: options.since }),
    db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.status, 'active')),
  ]);
  const byUser = new Map(totals.map((t) => [t.userId, t.received]));
  return members
    .map((m) => ({ userId: m.id, displayName: m.displayName, received: byUser.get(m.id) ?? 0 }))
    .sort((a, b) => b.received - a.received || a.displayName.localeCompare(b.displayName, 'ru'));
}

/** Kudos received by one member, for their profile card. */
export async function kudosReceivedBy(db: Db, userId: string): Promise<number> {
  const rows = await db.select({ id: kudos.id }).from(kudos).where(eq(kudos.toUserId, userId));
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* Activity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Verb families this caller may not read.
 *
 * The activity feed stores a pre-rendered sentence and a structured payload, so
 * a `goal.contributed` row spells out the amount («Папа пополнил цель „Море“ на
 * 15 000,00 ₽»). Children hold no `goal:*` permission at all (D4), so those rows
 * must never reach them — including the generic `comment.added` rows that point
 * at a goal.
 */
export function deniedVerbPrefixesFor(auth: AuthContext): string[] {
  const denied: string[] = [];
  if (!auth.can('goal:read')) denied.push('goal.');
  return denied;
}

export async function listActivity(
  db: Db,
  auth: AuthContext,
  query: ListActivityQuery,
): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
  const rows = await repo.listActivity(db, {
    deniedVerbPrefixes: deniedVerbPrefixesFor(auth),
    limit: query.limit + 1,
    cursor: query.cursor ? repo.decodeCursor(query.cursor) : undefined,
    actorId: query.actorId,
    verb: query.verb,
    entityType: query.entityType,
    entityId: query.entityId,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
  });
  const page = repo.toPage(rows, query.limit);
  return { items: page.items.map(toActivityItem), nextCursor: page.nextCursor };
}

/* -------------------------------------------------------------------------- */
/* The merged wall feed                                                        */
/* -------------------------------------------------------------------------- */

export type FeedItem =
  | { kind: 'post'; id: string; createdAt: string; post: PostResponse }
  | { kind: 'activity'; id: string; createdAt: string; activity: ActivityItem };

export interface WallFeed {
  /** Live pinned announcements, outside the cursor stream (first page only). */
  pinned: PostResponse[];
  items: FeedItem[];
  nextCursor: string | null;
}

interface MergeCandidate {
  id: string;
  createdAt: Date;
  kind: 'post' | 'activity';
  post?: PostRow;
  activity?: ActivityLogRow;
}

/**
 * Merges two already-sorted descending streams on `(createdAt, id)`. Pure, so
 * the interleaving is testable without a database.
 */
export function mergeStreams(a: MergeCandidate[], b: MergeCandidate[]): MergeCandidate[] {
  const merged = [...a, ...b];
  merged.sort((x, y) => {
    const delta = y.createdAt.getTime() - x.createdAt.getTime();
    return delta !== 0 ? delta : (y.id < x.id ? -1 : y.id > x.id ? 1 : 0);
  });
  return merged;
}

/**
 * The wall: announcements, system posts and the activity feed in one timeline.
 *
 * Each source is over-fetched by `limit + 1` and merged in memory. That is
 * correct because both streams are keyset-ordered on the same
 * `(created_at, id)` key, so the first `limit` merged rows are exactly the
 * first `limit` rows of the union — no `UNION ALL` view, no second sort in
 * Postgres, and each source keeps its own index.
 */
export async function getWallFeed(
  db: Db,
  auth: AuthContext,
  query: { limit: number; cursor?: string | undefined },
): Promise<WallFeed> {
  const now = new Date();
  const cursor = query.cursor ? repo.decodeCursor(query.cursor) : undefined;

  const [pinnedRows, postRows, activityRows] = await Promise.all([
    cursor ? Promise.resolve([] as PostRow[]) : repo.listPinnedPosts(db, now),
    repo.listPosts(db, { limit: query.limit + 1, cursor, excludePinned: true, now }),
    repo.listActivity(db, {
      limit: query.limit + 1,
      cursor,
      deniedVerbPrefixes: deniedVerbPrefixesFor(auth),
    }),
  ]);

  const merged = mergeStreams(
    postRows.map((post) => ({ id: post.id, createdAt: post.createdAt, kind: 'post' as const, post })),
    activityRows.map((activity) => ({
      id: activity.id,
      createdAt: activity.createdAt,
      kind: 'activity' as const,
      activity,
    })),
  );

  const page = repo.toPage(merged, query.limit);

  const postsInPage = page.items
    .map((item) => item.post)
    .filter((row): row is PostRow => row !== undefined);
  const hydrated = await hydratePosts(db, [...pinnedRows, ...postsInPage], auth.userId, now);
  const byId = new Map(hydrated.map((p) => [p.id, p]));

  const items: FeedItem[] = [];
  for (const candidate of page.items) {
    if (candidate.kind === 'post') {
      const post = byId.get(candidate.id);
      if (post) {
        items.push({
          kind: 'post',
          id: candidate.id,
          createdAt: candidate.createdAt.toISOString(),
          post,
        });
      }
    } else if (candidate.activity) {
      items.push({
        kind: 'activity',
        id: candidate.id,
        createdAt: candidate.createdAt.toISOString(),
        activity: toActivityItem(candidate.activity),
      });
    }
  }

  return {
    pinned: pinnedRows
      .map((row) => byId.get(row.id))
      .filter((p): p is PostResponse => p !== undefined),
    items,
    nextCursor: page.nextCursor,
  };
}

/**
 * Resolves display names for a set of user ids — used by other modules that
 * need an `ActivityActor` and only hold an id.
 */
export async function displayNamesFor(
  exec: Executor,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await exec
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, [...userIds]));
  return new Map(rows.map((r) => [r.id, r.displayName]));
}
