import { z } from 'zod';
import {
  activityItemSchema,
  commentListResponseSchema,
  commentResponseSchema,
  idSchema,
  isoDateTimeSchema,
  kudosListResponseSchema,
  kudosResponseSchema,
  pollListResponseSchema,
  pollResponseSchema,
  postResponseSchema,
  publicUserSchema,
  reactionListResponseSchema,
  type CommentListResponse,
  type CommentResponse,
  type CommentableEntityType,
  type CreateComment,
  type CreatePoll,
  type CreatePost,
  type EntityRef,
  type KudosCreate,
  type KudosListResponse,
  type KudosResponse,
  type PollListResponse,
  type PollResponse,
  type PostResponse,
  type PublicUser,
  type ReactionListResponse,
} from '@family/shared';
import { api } from '@/shared/api/client';

/**
 * Typed fetchers and query keys for the wall.
 *
 * Two backend facts shape this file:
 *
 * 1. **Comments and reactions are mounted once per entity type** — there is no
 *    `/:entityType/` wildcard, because a wildcard at the root would swallow
 *    every other module's routes. `ENTITY_SEGMENTS` is the one place that maps
 *    the contract's closed enum onto the URL segment.
 *
 * 2. **The feed cursor is an opaque base64url keyset token.** It is read from
 *    `nextCursor` and handed back verbatim; nothing here ever inspects,
 *    decodes or constructs one.
 *
 * Responses are parsed rather than cast: a contract drift between backend and
 * frontend should fail loudly at the boundary, not as `undefined.map` three
 * components deep.
 */

/* -------------------------------------------------------------------------- */
/* query keys                                                                  */
/* -------------------------------------------------------------------------- */

export type PollStatusFilter = 'all' | 'open' | 'closed';

export const wallKeys = {
  all: ['wall'] as const,
  feed: () => [...wallKeys.all, 'feed'] as const,
  post: (id: string) => [...wallKeys.all, 'post', id] as const,
  comments: (ref: EntityRef) =>
    [...wallKeys.all, 'comments', ref.entityType, ref.entityId] as const,
  reactions: (ref: EntityRef) =>
    [...wallKeys.all, 'reactions', ref.entityType, ref.entityId] as const,
  polls: (status: PollStatusFilter) => [...wallKeys.all, 'polls', status] as const,
  kudos: () => [...wallKeys.all, 'kudos'] as const,
  kudosTotals: (sinceDays: number) => [...wallKeys.all, 'kudos', 'totals', sinceDays] as const,
  members: () => [...wallKeys.all, 'members'] as const,
};

/* -------------------------------------------------------------------------- */
/* the feed envelope                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/wall/feed`. The envelope itself is not exported from
 * `@family/shared` — it is assembled in `wall.routes.ts` out of schemas that
 * are — so it is composed here from the shared parts rather than redeclared.
 *
 * `pinned` is served **outside** the cursor stream so page 2 never repeats a
 * pinned announcement.
 */
export const wallFeedItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('post'),
    id: idSchema,
    createdAt: isoDateTimeSchema,
    post: postResponseSchema,
  }),
  z.object({
    kind: z.literal('activity'),
    id: idSchema,
    createdAt: isoDateTimeSchema,
    activity: activityItemSchema,
  }),
]);
export type WallFeedItem = z.infer<typeof wallFeedItemSchema>;

export const wallFeedPageSchema = z.object({
  pinned: z.array(postResponseSchema),
  items: z.array(wallFeedItemSchema),
  nextCursor: z.string().nullable(),
});
export type WallFeedPage = z.infer<typeof wallFeedPageSchema>;

export const kudosTotalsSchema = z.object({
  items: z.array(
    z.object({
      userId: idSchema,
      displayName: z.string(),
      received: z.number().int().min(0),
    }),
  ),
});
export type KudosTotals = z.infer<typeof kudosTotalsSchema>;
export type KudosTotal = KudosTotals['items'][number];

/** The roster serves either projection; the public one is the common subset. */
const memberRosterSchema = z.object({
  items: z.array(publicUserSchema),
});

/* -------------------------------------------------------------------------- */
/* entity segments                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Contract enum to URL segment. Comments and reactions live under the target's
 * own collection: `/api/posts/:id/comments`, `/api/tasks/:id/reactions`.
 */
export const ENTITY_SEGMENTS: Record<CommentableEntityType, string> = {
  post: 'posts',
  task: 'tasks',
  event: 'events',
  goal: 'goals',
  poll: 'polls',
};

export function entityPath(ref: EntityRef, suffix: string): string {
  return `/${ENTITY_SEGMENTS[ref.entityType]}/${ref.entityId}/${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* feed                                                                        */
/* -------------------------------------------------------------------------- */

export async function fetchWallFeed(
  params: { cursor?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<WallFeedPage> {
  const raw = await api.get<unknown>('/wall/feed', {
    query: { limit: params.limit ?? 20, cursor: params.cursor ?? undefined },
    ...(signal ? { signal } : {}),
  });
  return wallFeedPageSchema.parse(raw);
}

/* -------------------------------------------------------------------------- */
/* announcements                                                               */
/* -------------------------------------------------------------------------- */

export async function createPost(body: CreatePost): Promise<PostResponse> {
  return postResponseSchema.parse(await api.post<unknown>('/wall/posts', body));
}

/** `pinnedUntil: null` unpins. Pins always expire — a boolean would stay forever. */
export async function setPostPin(id: string, pinnedUntil: string | null): Promise<PostResponse> {
  return postResponseSchema.parse(await api.post<unknown>(`/wall/posts/${id}/pin`, { pinnedUntil }));
}

export async function deletePost(id: string): Promise<void> {
  await api.del<unknown>(`/wall/posts/${id}`);
}

/* -------------------------------------------------------------------------- */
/* comments                                                                    */
/* -------------------------------------------------------------------------- */

export async function fetchComments(
  ref: EntityRef,
  params: { cursor?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<CommentListResponse> {
  const raw = await api.get<unknown>(entityPath(ref, 'comments'), {
    query: { order: 'asc', limit: params.limit ?? 30, cursor: params.cursor ?? undefined },
    ...(signal ? { signal } : {}),
  });
  return commentListResponseSchema.parse(raw);
}

export async function createComment(ref: EntityRef, body: CreateComment): Promise<CommentResponse> {
  return commentResponseSchema.parse(await api.post<unknown>(entityPath(ref, 'comments'), body));
}

/** Soft delete server-side; the row simply stops being returned. */
export async function deleteComment(id: string): Promise<void> {
  await api.del<unknown>(`/comments/${id}`);
}

/* -------------------------------------------------------------------------- */
/* reactions                                                                   */
/* -------------------------------------------------------------------------- */

export async function fetchReactions(
  ref: EntityRef,
  signal?: AbortSignal,
): Promise<ReactionListResponse> {
  const raw = await api.get<unknown>(entityPath(ref, 'reactions'), {
    ...(signal ? { signal } : {}),
  });
  return reactionListResponseSchema.parse(raw);
}

/** Idempotent toggle. Answers with the fresh summary, so we never have to guess. */
export async function toggleReaction(ref: EntityRef, emoji: string): Promise<ReactionListResponse> {
  return reactionListResponseSchema.parse(
    await api.post<unknown>(entityPath(ref, 'reactions'), { emoji }),
  );
}

/* -------------------------------------------------------------------------- */
/* kudos                                                                       */
/* -------------------------------------------------------------------------- */

export async function fetchKudosTotals(
  sinceDays: number,
  signal?: AbortSignal,
): Promise<KudosTotals> {
  const raw = await api.get<unknown>('/wall/kudos/totals', {
    query: { sinceDays },
    ...(signal ? { signal } : {}),
  });
  return kudosTotalsSchema.parse(raw);
}

export async function fetchKudos(
  params: { cursor?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<KudosListResponse> {
  const raw = await api.get<unknown>('/wall/kudos', {
    query: { limit: params.limit ?? 20, cursor: params.cursor ?? undefined },
    ...(signal ? { signal } : {}),
  });
  return kudosListResponseSchema.parse(raw);
}

export async function giveKudos(body: KudosCreate): Promise<KudosResponse> {
  return kudosResponseSchema.parse(await api.post<unknown>('/wall/kudos', body));
}

/* -------------------------------------------------------------------------- */
/* polls                                                                       */
/* -------------------------------------------------------------------------- */

export async function fetchPolls(
  params: { status: PollStatusFilter; cursor?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<PollListResponse> {
  const raw = await api.get<unknown>('/wall/polls', {
    query: { status: params.status, limit: params.limit ?? 20, cursor: params.cursor ?? undefined },
    ...(signal ? { signal } : {}),
  });
  return pollListResponseSchema.parse(raw);
}

export async function createPoll(body: CreatePoll): Promise<PollResponse> {
  return pollResponseSchema.parse(await api.post<unknown>('/wall/polls', body));
}

/** Replaces the caller's selection. A closed poll answers `409 CONFLICT`. */
export async function votePoll(id: string, optionIds: string[]): Promise<PollResponse> {
  return pollResponseSchema.parse(await api.post<unknown>(`/wall/polls/${id}/votes`, { optionIds }));
}

/** Closing is one-way; reopening is deliberately not offered. */
export async function closePoll(id: string): Promise<PollResponse> {
  return pollResponseSchema.parse(await api.patch<unknown>(`/wall/polls/${id}`, { close: true }));
}

/* -------------------------------------------------------------------------- */
/* roster                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Names and avatars for the ids that posts, comments, kudos and votes carry.
 * Every role including `guest` holds `member:read`, but the call is still
 * best-effort: a missing roster degrades to a neutral placeholder rather than
 * breaking the feed.
 */
export async function fetchMembers(signal?: AbortSignal): Promise<PublicUser[]> {
  const raw = await api.get<unknown>('/members', { ...(signal ? { signal } : {}) });
  return memberRosterSchema.parse(raw).items;
}
