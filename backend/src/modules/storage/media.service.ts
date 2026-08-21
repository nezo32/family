import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { MAX_ATTACHMENTS, MEDIA_LIMITS, type MediaAttachment } from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import type { Db, Executor } from '../../core/db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { MediaAttachmentRow } from '../wall/wall.schema.js';
import { MEDIA_EXTENSIONS, assertWithinLimits, sniffMedia, unsupportedMedia } from './media.js';
import { probeMedia, type ByteSource } from './media.probe.js';
import * as repo from './media.repository.js';
import { requireStorage, type ObjectMetadata, type StoredObject } from './s3.adapter.js';

/**
 * Media business rules: upload, attach, detach, serve, sweep.
 *
 * ## What this module may import, and why it matters
 *
 * Nothing from `modules/wall/*` except the **schema**. The wall calls *into*
 * here (a post attaches its media inside its own transaction), so an import in
 * the other direction would be a cycle at module-init time. The one thing that
 * genuinely needs the wall — "may this caller read the comment this photo hangs
 * on?" — lives in `media.access.ts`, which only the routes touch.
 *
 * ## The ordering, which is the same one avatars settled on
 *
 *   1. spool to disk        — bounded memory, seekable for the probe
 *   2. sniff and probe      — the security gate and the limit gate
 *   3. write the object     — before any database row exists
 *   4. insert the row       — a draft, attached to nothing yet
 *
 * A crash between 3 and 4 leaks one object with no row, which is why step 4 is
 * wrapped: a failed insert removes the object it was about to reference.
 * Everything else fails closed — no row is ever written for bytes that are not
 * in the bucket.
 */

/** Serve-side cache policy. Identical to avatars: the id never changes content. */
export const MEDIA_CACHE_CONTROL = 'private, max-age=31536000, immutable';

const MEDIA_PREFIX = 'media';

/** 16 bytes, so the object name is not derivable from the id alone. */
const OBJECT_NAME_BYTES = 16;

/**
 * What may hold media. **Narrower than `COMMENTABLE_ENTITY_TYPES` on purpose.**
 *
 * A photo hangs on a note or on a reply. A task, an event and a goal take
 * *comments*, and a comment takes media — so media reaches them through the
 * thread without this set having to grow, and without every module that deletes
 * something having to learn about objects.
 */
export const ATTACHABLE_ENTITY_TYPES = ['post', 'comment'] as const;
export type AttachableEntityType = (typeof ATTACHABLE_ENTITY_TYPES)[number];

/**
 * How long an unposted draft lives before the sweep reclaims it.
 *
 * A day, because a composer left open overnight on a phone is a real thing and
 * losing somebody's uploaded photo out from under a half-written note is worse
 * than storing it for another twelve hours.
 */
export const DRAFT_TTL_HOURS = 24;

/**
 * How long a detached object survives before its bytes go.
 *
 * A deleted post is a *soft* delete: the row is still there, the comments are
 * still there, and this is the window in which "восстановите, я не то удалил"
 * is still answerable. Thirty days, then the bytes are gone for good — the
 * grace period is the whole reason the cascade does not delete objects.
 */
export const DETACHED_GRACE_DAYS = 30;

/* -------------------------------------------------------------------------- */
/* Keys and URLs                                                               */
/* -------------------------------------------------------------------------- */

export function mediaObjectKey(id: string, objectName: string): string {
  return `${MEDIA_PREFIX}/${id}/${objectName}`;
}

/**
 * The URL the client gets. Note what it is **not**: a bucket URL, a presigned
 * link or anything the client could have constructed. The id is ours, the path
 * is ours, and the object it resolves to is read from the row — a client that
 * edits this string gets somebody else's 404, never somebody else's bytes.
 */
export function mediaUrlFor(id: string): string {
  return `/api/media/${id}`;
}

export function toMediaAttachment(row: MediaAttachmentRow): MediaAttachment {
  return {
    id: row.id,
    kind: row.kind,
    contentType: row.contentType,
    url: mediaUrlFor(row.id),
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                      */
/* -------------------------------------------------------------------------- */

export interface MediaUpload {
  /** The multipart part's stream. Never buffered whole — see the header. */
  readonly file: Readable;
  /** Whatever the client claimed. Logged, never stored, never trusted. */
  readonly declaredType: string | undefined;
  /** `true` when the parser hit its byte cap. A truncated video is not a video. */
  truncated(): boolean;
}

/**
 * `POST /api/media`.
 *
 * Spools to `os.tmpdir()` rather than to a Buffer, and that is the single
 * biggest departure from the avatar path. A 2 MB avatar in memory is nothing;
 * a 100 MB video per concurrent upload, on a VDI that also runs Postgres, Redis
 * and the object store, is an OOM waiting for the evening everybody posts at
 * once. The temp file is also what makes the probe possible at all: `moov` is
 * at the **end** of a phone-recorded video, and a stream cannot seek.
 */
export async function uploadMedia(
  db: Db,
  auth: AuthContext,
  upload: MediaUpload,
): Promise<MediaAttachment> {
  const storage = requireStorage();
  const id = randomUUID();
  const tempPath = join(tmpdir(), `family-upload-${id}`);

  try {
    await pipeline(upload.file, createWriteStream(tempPath));

    if (upload.truncated()) {
      // The parser stopped at its ceiling. We do not know the kind yet, so the
      // message names the largest limit; the per-kind 413 below is the precise
      // one and fires whenever the file did fit through the parser.
      throw new AppError('PAYLOAD_TOO_LARGE', 'Upload exceeded the transport limit', {
        details: {
          file: [
            `Файл больше ${String(Math.round(MEDIA_LIMITS.video.maxBytes / (1024 * 1024)))} МБ — ` +
              'столько мы не принимаем ни для видео, ни тем более для фото.',
          ],
        },
      });
    }

    const { size } = await stat(tempPath);
    if (size === 0) throw badRequest('Uploaded file is empty', { file: ['Файл пустой.'] });

    const handle = await open(tempPath, 'r');
    let probed;
    let head: Buffer;
    try {
      const source: ByteSource = {
        size,
        read: async (offset, length) => {
          const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
          if (buffer.length === 0) return buffer;
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          return buffer.subarray(0, bytesRead);
        },
      };

      head = await source.read(0, 4096);
      const sniff = sniffMedia(head);
      if (!sniff.ok) {
        unsupportedMedia(sniff.reason, { declaredType: upload.declaredType ?? null });
      }
      probed = await probeMedia(source, sniff.sniffed, head);
    } finally {
      await handle.close();
    }

    assertWithinLimits(probed, size);

    const objectName = `${randomBytes(OBJECT_NAME_BYTES).toString('hex')}.${
      MEDIA_EXTENSIONS[probed.contentType]
    }`;
    const key = mediaObjectKey(id, objectName);

    await storage.putStream({
      key,
      body: createReadStream(tempPath),
      contentLength: size,
      // From the container, never from the request. This value is echoed on
      // every GET, so anything else here is a stored-XSS vector.
      contentType: probed.contentType,
      cacheControl: MEDIA_CACHE_CONTROL,
    });

    try {
      const row = await repo.insertAttachment(db, {
        id,
        uploaderId: auth.userId,
        kind: probed.kind,
        contentType: probed.contentType,
        objectKey: key,
        byteSize: size,
        width: probed.width,
        height: probed.height,
        durationMs: probed.durationMs,
      });
      return toMediaAttachment(row);
    } catch (error) {
      // An object with no row is invisible to the sweep — it has nothing to
      // scan. Undo it here, while we still hold the only reference.
      await removeQuietly(key);
      throw error;
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => {
      /* a temp file that outlives the request is the OS's problem, not the member's */
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Attaching                                                                   */
/* -------------------------------------------------------------------------- */

function assertAttachable(entityType: string): AttachableEntityType {
  if (!(ATTACHABLE_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    throw badRequest(`Entity type ${entityType} cannot hold media`);
  }
  return entityType as AttachableEntityType;
}

/**
 * Hang a set of freshly uploaded ids on a brand-new entity, in array order.
 *
 * Called **inside the entity's own transaction** — that is the whole contract.
 * A post that fails to save must not leave its photos claimed, and a photo that
 * turns out to belong to somebody else must stop the post.
 *
 * Every id is checked for four things, and each one is a real failure:
 *
 * - it exists (`404` — an id from a stale composer)
 * - it belongs to the caller (`403` — an id from somebody else's draft; the
 *   uploader is the only person who has ever seen it)
 * - it is not already attached (`409` — one object, one place; two pointers
 *   would make deletion ambiguous)
 * - there are no more than `MAX_ATTACHMENTS` of them
 */
export async function attachMediaTo(
  tx: Executor,
  input: {
    entityType: string;
    entityId: string;
    uploaderId: string;
    attachmentIds: readonly string[];
  },
): Promise<MediaAttachmentRow[]> {
  const entityType = assertAttachable(input.entityType);
  const ids = dedupe(input.attachmentIds);
  if (ids.length === 0) return [];
  assertCount(ids.length);

  const rows = await repo.lockAttachmentsForUpdate(tx, ids);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const attached: MediaAttachmentRow[] = [];
  for (const [index, id] of ids.entries()) {
    const row = byId.get(id);
    if (!row) throw notFound('Attachment');
    if (row.uploaderId !== input.uploaderId) {
      throw forbidden('Only the uploader may attach their own media');
    }
    if (row.entityId !== null) {
      throw conflict('This media is already attached to something else');
    }
    await repo.attachToEntity(tx, {
      id,
      entityType,
      entityId: input.entityId,
      sortOrder: index,
    });
    attached.push(row);
  }
  return attached;
}

export interface ReconcileResult {
  /** Object keys whose rows are gone. Removed **after** the commit, never inside it. */
  readonly removedKeys: readonly string[];
}

/**
 * Make the entity's media exactly `attachmentIds`, in that order.
 *
 * The array is the whole set: an id left out is an id the writer removed, and
 * removing a photo from your own note is a deliberate editorial act — so its
 * row **and its object** go, immediately, the same way replacing an avatar
 * deletes the previous object. That is the opposite of the cascade path, which
 * keeps bytes for thirty days, and the difference is who decided: a person
 * editing one photo out, versus a moderator deleting a whole note.
 *
 * Object removal is returned rather than performed, because it must happen
 * after the transaction commits — a rollback that had already deleted bytes is
 * unrecoverable.
 */
export async function reconcileAttachments(
  tx: Executor,
  input: {
    entityType: string;
    entityId: string;
    uploaderId: string;
    attachmentIds: readonly string[];
  },
): Promise<ReconcileResult> {
  const entityType = assertAttachable(input.entityType);
  const ids = dedupe(input.attachmentIds);
  assertCount(ids.length);

  const existing = await repo.listAttachmentsOf(tx, entityType, input.entityId);
  const existingIds = new Set(existing.map((row) => row.id));
  const keep = new Set(ids);

  const removed = existing.filter((row) => !keep.has(row.id));
  await repo.deleteAttachmentRows(
    tx,
    removed.map((row) => row.id),
  );

  const incoming = ids.filter((id) => !existingIds.has(id));
  if (incoming.length > 0) {
    const rows = await repo.lockAttachmentsForUpdate(tx, incoming);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of incoming) {
      const row = byId.get(id);
      if (!row) throw notFound('Attachment');
      if (row.uploaderId !== input.uploaderId) {
        throw forbidden('Only the uploader may attach their own media');
      }
      if (row.entityId !== null) {
        throw conflict('This media is already attached to something else');
      }
    }
  }

  // One pass for the final order, so a pure reorder is as cheap as an append.
  for (const [index, id] of ids.entries()) {
    if (existingIds.has(id)) {
      await repo.setSortOrder(tx, id, index);
    } else {
      await repo.attachToEntity(tx, {
        id,
        entityType,
        entityId: input.entityId,
        sortOrder: index,
      });
    }
  }

  return { removedKeys: removed.map((row) => row.objectKey) };
}

/**
 * **Call this from every module that deletes something that can hold media**,
 * inside the same transaction as the delete — exactly like `deleteCommentsFor`.
 *
 * Soft delete only: the rows stop being returned, the bytes stay for
 * {@link DETACHED_GRACE_DAYS}. There is no `ON DELETE CASCADE` to lean on and
 * there never will be, because `(entity_type, entity_id)` is a polymorphic
 * pointer with no foreign key.
 */
export async function detachAllFrom(
  tx: Executor,
  entityType: string,
  entityId: string,
): Promise<number> {
  const rows = await repo.softDeleteAttachmentsFor(tx, assertAttachable(entityType), entityId);
  return rows.length;
}

/** Same, for a set of entities — the comments of a deleted post, in one call. */
export async function detachAllFromMany(
  tx: Executor,
  entityType: string,
  entityIds: readonly string[],
): Promise<number> {
  let total = 0;
  for (const entityId of entityIds) {
    total += await detachAllFrom(tx, entityType, entityId);
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** Attachments for a whole page of entities. One query, no N+1. */
export async function attachmentsForPage(
  exec: Executor,
  entityType: string,
  entityIds: readonly string[],
): Promise<Map<string, MediaAttachment[]>> {
  const rows = await repo.loadAttachmentsFor(exec, entityType, entityIds);
  const out = new Map<string, MediaAttachment[]>();
  for (const [entityId, list] of rows) out.set(entityId, list.map(toMediaAttachment));
  return out;
}

export async function attachmentsOf(
  exec: Executor,
  entityType: string,
  entityId: string,
): Promise<MediaAttachment[]> {
  const map = await attachmentsForPage(exec, entityType, [entityId]);
  return map.get(entityId) ?? [];
}

/**
 * What a card is allowed to say about its media, for **this** reader.
 *
 * The permission check lives here — one function, called by every mapper on
 * both sides of the wall — rather than in each of the six places that build a
 * `PostResponse` or a `CommentResponse`. Five of those would stay correct and
 * the sixth is the one that ships a photo to a `guest`.
 *
 * Without `media:read` the reader gets the **count and nothing else**: no id,
 * no `/api/media/…` url, no content type, no dimensions. The count is what lets
 * the card draw «Фото — только для семьи» in place of the box (§D7.14.10)
 * instead of rendering a note that looks like it was written empty. Everything
 * that would let the reader go and ask for the bytes is withheld — and the
 * delivery route refuses them anyway, with a 404 (D4). Both halves, because the
 * response shape is not a security boundary on its own and the route is not a
 * product decision on its own.
 */
export interface VisibleAttachments {
  readonly attachments: MediaAttachment[];
  readonly hiddenAttachments: number;
}

export function visibleAttachmentsFor(
  auth: Pick<AuthContext, 'can'>,
  attachments: MediaAttachment[],
): VisibleAttachments {
  if (auth.can('media:read')) return { attachments, hiddenAttachments: 0 };
  return { attachments: [], hiddenAttachments: attachments.length };
}

export async function findAttachment(
  exec: Executor,
  id: string,
): Promise<MediaAttachmentRow | null> {
  return repo.findAttachmentById(exec, id);
}

export async function statMedia(row: MediaAttachmentRow): Promise<ObjectMetadata | null> {
  return requireStorage().head(row.objectKey);
}

export async function openMedia(
  row: MediaAttachmentRow,
  options: { range?: string | undefined } = {},
): Promise<StoredObject | null> {
  return requireStorage().get(row.objectKey, options);
}

/* -------------------------------------------------------------------------- */
/* Deleting a draft                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `DELETE /api/media/:id` — the composer's «убрать» before anything is posted.
 *
 * Only a draft, and only your own. Media that is already on a post is changed
 * by editing the post's `attachmentIds`, so that the removal and the note it
 * belongs to commit together; a delete endpoint that could reach into a
 * published post would be a second way to edit somebody's note, with none of
 * the post's own permission rules.
 */
export async function deleteDraft(db: Db, auth: AuthContext, id: string): Promise<void> {
  const key = await db.transaction(async (tx) => {
    const [row] = await repo.lockAttachmentsForUpdate(tx, [id]);
    // 404 rather than 403 for somebody else's draft: an id nobody but its
    // uploader has ever seen must not be confirmed to exist (D4).
    if (!row || row.uploaderId !== auth.userId) throw notFound('Attachment');
    if (row.entityId !== null) {
      throw conflict('This media is attached to a post — edit the post instead');
    }
    await repo.deleteAttachmentRows(tx, [id]);
    return row.objectKey;
  });

  await removeQuietly(key);
}

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

export interface SweepResult {
  readonly drafts: number;
  readonly detached: number;
  /**
   * Rows whose object the store refused to give up — kept, to be retried.
   *
   * Reported rather than merely logged so the scheduled caller can tell "there
   * was nothing to reclaim" apart from "the store is down and I reclaimed
   * nothing". Both return zeroes otherwise, and the second one is the shape
   * that quietly stops working for a month.
   */
  readonly failed: number;
}

/**
 * Reclaim bytes nothing points at any more.
 *
 * Two populations, and **only** these two:
 *
 * - drafts older than {@link DRAFT_TTL_HOURS} that were never posted;
 * - rows detached more than {@link DETACHED_GRACE_DAYS} ago.
 *
 * What it must **never** touch: anything behind the «Очистить доску» horizon.
 * A cleared wall is hidden, not deleted (§D7.11) — the posts, their comments
 * and their photos are all still there and an undo puts the whole board back.
 * A sweep keyed off the horizon would turn a reversible product decision into
 * an irreversible data loss, so the horizon is not an input here at all.
 *
 * The object goes first and the row second: an object deleted without its row
 * is a broken card that the *next* sweep will clean up, while a row deleted
 * without its object is a byte leak nothing can ever find again.
 *
 * So a store that is down or unreachable costs nothing: every removal that
 * throws leaves its row exactly where it was, counted in {@link
 * SweepResult.failed}, and tomorrow's run — or the retry BullMQ schedules for
 * `maintenance.sweep-media` — tries again. Re-running is always safe: the two
 * queries select on state the previous run already changed, so a second pass
 * over the same window finds nothing left to do.
 */
export async function sweepOrphanedMedia(
  db: Db,
  options: { now?: Date; batch?: number } = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const batch = options.batch ?? 200;

  const draftCutoff = new Date(now.getTime() - DRAFT_TTL_HOURS * 60 * 60 * 1000);
  const detachedCutoff = new Date(now.getTime() - DETACHED_GRACE_DAYS * 24 * 60 * 60 * 1000);

  const [drafts, detached] = await Promise.all([
    repo.listAbandonedDrafts(db, draftCutoff, batch),
    repo.listDetachedBefore(db, detachedCutoff, batch),
  ]);

  const victims = [...drafts, ...detached];
  if (victims.length === 0) return { drafts: 0, detached: 0, failed: 0 };

  const reclaimed: string[] = [];
  let failed = 0;
  for (const row of victims) {
    try {
      await requireStorage().remove(row.objectKey);
      reclaimed.push(row.id);
    } catch (error) {
      // Leave the row alone: the next run tries again. Dropping it here would
      // orphan the object permanently.
      failed += 1;
      logger.warn({ err: error, key: row.objectKey }, 'could not reclaim a media object');
    }
  }
  await repo.deleteAttachmentRows(db, reclaimed);

  const reclaimedSet = new Set(reclaimed);
  return {
    drafts: drafts.filter((row) => reclaimedSet.has(row.id)).length,
    detached: detached.filter((row) => reclaimedSet.has(row.id)).length,
    failed,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Best effort, deliberately: the row is already correct and the member is done. */
export async function removeQuietly(key: string): Promise<void> {
  try {
    await requireStorage().remove(key);
  } catch (error) {
    logger.warn({ err: error, key }, 'orphaned media object left in the bucket');
  }
}

export async function removeAllQuietly(keys: readonly string[]): Promise<void> {
  for (const key of keys) await removeQuietly(key);
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function assertCount(count: number): void {
  if (count > MAX_ATTACHMENTS) {
    throw badRequest(`At most ${String(MAX_ATTACHMENTS)} attachments`, {
      attachmentIds: [`Не больше ${String(MAX_ATTACHMENTS)} файлов на одну запись.`],
    });
  }
}
