import { eq } from 'drizzle-orm';

import { buildAuthContext, type AuthContext } from '../../core/auth/context.js';
import type { Executor } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { users } from '../identity/users.schema.js';
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

/**
 * The member a playback ticket names, resolved against the database **now**.
 *
 * This is what makes a ticket a credential rather than a signed permission.
 * The token says who minted it and nothing more; every question that could have
 * changed since — is this member still active, do they still hold `media:read`,
 * is the note still there — is answered here and in `assertCanReadAttachment`,
 * on every single range request. A suspended member's outstanding tickets stop
 * working on their next seek.
 *
 * `null` for anybody who is not `active`, which the caller turns into a 404:
 * a rejected or suspended account must not learn from this endpoint that the
 * object exists (D4).
 *
 * The users table is read directly rather than through the identity module's
 * repository, which is the same rule `comments.service.ts` follows for its
 * access resolvers (D8: a module never imports another module's repository).
 */
export async function ticketActor(exec: Executor, userId: string): Promise<AuthContext | null> {
  const [user] = await exec.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.status !== 'active') return null;
  return buildAuthContext(user);
}
