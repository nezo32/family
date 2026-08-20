import { eq } from 'drizzle-orm';

import type { Executor } from '../../core/db.js';
import { users, type UserRow } from '../identity/users.schema.js';

/**
 * Data access for the avatar column. No HTTP, no S3, no business rules (D8).
 *
 * `users.avatarUrl` is the only column this module owns, and it deliberately
 * stays a plain nullable text column — the object key is recoverable from the
 * URL (see `avatar.ts`), so adding a second column would be duplicating state
 * that can then disagree with itself.
 */

/**
 * The current avatar URL **with the row locked for the rest of the transaction**.
 *
 * The lock is what makes "write the new object, then delete the old one" safe.
 * Without it two uploads racing each other both read the same previous URL,
 * both overwrite it, and the object belonging to the losing write is never
 * referenced again and never deleted — a slow leak that only shows up as a
 * bucket that grows and never shrinks.
 */
export async function lockAvatarUrl(x: Executor, userId: string): Promise<string | null | undefined> {
  const [row] = await x
    .select({ avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for('update');
  return row?.avatarUrl;
}

/** The avatar URL of any member, for the serving route. `undefined` = no such user. */
export async function findAvatarUrl(x: Executor, userId: string): Promise<string | null | undefined> {
  const [row] = await x
    .select({ avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.avatarUrl;
}

/** Set (or clear) the avatar URL, returning the full row for the response. */
export async function setAvatarUrl(
  x: Executor,
  userId: string,
  avatarUrl: string | null,
): Promise<UserRow | undefined> {
  const [row] = await x
    .update(users)
    .set({ avatarUrl, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return row;
}
