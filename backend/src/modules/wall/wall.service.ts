import { eq, inArray } from 'drizzle-orm';

import type {
  ActivityItem,
  CreatePost,
  KudosCreate,
  KudosFeedItem,
  KudosResponse,
  ListActivityQuery,
  ListPostsQuery,
  PollResponse,
  PostResponse,
  UpdatePost,
  WallClearResponse,
  WallFeedItem,
  WallRestore,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import type { Db, Executor } from '../../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { kudos, type KudosRow } from '../chores/chores.schema.js';
import { users } from '../identity/users.schema.js';
import { dispatchAfterCommit, emitIntent } from '../notifications/notifications.service.js';
import { recordActivityEvent } from './activity.service.js';
import { deleteCommentsFor } from './comments.service.js';
import { hydratePolls } from './polls.service.js';
import * as repo from './wall.repository.js';
import type { ActivityLogRow, PollRow, PostRow } from './wall.schema.js';

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

  const { post, dispatch } = await db.transaction(async (tx) => {
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

    // An announcement is addressed to the household by name. The fan-out still
    // drops anyone without `post:create`/`member:read`, and the author never
    // receives their own post.
    const intent = await emitIntent(tx, {
      type: 'announcement_posted',
      audience: { everyone: true },
      actorId: auth.userId,
      entityType: 'post',
      entityId: row.id,
      payload: {
        postId: row.id,
        actorName: auth.displayName,
        authorName: auth.displayName,
        title: postHeadline(row),
        excerpt: row.body.slice(0, 200),
        pinned: isPinned(row),
      },
      dedupeKey: `announcement_posted:${row.id}`,
    });

    return { post: row, dispatch: intent.dispatch };
  });

  await dispatchAfterCommit([dispatch]);
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

  const updated =
    Object.keys(patch).length > 0 ? await repo.updatePost(db, postId, patch) : existing;
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
 * recognition and nothing more (D5 warns against a sibling leaderboard):
 * nothing accumulates, and there is no ledger left to touch.
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
    const { response, dispatch } = await db.transaction(async (tx) => {
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

      /**
       * **Exactly one recipient.** This used to omit `audience` entirely, which
       * the column defaults to `{}` — and `{}` parses as `{ everyone: true }`.
       * `kudos_received` also requires no permission, so nothing downstream
       * narrowed it: every «спасибо» pushed «Спасибо от семьи» at the whole
       * household, each of whom was told *they* had been thanked.
       */
      const intent = await emitIntent(tx, {
        type: 'kudos_received',
        audience: { users: [row.toUserId] },
        actorId: auth.userId,
        entityType: 'kudos',
        entityId: row.id,
        payload: {
          kudosId: row.id,
          toUserId: row.toUserId,
          actorName: auth.displayName,
          fromName: auth.displayName,
          emoji: row.emoji,
          message: row.message,
        },
        dedupeKey: `kudos_received:${row.id}`,
      });

      return { response: toKudosResponse(row), dispatch: intent.dispatch };
    });

    await dispatchAfterCommit([dispatch]);
    return response;
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
/* The merged wall feed (§D7)                                                  */
/* -------------------------------------------------------------------------- */

export type FeedItem = WallFeedItem;

export interface WallFeed {
  /** Live pinned announcements, outside the cursor stream (first page only). */
  pinned: PostResponse[];
  /**
   * Open polls, outside the cursor stream (first page only).
   *
   * A card is never in two places (§D7.4): an open poll is in the head or
   * nowhere, and when it closes it leaves the head and takes its chronological
   * position in `items` — which may be far down, which is what «Что решили» is
   * for.
   */
  openPolls: PollResponse[];
  items: WallFeedItem[];
  nextCursor: string | null;
  /** The «Очистить доску» horizon, echoed so the client can explain an empty wall. */
  clearedAt: string | null;
}

interface MergeCandidate {
  id: string;
  createdAt: Date;
  kind: 'post' | 'activity' | 'poll' | 'kudos';
  post?: PostRow;
  activity?: ActivityLogRow;
  poll?: PollRow;
  kudos?: KudosRow;
}

/**
 * Merges already-sorted descending streams on `(createdAt, id)`. Pure, so the
 * interleaving is testable without a database. Variadic because the stream has
 * four sources now — posts, activity, closed polls and kudos — and a fold of
 * pairwise merges would sort the same rows three times.
 */
export function mergeStreams(...streams: MergeCandidate[][]): MergeCandidate[] {
  const merged = streams.flat();
  merged.sort((x, y) => {
    const delta = y.createdAt.getTime() - x.createdAt.getTime();
    return delta !== 0 ? delta : y.id < x.id ? -1 : y.id > x.id ? 1 : 0;
  });
  return merged;
}

/** A member who no longer exists. Never an id, never an empty name. */
const UNKNOWN_MEMBER_RU = 'Участник';

/**
 * Hydrates a page of kudos into feed cards.
 *
 * The recipient's display name rides on the card because the card *is* the
 * record — «(П) Павел сказал спасибо · (Л) Лизе» — and the client's roster is
 * a best-effort query that may be missing. Comment counts and reaction faces
 * come from the same polymorphic tables everything else uses; `kudos` joined
 * `COMMENTABLE_ENTITY_TYPES` for exactly this card (§D7.6).
 */
export async function hydrateKudos(
  exec: Executor,
  rows: readonly KudosRow[],
  viewerId: string,
): Promise<KudosFeedItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [counts, facts, names] = await Promise.all([
    repo.countComments(exec, 'kudos', ids),
    repo.loadReactions(exec, 'kudos', ids),
    displayNamesFor(
      exec,
      rows.map((r) => r.toUserId),
    ),
  ]);
  const summaries = repo.buildReactionSummaries(facts, viewerId);
  return rows.map((row) => ({
    ...toKudosResponse(row),
    toDisplayName: names.get(row.toUserId) ?? UNKNOWN_MEMBER_RU,
    commentCount: repo.commentCountOf(counts, row.id),
    reactions: summaries.get(row.id) ?? [],
  }));
}

/**
 * Activity verbs the feed now draws as a **card**, so their log rows must not
 * also appear as a digest line (§D7.6).
 *
 * Found by driving the built app rather than by reading the spec: with kudos
 * and polls as feed items, «Благодарность 🙏: Мама → Лиза» rendered 40px under
 * the Спасибо card that already draws both people, and «Мама повесила
 * объявление „…“» under the announcement itself. The activity layer is "a
 * scribble in the margin" for things that have **no** card; a scribble
 * repeating the card above it is the feed telling you the same thing twice.
 *
 * `/activity` keeps every row: it is the family's own log, and other modules
 * read it.
 */
const VERBS_WITH_THEIR_OWN_CARD = [
  'post.created',
  'post.pinned',
  'poll.created',
  'poll.closed',
  'kudos.given',
] as const;

/**
 * How many open polls the head may carry.
 *
 * The head itself is capped at five cards on the **client** (§D7.4) — a head
 * that fills the first viewport has become a section with the label filed off.
 * This bound is the transport's own sanity limit, not the design rule.
 */
const HEAD_POLL_LIMIT = 20;

/**
 * Стена, as one continuous stream (§D7).
 *
 * Four sources — announcements and system posts, the activity log, **closed**
 * polls and kudos — are each over-fetched by `limit + 1` and merged in memory.
 * That is correct because every source is keyset-ordered on the same
 * `(created_at, id)` key, so the first `limit` merged rows are exactly the
 * first `limit` rows of the union: no `UNION ALL` view, no second sort in
 * Postgres, and each source keeps its own index.
 *
 * Two collections ride **outside** the cursor stream and are served on the
 * first page only — live pins and open polls. They are the feed's head: they
 * do not move as the feed grows, they are never repeated on page two, and
 * neither of them ever appears in `items` as well (§D7.4).
 *
 * Everything except open polls is filtered by the «Очистить доску» horizon
 * (§D7.11). Open polls are exempt on purpose: a clear collapses the wall to
 * exactly what still needs answering, and it must not silently cancel a
 * question nobody has answered yet.
 */
export async function getWallFeed(
  db: Db,
  auth: AuthContext,
  query: { limit: number; cursor?: string | undefined },
): Promise<WallFeed> {
  const now = new Date();
  const cursor = query.cursor ? repo.decodeCursor(query.cursor) : undefined;
  const horizon = await repo.getWallHorizon(db);
  const since = horizon ?? undefined;
  const firstPage = cursor === undefined;

  const [pinnedRows, openPollRows, postRows, activityRows, closedPollRows, kudosRows] =
    await Promise.all([
      firstPage ? repo.listPinnedPosts(db, now, 20, since) : Promise.resolve([] as PostRow[]),
      firstPage
        ? repo.listPolls(db, { limit: HEAD_POLL_LIMIT, status: 'open', now })
        : Promise.resolve([] as PollRow[]),
      repo.listPosts(db, { limit: query.limit + 1, cursor, excludePinned: true, since, now }),
      repo.listActivity(db, {
        limit: query.limit + 1,
        cursor,
        since,
        excludeVerbs: VERBS_WITH_THEIR_OWN_CARD,
        deniedVerbPrefixes: deniedVerbPrefixesFor(auth),
      }),
      repo.listPolls(db, { limit: query.limit + 1, cursor, status: 'closed', since, now }),
      repo.listKudos(db, { limit: query.limit + 1, cursor, since }),
    ]);

  const merged = mergeStreams(
    postRows.map((post) => ({
      id: post.id,
      createdAt: post.createdAt,
      kind: 'post' as const,
      post,
    })),
    activityRows.map((activity) => ({
      id: activity.id,
      createdAt: activity.createdAt,
      kind: 'activity' as const,
      activity,
    })),
    closedPollRows.map((poll) => ({
      id: poll.id,
      createdAt: poll.createdAt,
      kind: 'poll' as const,
      poll,
    })),
    kudosRows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      kind: 'kudos' as const,
      kudos: row,
    })),
  );

  const page = repo.toPage(merged, query.limit);

  const postsInPage = page.items
    .map((item) => item.post)
    .filter((row): row is PostRow => row !== undefined);
  const pollsInPage = page.items
    .map((item) => item.poll)
    .filter((row): row is PollRow => row !== undefined);
  const kudosInPage = page.items
    .map((item) => item.kudos)
    .filter((row): row is KudosRow => row !== undefined);

  const [hydratedPosts, hydratedPolls, hydratedKudos] = await Promise.all([
    hydratePosts(db, [...pinnedRows, ...postsInPage], auth.userId, now),
    hydratePolls(db, [...openPollRows, ...pollsInPage], auth.userId, now),
    hydrateKudos(db, kudosInPage, auth.userId),
  ]);

  const postById = new Map(hydratedPosts.map((p) => [p.id, p]));
  const pollById = new Map(hydratedPolls.map((p) => [p.id, p]));
  const kudosById = new Map(hydratedKudos.map((k) => [k.id, k]));

  const items: WallFeedItem[] = [];
  for (const candidate of page.items) {
    const createdAt = candidate.createdAt.toISOString();
    if (candidate.kind === 'post') {
      const post = postById.get(candidate.id);
      if (post) items.push({ kind: 'post', id: candidate.id, createdAt, post });
    } else if (candidate.kind === 'poll') {
      const poll = pollById.get(candidate.id);
      if (poll) items.push({ kind: 'poll', id: candidate.id, createdAt, poll });
    } else if (candidate.kind === 'kudos') {
      const card = kudosById.get(candidate.id);
      if (card) items.push({ kind: 'kudos', id: candidate.id, createdAt, kudos: card });
    } else if (candidate.activity) {
      items.push({
        kind: 'activity',
        id: candidate.id,
        createdAt,
        activity: toActivityItem(candidate.activity),
      });
    }
  }

  return {
    pinned: pinnedRows
      .map((row) => postById.get(row.id))
      .filter((p): p is PostResponse => p !== undefined),
    openPolls: openPollRows
      .map((row) => pollById.get(row.id))
      .filter((p): p is PollResponse => p !== undefined),
    items,
    nextCursor: page.nextCursor,
    clearedAt: horizon ? horizon.toISOString() : null,
  };
}

/* -------------------------------------------------------------------------- */
/* «Очистить доску» — a horizon, not a delete (§D7.11)                         */
/* -------------------------------------------------------------------------- */

/** «20 августа» — the day and the month, in the family's own timezone. */
export function formatDayMonthRu(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone }).format(at);
}

/** The floor the feed draws after a clear. */
export function wallClearedBody(day: string): string {
  return `Доску очистили ${day}`;
}

/**
 * Clear the wall.
 *
 * **Nothing is deleted.** One column on the singleton family row moves, the
 * feed stops returning rows older than it, and every post, comment, reaction,
 * kudos, poll and activity row stays exactly where it was. Live pins clear
 * (they are older than the horizon); open polls stay (the feed exempts them).
 *
 * The clear writes **one system post**, stamped just after the horizon so it
 * survives it. That card is then the oldest thing in the feed and it is the
 * line «Что было раньше» used to draw — a family member opening the app after
 * a clear finds an explanation rather than an amnesia.
 *
 * `settings:manage`, not `post:delete:any` (§D7.11): moderating one note
 * somebody wrote is a different thing from resetting what six people see, and
 * the horizon lives on the family settings row (D1).
 */
export async function clearWall(db: Db, auth: AuthContext): Promise<WallClearResponse> {
  if (!auth.can('settings:manage')) throw forbidden('Missing permission: settings:manage');

  return db.transaction(async (tx) => {
    const settings = await repo.getFamilySettingsRow(tx);

    // The database's clock, not this process's — see `setWallHorizonNow`. Every
    // `created_at` on the wall is written by Postgres, and the two clocks drift.
    const clearedAt = await repo.setWallHorizonNow(tx, settings.id);

    // One millisecond after the horizon, because the feed's predicate is
    // strictly `created_at > cleared_at`. The row has to survive the line it
    // announces.
    const marker = await repo.insertPost(tx, {
      authorId: null,
      type: 'system',
      title: null,
      body: wallClearedBody(formatDayMonthRu(clearedAt, settings.timezone)),
      pinnedUntil: null,
      createdAt: new Date(clearedAt.getTime() + 1),
    });

    return {
      clearedAt: clearedAt.toISOString(),
      previousClearedAt: settings.wallClearedAt ? settings.wallClearedAt.toISOString() : null,
      systemPostId: marker.id,
    };
  });
}

/**
 * Undo, for the six seconds the toast is on screen (§G4).
 *
 * Puts the previous horizon back — `null` included, which is "the wall was
 * never cleared" — and soft-deletes the marker post, so an undone clear leaves
 * no trace of itself on a wall that is whole again.
 */
export async function restoreWall(db: Db, auth: AuthContext, input: WallRestore): Promise<void> {
  if (!auth.can('settings:manage')) throw forbidden('Missing permission: settings:manage');

  await db.transaction(async (tx) => {
    const settings = await repo.getFamilySettingsRow(tx);
    await repo.setWallHorizon(tx, settings.id, input.clearedAt ? new Date(input.clearedAt) : null);
    if (input.systemPostId) await repo.softDeletePost(tx, input.systemPostId);
  });
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
