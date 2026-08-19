import { useMemo } from 'react';
import { resolveScope } from '@family/shared';
import type { Permission } from '@family/shared';
import { useMe } from './use-me';

/**
 * Permission checks for the UI.
 *
 * D4, non-negotiable: **never branch on `role === 'admin'`.** The role exists
 * for display copy (`ROLE_LABELS_RU`) and nothing else. Access decisions read
 * the effective permission list that `GET /api/me` returns, because that list
 * already folds in the per-user `permission_grants` / `permission_denies`
 * overrides that the role matrix knows nothing about.
 *
 * This is a UI affordance layer. The backend enforces the same rules; hiding a
 * button is politeness, not security.
 *
 * ### `own` / `any` scopes
 * Permissions come in two shapes:
 *   - unscoped:  `task:create`, `goal:contribute`, `member:approve`
 *   - scoped:    `task:update:own` + `task:update:any`
 *
 * `can(base, resource?)` takes the **base** (`'task:update'`) and resolves it:
 *   - holder of `…:any`  → allowed for every row
 *   - holder of `…:own`  → allowed only when `resource` belongs to the user
 *   - `…:own` with no `resource` → allowed (affordance: "you can do this to
 *     your own items", used to decide whether to render a create/edit button at
 *     all before a specific row is in hand)
 *   - neither → denied
 *
 * An unscoped base is looked up verbatim, so `can('task:create')` works too.
 */

/** Anything with an owner. Feature rows should expose at least one of these. */
export interface ScopedResource {
  ownerId?: string | null;
  createdById?: string | null;
  authorId?: string | null;
  userId?: string | null;
  assigneeId?: string | null;
}

export type PermissionScope = 'any' | 'own' | null;

export type CanFn = (base: string, resource?: ScopedResource | null) => boolean;

export interface UseCanResult {
  /** The main check. See the scope rules above. */
  can: CanFn;
  /** Resolve a base to its scope without evaluating a resource. */
  scopeFor: (base: string) => PermissionScope;
  /** Exact-match check when you really do hold the full permission string. */
  hasPermission: (permission: Permission) => boolean;
  /** True when at least one of the given bases is allowed. */
  canAny: (...bases: string[]) => boolean;
  /** True when every one of the given bases is allowed. */
  canAll: (...bases: string[]) => boolean;
  /** The raw effective list, for debugging / settings screens. */
  permissions: readonly Permission[];
  /** `false` until `/api/me` has resolved — render skeletons, not "нет доступа". */
  isReady: boolean;
  /** Current user id, used by the ownership test. */
  userId: string | null;
}

/** Does `resource` belong to `userId`? Absent ownership fields mean "not mine". */
export function isOwnedBy(
  resource: ScopedResource | null | undefined,
  userId: string | null,
): boolean {
  if (!resource || !userId) return false;
  return (
    resource.ownerId === userId ||
    resource.createdById === userId ||
    resource.authorId === userId ||
    resource.userId === userId ||
    resource.assigneeId === userId
  );
}

/**
 * Pure core, exported for tests and for non-hook call sites (route loaders).
 */
export function evaluate(
  permissions: ReadonlySet<string>,
  userId: string | null,
  base: string,
  resource?: ScopedResource | null,
): boolean {
  // Exact match first: covers unscoped permissions and callers that passed the
  // full string (`'task:update:any'`).
  if (permissions.has(base)) return true;

  if (permissions.has(`${base}:any`)) return true;

  if (permissions.has(`${base}:own`)) {
    // No specific row in hand → this is an affordance question, answer yes.
    if (resource === undefined) return true;
    return isOwnedBy(resource, userId);
  }

  return false;
}

/**
 * Resolve a scoped permission pair — `@family/shared`'s `resolveScope`, which
 * is the same function `AuthContext.scopeFor` calls on the server.
 *
 * The inlined version this replaces had a **third branch**: a bare `base` held
 * verbatim also returned `'any'`. The server has never done that, so any caller
 * relying on it would have rendered a control the API answers with 403 — and
 * for `goal:read` (which exists both bare and as `goal:read:any`) it would have
 * told a teen they may read every goal in the house. The server's answer wins.
 *
 * If you want a plain "may I?" on an unscoped permission, that is `can(base)`,
 * which still looks the string up verbatim.
 */
export function resolveScopeFor(permissions: ReadonlySet<string>, base: string): PermissionScope {
  return resolveScope(permissions, base);
}

export function useCan(): UseCanResult {
  const { data: me, isSuccess } = useMe();

  return useMemo<UseCanResult>(() => {
    const list: readonly Permission[] = me?.permissions ?? [];
    const set: ReadonlySet<string> = new Set<string>(list);
    const userId = me?.user.id ?? null;

    const can: CanFn = (base, resource) => evaluate(set, userId, base, resource);

    return {
      can,
      scopeFor: (base) => resolveScopeFor(set, base),
      hasPermission: (permission) => set.has(permission),
      canAny: (...bases) => bases.some((base) => can(base)),
      canAll: (...bases) => bases.every((base) => can(base)),
      permissions: list,
      isReady: isSuccess,
      userId,
    };
  }, [me, isSuccess]);
}
