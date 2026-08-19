import {
  AUTH_PROVIDERS,
  canManageRole,
  effectivePermissions,
  ROLE_RANK,
  type AccountStatusResponse,
  type ApproveMemberRequest,
  type AuthOutcome,
  type AuthProvider,
  type LinkedIdentity,
  type LinkedIdentityList,
  type LoginRequest,
  type MeResponse,
  type MemberListItem,
  type Permission,
  type PublicUser,
  type RegisterRequest,
  type Role,
  type SelfUser,
  type SessionResponse,
  type UpdateMemberRequest,
  type UpdateProfileRequest,
  type UserStatus,
} from '@family/shared';

import { buildAuthContext, permissionsVersion, type AuthContext } from '../../core/auth/context.js';
import { hashRefreshToken } from '../../core/auth/tokens.js';
import { getConfig } from '../../core/config.js';
import type { Db, Executor } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import * as repo from './identity.repository.js';
import type { MemberFilter } from './identity.repository.js';
import type { FamilySettingsRow, UserIdentityRow } from './identity.schema.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';
import {
  assertActive,
  createStatusTicket,
  issueSession,
  readStatusTicket,
  revokeAllForUser,
  revokeFamily,
  toPublicUser,
  toSessionResponse,
  type IssuedSession,
  type SessionContext,
} from './session.service.js';
import type { UserRow } from './users.schema.js';

/**
 * Identity business rules (D8: no HTTP knowledge below the routes layer).
 *
 * Everything that decides *whether* something may happen lives here, and the
 * guards are exported as small pure functions so they can be unit-tested without
 * a database — a privilege-escalation check that is only exercised through an
 * integration test is a check nobody runs.
 */

export interface RequestContext extends SessionContext {
  /** `null` for unauthenticated flows (register, login). */
  actorId: string | null;
}

/* ========================================================================== */
/* guards — pure, exported for tests                                          */
/* ========================================================================== */

/**
 * A member may only be administered by someone strictly senior to them.
 *
 * Equal rank fails on purpose: two admins must not be able to demote or suspend
 * each other, and it also means an actor can never act on themselves through the
 * `/members` surface (self-service goes through `PATCH /me`).
 */
export function assertCanManageTarget(actorRole: Role, targetRole: Role): void {
  if (!canManageRole(actorRole, targetRole)) {
    throw new AppError('FORBIDDEN', 'Target member outranks you', {
      context: { actorRole, targetRole },
    });
  }
}

/** Nobody may hand out a role at or above their own — the classic escalation. */
export function assertCanAssignRole(actorRole: Role, newRole: Role): void {
  if (!canManageRole(actorRole, newRole)) {
    throw new AppError('FORBIDDEN', 'You cannot assign a role at or above your own', {
      context: { actorRole, newRole, actorRank: ROLE_RANK[actorRole] },
    });
  }
}

/**
 * Nobody may grant a permission they do not themselves hold.
 *
 * Without this an `admin` could grant `backup:manage` to a `child` and then sign
 * in as that child — the role matrix would be intact and completely bypassed.
 * Denies are unrestricted: taking a permission away is never an escalation.
 */
export function assertGrantsWithinActor(
  actorPermissions: ReadonlySet<Permission>,
  grants: readonly Permission[],
): void {
  const escalations = grants.filter((p) => !actorPermissions.has(p));
  if (escalations.length > 0) {
    throw new AppError('FORBIDDEN', 'You cannot grant a permission you do not hold', {
      details: { permissionGrants: escalations },
    });
  }
}

/**
 * The family must never be left without an owner.
 *
 * `remainingOwners` is the count of *other* active owners, so the guard reads
 * the same way for a demotion, a suspension, a rejection and a deletion.
 */
export function assertNotLastOwner(remainingOwners: number): void {
  if (remainingOwners <= 0) {
    throw new AppError('LAST_OWNER', 'The last owner cannot be demoted, suspended or removed');
  }
}

/**
 * Unlinking must never lock a member out of their own account.
 *
 * Counted over *distinct* login methods including `password`, because the
 * password credential lives on `users`, not in `user_identities`.
 */
export function assertNotLastLoginMethod(
  methods: readonly AuthProvider[],
  provider: AuthProvider,
): void {
  if (!methods.includes(provider)) {
    throw new AppError('NOT_FOUND', `Provider ${provider} is not linked`);
  }
  if (methods.length <= 1) {
    throw new AppError(
      'LAST_LOGIN_METHOD',
      'This is your only way to sign in — add another method first',
    );
  }
}

/**
 * The D3 bootstrap rule.
 *
 * Somebody has to be able to approve the first signup, and there is nobody to do
 * it — so the very first row, or a signup matching `BOOTSTRAP_OWNER_EMAIL`,
 * becomes an auto-approved `owner`.
 *
 * **It is one-shot.** The email path additionally requires that no active owner
 * exists yet. Without that guard the configured address stays a permanent
 * unauthenticated route to an owner account: registration verifies no email
 * ownership, so knowing the configured string is enough, and the rule runs
 * before the "registration is closed" gate. The `findUserByEmail` collision
 * check does not save you either, because an owner who signed in through
 * Telegram (never has an email) or Apple private relay (stored as NULL) leaves
 * nothing for it to collide with.
 */
export function isBootstrapSignup(
  email: string | null,
  existingUserCount: number,
  bootstrapEmail: string,
  activeOwnerCount: number,
): boolean {
  if (existingUserCount === 0) return true;
  if (activeOwnerCount > 0) return false;
  const configured = bootstrapEmail.trim().toLowerCase();
  if (!configured || !email) return false;
  return email.trim().toLowerCase() === configured;
}

/* ========================================================================== */
/* serializers                                                                */
/* ========================================================================== */

export function toSelfUser(user: UserRow): SelfUser {
  return {
    ...toPublicUser(user),
    email: user.email,
    birthDate: user.birthDate,
    timezone: user.timezone,
    locale: user.locale,
  };
}

export function toMemberListItem(user: UserRow): MemberListItem {
  return {
    ...toPublicUser(user),
    email: user.email,
    emailVerified: user.emailVerified,
    // `numeric` round-trips as a string; the admin contract wants a number.
    choreWeight: Number(user.choreWeight),
    sortOrder: user.sortOrder,
    permissionGrants: sanitizePermissions(user.permissionGrants),
    permissionDenies: sanitizePermissions(user.permissionDenies),
    createdAt: user.createdAt.toISOString(),
    approvedAt: user.approvedAt?.toISOString() ?? null,
    approvedById: user.approvedById,
    rejectedReason: user.rejectedReason,
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
  };
}

/**
 * Overrides live in a `text[]`, so a row written before a permission was renamed
 * can name one that no longer exists. Drop unknown entries rather than failing
 * the response schema on data we can safely ignore.
 */
function sanitizePermissions(values: readonly string[]): Permission[] {
  const catalog = new Set<string>(PERMISSION_CATALOG);
  return values.filter((v): v is Permission => catalog.has(v));
}

const PERMISSION_CATALOG: readonly string[] = effectivePermissions('owner');

function toFamilyContext(settings: FamilySettingsRow): MeResponse['family'] {
  return {
    name: settings.familyName,
    timezone: settings.timezone,
    weekStartsOn: settings.weekStartsOn,
    currency: settings.currency,
  };
}

/* ========================================================================== */
/* registration & login                                                       */
/* ========================================================================== */

export interface RegisterResult {
  outcome: AuthOutcome;
  /**
   * The raw refresh token, present only for the bootstrap signup that actually
   * receives a session. Kept out of `outcome` on purpose: `AuthOutcome` is the
   * response body, and the refresh token must only ever reach the cookie.
   */
  refreshToken: string | null;
}

/**
 * `POST /auth/register` (D3).
 *
 * Creates a `pending_approval` user and **no session** — except for the
 * bootstrap signup, which is auto-approved as `owner` because otherwise nobody
 * could ever approve anybody.
 */
export async function register(
  db: Db,
  input: RegisterRequest,
  ctx: RequestContext,
): Promise<RegisterResult> {
  const config = getConfig();

  const result = await db.transaction(async (tx) => {
    // Serialises the "is the family empty" question against a simultaneous
    // first registration; without it two people could both become owner.
    await repo.lockBootstrap(tx);

    const settings = await repo.getFamilySettings(tx);
    const existingCount = await repo.countUsers(tx);
    const activeOwners = await repo.countActiveOwners(tx);
    const bootstrap = isBootstrapSignup(
      input.email,
      existingCount,
      config.BOOTSTRAP_OWNER_EMAIL,
      activeOwners,
    );

    if (!settings.allowRegistration && !bootstrap) {
      throw new AppError('FORBIDDEN', 'Registration is currently closed');
    }

    const existing = await repo.findUserByEmail(tx, input.email);
    if (existing) {
      throw new AppError('ALREADY_EXISTS', 'An account with this email already exists');
    }

    const passwordHash = await hashPassword(input.password);
    const now = new Date();

    const user = await repo.insertUser(tx, {
      email: input.email,
      displayName: input.displayName,
      passwordHash,
      role: bootstrap ? 'owner' : 'child',
      status: bootstrap ? 'active' : 'pending_approval',
      approvedAt: bootstrap ? now : null,
    });

    // `password` is a first-class provider so the unlink guard can count it
    // uniformly alongside the OAuth ones.
    await repo.insertIdentity(tx, {
      userId: user.id,
      provider: 'password',
      providerUserId: user.id,
      providerEmail: input.email,
      providerEmailVerified: false,
    });

    await repo.writeAudit(tx, {
      actorId: user.id,
      action: 'member:register',
      targetType: 'user',
      targetId: user.id,
      metadata: { bootstrap, role: user.role, status: user.status },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    if (user.status !== 'active') return { user, issued: null };

    const issued = await issueSession(tx, user, ctx);
    await repo.touchLastLogin(tx, user.id);
    return { user, issued };
  });

  if (!result.issued) {
    return {
      outcome: {
        session: null,
        pending: { status: result.user.status, ticket: createStatusTicket(result.user.id) },
      },
      refreshToken: null,
    };
  }

  return {
    outcome: { session: toSessionResponse(result.user, result.issued), pending: null },
    refreshToken: result.issued.refreshToken,
  };
}

export interface LoginResult {
  session: SessionResponse;
  issued: IssuedSession;
}

/**
 * `POST /auth/login`.
 *
 * The password is verified **before** the status is inspected, and an unknown
 * email still pays the full argon2 cost (see `verifyPassword`), so neither
 * timing nor error code reveals whether the account exists.
 */
export async function login(db: Db, input: LoginRequest, ctx: RequestContext): Promise<LoginResult> {
  const user = await repo.findUserByEmail(db, input.email);
  const ok = await verifyPassword(user?.passwordHash ?? null, input.password);

  if (!user || !ok) {
    throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  // Throws ACCOUNT_PENDING_APPROVAL / _REJECTED / _SUSPENDED before any token
  // is minted. Checked here as well as in `issueSession` so the transaction
  // below is never opened for an account that cannot have a session anyway.
  assertActive(user);

  const issued = await db.transaction(async (tx) => {
    const session = await issueSession(tx, user, ctx);

    if (user.passwordHash && needsRehash(user.passwordHash)) {
      await repo.updateUser(tx, user.id, { passwordHash: await hashPassword(input.password) });
    }
    await repo.touchLastLogin(tx, user.id);

    const identity = await repo.findIdentityForUser(tx, user.id, 'password');
    if (identity) await repo.touchIdentityLogin(tx, identity.id);

    return session;
  });

  return { session: toSessionResponse(user, issued), issued };
}

/**
 * `POST /auth/logout` — always succeeds, even with no cookie or a dead token.
 *
 * A logout that can fail is a logout users learn to distrust; the worst case
 * here is that we revoke nothing, and the caller clears the cookie regardless.
 */
export async function logout(
  db: Db,
  rawToken: string | null,
  allDevices: boolean,
  ctx: RequestContext,
): Promise<void> {
  if (!rawToken) return;

  const row = await repo.findRefreshTokenByHash(db, hashRefreshToken(rawToken));
  if (!row) return;

  await db.transaction(async (tx) => {
    if (allDevices) {
      await revokeAllForUser(tx, row.userId, 'logout');
    } else {
      await revokeFamily(tx, row.familyId, 'logout');
    }

    await repo.writeAudit(tx, {
      actorId: row.userId,
      action: 'session:logout',
      targetType: 'refresh_family',
      targetId: row.familyId,
      metadata: { allDevices },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  });
}

/**
 * `GET /auth/status?ticket=` — the unauthenticated pending/rejected screen.
 *
 * Returns `NOT_FOUND` for an unknown, forged or expired ticket, and never leaks
 * anything beyond the display name and the status the holder already knows.
 */
export async function accountStatus(db: Db, ticket: string): Promise<AccountStatusResponse> {
  const userId = readStatusTicket(ticket);
  if (!userId) throw new AppError('NOT_FOUND', 'Unknown or expired ticket');

  const user = await repo.findUserById(db, userId);
  if (!user) throw new AppError('NOT_FOUND', 'Unknown or expired ticket');

  return {
    status: user.status,
    displayName: user.displayName,
    submittedAt: user.createdAt.toISOString(),
    reason: user.status === 'active' ? null : user.rejectedReason,
  };
}

/* ========================================================================== */
/* self                                                                       */
/* ========================================================================== */

/**
 * `GET /me` — the only source of client-side authorization state (D4).
 *
 * `permissions` is the effective list (matrix + grants − denies) and
 * `permissionsVersion` is its fingerprint, so a client can notice a role change
 * on reconnect instead of waiting for its cache to go stale.
 */
export async function getMe(db: Db, userId: string): Promise<MeResponse> {
  const user = await repo.findUserById(db, userId);
  if (!user) throw new AppError('UNAUTHENTICATED', 'User no longer exists');

  const settings = await repo.getFamilySettings(db);
  const auth = buildAuthContext(user);

  return {
    user: toSelfUser(user),
    permissions: [...auth.permissions].sort(),
    family: toFamilyContext(settings),
    permissionsVersion: permissionsVersion(auth.permissions),
  };
}

/**
 * `PATCH /me`.
 *
 * The contract is `.strict()`, so an attempt to smuggle `role` or
 * `permissionGrants` in here is a 400 from the schema and never reaches this
 * function — but the patch is still built field by field rather than spread, so
 * a future contract change cannot silently widen what a member may edit.
 */
export async function updateProfile(
  db: Db,
  userId: string,
  input: UpdateProfileRequest,
): Promise<SelfUser> {
  const patch: Parameters<typeof repo.updateUser>[2] = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.avatarUrl !== undefined) patch.avatarUrl = input.avatarUrl ?? null;
  if (input.color !== undefined) patch.color = input.color ?? null;
  if (input.birthDate !== undefined) patch.birthDate = input.birthDate ?? null;
  if (input.timezone !== undefined) patch.timezone = input.timezone ?? null;
  if (input.locale !== undefined) patch.locale = input.locale;

  const updated = await repo.updateUser(db, userId, patch);
  if (!updated) throw new AppError('NOT_FOUND', 'User not found');
  return toSelfUser(updated);
}

/* ========================================================================== */
/* linked identities                                                          */
/* ========================================================================== */

export async function listLinkedIdentities(db: Db, userId: string): Promise<LinkedIdentityList> {
  const user = await repo.findUserById(db, userId);
  if (!user) throw new AppError('UNAUTHENTICATED', 'User no longer exists');

  const rows = await repo.listIdentities(db, userId);
  return buildIdentityList(user, rows);
}

function buildIdentityList(user: UserRow, rows: UserIdentityRow[]): LinkedIdentityList {
  const items: LinkedIdentity[] = rows.map((row) => ({
    provider: row.provider,
    providerUsername: row.providerUsername,
    providerEmail: row.providerEmail,
    linkedAt: row.linkedAt.toISOString(),
    isPrimary: false,
  }));

  // A password set through an OAuth-first account may have no identity row yet;
  // it is still a login method and must appear here, or the settings screen
  // offers "add a password" to somebody who already has one.
  if (user.passwordHash && !items.some((i) => i.provider === 'password')) {
    items.push({
      provider: 'password',
      providerUsername: null,
      providerEmail: user.email,
      linkedAt: user.createdAt.toISOString(),
      isPrimary: false,
    });
  }

  // Display hint only (the real unlink guard is a locked count): the method used
  // most recently, falling back to the oldest link.
  const primary =
    rows.reduce<UserIdentityRow | null>((best, row) => {
      if (!row.lastLoginAt) return best;
      if (!best?.lastLoginAt || row.lastLoginAt > best.lastLoginAt) return row;
      return best;
    }, null) ?? rows[0];

  for (const item of items) {
    if (primary && item.provider === primary.provider) item.isPrimary = true;
  }

  const linked = new Set(items.map((i) => i.provider));
  return { items, available: AUTH_PROVIDERS.filter((p) => !linked.has(p)) };
}

/**
 * `DELETE /me/identities/:provider`.
 *
 * `SELECT ... FOR UPDATE` on the user row first (D3): counting login methods and
 * removing one must be atomic, or two concurrent unlinks each see "two methods
 * left" and between them remove both.
 */
export async function unlinkIdentity(
  db: Db,
  userId: string,
  provider: AuthProvider,
  ctx: RequestContext,
): Promise<LinkedIdentityList> {
  return db.transaction(async (tx) => {
    const user = await repo.lockUser(tx, userId);
    if (!user) throw new AppError('UNAUTHENTICATED', 'User no longer exists');

    const methods = await repo.loginMethodsOf(tx, user);
    assertNotLastLoginMethod(methods, provider);

    await repo.deleteIdentity(tx, userId, provider);
    if (provider === 'password') {
      await repo.updateUser(tx, userId, { passwordHash: null });
    }

    await repo.writeAudit(tx, {
      actorId: ctx.actorId,
      action: 'identity:unlink',
      targetType: 'user',
      targetId: userId,
      metadata: { provider, remaining: methods.filter((m) => m !== provider) },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    const fresh = await repo.findUserById(tx, userId);
    const rows = await repo.listIdentities(tx, userId);
    return buildIdentityList(fresh ?? user, rows);
  });
}

/* ========================================================================== */
/* member administration                                                      */
/* ========================================================================== */

export interface MemberListResult {
  items: (MemberListItem | PublicUser)[];
  pendingCount: number;
}

/**
 * `GET /members`.
 *
 * Two serializers, chosen by the caller's permissions rather than by the client:
 * an admin sees moderation state, everybody else sees the public projection. A
 * child must not learn another member's email from the roster.
 */
export async function listMembers(
  db: Db,
  auth: AuthContext,
  filter: MemberFilter = {},
): Promise<MemberListResult> {
  const isAdmin = auth.can('member:update:any');
  const rows = await repo.listUsers(db, filter);

  if (!isAdmin) {
    return { items: rows.map(toPublicUser), pendingCount: 0 };
  }

  return {
    items: rows.map(toMemberListItem),
    pendingCount: await repo.countByStatus(db, 'pending_approval'),
  };
}

export interface PendingMemberList {
  items: MemberListItem[];
  pendingCount: number;
}

export async function listPendingMembers(db: Db): Promise<PendingMemberList> {
  const rows = await repo.listUsers(db, { status: 'pending_approval' });
  return { items: rows.map(toMemberListItem), pendingCount: rows.length };
}

/**
 * `PATCH /members/:id` — role, chore weight and permission overrides.
 *
 * Three separate escalation guards apply, in this order: the actor must outrank
 * the target, may not assign a role at or above their own, and may not grant a
 * permission they do not hold.
 */
export async function updateMember(
  db: Db,
  auth: AuthContext,
  targetId: string,
  input: UpdateMemberRequest,
  ctx: RequestContext,
): Promise<MemberListItem> {
  return db.transaction(async (tx) => {
    const target = await repo.lockUser(tx, targetId);
    if (!target) throw new AppError('NOT_FOUND', 'Member not found');

    assertCanManageTarget(auth.role, target.role);

    const patch: Parameters<typeof repo.updateUser>[2] = {};

    if (input.role !== undefined && input.role !== target.role) {
      if (!auth.can('member:role:assign')) {
        throw new AppError('FORBIDDEN', 'Missing permission: member:role:assign');
      }
      assertCanAssignRole(auth.role, input.role);
      if (target.role === 'owner') {
        assertNotLastOwner(await repo.countActiveOwners(tx, target.id));
      }
      patch.role = input.role;
    }

    if (input.permissionGrants !== undefined) {
      assertGrantsWithinActor(auth.permissions, input.permissionGrants);
      patch.permissionGrants = [...input.permissionGrants];
    }
    if (input.permissionDenies !== undefined) patch.permissionDenies = [...input.permissionDenies];
    if (input.choreWeight !== undefined) patch.choreWeight = input.choreWeight;
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.color !== undefined) patch.color = input.color ?? null;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;

    const updated = await repo.updateUser(tx, targetId, patch);
    if (!updated) throw new AppError('NOT_FOUND', 'Member not found');

    await repo.writeAudit(tx, {
      actorId: auth.userId,
      action: patch.role ? 'member:role_change' : 'member:update',
      targetType: 'user',
      targetId,
      metadata: {
        before: { role: target.role, choreWeight: target.choreWeight },
        after: { role: updated.role, choreWeight: updated.choreWeight },
        changed: Object.keys(patch),
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    // A permission or role change must not be renewable on an old refresh
    // family's terms; the next refresh re-reads the row anyway, but the access
    // token in flight carries the old role for up to its remaining lifetime.
    if (patch.role) await revokeAllForUser(tx, targetId, 'admin');

    return toMemberListItem(updated);
  });
}

/**
 * `POST /members/:id/approve` (D3 §3.4).
 *
 * The status change is a conditional `UPDATE ... WHERE status =
 * 'pending_approval'`, so two admins clicking at the same moment produce exactly
 * one `200` and one `409 CONFLICT` — never two approvals, never a lost role
 * choice. The role is picked here, never self-declared at signup.
 */
export async function approveMember(
  db: Db,
  auth: AuthContext,
  targetId: string,
  input: ApproveMemberRequest,
  ctx: RequestContext,
): Promise<MemberListItem> {
  assertCanAssignRole(auth.role, input.role);

  return db.transaction(async (tx) => {
    const patch: Parameters<typeof repo.transitionUserStatus>[3] = {
      status: 'active',
      role: input.role,
      approvedAt: new Date(),
      approvedById: auth.userId,
      rejectedReason: null,
    };
    if (input.choreWeight !== undefined) patch.choreWeight = input.choreWeight;

    const approved = await requireTransitioned(
      tx,
      await repo.transitionUserStatus(tx, targetId, 'pending_approval', patch),
      targetId,
      'pending_approval',
    );

    await repo.writeAudit(tx, {
      actorId: auth.userId,
      action: 'member:approve',
      targetType: 'user',
      targetId,
      metadata: { role: input.role },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return toMemberListItem(approved);
  });
}

export async function rejectMember(
  db: Db,
  auth: AuthContext,
  targetId: string,
  reason: string | undefined,
  ctx: RequestContext,
): Promise<MemberListItem> {
  return db.transaction(async (tx) => {
    const rejected = await requireTransitioned(
      tx,
      await repo.transitionUserStatus(tx, targetId, 'pending_approval', {
        status: 'rejected',
        rejectedReason: reason ?? null,
      }),
      targetId,
      'pending_approval',
    );

    // A rejected signup has no session, but revoking is idempotent and this is
    // the one place that guarantees the invariant "not active ⇒ no live family".
    await revokeAllForUser(tx, targetId, 'status_change');

    await repo.writeAudit(tx, {
      actorId: auth.userId,
      action: 'member:reject',
      targetType: 'user',
      targetId,
      metadata: { reason: reason ?? null },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return toMemberListItem(rejected);
  });
}

/**
 * `POST /members/:id/suspend`.
 *
 * Revokes every refresh family in the same transaction as the status change
 * (D3 §3.3), so the suspension cannot be renewed — the access token already in
 * the suspended user's memory is dead as soon as it hits the status gate, and
 * unusable within one token lifetime at the very worst.
 */
export async function suspendMember(
  db: Db,
  auth: AuthContext,
  targetId: string,
  reason: string | undefined,
  ctx: RequestContext,
): Promise<MemberListItem> {
  return db.transaction(async (tx) => {
    const target = await repo.lockUser(tx, targetId);
    if (!target) throw new AppError('NOT_FOUND', 'Member not found');
    assertCanManageTarget(auth.role, target.role);
    if (target.role === 'owner') {
      assertNotLastOwner(await repo.countActiveOwners(tx, target.id));
    }

    const suspended = await requireTransitioned(
      tx,
      await repo.transitionUserStatus(tx, targetId, 'active', {
        status: 'suspended',
        rejectedReason: reason ?? null,
      }),
      targetId,
      'active',
    );

    await revokeAllForUser(tx, targetId, 'status_change');

    await repo.writeAudit(tx, {
      actorId: auth.userId,
      action: 'member:suspend',
      targetType: 'user',
      targetId,
      metadata: { reason: reason ?? null },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return toMemberListItem(suspended);
  });
}

/**
 * `POST /members/:id/reactivate`.
 *
 * Deliberately does **not** restore the revoked sessions — the member signs in
 * again. Reviving a family that was revoked for cause would also revive whatever
 * copy of the cookie caused the suspension.
 */
export async function reactivateMember(
  db: Db,
  auth: AuthContext,
  targetId: string,
  ctx: RequestContext,
): Promise<MemberListItem> {
  return db.transaction(async (tx) => {
    const target = await repo.lockUser(tx, targetId);
    if (!target) throw new AppError('NOT_FOUND', 'Member not found');
    assertCanManageTarget(auth.role, target.role);

    const reactivated = await requireTransitioned(
      tx,
      await repo.transitionUserStatus(tx, targetId, 'suspended', {
        status: 'active',
        rejectedReason: null,
      }),
      targetId,
      'suspended',
    );

    await repo.writeAudit(tx, {
      actorId: auth.userId,
      action: 'member:reactivate',
      targetType: 'user',
      targetId,
      metadata: {},
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return toMemberListItem(reactivated);
  });
}

/**
 * Turns "the conditional update matched nothing" into the right HTTP failure.
 *
 * `404` when there is no such member, `409` when there is one but it had already
 * moved on — the loser of two simultaneous admin clicks.
 */
async function requireTransitioned(
  x: Executor,
  updated: UserRow | undefined,
  targetId: string,
  expected: UserStatus,
): Promise<UserRow> {
  if (updated) return updated;

  const current = await repo.findUserById(x, targetId);
  if (!current) throw new AppError('NOT_FOUND', 'Member not found');

  throw new AppError(
    'CONFLICT',
    `Member is ${current.status}, expected ${expected} — somebody else decided first`,
  );
}
