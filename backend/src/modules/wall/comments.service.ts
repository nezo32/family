import { and, eq, isNull } from 'drizzle-orm';

import {
  COMMENTABLE_ENTITY_TYPES,
  REACTABLE_ENTITY_TYPES,
  type CommentableEntityType,
  type CommentResponse,
  type MediaAttachment,
  type ReactableEntityType,
  type ReactionListResponse,
  type ReactionSummary,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import type { Executor } from '../../core/db.js';
import { badRequest, forbidden, notFound } from '../../core/errors.js';
import { kudos } from '../chores/chores.schema.js';
import { eventAttendees, eventOccurrences, eventSeries } from '../events/events.schema.js';
import { savingsGoals } from '../goals/goals.schema.js';
import { canReadGoal } from '../goals/goals.service.js';
import * as media from '../storage/media.service.js';
import { taskOccurrences, taskSeries } from '../tasks/tasks.schema.js';
import * as repo from './wall.repository.js';
import { polls, posts, type CommentRow } from './wall.schema.js';

/**
 * Comments and reactions for **any** module.
 *
 * The target is addressed as `(entityType, entityId)`, so tasks, events and
 * goals get discussion and emoji without a table, a migration or a second
 * endpoint each (household.md §3). Postgres cannot enforce that pointer, which
 * puts three obligations on this file:
 *
 * 1. `entityType` is validated against the closed enum in
 *    `@family/shared` on **every** write — an unknown type is a `BAD_REQUEST`,
 *    never a silent row nobody can ever read back.
 * 2. Reads resolve the **target's** permission first: a comment on a private
 *    goal is exactly as private as the goal. That is `assertCanReadEntity`
 *    below, and it is the single most important function in this module.
 * 3. There is no `ON DELETE CASCADE`. Every module that deletes a commentable
 *    entity must call `deleteCommentsFor` inside its own delete transaction.
 */

/* -------------------------------------------------------------------------- */
/* Entity type validation                                                      */
/* -------------------------------------------------------------------------- */

const ENTITY_TYPE_SET: ReadonlySet<string> = new Set<string>(COMMENTABLE_ENTITY_TYPES);
const REACTABLE_TYPE_SET: ReadonlySet<string> = new Set<string>(REACTABLE_ENTITY_TYPES);

export function isCommentableEntityType(value: string): value is CommentableEntityType {
  return ENTITY_TYPE_SET.has(value);
}

export function isReactableEntityType(value: string): value is ReactableEntityType {
  return REACTABLE_TYPE_SET.has(value);
}

/**
 * The integrity boundary. Anything not in the closed enum is a bad request —
 * writing it would create a row addressed to a type nothing can resolve.
 */
export function assertEntityType(value: string): CommentableEntityType {
  if (!isCommentableEntityType(value)) {
    throw badRequest(`Unknown entityType: ${value}`, {
      entityType: [`Ожидается одно из: ${COMMENTABLE_ENTITY_TYPES.join(', ')}`],
    });
  }
  return value;
}

/**
 * The same boundary for reactions, over the **wider** set — the commentable
 * types plus `comment` itself.
 *
 * Two functions rather than one widened one, because the difference between the
 * sets is the deliberate refusal of nested threads. `assertEntityType` is what
 * the comment endpoints call; anything that reaches them addressed to a
 * `comment` is a bad request and stays one. See `REACTABLE_ENTITY_TYPES` in
 * `@family/shared` for why a thread on a thread is not a thing we want to
 * enable by accident.
 */
export function assertReactableEntityType(value: string): ReactableEntityType {
  if (!isReactableEntityType(value)) {
    throw badRequest(`Unknown entityType: ${value}`, {
      entityType: [`Ожидается одно из: ${REACTABLE_ENTITY_TYPES.join(', ')}`],
    });
  }
  return value;
}

export interface EntityRef {
  entityType: ReactableEntityType;
  entityId: string;
}

/* -------------------------------------------------------------------------- */
/* Target read access                                                          */
/* -------------------------------------------------------------------------- */

/**
 * "May this caller read the thing being commented on?"
 *
 * Registered per entity type so a module can take ownership of its own rule
 * later (`registerEntityAccessResolver`) without this file growing a special
 * case. The defaults below read the other modules' **schemas** and query them
 * here — never through their repositories or services (D8) — because the check
 * has to happen before the comment rows are touched at all. The one thing they
 * do borrow is a module's *pure* predicate over a row already in hand
 * (`goals.service.canReadGoal`): duplicating a visibility rule is how the
 * comment thread ends up more readable than the thing it is attached to.
 */
export type EntityAccessResolver = (
  exec: Executor,
  entityId: string,
  auth: AuthContext,
) => Promise<boolean>;

const resolvers = new Map<ReactableEntityType, EntityAccessResolver>();

export function registerEntityAccessResolver(
  entityType: ReactableEntityType,
  resolver: EntityAccessResolver,
): void {
  resolvers.set(entityType, resolver);
}

/** A live post is visible to every active member (D1: one family, no scoping). */
const postResolver: EntityAccessResolver = async (exec, entityId) => {
  const [row] = await exec
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.id, entityId), isNull(posts.deletedAt)))
    .limit(1);
  return Boolean(row);
};

/** Polls are family-wide by construction; existence is the whole check. */
const pollResolver: EntityAccessResolver = async (exec, entityId) => {
  const [row] = await exec
    .select({ id: polls.id })
    .from(polls)
    .where(eq(polls.id, entityId))
    .limit(1);
  return Boolean(row);
};

/** `entityId` is a **task occurrence** id — that is where per-instance state lives (D2). */
const taskResolver: EntityAccessResolver = async (exec, entityId, auth) => {
  const scope = auth.scopeFor('task:read');
  if (!scope) return false;

  const [row] = await exec
    .select({
      visibility: taskSeries.visibility,
      createdById: taskSeries.createdById,
      assigneeId: taskOccurrences.assigneeId,
      completedById: taskOccurrences.completedById,
    })
    .from(taskOccurrences)
    .innerJoin(taskSeries, eq(taskOccurrences.seriesId, taskSeries.id))
    .where(eq(taskOccurrences.id, entityId))
    .limit(1);
  if (!row) return false;

  const isMine =
    row.createdById === auth.userId ||
    row.assigneeId === auth.userId ||
    row.completedById === auth.userId;

  // `private` narrows further than the permission matrix: even `task:read:any`
  // does not open somebody else's private series.
  if (row.visibility === 'private') return isMine;
  return scope === 'any' || isMine;
};

/** `entityId` is an **event occurrence** id. */
const eventResolver: EntityAccessResolver = async (exec, entityId, auth) => {
  if (!auth.can('event:read')) return false;

  const [row] = await exec
    .select({
      visibility: eventSeries.visibility,
      createdById: eventSeries.createdById,
    })
    .from(eventOccurrences)
    .innerJoin(eventSeries, eq(eventOccurrences.seriesId, eventSeries.id))
    .where(eq(eventOccurrences.id, entityId))
    .limit(1);
  if (!row) return false;

  if (row.visibility === 'private') return row.createdById === auth.userId;
  if (row.visibility === 'restricted') {
    if (row.createdById === auth.userId) return true;
    const [attendee] = await exec
      .select({ id: eventAttendees.id })
      .from(eventAttendees)
      .where(and(eq(eventAttendees.occurrenceId, entityId), eq(eventAttendees.userId, auth.userId)))
      .limit(1);
    return Boolean(attendee);
  }
  return true;
};

/**
 * Children hold no `goal:*` permission at all, so they never get here (D4 /
 * household.md §5), and a `private` goal is readable only by its owner and the
 * `:any`-equivalent authority.
 *
 * The verdict is `goals.service.canReadGoal` rather than a second copy of the
 * rule. This resolver used to spell it `auth.role === 'owner' || auth.role ===
 * 'admin'`, which was wrong twice over: D4 forbids branching on the role
 * string, and a role comparison reads straight past `permission_denies` — an
 * admin explicitly denied `goal:read` still read every comment on every private
 * goal. `canReadGoal` is the pure mirror of the SQL filter the goals list uses,
 * so a comment thread is now visible exactly when the goal it hangs off is.
 *
 * `canReadGoal` is a pure predicate over the row this function already fetched;
 * importing it does not break the rule above about not calling other modules'
 * repositories, and it is the only way the two answers cannot drift.
 */
const goalResolver: EntityAccessResolver = async (exec, entityId, auth) => {
  if (!auth.can('goal:read')) return false;

  const [row] = await exec
    .select({
      visibility: savingsGoals.visibility,
      ownerId: savingsGoals.ownerId,
    })
    .from(savingsGoals)
    .where(and(eq(savingsGoals.id, entityId), isNull(savingsGoals.deletedAt)))
    .limit(1);
  if (!row) return false;

  return canReadGoal(auth, row);
};

/**
 * A kudos is addressed from one member to another and drawn as a card the
 * whole family reads (§D7.6). There is nothing to narrow — existence is the
 * whole check, exactly as for a poll.
 */
const kudosResolver: EntityAccessResolver = async (exec, entityId) => {
  const [row] = await exec
    .select({ id: kudos.id })
    .from(kudos)
    .where(eq(kudos.id, entityId))
    .limit(1);
  return Boolean(row);
};

/**
 * A reaction target in its own right (`REACTABLE_ENTITY_TYPES`), and the only
 * resolver here that has to take **two** hops.
 *
 * A comment carries its own polymorphic pointer, so «может ли этот человек
 * поставить сердечко на это сообщение» is answered by: the comment exists and
 * is not deleted, **and** the thing it hangs on is readable. Re-deriving the
 * second half would let a heart be placed on a reply under a private goal that
 * the reactor cannot see — the exact leak `assertCanReadEntity` exists to
 * prevent, arrived at one level down.
 *
 * A soft-deleted comment is not reactable. Its own reactions were already hard-
 * deleted with it (`deleteComment`), and letting a new one land on a row nobody
 * can see would create a reaction that no screen ever draws and no cascade ever
 * cleans up.
 */
const commentResolver: EntityAccessResolver = async (exec, entityId, auth) => {
  const comment = await repo.findCommentById(exec, entityId);
  if (!comment) return false;
  const resolver = resolvers.get(assertEntityType(comment.entityType));
  if (!resolver) return false;
  return resolver(exec, comment.entityId, auth);
};

registerEntityAccessResolver('post', postResolver);
registerEntityAccessResolver('poll', pollResolver);
registerEntityAccessResolver('kudos', kudosResolver);
registerEntityAccessResolver('task', taskResolver);
registerEntityAccessResolver('event', eventResolver);
registerEntityAccessResolver('goal', goalResolver);
registerEntityAccessResolver('comment', commentResolver);

/**
 * Throws **404** — not 403 — when the target is outside the caller's read
 * scope (D4). Confirming that a private goal exists is itself a leak.
 */
export async function assertCanReadEntity(
  exec: Executor,
  ref: EntityRef,
  auth: AuthContext,
): Promise<void> {
  const resolver = resolvers.get(ref.entityType);
  if (!resolver) throw badRequest(`No access resolver for entityType: ${ref.entityType}`);
  const allowed = await resolver(exec, ref.entityId, auth);
  if (!allowed) throw notFound('Entity');
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

export function toCommentResponse(
  row: CommentRow,
  attachments: MediaAttachment[] = [],
  reactions: ReactionSummary[] = [],
  hiddenAttachments = 0,
): CommentResponse {
  return {
    id: row.id,
    entityType: assertEntityType(row.entityType),
    entityId: row.entityId,
    authorId: row.authorId,
    body: row.body,
    reactions,
    attachments,
    hiddenAttachments,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Two extra queries for a whole page of comments, never one per row — the same
 * discipline `countComments` and `loadReactions` follow.
 *
 * It takes the `AuthContext` because the page depends on two things about the
 * reader: which reactions are theirs, and whether they hold `media:read`
 * (D15 §4). A reader without it gets the count and none of the descriptors.
 */
export async function hydrateComments(
  exec: Executor,
  auth: AuthContext,
  rows: readonly CommentRow[],
): Promise<CommentResponse[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [attachments, facts] = await Promise.all([
    media.attachmentsForPage(exec, 'comment', ids),
    repo.loadReactions(exec, 'comment', ids),
  ]);
  const summaries = repo.buildReactionSummaries(facts, auth.userId);
  return rows.map((row) => {
    const visible = media.visibleAttachmentsFor(auth, attachments.get(row.id) ?? []);
    return toCommentResponse(
      row,
      visible.attachments,
      summaries.get(row.id) ?? [],
      visible.hiddenAttachments,
    );
  });
}

/**
 * A comment must say *something*: words, or media, or both.
 *
 * Enforced here rather than in the zod schema because that schema is also the
 * PWA's form schema, and a `superRefine` there would turn a `ZodObject` into a
 * `ZodEffects` the composer can no longer `.omit()` from.
 */
export function assertHasContent(body: string, attachmentIds: readonly string[] | undefined): void {
  if (body.trim().length === 0 && (attachmentIds?.length ?? 0) === 0) {
    throw badRequest('A comment needs a body or an attachment', {
      body: ['Напишите что-нибудь или прикрепите фото.'],
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Comments                                                                    */
/* -------------------------------------------------------------------------- */

export interface CommentPage {
  items: CommentResponse[];
  nextCursor: string | null;
}

export async function listCommentsFor(
  exec: Executor,
  auth: AuthContext,
  ref: { entityType: string; entityId: string },
  query: { limit: number; cursor?: string | undefined; order?: 'asc' | 'desc' },
): Promise<CommentPage> {
  const entityType = assertEntityType(ref.entityType);
  await assertCanReadEntity(exec, { entityType, entityId: ref.entityId }, auth);

  const rows = await repo.listComments(exec, {
    entityType,
    entityId: ref.entityId,
    limit: query.limit + 1,
    cursor: query.cursor ? repo.decodeCursor(query.cursor) : undefined,
    order: query.order ?? 'asc',
  });

  const page = repo.toPage(rows, query.limit);
  return { items: await hydrateComments(exec, auth, page.items), nextCursor: page.nextCursor };
}

export async function addComment(
  exec: Executor,
  auth: AuthContext,
  ref: { entityType: string; entityId: string },
  input: { body: string; attachmentIds?: readonly string[] | undefined },
): Promise<CommentResponse> {
  const entityType = assertEntityType(ref.entityType);
  if (!auth.can('comment:create')) throw forbidden('Missing permission: comment:create');
  assertHasContent(input.body, input.attachmentIds);
  await assertCanReadEntity(exec, { entityType, entityId: ref.entityId }, auth);

  // One transaction: a comment whose photos failed to attach must not exist,
  // and a photo claimed by a comment that failed to insert must stay a draft.
  const { row, attachments } = await exec.transaction(async (tx) => {
    const inserted = await repo.insertComment(tx, {
      entityType,
      entityId: ref.entityId,
      authorId: auth.userId,
      body: input.body.trim(),
    });
    const attached = await media.attachMediaTo(tx, {
      entityType: 'comment',
      entityId: inserted.id,
      uploaderId: auth.userId,
      attachmentIds: input.attachmentIds ?? [],
    });
    return { row: inserted, attachments: attached.map(media.toMediaAttachment) };
  });

  const visible = media.visibleAttachmentsFor(auth, attachments);
  // A brand-new comment has no reactions yet; the empty array is the truth.
  return toCommentResponse(row, visible.attachments, [], visible.hiddenAttachments);
}

/**
 * Editing is author-only, with no `:any` escape hatch: an adult rewriting a
 * child's words under the child's name is worse than leaving the typo.
 */
export async function editComment(
  exec: Executor,
  auth: AuthContext,
  commentId: string,
  input: { body: string; attachmentIds?: readonly string[] | undefined },
): Promise<CommentResponse> {
  const existing = await repo.findCommentById(exec, commentId);
  if (!existing) throw notFound('Comment');
  await assertCanReadEntity(
    exec,
    { entityType: assertEntityType(existing.entityType), entityId: existing.entityId },
    auth,
  );
  if (existing.authorId !== auth.userId) throw forbidden('Only the author may edit a comment');
  assertHasContent(
    input.body,
    input.attachmentIds ??
      (await media.attachmentsOf(exec, 'comment', commentId)).map((item) => item.id),
  );

  const { row, removedKeys } = await exec.transaction(async (tx) => {
    const updated = await repo.updateCommentBody(tx, commentId, input.body.trim());
    if (!updated) throw notFound('Comment');
    // `undefined` means "leave the media alone"; an array — even an empty one —
    // is the whole new set.
    const removed = input.attachmentIds
      ? await media.reconcileAttachments(tx, {
          entityType: 'comment',
          entityId: commentId,
          uploaderId: auth.userId,
          attachmentIds: input.attachmentIds,
        })
      : { removedKeys: [] as readonly string[] };
    return { row: updated, removedKeys: removed.removedKeys };
  });

  // After the commit, never inside it: a rollback that had already deleted
  // bytes cannot be undone.
  await media.removeAllQuietly(removedKeys);

  const [hydrated] = await hydrateComments(exec, auth, [row]);
  if (!hydrated) throw notFound('Comment');
  return hydrated;
}

/** Soft delete: `comment:delete:own` for your own, `:any` for anybody's. */
export async function deleteComment(
  exec: Executor,
  auth: AuthContext,
  commentId: string,
): Promise<void> {
  const scope = auth.scopeFor('comment:delete');
  if (!scope) throw forbidden('Missing permission: comment:delete:own');

  const existing = await repo.findCommentById(exec, commentId);
  if (!existing) throw notFound('Comment');
  await assertCanReadEntity(
    exec,
    { entityType: assertEntityType(existing.entityType), entityId: existing.entityId },
    auth,
  );
  if (scope === 'own' && existing.authorId !== auth.userId) {
    throw forbidden('Missing permission: comment:delete:any');
  }

  await exec.transaction(async (tx) => {
    await repo.softDeleteComment(tx, commentId);
    // Soft, and the objects stay: a deleted comment is recoverable for as long
    // as the sweep's grace period lasts (`media.service.ts`).
    await media.detachAllFrom(tx, 'comment', commentId);
    // Hard, and in the same transaction. `(entity_type, entity_id)` has no
    // foreign key, so nothing cascades and an orphaned reaction is invisible —
    // it is not attached to anything a query would think to look at. Reactions
    // are hard-deleted for the same reason they are on every other target: a
    // reaction carries no content, and its only job was the counter. This is
    // the third pointer in this file that has to be swept by hand, after the
    // comments themselves and their media.
    await repo.deleteReactionsFor(tx, 'comment', commentId);
  });
}

/* -------------------------------------------------------------------------- */
/* Reactions                                                                   */
/* -------------------------------------------------------------------------- */

export async function getReactionSummary(
  exec: Executor,
  auth: AuthContext,
  ref: { entityType: string; entityId: string },
): Promise<ReactionListResponse> {
  const entityType = assertReactableEntityType(ref.entityType);
  await assertCanReadEntity(exec, { entityType, entityId: ref.entityId }, auth);

  const facts = await repo.loadReactions(exec, entityType, [ref.entityId]);
  const summaries = repo.buildReactionSummaries(facts, auth.userId);
  return {
    entityType,
    entityId: ref.entityId,
    reactions: summaries.get(ref.entityId) ?? [],
  };
}

/**
 * Idempotent toggle: adds the emoji when absent, removes it when present, and
 * always answers with the fresh summary so an offline double-tap converges
 * instead of oscillating (household.md §3).
 */
export async function toggleReaction(
  exec: Executor,
  auth: AuthContext,
  ref: { entityType: string; entityId: string },
  input: { emoji: string },
): Promise<ReactionListResponse> {
  const entityType = assertReactableEntityType(ref.entityType);
  // Reacting is a comment-level act, not kudos. `kudos:give` is the deliberate
  // "thank you" to a person; an emoji on a post is the lightweight equivalent
  // of leaving a comment, so it rides on the same permission.
  if (!auth.can('comment:create')) throw forbidden('Missing permission: comment:create');
  await assertCanReadEntity(exec, { entityType, entityId: ref.entityId }, auth);

  const emoji = input.emoji.trim();
  if (emoji.length === 0) throw badRequest('Emoji must not be empty');

  await exec.transaction(async (tx) => {
    const existing = await repo.findReaction(tx, entityType, ref.entityId, auth.userId, emoji);
    if (existing) {
      await repo.deleteReactionById(tx, existing.id);
    } else {
      await repo.insertReaction(tx, {
        entityType,
        entityId: ref.entityId,
        userId: auth.userId,
        emoji,
      });
    }
  });

  return getReactionSummary(exec, auth, ref);
}

/** Reaction summaries for a whole page of targets. One query, no N+1. */
export async function summariesForPage(
  exec: Executor,
  entityType: ReactableEntityType,
  entityIds: readonly string[],
  viewerId: string,
): Promise<Map<string, ReactionSummary[]>> {
  const facts = await repo.loadReactions(exec, entityType, entityIds);
  return repo.buildReactionSummaries(facts, viewerId);
}

/* -------------------------------------------------------------------------- */
/* The cleanup hook                                                            */
/* -------------------------------------------------------------------------- */

export interface CommentCleanupResult {
  comments: number;
  reactions: number;
}

/**
 * **Call this from every module that deletes a commentable entity**, inside the
 * same transaction as the delete:
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   await softDeleteTask(tx, id);
 *   await deleteCommentsFor(tx, 'task', id);
 * });
 * ```
 *
 * The database cannot do this for us: `(entity_type, entity_id)` is a
 * polymorphic pointer, so there is no foreign key and therefore no
 * `ON DELETE CASCADE` (household.md §3). Without this call the rows become
 * invisible garbage that the nightly orphan sweep has to find.
 *
 * Comments are **soft**-deleted (they may still be needed for moderation and
 * for restoring an accidentally deleted entity); reactions are hard-deleted,
 * because a reaction carries no content and its only job was the counter.
 */
export async function deleteCommentsFor(
  tx: Executor,
  entityType: string,
  entityId: string,
): Promise<CommentCleanupResult> {
  const validated = assertEntityType(entityType);
  const [commentIds, reactionsDeleted] = await Promise.all([
    repo.softDeleteCommentsFor(tx, validated, entityId),
    repo.deleteReactionsFor(tx, validated, entityId),
  ]);
  // The third polymorphic pointer nobody can cascade: the photos on the
  // comments that just went. Same rule as the comments themselves — soft
  // delete, objects kept until the sweep's grace period runs out.
  await media.detachAllFromMany(tx, 'comment', commentIds);
  // …and the fourth, which arrived with reactions on comments: hearts on the
  // replies that just went. Same argument as `media` above — there is no FK to
  // cascade through, and an orphaned reaction is invisible rather than merely
  // wrong, because nothing left in the database points at it. Hard-deleted, and
  // counted with the rest: from the caller's point of view "how many reactions
  // did this take with it" is one number.
  const nestedReactions = await repo.deleteReactionsForMany(tx, 'comment', commentIds);
  return { comments: commentIds.length, reactions: reactionsDeleted + nestedReactions };
}
