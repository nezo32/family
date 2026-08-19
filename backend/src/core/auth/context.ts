import {
  canManageRole,
  effectivePermissions,
  PERMISSIONS,
  resolveScope,
  type Permission,
  type PermissionScope,
  type Role,
} from '@family/shared';

import type { UserRow } from '../../modules/identity/users.schema.js';

/**
 * The authenticated caller, attached to every non-public request as `req.auth`.
 *
 * Permissions are resolved once per request from the role matrix plus the
 * user's grant/deny overrides (D4), so handlers never touch the matrix.
 */
export interface AuthContext {
  readonly userId: string;
  readonly role: Role;
  readonly status: UserRow['status'];
  readonly displayName: string;
  readonly timezone: string | null;
  readonly permissions: ReadonlySet<Permission>;

  /** Exact permission check. */
  can(permission: Permission): boolean;
  /** True if the caller holds at least one of the listed permissions. */
  canAny(...permissions: Permission[]): boolean;
  /**
   * Resolves an `own`/`any` pair: `'any'` when the caller may act on every row,
   * `'own'` when limited to their own, `null` when denied entirely.
   *
   * Delegates to `resolveScope` in `@family/shared`, which is also what the
   * PWA's `useCan().scopeFor` calls — the two used to be separate inlinings
   * that had already drifted apart.
   */
  scopeFor(base: string): PermissionScope;
  /** A role may only manage roles strictly below its own rank. */
  canManageRole(target: Role): boolean;
}

const VALID_PERMISSIONS: ReadonlySet<string> = new Set<string>(PERMISSIONS);

function sanitize(values: readonly string[]): Permission[] {
  // Overrides live in a text[] column, so a stale row could name a permission
  // that no longer exists. Drop unknown entries rather than trusting them.
  return values.filter((v): v is Permission => VALID_PERMISSIONS.has(v));
}

export function buildAuthContext(user: UserRow): AuthContext {
  /**
   * A user who is not `active` gets an EMPTY permission set regardless of role.
   * This is the second line of defence behind the login gate: even if a token
   * survives a suspension, it can do nothing.
   */
  const permissions: ReadonlySet<Permission> =
    user.status === 'active'
      ? new Set(
          effectivePermissions(
            user.role,
            sanitize(user.permissionGrants),
            sanitize(user.permissionDenies),
          ),
        )
      : new Set<Permission>();

  return {
    userId: user.id,
    role: user.role,
    status: user.status,
    displayName: user.displayName,
    timezone: user.timezone,
    permissions,

    can: (permission) => permissions.has(permission),
    canAny: (...list) => list.some((p) => permissions.has(p)),
    scopeFor: (base) => resolveScope(permissions, base),
    // Rank comparison lives with `ROLE_RANK` in `@family/shared`; re-deriving it
    // here in a file that already imported the ranks was one `>=` away from
    // letting an admin demote another admin.
    canManageRole: (target) => canManageRole(user.role, target),
  };
}

/**
 * A stable fingerprint of the effective permission set.
 *
 * Returned by `/api/me` so the client can detect a permission change on
 * reconnect and refresh its UI without waiting for `staleTime` to elapse.
 */
export function permissionsVersion(permissions: ReadonlySet<Permission>): string {
  return [...permissions]
    .sort()
    .join('|')
    .split('')
    .reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)
    .toString(36);
}
