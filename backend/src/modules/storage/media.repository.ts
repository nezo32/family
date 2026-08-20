import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { Executor } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import {
  mediaAttachments,
  type MediaAttachmentRow,
  type NewMediaAttachmentRow,
} from '../wall/wall.schema.js';

/**
 * Data access for `media_attachments`. No HTTP, no S3, no business rules (D8).
 *
 * The one thing worth reading twice is {@link lockAttachmentsForUpdate}: it is
 * what stops the same object being hung on two posts. Without the row lock, two
 * `POST /wall/posts` requests naming the same freshly uploaded id both read
 * "unattached", both write their own pointer, and the loser's post silently
 * loses its photo — or worse, deleting one post reclaims an object the other
 * one is still drawing.
 */

export async function insertAttachment(
  x: Executor,
  values: NewMediaAttachmentRow,
): Promise<MediaAttachmentRow> {
  const [row] = await x.insert(mediaAttachments).values(values).returning();
  if (!row) throw new AppError('INTERNAL_ERROR', 'media_attachments insert returned no row');
  return row;
}

export async function findAttachmentById(
  x: Executor,
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<MediaAttachmentRow | null> {
  const where = options.includeDeleted
    ? eq(mediaAttachments.id, id)
    : and(eq(mediaAttachments.id, id), isNull(mediaAttachments.deletedAt));
  const [row] = await x.select().from(mediaAttachments).where(where).limit(1);
  return row ?? null;
}

/**
 * The candidate rows for an attach, **locked for the rest of the transaction**.
 *
 * Ordered by id rather than by the caller's array so that two transactions
 * naming overlapping sets always take the locks in the same order — an
 * unordered `FOR UPDATE` over a set is a deadlock waiting for the one evening
 * two people post at the same second.
 */
export async function lockAttachmentsForUpdate(
  tx: Executor,
  ids: readonly string[],
): Promise<MediaAttachmentRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(mediaAttachments)
    .where(and(inArray(mediaAttachments.id, [...ids]), isNull(mediaAttachments.deletedAt)))
    .orderBy(asc(mediaAttachments.id))
    .for('update');
}

/** Hang one row on an entity, at a known position. */
export async function attachToEntity(
  tx: Executor,
  input: { id: string; entityType: string; entityId: string; sortOrder: number },
): Promise<void> {
  await tx
    .update(mediaAttachments)
    .set({
      entityType: input.entityType,
      entityId: input.entityId,
      sortOrder: input.sortOrder,
      attachedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mediaAttachments.id, input.id));
}

/** Move an already-attached row to a new position, for a reorder. */
export async function setSortOrder(tx: Executor, id: string, sortOrder: number): Promise<void> {
  await tx
    .update(mediaAttachments)
    .set({ sortOrder, updatedAt: new Date() })
    .where(eq(mediaAttachments.id, id));
}

/**
 * Everything hanging on a page of entities, in draw order, in one query.
 *
 * Same discipline as `countComments`: an array of ids in, a map out, never one
 * query per card.
 */
export async function loadAttachmentsFor(
  x: Executor,
  entityType: string,
  entityIds: readonly string[],
): Promise<Map<string, MediaAttachmentRow[]>> {
  const byEntity = new Map<string, MediaAttachmentRow[]>();
  if (entityIds.length === 0) return byEntity;

  const rows = await x
    .select()
    .from(mediaAttachments)
    .where(
      and(
        eq(mediaAttachments.entityType, entityType),
        inArray(mediaAttachments.entityId, [...entityIds]),
        isNull(mediaAttachments.deletedAt),
      ),
    )
    .orderBy(asc(mediaAttachments.sortOrder), asc(mediaAttachments.createdAt));

  for (const row of rows) {
    if (!row.entityId) continue;
    const list = byEntity.get(row.entityId);
    if (list) list.push(row);
    else byEntity.set(row.entityId, [row]);
  }
  return byEntity;
}

export async function listAttachmentsOf(
  x: Executor,
  entityType: string,
  entityId: string,
): Promise<MediaAttachmentRow[]> {
  return x
    .select()
    .from(mediaAttachments)
    .where(
      and(
        eq(mediaAttachments.entityType, entityType),
        eq(mediaAttachments.entityId, entityId),
        isNull(mediaAttachments.deletedAt),
      ),
    )
    .orderBy(asc(mediaAttachments.sortOrder), asc(mediaAttachments.createdAt))
    .for('update');
}

/**
 * Soft-delete everything on one entity, returning what was hit.
 *
 * **Objects are deliberately not touched here.** This is the cascade path — a
 * post was deleted, or a comment was — and those are soft deletes that a
 * moderator can be wrong about. The bytes stay until the sweep's grace period
 * expires, which is the difference between "removed from the wall" and
 * "destroyed".
 */
export async function softDeleteAttachmentsFor(
  tx: Executor,
  entityType: string,
  entityId: string,
): Promise<MediaAttachmentRow[]> {
  return tx
    .update(mediaAttachments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(mediaAttachments.entityType, entityType),
        eq(mediaAttachments.entityId, entityId),
        isNull(mediaAttachments.deletedAt),
      ),
    )
    .returning();
}

/** Hard delete. Only ever called once the object itself is gone, or about to be. */
export async function deleteAttachmentRows(
  tx: Executor,
  ids: readonly string[],
): Promise<MediaAttachmentRow[]> {
  if (ids.length === 0) return [];
  return tx
    .delete(mediaAttachments)
    .where(inArray(mediaAttachments.id, [...ids]))
    .returning();
}

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Drafts nobody ever posted: uploaded, never attached, older than the cutoff.
 *
 * This is the orphan class that attach-then-post creates, and it is the one we
 * chose knowingly — the alternative (post first, attach after) publishes a
 * half-formed note to the whole family instead, and still leaks an object when
 * the second call fails.
 */
export async function listAbandonedDrafts(
  x: Executor,
  cutoff: Date,
  limit: number,
): Promise<MediaAttachmentRow[]> {
  return x
    .select()
    .from(mediaAttachments)
    .where(
      and(
        isNull(mediaAttachments.entityId),
        isNull(mediaAttachments.deletedAt),
        lt(mediaAttachments.createdAt, cutoff),
      ),
    )
    .orderBy(asc(mediaAttachments.createdAt))
    .limit(limit);
}

/** Rows detached long enough ago that the delete is not coming back. */
export async function listDetachedBefore(
  x: Executor,
  cutoff: Date,
  limit: number,
): Promise<MediaAttachmentRow[]> {
  return x
    .select()
    .from(mediaAttachments)
    .where(
      and(sql`${mediaAttachments.deletedAt} is not null`, lt(mediaAttachments.deletedAt, cutoff)),
    )
    .orderBy(asc(mediaAttachments.deletedAt))
    .limit(limit);
}
