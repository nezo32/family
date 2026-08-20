import { z } from 'zod';

import { kudosResponseSchema } from './chores.js';
import {
  cursorPaginationSchema,
  idSchema,
  isoDateTimeSchema,
  nonEmptyString,
  paginatedSchema,
  queryBooleanSchema,
} from './common.js';

/**
 * Family wall: announcements, polymorphic comments and reactions, polls, and
 * the activity feed.
 *
 * `comments` and `reactions` address their target as `(entityType, entityId)`,
 * so the same endpoints serve tasks, events and goals. The database cannot
 * enforce that pointer (see `wall.schema.ts`), which is why `entityType` is a
 * closed enum **here** — the contract is the integrity boundary.
 */

/**
 * `kudos` joined this enum with the feed (§D7.6, «Спасибо» as a card): a
 * thank-you is now a card in the stream with the common foot line, and the
 * common foot line is reactions plus a thread. Adding the member here is the
 * whole change — the generic comment/reaction endpoints are mounted once per
 * entry, and `comments.service.ts` gains the matching access resolver.
 */
export const COMMENTABLE_ENTITY_TYPES = ['post', 'task', 'event', 'goal', 'poll', 'kudos'] as const;
export const entityTypeSchema = z.enum(COMMENTABLE_ENTITY_TYPES);
export type CommentableEntityType = z.infer<typeof entityTypeSchema>;

export const entityRefSchema = z.object({
  entityType: entityTypeSchema,
  entityId: idSchema,
});
export type EntityRef = z.infer<typeof entityRefSchema>;

export const postTypeSchema = z.enum(['announcement', 'system']);
export type PostType = z.infer<typeof postTypeSchema>;

/* -------------------------------------------------------------------------- */
/* Posts                                                                       */
/* -------------------------------------------------------------------------- */

const postWritableFields = z.object({
  title: z.string().trim().max(160).nullish(),
  body: nonEmptyString(8000),
  /**
   * Pinning has an expiry rather than a flag: "закреплено до" self-clears,
   * a boolean stays pinned forever. Requires `post:pin`.
   */
  pinnedUntil: isoDateTimeSchema.nullish(),
});

export const createPostSchema = postWritableFields;
export type CreatePost = z.infer<typeof createPostSchema>;

export const updatePostSchema = postWritableFields.partial();
export type UpdatePost = z.infer<typeof updatePostSchema>;

/**
 * Aggregated reactions for one target.
 *
 * `userIds` is the field the UI actually renders (§D7.7): a reaction is drawn
 * as its emoji plus the **discs of the people who used it**, and no digit
 * appears anywhere — not on the chip, not in a `title`, not in an
 * `aria-label`. Six people in a family is what makes faces fit where a count
 * would otherwise go, and «❤️ 3» sitting 120px above «❤️ 1» in a single-column
 * feed is a comparison the reader performs for free (D5, D13).
 *
 * `count` stays in the contract because it is `userIds.length` and other
 * consumers (the OpenAPI surface, a future digest) may want the scalar. It is
 * **not** a licence to render it on Стена.
 */
export const reactionSummarySchema = z.object({
  emoji: z.string(),
  count: z.number().int().min(0),
  /** Whether the requesting user is one of the reactors. */
  reacted: z.boolean(),
  /** Who reacted, in the order they reacted. The family is small; faces fit. */
  userIds: z.array(idSchema).default([]),
});
export type ReactionSummary = z.infer<typeof reactionSummarySchema>;

export const postResponseSchema = z.object({
  id: idSchema,
  /** `null` => system-generated (goal reached, birthday, weekly digest). */
  authorId: idSchema.nullable(),
  type: postTypeSchema,
  title: z.string().nullable(),
  body: z.string(),
  pinnedUntil: isoDateTimeSchema.nullable(),
  /** `pinnedUntil > now()`, precomputed so every surface agrees on "closed". */
  isPinned: z.boolean(),
  commentCount: z.number().int().min(0),
  reactions: z.array(reactionSummarySchema).default([]),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PostResponse = z.infer<typeof postResponseSchema>;

export const listPostsQuerySchema = cursorPaginationSchema.extend({
  type: postTypeSchema.optional(),
  authorId: idSchema.optional(),
  pinnedFirst: queryBooleanSchema.default(true),
});
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;

export const postListResponseSchema = paginatedSchema(postResponseSchema);
export type PostListResponse = z.infer<typeof postListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Comments (polymorphic)                                                      */
/* -------------------------------------------------------------------------- */

export const createCommentSchema = z.object({
  body: nonEmptyString(4000),
});
export type CreateComment = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = createCommentSchema;
export type UpdateComment = z.infer<typeof updateCommentSchema>;

export const commentResponseSchema = z.object({
  id: idSchema,
  entityType: entityTypeSchema,
  entityId: idSchema,
  authorId: idSchema,
  body: z.string(),
  reactions: z.array(reactionSummarySchema).default([]),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type CommentResponse = z.infer<typeof commentResponseSchema>;

export const listCommentsQuerySchema = cursorPaginationSchema.extend({
  /** Comments read oldest-first; the newest page is the one you scroll to. */
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;

export const commentListResponseSchema = paginatedSchema(commentResponseSchema);
export type CommentListResponse = z.infer<typeof commentListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Reactions                                                                   */
/* -------------------------------------------------------------------------- */

/** A single emoji. Length is generous because one emoji can be several code points. */
export const emojiSchema = z.string().trim().min(1).max(16);

/**
 * Idempotent toggle: adds the reaction if the user has not used that emoji on
 * that target, removes it otherwise. The response is the fresh summary, so the
 * client never has to guess which way the toggle went.
 */
export const toggleReactionSchema = z.object({
  emoji: emojiSchema,
});
export type ToggleReaction = z.infer<typeof toggleReactionSchema>;

export const reactionListResponseSchema = z.object({
  entityType: entityTypeSchema,
  entityId: idSchema,
  reactions: z.array(reactionSummarySchema),
});
export type ReactionListResponse = z.infer<typeof reactionListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Polls                                                                       */
/* -------------------------------------------------------------------------- */

export const createPollSchema = z.object({
  question: nonEmptyString(300),
  options: z.array(nonEmptyString(160)).min(2).max(10),
  closesAt: isoDateTimeSchema.nullish(),
  allowMultiple: z.boolean().default(false),
});
export type CreatePoll = z.infer<typeof createPollSchema>;

export const updatePollSchema = z.object({
  question: nonEmptyString(300).optional(),
  closesAt: isoDateTimeSchema.nullish(),
  /** Closing is one-way; reopening is not offered on purpose. */
  close: z.boolean().optional(),
});
export type UpdatePoll = z.infer<typeof updatePollSchema>;

/**
 * Cast a vote. Single-choice polls must receive exactly one id — that rule is
 * enforced by the **service** (it needs `allow_multiple` from the parent row),
 * not by this schema and not by a DB constraint. Re-voting replaces the
 * caller's previous selection inside one transaction.
 */
export const votePollSchema = z.object({
  optionIds: z.array(idSchema).min(1).max(10),
});
export type VotePoll = z.infer<typeof votePollSchema>;

export const pollOptionResponseSchema = z.object({
  id: idSchema,
  label: z.string(),
  sortOrder: z.number().int(),
  voteCount: z.number().int().min(0),
  /** Voter ids — the family is small and open ballots are the point. */
  voterIds: z.array(idSchema).default([]),
});
export type PollOptionResponse = z.infer<typeof pollOptionResponseSchema>;

export const pollResponseSchema = z.object({
  id: idSchema,
  question: z.string(),
  allowMultiple: z.boolean(),
  closesAt: isoDateTimeSchema.nullable(),
  closedAt: isoDateTimeSchema.nullable(),
  /** `closedAt != null || closesAt <= now()`. */
  isClosed: z.boolean(),
  createdById: idSchema,
  options: z.array(pollOptionResponseSchema),
  totalVoters: z.number().int().min(0),
  /** The option ids the caller picked; empty when they have not voted. */
  myOptionIds: z.array(idSchema).default([]),
  /**
   * Live comment count, for the card's common foot line (§D7.6/D7.8). This is
   * the one number Стена is allowed to draw: it describes the object you are
   * about to open, it is not attached to a person, and nothing sorts by it.
   */
  commentCount: z.number().int().min(0).default(0),
  /** Reactions on the poll itself — «а почему на дачу?» goes in the thread. */
  reactions: z.array(reactionSummarySchema).default([]),
  createdAt: isoDateTimeSchema,
});
export type PollResponse = z.infer<typeof pollResponseSchema>;

export const listPollsQuerySchema = cursorPaginationSchema.extend({
  status: z.enum(['all', 'open', 'closed']).default('all'),
});
export type ListPollsQuery = z.infer<typeof listPollsQuerySchema>;

export const pollListResponseSchema = paginatedSchema(pollResponseSchema);
export type PollListResponse = z.infer<typeof pollListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Activity feed                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One entry of the append-only feed. `summary` is a **pre-rendered Russian
 * sentence** frozen at write time ("Папа выполнил задачу «Вынести мусор»") — it
 * must stay readable after the referenced task is renamed or deleted, so the
 * client renders it verbatim and uses `entityType`/`entityId` only for the link.
 */
export const activityItemSchema = z.object({
  id: idSchema,
  /** `null` => the system acted, or the actor no longer exists. */
  actorId: idSchema.nullable(),
  /** Dotted domain event name: `task.completed`, `goal.reached`, `shopping.bought`. */
  verb: z.string(),
  entityType: z.string().nullable(),
  entityId: idSchema.nullable(),
  summary: z.string(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: isoDateTimeSchema,
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const listActivityQuerySchema = cursorPaginationSchema.extend({
  actorId: idSchema.optional(),
  /** Prefix match is allowed: `task.` returns every task event. */
  verb: z.string().max(64).optional(),
  entityType: z.string().max(32).optional(),
  entityId: idSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>;

export const activityListResponseSchema = paginatedSchema(activityItemSchema);
export type ActivityListResponse = z.infer<typeof activityListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* The wall feed (§D7)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * «Спасибо» as a feed card.
 *
 * A kudos is a note addressed **from** one person **to** another, so the card
 * draws both — which is why the recipient's display name rides on the item
 * rather than being looked up client-side: the roster is a best-effort query
 * that a guest may not get, and «(Л) Лизе» is the whole point of the card.
 */
export const kudosFeedItemSchema = kudosResponseSchema.extend({
  /** The recipient, resolved server-side. Never an id in the UI. */
  toDisplayName: z.string(),
  commentCount: z.number().int().min(0).default(0),
  reactions: z.array(reactionSummarySchema).default([]),
});
export type KudosFeedItem = z.infer<typeof kudosFeedItemSchema>;

/**
 * One card in the stream.
 *
 * Four kinds, one clock. `post` and `activity` were the original union;
 * `poll` and `kudos` joined it so that a closed poll can take its
 * chronological place and a thank-you can be a card instead of a roster chip
 * (§D7.13 gaps 1 and 3). **Open** polls and **live** pins never appear here —
 * they are served in the head, so a card is never in two places (§D7.4).
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
  z.object({
    kind: z.literal('poll'),
    id: idSchema,
    createdAt: isoDateTimeSchema,
    poll: pollResponseSchema,
  }),
  z.object({
    kind: z.literal('kudos'),
    id: idSchema,
    createdAt: isoDateTimeSchema,
    kudos: kudosFeedItemSchema,
  }),
]);
export type WallFeedItem = z.infer<typeof wallFeedItemSchema>;

/**
 * A page of Стена.
 *
 * `pinned` and `openPolls` are the **head** (§D7.4): they are served outside
 * the cursor stream, so page two never repeats them and they do not move as
 * the feed grows. Everything else is `items`, ordered `createdAt` descending
 * and by nothing else.
 *
 * `clearedAt` is the horizon (§D7.11) — the feed returns only rows created
 * after it. It is echoed back so the client can tell "the wall is empty"
 * apart from "the wall was cleared", without a second request.
 */
export const wallFeedResponseSchema = z.object({
  pinned: z.array(postResponseSchema),
  openPolls: z.array(pollResponseSchema),
  items: z.array(wallFeedItemSchema),
  nextCursor: z.string().nullable(),
  clearedAt: isoDateTimeSchema.nullable(),
});
export type WallFeedResponse = z.infer<typeof wallFeedResponseSchema>;

/* -------------------------------------------------------------------------- */
/* «Очистить доску» — a horizon, not a delete (§D7.11, D13)                    */
/* -------------------------------------------------------------------------- */

/**
 * The answer to a clear.
 *
 * Nothing is deleted: `clearedAt` is written to `family_settings` and the feed
 * stops returning rows older than it. `previousClearedAt` and `systemPostId`
 * are the undo token — six seconds of «Вернуть» hand them straight back.
 */
export const wallClearResponseSchema = z.object({
  clearedAt: isoDateTimeSchema,
  /** What the horizon was before this clear. `null` means "never cleared". */
  previousClearedAt: isoDateTimeSchema.nullable(),
  /** The system post that becomes the feed's visible floor — «Доску очистили …». */
  systemPostId: idSchema,
});
export type WallClearResponse = z.infer<typeof wallClearResponseSchema>;

/** Undo: put the previous horizon back, `null` included, and drop the marker post. */
export const wallRestoreSchema = z.object({
  clearedAt: isoDateTimeSchema.nullable(),
  systemPostId: idSchema.nullish(),
});
export type WallRestore = z.infer<typeof wallRestoreSchema>;
