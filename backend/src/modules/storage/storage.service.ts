import type { SelfUser } from '@family/shared';

import type { Db } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { toSelfUser } from '../identity/identity.service.js';
import { avatarObjectKey, avatarUrlFor, buildAvatarObjectName, parseAvatarUrl } from './avatar.js';
import { validateImageUpload } from './image.js';
import { requireStorage, type ObjectMetadata, type StoredObject } from './s3.adapter.js';
import * as repo from './storage.repository.js';

/**
 * Avatar business rules.
 *
 * The ordering in {@link setAvatar} is the interesting part and it is not
 * arbitrary:
 *
 *   1. validate the bytes          — cheapest, and the only security gate
 *   2. write the **new** object    — before any database change
 *   3. swap the URL in one locked transaction
 *   4. delete the **old** object   — after the commit
 *
 * Every other ordering has a failure mode that loses data rather than leaking
 * it. Writing the row first and the object second means a crash in between
 * leaves a member pointing at an object that does not exist — a broken face
 * with no way to fix it except uploading again. Deleting the old object before
 * the commit means a rollback leaves the member pointing at an object we just
 * removed. What this ordering can leak is a single orphaned object when step 3
 * or 4 fails, which costs a few kilobytes and nothing else.
 */

/** Serve-side cache policy. `private` — an avatar is behind a session, so no shared cache may keep it. */
export const AVATAR_CACHE_CONTROL = 'private, max-age=31536000, immutable';

export interface AvatarUpload {
  readonly bytes: Uint8Array;
  /** Whatever the client claimed. Checked, then discarded — see `image.ts`. */
  readonly declaredType: string | undefined;
}

/**
 * `POST /api/me/avatar`.
 *
 * Returns the updated `SelfUser` so the client can drop it straight into its
 * `/api/me` cache rather than firing a second request to find out what changed.
 */
export async function setAvatar(
  db: Db,
  userId: string,
  upload: AvatarUpload,
  maxBytes: number,
): Promise<SelfUser> {
  const storage = requireStorage();

  const image = validateImageUpload(upload.bytes, {
    declaredType: upload.declaredType,
    maxBytes,
  });

  const objectName = buildAvatarObjectName(image.contentType);
  const key = avatarObjectKey(userId, objectName);

  await storage.put({
    key,
    body: image.bytes,
    // From the magic bytes, never from the request. This value is echoed back
    // on every subsequent GET, so anything else here is a stored-XSS vector.
    contentType: image.contentType,
    cacheControl: AVATAR_CACHE_CONTROL,
  });

  const { user, previousKey } = await db.transaction(async (tx) => {
    const current = await repo.lockAvatarUrl(tx, userId);
    if (current === undefined) throw new AppError('NOT_FOUND', 'User not found');

    const row = await repo.setAvatarUrl(tx, userId, avatarUrlFor(userId, objectName));
    if (!row) throw new AppError('NOT_FOUND', 'User not found');

    return { user: row, previousKey: parseAvatarUrl(current)?.key ?? null };
  });

  // Best effort, and deliberately so: the swap has already committed, and
  // failing the whole request because a dead object survived would turn a
  // successful upload into an error the member cannot act on.
  if (previousKey && previousKey !== key) await removeQuietly(previousKey);

  return toSelfUser(user);
}

/**
 * `DELETE /api/me/avatar`.
 *
 * Idempotent: a member with no avatar gets a 200 and their unchanged profile.
 * An avatar that came from an OAuth provider (an absolute URL we never stored)
 * is cleared from the row and nothing is deleted from the bucket.
 */
export async function clearAvatar(db: Db, userId: string): Promise<SelfUser> {
  const { user, previousKey } = await db.transaction(async (tx) => {
    const current = await repo.lockAvatarUrl(tx, userId);
    if (current === undefined) throw new AppError('NOT_FOUND', 'User not found');

    const row = await repo.setAvatarUrl(tx, userId, null);
    if (!row) throw new AppError('NOT_FOUND', 'User not found');

    return { user: row, previousKey: parseAvatarUrl(current)?.key ?? null };
  });

  if (previousKey) await removeQuietly(previousKey);

  return toSelfUser(user);
}

/**
 * `GET /api/users/:id/avatar` — resolve the object to stream.
 *
 * The key comes from the **stored** `avatarUrl`, not from the request's `?v`.
 * That is what makes the cache-busting parameter free of security weight: a
 * caller who edits it still gets this member's current avatar or nothing.
 *
 * `null` means 404, and it means 404 for all four distinct causes — no such
 * user, no avatar set, an avatar hosted somewhere else, an object missing from
 * the bucket. Telling them apart would let an unauthenticated-ish probe map the
 * family's user ids (D4).
 */
export async function resolveAvatarKey(db: Db, userId: string): Promise<string | null> {
  const stored = await repo.findAvatarUrl(db, userId);
  if (stored === undefined) return null;

  const parsed = parseAvatarUrl(stored);
  // Belt and braces: the URL encodes the owner, and a row whose URL names a
  // different user is corruption we refuse to serve rather than follow.
  if (!parsed || parsed.userId !== userId) return null;

  return parsed.key;
}

/** Metadata for a conditional request. `null` for every "not here" cause. */
export async function statAvatar(db: Db, userId: string): Promise<ObjectMetadata | null> {
  const key = await resolveAvatarKey(db, userId);
  if (!key) return null;
  return requireStorage().head(key);
}

export async function openAvatar(db: Db, userId: string): Promise<StoredObject | null> {
  const key = await resolveAvatarKey(db, userId);
  if (!key) return null;
  return requireStorage().get(key);
}

async function removeQuietly(key: string): Promise<void> {
  try {
    await requireStorage().remove(key);
  } catch {
    /* orphaned object; the row is already correct */
  }
}
