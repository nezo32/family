import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { AuthProvider, Role, UserStatus } from '@family/shared';

import type { Executor } from '../../core/db.js';
import {
  auditLog,
  familySettings,
  oauthTransactions,
  refreshTokens,
  userIdentities,
  type FamilySettingsRow,
  type NewAuditLogRow,
  type NewOAuthTransactionRow,
  type NewRefreshTokenRow,
  type NewUserIdentityRow,
  type OAuthTransactionRow,
  type RefreshRevokeReason,
  type RefreshTokenRow,
  type UserIdentityRow,
} from './identity.schema.js';
import { users, type NewUserRow, type UserRow } from './users.schema.js';

/**
 * Data access for the identity module.
 *
 * Every function takes an `Executor` first (D8) so the caller decides whether it
 * runs on the pool or inside an open transaction — the approval flow, the
 * rotation flow and the unlink guard all need several of these to share one
 * transaction and one set of row locks.
 *
 * Nothing here knows about HTTP, and nothing here throws `AppError`: a repository
 * reports "no row", the service decides whether that is a 404, a 409 or fine.
 */

/* ========================================================================== */
/* users                                                                      */
/* ========================================================================== */

export async function findUserById(x: Executor, id: string): Promise<UserRow | undefined> {
  const [row] = await x.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

/**
 * Case-insensitive lookup, matching the partial `users_email_lower_uq` index so
 * the planner uses it instead of scanning.
 */
export async function findUserByEmail(x: Executor, email: string): Promise<UserRow | undefined> {
  const [row] = await x
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return row;
}

/**
 * Takes a row lock for the duration of the transaction.
 *
 * Used by the unlink guard: counting login methods and deleting one must not
 * interleave with another request doing the same, or two concurrent unlinks each
 * see "2 methods" and between them remove both.
 */
export async function lockUser(x: Executor, id: string): Promise<UserRow | undefined> {
  const [row] = await x.select().from(users).where(eq(users.id, id)).limit(1).for('update');
  return row;
}

export async function countUsers(x: Executor): Promise<number> {
  const [row] = await x.select({ value: count() }).from(users);
  return row?.value ?? 0;
}

export async function countByStatus(x: Executor, status: UserStatus): Promise<number> {
  const [row] = await x.select({ value: count() }).from(users).where(eq(users.status, status));
  return row?.value ?? 0;
}

/**
 * Active owners, optionally excluding one id.
 *
 * The exclusion is what makes the last-owner guard usable: "would this change
 * leave zero owners" is `countActiveOwners(tx, targetId) === 0`.
 */
export async function countActiveOwners(x: Executor, excludeUserId?: string): Promise<number> {
  const predicate = excludeUserId
    ? and(eq(users.role, 'owner'), eq(users.status, 'active'), sql`${users.id} <> ${excludeUserId}`)
    : and(eq(users.role, 'owner'), eq(users.status, 'active'));

  const [row] = await x.select({ value: count() }).from(users).where(predicate);
  return row?.value ?? 0;
}

export async function insertUser(x: Executor, values: NewUserRow): Promise<UserRow> {
  const [row] = await x.insert(users).values(values).returning();
  if (!row) throw new Error('insertUser returned no row');
  return row;
}

export async function updateUser(
  x: Executor,
  id: string,
  patch: Partial<NewUserRow>,
): Promise<UserRow | undefined> {
  const [row] = await x
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return row;
}

/**
 * The conditional status transition behind approve / reject / suspend /
 * reactivate (D3).
 *
 * The `status = $from` predicate is the whole point: two admins clicking
 * "approve" at the same instant both run this statement, exactly one updates a
 * row, and the loser gets `undefined` — which the service turns into a `409`.
 * Doing it as read-then-write would let both succeed.
 */
export async function transitionUserStatus(
  x: Executor,
  id: string,
  from: UserStatus,
  patch: Partial<NewUserRow> & { status: UserStatus },
): Promise<UserRow | undefined> {
  const [row] = await x
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(users.id, id), eq(users.status, from)))
    .returning();
  return row;
}

export interface MemberFilter {
  status?: UserStatus;
  role?: Role;
}

export async function listUsers(x: Executor, filter: MemberFilter = {}): Promise<UserRow[]> {
  const conditions = [
    filter.status ? eq(users.status, filter.status) : undefined,
    filter.role ? eq(users.role, filter.role) : undefined,
  ].filter((c) => c !== undefined);

  const query = x.select().from(users);
  const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;

  return filtered.orderBy(asc(users.sortOrder), asc(users.displayName));
}

export async function touchLastLogin(x: Executor, id: string): Promise<void> {
  const now = new Date();
  await x.update(users).set({ lastLoginAt: now, lastSeenAt: now }).where(eq(users.id, id));
}

/**
 * Serialises the "is this the very first user" decision (D3 bootstrap rule).
 *
 * `SELECT count(*)` under READ COMMITTED is not a lock: two simultaneous first
 * registrations would both see zero users and both become `owner`. A transaction
 * advisory lock costs one round trip and removes the race entirely.
 */
export async function lockBootstrap(x: Executor): Promise<void> {
  // Arbitrary but stable key; nothing else in the app takes an advisory lock.
  await x.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
}

const BOOTSTRAP_LOCK_KEY = 7_243_119;

/* ========================================================================== */
/* user_identities                                                            */
/* ========================================================================== */

export async function listIdentities(x: Executor, userId: string): Promise<UserIdentityRow[]> {
  return x
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .orderBy(asc(userIdentities.linkedAt));
}

/** The identity join key is always `(provider, providerUserId)` — never email (D3). */
export async function findIdentityBySubject(
  x: Executor,
  provider: AuthProvider,
  providerUserId: string,
): Promise<UserIdentityRow | undefined> {
  const [row] = await x
    .select()
    .from(userIdentities)
    .where(
      and(eq(userIdentities.provider, provider), eq(userIdentities.providerUserId, providerUserId)),
    )
    .limit(1);
  return row;
}

export async function findIdentityForUser(
  x: Executor,
  userId: string,
  provider: AuthProvider,
): Promise<UserIdentityRow | undefined> {
  const [row] = await x
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)))
    .limit(1);
  return row;
}

export async function insertIdentity(
  x: Executor,
  values: NewUserIdentityRow,
): Promise<UserIdentityRow> {
  const [row] = await x.insert(userIdentities).values(values).returning();
  if (!row) throw new Error('insertIdentity returned no row');
  return row;
}

export async function touchIdentityLogin(x: Executor, id: string): Promise<void> {
  await x
    .update(userIdentities)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(userIdentities.id, id));
}

export async function deleteIdentity(
  x: Executor,
  userId: string,
  provider: AuthProvider,
): Promise<UserIdentityRow | undefined> {
  const [row] = await x
    .delete(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)))
    .returning();
  return row;
}

/**
 * Every distinct way this user can sign in.
 *
 * `password` counts as a login method even when there is no `user_identities`
 * row for it, because the credential itself lives in `users.password_hash`.
 * Miss that and a user can unlink their last OAuth identity "safely" while
 * actually still having a password — or, worse, the reverse.
 */
export async function loginMethodsOf(
  x: Executor,
  user: Pick<UserRow, 'id' | 'passwordHash'>,
): Promise<AuthProvider[]> {
  const rows = await x
    .select({ provider: userIdentities.provider })
    .from(userIdentities)
    .where(eq(userIdentities.userId, user.id));

  const methods = new Set<AuthProvider>(rows.map((r) => r.provider));
  if (user.passwordHash) methods.add('password');
  return [...methods];
}

/* ========================================================================== */
/* oauth_transactions                                                          */
/* ========================================================================== */

export async function insertOAuthTransaction(
  x: Executor,
  values: NewOAuthTransactionRow,
): Promise<OAuthTransactionRow> {
  const [row] = await x.insert(oauthTransactions).values(values).returning();
  if (!row) throw new Error('insertOAuthTransaction returned no row');
  return row;
}

/**
 * `DELETE ... RETURNING` — the delete *is* the single-use guard.
 *
 * A read-then-delete would let a replayed callback be processed twice in the
 * window between the two statements. Returns `undefined` when the state is
 * unknown, already consumed, or expired (checked by the caller against
 * `expiresAt`).
 */
export async function consumeOAuthTransaction(
  x: Executor,
  state: string,
): Promise<OAuthTransactionRow | undefined> {
  const [row] = await x
    .delete(oauthTransactions)
    .where(eq(oauthTransactions.state, state))
    .returning();
  return row;
}

export async function deleteExpiredOAuthTransactions(x: Executor): Promise<void> {
  await x.delete(oauthTransactions).where(sql`${oauthTransactions.expiresAt} < now()`);
}

/* ========================================================================== */
/* refresh_tokens                                                              */
/* ========================================================================== */

export async function insertRefreshToken(
  x: Executor,
  values: NewRefreshTokenRow,
): Promise<RefreshTokenRow> {
  const [row] = await x.insert(refreshTokens).values(values).returning();
  if (!row) throw new Error('insertRefreshToken returned no row');
  return row;
}

/**
 * The rotation lookup.
 *
 * `FOR UPDATE` is what serialises two simultaneous refreshes of the same token:
 * the loser blocks here until the winner commits, then re-reads the row and sees
 * `used_at` set, which sends it down the grace branch instead of minting a
 * second successor.
 */
export async function lockRefreshTokenByHash(
  x: Executor,
  tokenHash: string,
): Promise<RefreshTokenRow | undefined> {
  const [row] = await x
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1)
    .for('update');
  return row;
}

export async function findRefreshTokenByHash(
  x: Executor,
  tokenHash: string,
): Promise<RefreshTokenRow | undefined> {
  const [row] = await x
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  return row;
}

/**
 * *The* live successor of a rotated token.
 *
 * `LIMIT 1` ordered by generation is deliberate: the whole point of the grace
 * window is that a concurrent refresh joins the existing chain rather than
 * forking it, so this must resolve to one row even if a historical bug ever left
 * two. Revoked successors are excluded — a successor that was itself revoked
 * means the family is dead and this is a replay, not a benign race.
 */
export async function findLiveSuccessor(
  x: Executor,
  prevTokenId: string,
): Promise<RefreshTokenRow | undefined> {
  const [row] = await x
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.prevTokenId, prevTokenId), isNull(refreshTokens.revokedAt)))
    .orderBy(asc(refreshTokens.generation), asc(refreshTokens.issuedAt))
    .limit(1);
  return row;
}

/**
 * The newest still-live generation of a family, ignoring one row.
 *
 * The grace branch's fallback: with three tabs refreshing at once the direct
 * successor of the presented token may itself already have been rotated, and
 * only "does this family still have a live head" distinguishes that benign burst
 * from a genuine replay.
 */
export async function findLiveFamilyHead(
  x: Executor,
  familyId: string,
  excludeId: string,
): Promise<RefreshTokenRow | undefined> {
  const [row] = await x
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.familyId, familyId),
        isNull(refreshTokens.revokedAt),
        sql`${refreshTokens.id} <> ${excludeId}`,
      ),
    )
    .orderBy(desc(refreshTokens.generation), desc(refreshTokens.issuedAt))
    .limit(1);
  return row;
}

/**
 * Consumes one generation.
 *
 * The `used_at IS NULL` predicate is the concurrency guard (see the state
 * machine in `docs/architecture/identity.md`): zero rows updated means another
 * request already rotated this token, so the caller must fall into the grace
 * branch rather than proceeding.
 */
export async function consumeRefreshToken(
  x: Executor,
  id: string,
): Promise<RefreshTokenRow | undefined> {
  const now = new Date();
  const [row] = await x
    .update(refreshTokens)
    .set({ usedAt: now, revokedAt: now, revokedReason: 'rotated' })
    .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.usedAt)))
    .returning();
  return row;
}

/** Revokes every live generation of one family. Idempotent. */
export async function revokeFamilyRows(
  x: Executor,
  familyId: string,
  reason: RefreshRevokeReason,
): Promise<number> {
  const rows = await x
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return rows.length;
}

/** Revokes every live family of one user. Idempotent. */
export async function revokeUserRows(
  x: Executor,
  userId: string,
  reason: RefreshRevokeReason,
  exceptFamilyId?: string,
): Promise<number> {
  const predicate = exceptFamilyId
    ? and(
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
        sql`${refreshTokens.familyId} <> ${exceptFamilyId}`,
      )
    : and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt));

  const rows = await x
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(predicate)
    .returning({ id: refreshTokens.id });
  return rows.length;
}

export async function revokeFamiliesForUsers(
  x: Executor,
  userIds: string[],
  reason: RefreshRevokeReason,
): Promise<number> {
  if (userIds.length === 0) return 0;
  const rows = await x
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(inArray(refreshTokens.userId, userIds), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return rows.length;
}

/** Backs the active-sessions screen: the live head of each family, newest first. */
export async function listLiveRefreshTokens(
  x: Executor,
  userId: string,
): Promise<RefreshTokenRow[]> {
  return x
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .orderBy(desc(refreshTokens.issuedAt));
}

export async function deleteExpiredRefreshTokens(x: Executor): Promise<void> {
  await x.delete(refreshTokens).where(sql`${refreshTokens.expiresAt} < now()`);
}

/* ========================================================================== */
/* family_settings                                                             */
/* ========================================================================== */

/**
 * The singleton family row (D1).
 *
 * `singleton` carries a unique index plus a CHECK, so the insert can race
 * harmlessly: whoever loses `onConflictDoNothing` simply re-reads the winner's
 * row. Never returns `undefined` — the caller always gets configuration.
 */
export async function getFamilySettings(x: Executor): Promise<FamilySettingsRow> {
  const [existing] = await x.select().from(familySettings).limit(1);
  if (existing) return existing;

  await x
    .insert(familySettings)
    .values({ singleton: true })
    .onConflictDoNothing({ target: familySettings.singleton });

  const [created] = await x.select().from(familySettings).limit(1);
  if (!created) throw new Error('family_settings singleton could not be created');
  return created;
}

export async function updateFamilySettings(
  x: Executor,
  patch: Partial<FamilySettingsRow>,
): Promise<FamilySettingsRow> {
  const current = await getFamilySettings(x);
  const [row] = await x
    .update(familySettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(familySettings.id, current.id))
    .returning();
  if (!row) throw new Error('family_settings update affected no row');
  return row;
}

/* ========================================================================== */
/* audit_log                                                                   */
/* ========================================================================== */

/**
 * Append-only. Written inside the same transaction as the mutation it records,
 * so a failed audit write fails the mutation (`docs/architecture/identity.md`
 * §1.5) rather than leaving a silent administrative change.
 */
export async function writeAudit(x: Executor, entry: NewAuditLogRow): Promise<void> {
  await x.insert(auditLog).values(entry);
}
