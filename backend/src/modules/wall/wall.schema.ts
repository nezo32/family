import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, emptyJsonObject, primaryId, softDelete, timestamps } from '../../db/base.js';
import { users } from '../identity/users.schema.js';

/**
 * Family wall — announcements, comments, reactions, polls and the activity feed.
 *
 * Single tenant (D1): no `household_id`. A post is visible to every active
 * member, full stop.
 *
 * ## Polymorphic comments and reactions
 *
 * `comments` and `reactions` address their target by `(entity_type, entity_id)`
 * instead of one FK column per commentable table. That buys discussion and
 * emoji on tasks, events and goals for **zero** extra tables, and lets a new
 * commentable entity appear without a migration.
 *
 * The trade-off is explicit and accepted: **Postgres cannot enforce referential
 * integrity on a polymorphic pointer.** Consequences the service layer owns:
 *
 * - `ON DELETE CASCADE` does not happen. Deleting a task must call the wall
 *   service (or emit a domain event) to soft-delete its comments; orphan rows
 *   are otherwise invisible garbage.
 * - `entity_type` is unvalidated `text` at the DB level. Keep the allowed set
 *   in one place (`ENTITY_TYPES` in the shared contracts) and validate on write.
 * - Reads need one query per entity type; there is no join that fetches "the
 *   commented object" generically. In practice the caller already has it.
 *
 * The alternative — a `commentable` supertype table with a real FK from each
 * concrete table — was rejected: it adds a write to every task/event/goal insert
 * to protect a family-sized dataset from a class of bug the service prevents.
 */

export const postType = pgEnum('post_type', ['announcement', 'system']);

/**
 * Allowed `entity_type` values for comments and reactions. Mirrored in
 * `@family/shared` (`contracts/wall.ts`), which is where request validation
 * reads it from — this const exists so the schema file documents the set too.
 */
export const COMMENTABLE_ENTITY_TYPES = ['post', 'task', 'event', 'goal', 'poll'] as const;

export const posts = pgTable(
  'posts',
  {
    id: primaryId(),

    /** NULL => system-generated (birthday reminder, goal reached, digest). */
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),

    type: postType().notNull().default('announcement'),

    title: text(),
    body: text().notNull(),

    /**
     * Pin with an expiry rather than a boolean flag: "закреплено до" self-heals,
     * a boolean stays pinned forever because nobody remembers to unpin.
     */
    pinnedUntil: timestamp({ withTimezone: true }),

    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    index('posts_created_at_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.deletedAt} is null`),
    index('posts_pinned_idx')
      .on(t.pinnedUntil.desc())
      .where(sql`${t.pinnedUntil} is not null and ${t.deletedAt} is null`),
    index('posts_author_idx').on(t.authorId),
  ],
);

/** Polymorphic — see the file header for the integrity trade-off. */
export const comments = pgTable(
  'comments',
  {
    id: primaryId(),

    /** One of `COMMENTABLE_ENTITY_TYPES`. Not an enum: adding a type stays migration-free. */
    entityType: text().notNull(),
    entityId: uuid().notNull(),

    authorId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    body: text().notNull(),

    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    /** The only access path: "all comments on this thing, oldest first". */
    index('comments_entity_idx')
      .on(t.entityType, t.entityId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
    index('comments_author_idx').on(t.authorId),
  ],
);

/**
 * Emoji reactions, including kudos (`kudos:give` in D4 is a reaction on another
 * member's post or completed task). One row per (target, user, emoji): a user
 * may add several different emoji but cannot double-count one.
 */
export const reactions = pgTable(
  'reactions',
  {
    id: primaryId(),

    entityType: text().notNull(),
    entityId: uuid().notNull(),

    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** A single grapheme cluster, validated in the contract. */
    emoji: text().notNull(),

    ...createdAt(),
  },
  (t) => [
    uniqueIndex('reactions_unique_idx').on(t.entityType, t.entityId, t.userId, t.emoji),
    /** Counting reactions for a target without touching the unique index prefix order. */
    index('reactions_entity_idx').on(t.entityType, t.entityId, t.emoji),
  ],
);

export const polls = pgTable(
  'polls',
  {
    id: primaryId(),

    question: text().notNull(),

    /** Soft deadline: the UI stops accepting votes; a job stamps `closed_at`. */
    closesAt: timestamp({ withTimezone: true }),
    allowMultiple: boolean().notNull().default(false),

    createdById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /** Set when closed manually or by the expiry job. NULL => open. */
    closedAt: timestamp({ withTimezone: true }),

    ...createdAt(),
  },
  (t) => [
    index('polls_open_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.closedAt} is null`),
  ],
);

export const pollOptions = pgTable(
  'poll_options',
  {
    id: primaryId(),

    pollId: uuid()
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),

    label: text().notNull(),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [index('poll_options_poll_idx').on(t.pollId, t.sortOrder)],
);

/**
 * One row per (poll, user, option).
 *
 * The unique index is on `(poll_id, user_id, option_id)` — it stops a user
 * voting for the *same option* twice but deliberately allows several options,
 * because multi-choice polls need exactly that. **Single-choice enforcement
 * (`allow_multiple = false` => at most one row per (poll, user)) lives in the
 * service layer**, inside the same transaction as the insert: expressing it in
 * the schema would need either a conditional unique index that cannot read the
 * parent row, or a trigger. A `SELECT ... FOR UPDATE` on the poll row plus a
 * delete-then-insert is simpler and testable.
 */
export const pollVotes = pgTable(
  'poll_votes',
  {
    id: primaryId(),

    pollId: uuid()
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    optionId: uuid()
      .notNull()
      .references(() => pollOptions.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    ...createdAt(),
  },
  (t) => [
    uniqueIndex('poll_votes_unique_idx').on(t.pollId, t.userId, t.optionId),
    index('poll_votes_option_idx').on(t.optionId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Media attachments                                                           */
/* -------------------------------------------------------------------------- */

export const mediaKind = pgEnum('media_kind', ['image', 'video', 'audio']);

/**
 * Photo, video and audio hanging off a post or a comment.
 *
 * ## Why one table and not two
 *
 * The obvious alternative is an assets table plus a join table. It buys reuse —
 * one object referenced by several posts — and costs a join on every read plus
 * a second class of orphan (an asset with no link rows). **Nothing in this app
 * reuses an object.** A photo is taken, uploaded and hung on one note; there is
 * no library screen, no picker over past uploads, no de-duplication. A join
 * table with exactly one row per asset is state that can disagree with itself:
 * two link rows for one object make "delete the object when it is detached"
 * ambiguous, and two `sort_order`s for one asset make the draw order a
 * question. One row, one object, one place it hangs.
 *
 * ## The draft state is a null pointer
 *
 * Upload happens **before** the post exists (attach-then-post): the composer
 * uploads while the writer is still typing, so the note appears complete the
 * moment it is posted, and a failed upload is a failure the writer can see and
 * retry *before* anything is published. A freshly uploaded row therefore has
 * `entity_id IS NULL` — it is a draft, visible to its uploader and to nobody
 * else, and `media_attachments_drafts_idx` is exactly the index the orphan
 * sweep scans.
 *
 * ## The pointer is polymorphic and the database cannot help
 *
 * `(entity_type, entity_id)` carries the same trade-off as `comments` above and
 * one extra obligation: an object outlives its row unless somebody deletes it.
 * So every path that removes an entity calls `detachAllFrom` in the same
 * transaction (soft delete, objects kept — see `media.service.ts`), and the
 * nightly sweep is what actually reclaims bytes. `entity_type` here is a
 * **narrower** set than `COMMENTABLE_ENTITY_TYPES`: only `post` and `comment`
 * hold media, and `ATTACHABLE_ENTITY_TYPES` in the storage module is where that
 * is enforced.
 *
 * ## Why it lives in this file rather than in the storage module
 *
 * `db/schema.ts` is the lead's barrel and drizzle-kit only sees what the barrel
 * re-exports. `wall.schema.ts` is already in it, and the attachment pointer is
 * a wall concept — the storage module owns the *objects*, this table owns
 * *where they hang*.
 */
export const mediaAttachments = pgTable(
  'media_attachments',
  {
    id: primaryId(),

    /** Who uploaded it. Never deleted while their media exists — same rule as a comment. */
    uploaderId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    kind: mediaKind().notNull(),

    /** The **sniffed** type. Echoed on every GET, so it is never the client's claim. */
    contentType: text().notNull(),

    /**
     * The bucket key, generated server-side (`media/<id>/<random>.<ext>`).
     * Unique so two rows can never claim the same object and make deletion a
     * question of which row wins.
     */
    objectKey: text().notNull(),

    byteSize: integer().notNull(),

    /**
     * Pixel dimensions, rotation already applied, so the card can box the
     * aspect ratio before the bytes land and the feed never reflows (§D7.6).
     * NULL for audio.
     */
    width: integer(),
    height: integer(),

    /** NULL for a still image. Parsed from the container, never from the client. */
    durationMs: integer(),

    /** `post` | `comment`. NULL together with `entityId` => an unattached draft. */
    entityType: text(),
    entityId: uuid(),

    /** Draw order within one entity. Assigned from the position in `attachmentIds`. */
    sortOrder: integer().notNull().default(0),

    /** When it stopped being a draft. NULL for a draft; the sweep reads `createdAt`. */
    attachedAt: timestamp({ withTimezone: true }),

    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    /** The only read path: "everything hanging on this thing, in order". */
    index('media_attachments_entity_idx')
      .on(t.entityType, t.entityId, t.sortOrder)
      .where(sql`${t.deletedAt} is null`),
    /** The sweep's index: drafts nobody ever posted. */
    index('media_attachments_drafts_idx')
      .on(t.createdAt)
      .where(sql`${t.entityId} is null and ${t.deletedAt} is null`),
    /** The sweep's other index: detached rows past their grace period. */
    index('media_attachments_deleted_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    index('media_attachments_uploader_idx').on(t.uploaderId),
    uniqueIndex('media_attachments_object_key_idx').on(t.objectKey),
  ],
);

/**
 * Append-only feed of domain events ("Папа выполнил задачу «Вынести мусор»").
 *
 * Never `UPDATE`d, never `DELETE`d — same discipline as the ledgers (D5/D6).
 * `summary` is a **pre-rendered Russian sentence** written at event time: the
 * feed must stay readable after the underlying task is renamed or deleted, and
 * re-deriving copy from `metadata` on every read would couple the feed to every
 * other module's wording. `metadata` keeps the structured payload for links and
 * for anything that wants to re-render richly.
 */
export const activityLog = pgTable(
  'activity_log',
  {
    id: primaryId(),

    /** NULL => the system did it, or the actor was deleted. */
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),

    /** Dotted domain event name: `task.completed`, `goal.reached`, `member.approved`. */
    verb: text().notNull(),

    /** Optional deep-link target. Polymorphic, same trade-off as `comments`. */
    entityType: text(),
    entityId: uuid(),

    /** Ready-to-render Russian sentence. Frozen at write time. */
    summary: text().notNull(),

    metadata: jsonb().$type<Record<string, unknown>>().notNull().default(emptyJsonObject),

    ...createdAt(),
  },
  (t) => [
    index('activity_log_created_at_idx').on(t.createdAt.desc()),
    index('activity_log_actor_idx').on(t.actorId, t.createdAt.desc()),
    index('activity_log_entity_idx').on(t.entityType, t.entityId),
    index('activity_log_verb_idx').on(t.verb),
  ],
);

export type PostRow = typeof posts.$inferSelect;
export type NewPostRow = typeof posts.$inferInsert;
export type CommentRow = typeof comments.$inferSelect;
export type NewCommentRow = typeof comments.$inferInsert;
export type ReactionRow = typeof reactions.$inferSelect;
export type NewReactionRow = typeof reactions.$inferInsert;
export type PollRow = typeof polls.$inferSelect;
export type NewPollRow = typeof polls.$inferInsert;
export type PollOptionRow = typeof pollOptions.$inferSelect;
export type NewPollOptionRow = typeof pollOptions.$inferInsert;
export type PollVoteRow = typeof pollVotes.$inferSelect;
export type NewPollVoteRow = typeof pollVotes.$inferInsert;
export type ActivityLogRow = typeof activityLog.$inferSelect;
export type NewActivityLogRow = typeof activityLog.$inferInsert;
export type MediaAttachmentRow = typeof mediaAttachments.$inferSelect;
export type NewMediaAttachmentRow = typeof mediaAttachments.$inferInsert;
