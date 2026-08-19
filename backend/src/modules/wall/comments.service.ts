import { and, eq, isNull } from 'drizzle-orm';

import {
  COMMENTABLE_ENTITY_TYPES,
  type CommentableEntityType,
  type CommentResponse,
  type ReactionListResponse,
  type ReactionSummary,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import type { Executor } from '../../core/db.js';
import { badRequest, forbidden, notFound } from '../../core/errors.js';
import { eventAttendees, eventOccurrences, eventSeries } from '../events/events.schema.js';
import { savingsGoals } from '../goals/goals.schema.js';
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

export function isCommentableEntityType(value: string): value is CommentableEntityType {
  return ENTITY_TYPE_SET.has(value);
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

export interface EntityRef {
  entityType: CommentableEntityType;
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
 * case. The defaults below read the other modules' **schemas** — never their
 * repositories or services (D8) — because the check has to happen before the
 * comment rows are touched at all.
 */
export type EntityAccessResolver = (
  exec: Executor,
  entityId: string,
  auth: AuthContext,
) => Promise<boolean>;

const resolvers = new Map<CommentableEntityType, EntityAccessResolver>();

export function registerEntityAccessResolver(
  entityType: CommentableEntityType,
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
  const [row] = await exec.select({ id: polls.id }).from(polls).where(eq(polls.id, entityId)).limit(1);
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
      .where(
        and(eq(eventAttendees.occurrenceId, entityId), eq(eventAttendees.userId, auth.userId)),
      )
      .limit(1);
    return Boolean(attendee);
  }
  return true;
};

/**
 * Children hold no `goal:*` permission at all, so they never get here (D4 /
 * household.md §5), and a `private` goal is readable only by its owner, its
 * creator and owner/admin.
 */
const goalResolver: EntityAccessResolver = async (exec, entityId, auth) => {
  if (!auth.can('goal:read')) return false;

  const [row] = await exec
    .select({
      visibility: savingsGoals.visibility,
      ownerId: savingsGoals.ownerId,
      createdById: savingsGoals.createdById,
    })
    .from(savingsGoals)
    .where(and(eq(savingsGoals.id, entityId), isNull(savingsGoals.deletedAt)))
    .limit(1);
  if (!row) return false;

  if (row.visibility !== 'private') return true;
  return (
    row.ownerId === auth.userId ||
    row.createdById === auth.userId ||
    auth.role === 'owner' ||
    auth.role === 'admin'
  );
};

registerEntityAccessResolver('post', postResolver);
registerEntityAccessResolver('poll', pollResolver);
registerEntityAccessResolver('task', taskResolver);
registerEntityAccessResolver('event', eventResolver);
registerEntityAccessResolver('goal', goalResolver);

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

export function toCommentResponse(row: CommentRow): CommentResponse {
  return {
    id: row.id,
    entityType: assertEntityType(row.entityType),
    entityId: row.entityId,
    authorId: row.authorId,
    body: row.body,
    // `comment` is not in COMMENTABLE_ENTITY_TYPES, so a comment cannot itself
    // be reacted to. The field stays in the contract for a future enum entry.
    reactions: [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
  return { items: page.items.map(toCommentResponse), nextCursor: page.nextCursor };
}

export async function addComment(
  exec: Executor,
  auth: AuthContext,
  ref: { entityType: string; entityId: string },
  input: { body: string },
): Promise<CommentResponse> {
  const entityType = assertEntityType(ref.entityType);
  if (!auth.can('comment:create')) throw forbidden('Missing permission: comment:create');
  await assertCanReadEntity(exec, { entityType, entityId: ref.entityId }, auth);

  const row = await repo.insertComment(exec, {
    entityType,
    entityId: ref.entityId,
    authorId: auth.userId,
    body: input.body.trim(),
  });
  return toCommentResponse(row);
}

/**
 * Editing is author-only, with no `:any` escape hatch: an adult rewriting a
 * child's words under the child's name is worse than leaving the typo.
 */
export async function editComment(
  exec: Executor,
  auth: AuthContext,
  commentId: string,
  input: { body: string },
): Promise<CommentResponse> {
  const existing = await repo.findCommentById(exec, commentId);
  if (!existing) throw notFound('Comment');
  await assertCanReadEntity(
    exec,
    { entityType: assertEntityType(existing.entityType), entityId: existing.entityId },
    auth,
  );
  if (existing.authorId !== auth.userId) throw forbidden('Only the author may edit a comment');

  const row = await repo.updateCommentBody(exec, commentId, input.body.trim());
  if (!row) throw notFound('Comment');
  return toCommentResponse(row);
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

  await repo.softDeleteComment(exec, commentId);
}

/* -------------------------------------------------------------------------- */
/* Reactions                                                                   */
/* -------------------------------------------------------------------------- */

export async function getReactionSummary(
  exec: Executor,
  auth: AuthContext,
  ref: { entityType: string; entityId: string },
): Promise<ReactionListResponse> {
  const entityType = assertEntityType(ref.entityType);
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
  const entityType = assertEntityType(ref.entityType);
  if (!auth.can('kudos:give')) throw forbidden('Missing permission: kudos:give');
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
  entityType: CommentableEntityType,
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
  const [commentsDeleted, reactionsDeleted] = await Promise.all([
    repo.softDeleteCommentsFor(tx, validated, entityId),
    repo.deleteReactionsFor(tx, validated, entityId),
  ]);
  return { comments: commentsDeleted, reactions: reactionsDeleted };
}
