/**
 * Roles & permissions — the single source of truth for the whole application.
 *
 * The backend enforces these; the frontend mirrors them for UI affordances only.
 * `GET /api/me` returns the *effective* permission list so the client never has
 * to re-derive the matrix.
 */

export const ROLES = ['owner', 'admin', 'adult', 'teen', 'child', 'guest'] as const;
export type Role = (typeof ROLES)[number];

/** Ordered from most to least privileged. Used for "can this role manage that role" checks. */
export const ROLE_RANK: Record<Role, number> = {
  owner: 100,
  admin: 80,
  adult: 60,
  teen: 40,
  child: 20,
  guest: 10,
};

export const ROLE_LABELS_RU: Record<Role, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  adult: 'Взрослый',
  teen: 'Подросток',
  child: 'Ребёнок',
  guest: 'Гость',
};

export const ROLE_DESCRIPTIONS_RU: Record<Role, string> = {
  owner: 'Полный доступ. Единственная роль, которую нельзя удалить или понизить.',
  admin: 'Управляет участниками, ролями и настройками семьи.',
  adult: 'Полный доступ к задачам, событиям и финансам семьи.',
  teen: 'Задачи и события, свои карманные деньги. Финансы семьи — только просмотр целей.',
  child: 'Свои задачи, общий календарь и список покупок.',
  guest: 'Ограниченный просмотр: календарь и экстренная информация.',
};

/**
 * Permission catalog. Naming convention: `<resource>:<action>[:<scope>]`
 * where scope is `own` (rows the user created or is assigned to) or `any`.
 */
export const PERMISSIONS = [
  // members & access
  'member:read',
  'member:approve',
  'member:update:any',
  'member:remove',
  'member:role:assign',

  // tasks / chores
  'task:read:own',
  'task:read:any',
  'task:create',
  'task:update:own',
  'task:update:any',
  'task:delete:own',
  'task:delete:any',
  'task:assign:any',
  'task:complete:own',
  'task:complete:any',

  // calendar events
  'event:read',
  'event:create',
  'event:update:own',
  'event:update:any',
  'event:delete:own',
  'event:delete:any',

  // moneybox / savings goals
  'goal:read',
  'goal:read:any',
  'goal:create',
  'goal:update',
  'goal:delete',
  'goal:contribute',

  // shopping lists
  'shopping:read',
  'shopping:write',
  'shopping:list:manage',

  // family wall
  'post:create',
  'post:pin',
  'post:delete:own',
  'post:delete:any',
  'comment:create',
  'comment:delete:own',
  'comment:delete:any',
  'kudos:give',
  'poll:create',
  'poll:vote',
  'poll:close',

  // personal
  'notification:manage:own',
  'profile:update:own',
  'identity:manage:own',

  // administration
  'settings:read',
  'settings:manage',
  'audit:read',
  'backup:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERSONAL: Permission[] = [
  'notification:manage:own',
  'profile:update:own',
  'identity:manage:own',
];

const GUEST: Permission[] = ['event:read', 'member:read', ...PERSONAL];

const CHILD: Permission[] = [
  ...GUEST,
  'task:read:own',
  'task:complete:own',
  'shopping:read',
  'shopping:write',
  'post:create',
  'post:delete:own',
  'comment:create',
  'comment:delete:own',
  'kudos:give',
  'poll:vote',
];

const TEEN: Permission[] = [
  ...CHILD,
  'task:read:any',
  'task:create',
  'task:update:own',
  'task:delete:own',
  'event:create',
  'event:update:own',
  'event:delete:own',
  'goal:read',
  'poll:create',
  'poll:close',
];

const ADULT: Permission[] = [
  ...TEEN,
  'task:update:any',
  'task:delete:any',
  'task:assign:any',
  'task:complete:any',
  'event:update:any',
  'event:delete:any',
  'goal:create',
  'goal:update',
  'goal:delete',
  'goal:contribute',
  'shopping:list:manage',
  'post:pin',
  'post:delete:any',
  'comment:delete:any',
  'settings:read',
];

const ADMIN: Permission[] = [
  ...ADULT,
  'member:approve',
  'member:update:any',
  'member:remove',
  'member:role:assign',
  'goal:read:any',
  'settings:manage',
  'audit:read',
  'backup:manage',
];

const OWNER: Permission[] = [...PERMISSIONS];

/** Role → permission matrix. Deduplicated and frozen at module load. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  owner: Object.freeze([...new Set(OWNER)]),
  admin: Object.freeze([...new Set(ADMIN)]),
  adult: Object.freeze([...new Set(ADULT)]),
  teen: Object.freeze([...new Set(TEEN)]),
  child: Object.freeze([...new Set(CHILD)]),
  guest: Object.freeze([...new Set(GUEST)]),
}) as Readonly<Record<Role, readonly Permission[]>>;

/**
 * Effective permissions for a role, plus optional per-user grants/revocations.
 * Revocations win over grants, which win over the role default.
 */
export function effectivePermissions(
  role: Role,
  granted: readonly Permission[] = [],
  revoked: readonly Permission[] = [],
): Permission[] {
  const revokedSet = new Set(revoked);
  const result = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const p of granted) result.add(p);
  for (const p of revokedSet) result.delete(p);
  return [...result];
}

export function hasPermission(
  permissions: readonly Permission[] | ReadonlySet<Permission>,
  required: Permission,
): boolean {
  if (permissions instanceof Set) return (permissions as ReadonlySet<Permission>).has(required);
  return (permissions as readonly Permission[]).includes(required);
}

/**
 * Resolves an `own`/`any` permission pair: returns `'any'` when the actor may act
 * on every row, `'own'` when limited to their own rows, `null` when denied.
 */
export function resolveScope(
  permissions: readonly Permission[],
  ownPermission: Permission,
  anyPermission: Permission,
): 'any' | 'own' | null {
  if (hasPermission(permissions, anyPermission)) return 'any';
  if (hasPermission(permissions, ownPermission)) return 'own';
  return null;
}

/** A role may only manage roles strictly below its own rank. */
export function canManageRole(actor: Role, target: Role): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

/** Roles a given actor is allowed to assign to somebody else. */
export function assignableRoles(actor: Role): Role[] {
  return ROLES.filter((r) => canManageRole(actor, r));
}
