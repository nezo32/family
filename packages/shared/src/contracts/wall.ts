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

/**
 * What may carry **reactions** — the commentable set plus `comment` itself.
 *
 * The owner asked for it in as many words: «в обсуждениях должна быть
 * возможность… добавлять реакции на сообщения в обсуждениях». A heart on a
 * reply is the lightest thing the app can offer, and it is the natural answer
 * to a reply that does not need one of its own.
 *
 * ## Why this is a second enum rather than one more member of the first
 *
 * Because the two sets are not the same set, and merging them would enable a
 * feature nobody asked for **by accident**. `COMMENTABLE_ENTITY_TYPES` is what
 * the generic comment endpoints are mounted on, so adding `comment` there would
 * silently mount `POST /api/comments/:id/comments` and give Стена nested
 * threads — a different product, with its own depth limit, its own indentation
 * design, its own notification rules and its own moderation story, none of
 * which exist. §D7 is explicit that a discussion is a flat list under a card.
 *
 * So the refusal is deliberate and it is expressed structurally: reactions widen
 * to `comment`, comments do not. `reactableEntityTypeSchema` is the integrity
 * boundary for the reaction routes exactly as `entityTypeSchema` is for the
 * comment routes.
 *
 * A reaction on a comment carries the same polymorphic-pointer obligation as
 * every other row here: nothing cascades, so deleting a comment (or the thing
 * it hangs on) must delete its reactions in the same transaction.
 */
export const REACTABLE_ENTITY_TYPES = [...COMMENTABLE_ENTITY_TYPES, 'comment'] as const;
export const reactableEntityTypeSchema = z.enum(REACTABLE_ENTITY_TYPES);
export type ReactableEntityType = z.infer<typeof reactableEntityTypeSchema>;

export const entityRefSchema = z.object({
  entityType: entityTypeSchema,
  entityId: idSchema,
});
export type EntityRef = z.infer<typeof entityRefSchema>;

export const postTypeSchema = z.enum(['announcement', 'system']);
export type PostType = z.infer<typeof postTypeSchema>;

/* -------------------------------------------------------------------------- */
/* Media attachments (фото / видео / аудио)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Photo, video and audio on a post or on a comment.
 *
 * ## The client never names an object, and never sends a URL
 *
 * `avatarUrl` was once a client-writable URL, and that shape is why a
 * token-leak check had to become structural. Media therefore has exactly one
 * door: the bytes are POSTed to `/api/media`, the server sniffs them, stores
 * them and mints an **id**. A post or comment then references that id and
 * nothing else — `url` below is an output field, produced by the server, and a
 * client that sends one gets it ignored.
 *
 * ## Why the limits live in the contract
 *
 * A 413 with no number in it is a mystery; a mystery on an upload that took
 * ninety seconds is worse. The caps are published here so the composer can
 * refuse an oversized file **before** it is uploaded and say why, in the same
 * words the server would use. The server imports the same constants, so the two
 * cannot drift.
 */
export const MEDIA_KINDS = ['image', 'video', 'audio'] as const;
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/**
 * The formats we accept, decided by **magic bytes** on the way in — the
 * declared `Content-Type` and the filename are never trusted and never stored.
 *
 * The list is short on purpose, and the rule that produced it is *"every device
 * in this family can play it"*, not *"some browser can produce it"*:
 *
 * - **JPEG / PNG / WebP** — the three a canvas can re-encode to, so the client
 *   can downscale anything it manages to decode before it ever uploads.
 * - **GIF** — costs one magic-byte check, renders in an `<img>`, and carries no
 *   script. Refusing «смешная гифка» would be a security answer to a question
 *   nobody asked.
 * - **MP4** and **QuickTime** — an iPhone records `.mov` (QuickTime) by default
 *   and a PWA cannot change that. Rejecting it would mean the family's main
 *   camera cannot post video; transcoding it would mean ffmpeg on a VDI that
 *   also runs Postgres, Redis and the object store. Both containers are
 *   H.264/AAC in practice and play everywhere the family looks.
 * - **M4A/AAC and MP3** — the two audio formats Safari plays without argument.
 *
 * Deliberately absent: **SVG** (a document that executes), **HEIC/AVIF** (no
 * browser but Safari renders them and we cannot transcode — the client is asked
 * to re-encode in a canvas instead), **WebM/Ogg/Opus** (a recording no iPhone
 * in the family could play back), **WAV** (uncompressed audio, huge for what it
 * carries).
 */
export const ALLOWED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'audio/mp4',
  'audio/mpeg',
] as const;
export type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

/**
 * Size and duration caps, per kind.
 *
 * Six people, one small VDI, and an object store whose **whole volume is
 * tarred over the network every night**. That last one is what sets the video
 * number: every byte accepted here is re-read, re-compressed and re-transferred
 * every night for as long as the family keeps it, and «Очистить доску» is a
 * horizon rather than a delete, so nothing ever shrinks.
 *
 * - **Photo 10 MiB.** A 12 MP phone JPEG is 3–5 MB, so this takes an original
 *   straight off a camera without pretending a 60 MP raw export is a snapshot.
 * - **Video 100 MiB / 3 minutes.** 1080p30 off an iPhone runs ≈ 60 MB per
 *   minute, so in practice the size cap binds first on a long clip and the
 *   duration cap binds first on a short one at 4K — both are published, and the
 *   refusal names whichever one was hit. Three minutes is a birthday song, a
 *   first bike ride, a school concert item; it is not a film.
 * - **Audio 25 MiB / 10 minutes.** A voice message is seconds; the ceiling is
 *   there so a whole album cannot arrive one track at a time.
 */
export const MEDIA_LIMITS = {
  image: { maxBytes: 10 * 1024 * 1024, maxDurationMs: null },
  video: { maxBytes: 100 * 1024 * 1024, maxDurationMs: 3 * 60 * 1000 },
  audio: { maxBytes: 25 * 1024 * 1024, maxDurationMs: 10 * 60 * 1000 },
} as const satisfies Record<MediaKind, { maxBytes: number; maxDurationMs: number | null }>;

/** The transport's own ceiling — the largest of the three, enforced by the parser. */
export const MEDIA_MAX_BYTES = MEDIA_LIMITS.video.maxBytes;

/**
 * Attachments per post or per comment.
 *
 * Ten is a phone's photo-picker selection, not a design constraint; the real
 * bound is the size cap multiplied by this number, which is why it is not
 * larger.
 */
export const MAX_ATTACHMENTS = 10;

/**
 * Decompression-bomb guard. We never decode an image server-side, but the six
 * phones that render it do — a 200 kB PNG declaring 50 000 × 50 000 is a denial
 * of service against the reader, and the dimensions are already parsed.
 */
export const MEDIA_MAX_PIXELS = 60_000_000;
export const MEDIA_MAX_DIMENSION = 12_000;

/**
 * One stored object, as the API hands it back.
 *
 * `width`/`height` are always present for an image and for video (parsed from
 * the container, rotation applied), so the card can reserve the box **before**
 * the bytes arrive and nothing in the feed reflows on load (§D7.6). They are
 * `null` for audio, which has no box. `durationMs` is the mirror: present for
 * video and audio, `null` for a still image.
 */
export const mediaAttachmentSchema = z.object({
  id: idSchema,
  kind: mediaKindSchema,
  /** The **sniffed** type, never the uploader's claim. One of `ALLOWED_MEDIA_TYPES`. */
  contentType: z.string(),
  /**
   * Our own authenticated path — `/api/media/<id>`. Never a bucket URL: the
   * object store has no route to the internet and no published port, so this is
   * the only door, and a family photo stays readable exactly as long as the
   * session is.
   */
  url: z.string(),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: isoDateTimeSchema,
});
export type MediaAttachment = z.infer<typeof mediaAttachmentSchema>;

/**
 * What a writer sends: ids minted by `POST /api/media`, **in the order they
 * should be drawn**. The array is the ordering — there is no `sortOrder` on the
 * wire, because two clients disagreeing about a number is a bug and an array
 * cannot disagree with itself.
 *
 * On an update the array is the **whole** set: ids omitted from it are detached
 * and their objects reclaimed. Omitting the field entirely leaves the existing
 * attachments alone.
 */
export const attachmentIdsSchema = z.array(idSchema).max(MAX_ATTACHMENTS);

/**
 * A **playback ticket** — the credential a `<video>` or an `<audio>` can
 * actually carry.
 *
 * ## The problem it exists to solve
 *
 * `GET /api/media/:id` is bearer-authenticated, and a media element sends no
 * `Authorization` header. There is no attribute for it, no hook, and no way to
 * add one. So the PWA had to `fetch()` the whole file and hand the element an
 * object URL — which works, and throws away the two things that matter most on
 * exactly the files where they matter most: **seeking** and **partial
 * playback**. A three-minute clip downloads in full before the first frame, and
 * dragging the scrubber re-reads bytes the browser already has. The backend's
 * `Range` support is complete and correct; it is simply unreachable.
 *
 * ## The shape
 *
 * `POST /api/media/:id/ticket` mints a short-lived capability for **one object
 * and one member**, and `GET /api/media/:id/stream?t=…` accepts it in place of
 * a bearer. That URL goes straight into `<video src>`, so the browser's own
 * media stack issues the range requests, unmediated — no service worker in the
 * byte path, no object URL, no buffering.
 *
 * ## What a leaked ticket costs, which is the question that chose this
 *
 * Nearly nothing, and deliberately so:
 *
 * - it names **one** attachment — not the wall, not the member's session;
 * - it is bound to the member who minted it, and the stream route re-runs their
 *   full authorisation on **every** request, so it is a *credential* and never
 *   a bypass: suspend them, revoke `media:read`, delete the post, and the next
 *   range request is a 404;
 * - it expires in {@link MEDIA_TICKET_TTL_SECONDS} — comfortably longer than
 *   the longest file the limits allow, and short enough that a URL in somebody
 *   else's history is worthless by the time they look at it.
 *
 * The signing key is derived from `COOKIE_SECRET` through its own info string,
 * so a ticket can never be replayed as a session credential — the same rule the
 * ICS feed token follows. That token's lesson is recorded too: it was once
 * logged in full, which is why `core/logger.ts` strips query strings from every
 * request line. Tickets ride in `?t=` and are covered by that already.
 */
export const MEDIA_TICKET_TTL_SECONDS = 900;

export const mediaTicketResponseSchema = z.object({
  /** `/api/media/<id>/stream?t=<ticket>` — put it straight in `src`. */
  url: z.string(),
  /** When the ticket stops working. Re-mint before this, or on a 404. */
  expiresAt: isoDateTimeSchema,
});
export type MediaTicketResponse = z.infer<typeof mediaTicketResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Posts                                                                       */
/* -------------------------------------------------------------------------- */

const postWritableFields = z.object({
  title: z.string().trim().max(160).nullish(),
  /**
   * **May be empty — but only when the post carries media.**
   *
   * It used to be `nonEmptyString(8000)`, which was right while a post was
   * words and nothing else. A photo with no caption is a whole note on a family
   * wall, and «пусто» is not what the reader sees — they see the photo. The
   * *"one of body or attachments must be present"* rule is enforced in
   * `wall.service.ts` rather than here, because a `superRefine` would turn this
   * object into a `ZodEffects` and the composer builds its form schema with
   * `createPostSchema.omit(...)`, which only a `ZodObject` has.
   */
  body: z.string().trim().max(8000, 'Не длиннее 8000 символов'),
  /**
   * Pinning has an expiry rather than a flag: "закреплено до" self-clears,
   * a boolean stays pinned forever. Requires `post:pin`.
   */
  pinnedUntil: isoDateTimeSchema.nullish(),
  /**
   * Ids from `POST /api/media`, in draw order. Optional rather than
   * `.default([])` on purpose: a defaulted array is *required* in the inferred
   * output type, and every existing caller that builds a `CreatePost` literal —
   * including the PWA's optimistic draft — would stop compiling for a field it
   * does not use yet.
   */
  attachmentIds: attachmentIdsSchema.optional(),
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
  /**
   * Photo, video and audio, in draw order.
   *
   * `.default([])` rather than `.optional()`, and the change is deliberate.
   * The server has always sent this field — an empty array when there is
   * none — so `optional()` was never describing the wire. What it was
   * protecting was the PWA's optimistic `const draft: PostResponse = {…}`,
   * which did not set it. That draft now sets `attachments: []`, which is the
   * truth about a post being written, and in exchange every card can read
   * `post.attachments` without a `?? []` guarding a case the server cannot
   * produce.
   *
   * Promoted **together with** `commentResponseSchema.attachments` below. One
   * without the other leaves the thread paying a cost the card no longer pays,
   * and a reader would have to look up which of the two was which.
   */
  attachments: z.array(mediaAttachmentSchema).default([]),
  /**
   * How many attachments this card carries that **you** may not open (D15 §4).
   *
   * `0` for everybody who holds `media:read`, which is every role from `child`
   * up. For a `guest` it is the count, and `attachments` is empty — no id, no
   * url, no content type, no dimensions. That asymmetry is the whole design:
   * the card must be able to say «Фото — только для семьи» in place of the box
   * (§D7.14.10) instead of drawing a note that silently looks like it has
   * nothing in it, and the reader must not come away holding an object id they
   * could probe the delivery route with.
   *
   * A count rather than a boolean because the placeholder is a real element in
   * a real layout — one line for one photo reads differently from one line
   * standing in for four — and because the count is derived from rows the
   * reader may already see the card for. It is the *only* thing about the media
   * that crosses the wire to somebody without `media:read`.
   *
   * **`.default(0)` now, promoted from `.optional()`** — the same move
   * `attachments` made just above it, and made for the same reason. The server
   * has always sent this field, so `optional()` was never describing the wire;
   * what it was protecting was the PWA's optimistic
   * `const draft: PostResponse = {…}`, which a `.default()` forces to set it.
   * Those drafts now set `hiddenAttachments: 0` — the truth about a note being
   * written by somebody who is watching it appear — and in exchange every card
   * reads a plain `number` with no `?? 0` guarding a case the server cannot
   * produce.
   *
   * Branch on `> 0`, never on an empty `attachments` array — that is also what
   * a note with no photos at all looks like.
   */
  hiddenAttachments: z.number().int().nonnegative().default(0),
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
  /** Empty is allowed only with media, exactly as on a post. Enforced in the service. */
  body: z.string().trim().max(4000, 'Не длиннее 4000 символов'),
  attachmentIds: attachmentIdsSchema.optional(),
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
  /**
   * Same shape and same rules as a post's, `.default([])` included — see the
   * note there. The two fields were promoted in one change on purpose.
   */
  attachments: z.array(mediaAttachmentSchema).default([]),
  /** Same field, same rule and the same `.default(0)` — see the note there. */
  hiddenAttachments: z.number().int().nonnegative().default(0),
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

/**
 * **The like.**
 *
 * A like is not a second system next to reactions — it *is* this emoji's
 * reaction row, promoted to one tap (§D7.7a, D14). Two systems would mean two
 * states that can disagree, ❤️ drawn twice on one card, and a permanently
 * unanswerable question about whether a heart and a ❤️ reaction from the same
 * person are one act or two.
 *
 * It lives in the contract rather than in `features/wall/locale.ts` so that the
 * client, a future digest and any future notification rule cannot drift apart
 * on what «лайк» means. `REACTION_EMOJI[0]` on the client must equal it.
 *
 * Note the code points: `U+2764 U+FE0F`. The variation selector is part of the
 * value the server stores and compares, so a bare `U+2764` would be a
 * *different* reaction row and the promoted chip would never light up.
 */
export const LIKE_EMOJI = '❤️';

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
  /** The **reactable** set, which includes `comment` — see `REACTABLE_ENTITY_TYPES`. */
  entityType: reactableEntityTypeSchema,
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
