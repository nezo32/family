import {
  meResponseSchema,
  type FamilyContext,
  type MeResponse,
  type Permission,
  type Role,
  type UserStatus,
} from '@family/shared';

/**
 * The one `GET /api/me` fixture every test uses.
 *
 * ## Why this file exists
 *
 * Six test files used to hand-build their own flat `me` object and seed it with
 * `queryClient.setQueryData(meKeys.detail(), …)` or hand it back from a stubbed
 * `fetch`. Every one of them was a *different* shape from what the server
 * actually returns, and because `setQueryData` writes straight past the query
 * function, the real `meResponseSchema.parse()` never ran in a single test. The
 * whole suite stayed green while `/api/me` threw a `ZodError` on every call in
 * the real app and every authenticated screen rendered an error state.
 *
 * So: this fixture is **parsed through the real contract schema** before it is
 * returned. A future drift between `@family/shared` and what the tests assume
 * fails here, loudly, in every test that seeds a user — which is the behaviour
 * the old hand-built objects were missing.
 *
 * The return value is plain JSON, so the same helper serves both uses:
 *
 * ```ts
 * queryClient.setQueryData(meKeys.detail(), makeMe({ permissions }));   // cache
 * if (url.endsWith('/api/me')) return json(200, makeMe({ permissions })); // fetch
 * ```
 */

export interface MeOverrides {
  id?: string;
  displayName?: string;
  email?: string | null;
  avatarUrl?: string | null;
  color?: string | null;
  role?: Role;
  status?: UserStatus;
  /** `null` means "inherit `family.timezone`" — that is the contract, not a bug. */
  timezone?: string | null;
  birthDate?: string | null;
  locale?: string;
  permissions?: readonly Permission[];
  family?: Partial<FamilyContext>;
  permissionsVersion?: string;
}

const DEFAULT_ID = '11111111-1111-4111-8111-111111111111';

export const DEFAULT_FAMILY: FamilyContext = {
  name: 'Семья',
  timezone: 'Europe/Moscow',
  /** ISO-8601: 1 = понедельник. Not the 0-based react-day-picker axis. */
  weekStartsOn: 1,
  currency: 'RUB',
};

/**
 * A contract-valid `MeResponse`.
 *
 * Note the nesting — `{ user, permissions, family, permissionsVersion }`. Tests
 * that reach for `me.displayName` are reading the shape that no longer exists.
 */
export function makeMe(overrides: MeOverrides = {}): MeResponse {
  return meResponseSchema.parse({
    user: {
      id: overrides.id ?? DEFAULT_ID,
      displayName: overrides.displayName ?? 'Мама',
      avatarUrl: overrides.avatarUrl ?? null,
      color: overrides.color ?? null,
      role: overrides.role ?? 'adult',
      status: overrides.status ?? 'active',
      email: overrides.email === undefined ? 'mama@example.com' : overrides.email,
      birthDate: overrides.birthDate ?? null,
      timezone: overrides.timezone === undefined ? 'Europe/Moscow' : overrides.timezone,
      locale: overrides.locale ?? 'ru-RU',
    },
    permissions: overrides.permissions ?? [],
    family: { ...DEFAULT_FAMILY, ...overrides.family },
    permissionsVersion: overrides.permissionsVersion ?? 'pv-test-1',
  });
}
