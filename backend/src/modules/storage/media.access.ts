import type { AuthContext } from '../../core/auth/context.js';
import type { Executor } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { assertCanReadEntity, assertEntityType } from '../wall/comments.service.js';
import { findCommentById } from '../wall/wall.repository.js';
import type { MediaAttachmentRow } from '../wall/wall.schema.js';

/**
 * "May this caller see these bytes?"
 *
 * Kept in its own file for one structural reason: it is the only part of the
 * media pipeline that needs the wall, and `media.service.ts` is imported *by*
 * the wall. Putting this function there would close a cycle — `wall.service` →
 * `media.service` → `comments.service` → … — that ESM would resolve at
 * module-init time, in an order nobody chose. Only the routes touch this file.
 *
 * ## The rule
 *
 * **A photo is exactly as private as the thing it hangs on.** Not more, not
 * less. That sentence is the whole design, and it is why this delegates to
 * `assertCanReadEntity` rather than re-deriving anything: a photo on a comment
 * on a private goal is readable exactly when that goal is, and if the goal's
 * rule changes tomorrow this follows it for free.
 *
 * A comment carries its own polymorphic pointer, so an attachment on a comment
 * is resolved in **two** hops: the comment must exist and not be deleted, and
 * then the comment's own target must be readable.
 *
 * Every refusal is a `404`. Not one of them is a `403`, because this is a `GET`
 * and a 403 on a read answers the question it was refusing to answer (D4) —
 * the same reason the avatar route carries `notFoundOnDeny`.
 */
export async function assertCanReadAttachment(
  exec: Executor,
  row: MediaAttachmentRow,
  auth: AuthContext,
): Promise<void> {
  // A draft belongs to the person who is still composing. Nobody else may even
  // learn the id exists — 404, never 403.
  if (row.entityId === null || row.entityType === null) {
    if (row.uploaderId !== auth.userId) throw notFound('Attachment');
    return;
  }

  if (row.entityType === 'post') {
    await assertCanReadEntity(exec, { entityType: 'post', entityId: row.entityId }, auth);
    return;
  }

  if (row.entityType === 'comment') {
    const comment = await findCommentById(exec, row.entityId);
    if (!comment) throw notFound('Attachment');
    await assertCanReadEntity(
      exec,
      { entityType: assertEntityType(comment.entityType), entityId: comment.entityId },
      auth,
    );
    return;
  }

  // A pointer to a type nothing can resolve is corruption, and corruption is
  // not something to serve bytes out of.
  throw notFound('Attachment');
}
