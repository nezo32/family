import { describe, expect, it } from 'vitest';

import {
  canManageRole,
  effectivePermissions,
  resolveScope,
  ROLES,
  type Role,
} from '@family/shared';

import { authFor } from '../../test/access.js';

/**
 * `scopeFor` and `canManageRole` used to be re-derived here — and the PWA
 * re-derived `scopeFor` a third time, in `shared/auth/use-can.ts`, with an
 * extra branch the server never had. Both now call `@family/shared`, and these
 * are the cases that pin the reconciliation down.
 *
 * The frontend's `resolveScopeFor` is a one-line delegation to the same
 * `resolveScope` exercised below, so a mirrored test on that side would be
 * testing the delegation, not the behaviour.
 */

describe('AuthContext.scopeFor', () => {
  it('is `resolveScope` from @family/shared, not a re-implementation', () => {
    for (const role of ROLES) {
      const auth = authFor(role);
      const permissions = effectivePermissions(role);
      for (const base of ['task:read', 'task:update', 'task:delete', 'post:delete', 'goal:read']) {
        expect(auth.scopeFor(base)).toBe(resolveScope(permissions, base));
      }
    }
  });

  it('resolves the pair the way both sides now agree it resolves', () => {
    expect(authFor('adult').scopeFor('task:update')).toBe('any');
    expect(authFor('teen').scopeFor('task:update')).toBe('own');
    expect(authFor('child').scopeFor('task:update')).toBeNull();
  });

  /**
   * The branch the client had and the server did not.
   *
   * `use-can.ts` ended `resolveScopeFor` with `if (has(base)) return 'any'`, so
   * an unscoped permission held verbatim resolved to full authority — the API
   * answered the resulting click with a 403.
   *
   * The **server's** stricter answer won, and not only because it was the one
   * being enforced: a bare permission is not always the lesser-scoped one.
   * `goal:read` and `goal:read:any` both exist, a teen holds the bare
   * `goal:read`, and calling that `'any'` would have told the UI the teen may
   * read every goal in the house — widening what it believed, not narrowing it.
   */
  it('does not treat a bare permission as `any`', () => {
    const teen = authFor('teen');
    expect(teen.can('goal:read')).toBe(true);
    expect(teen.scopeFor('goal:read')).toBeNull();

    const admin = authFor('admin');
    expect(admin.scopeFor('goal:read')).toBe('any'); // holds `goal:read:any`

    // Unscoped permissions are asked about with `can`, which is the exact
    // lookup — that is where "may I?" on `goal:contribute` belongs.
    expect(authFor('adult').can('goal:contribute')).toBe(true);
    expect(authFor('adult').scopeFor('goal:contribute')).toBeNull();
  });

  it('still folds in per-user revocations', () => {
    const stripped = authFor('adult', { denies: ['task:update:any'] });
    expect(stripped.scopeFor('task:update')).toBe('own');
  });

  it('gives a suspended caller no scope at all, whatever their role', () => {
    expect(authFor('owner', { status: 'suspended' }).scopeFor('task:update')).toBeNull();
  });
});

describe('AuthContext.canManageRole', () => {
  it('is `canManageRole` from @family/shared, for every pair of roles', () => {
    for (const actor of ROLES) {
      const auth = authFor(actor);
      for (const target of ROLES) {
        expect(auth.canManageRole(target)).toBe(canManageRole(actor, target));
      }
    }
  });

  it('is strictly-below, so a role can never manage its own', () => {
    const peers: Role[] = ['owner', 'admin', 'adult', 'teen', 'child', 'guest'];
    for (const role of peers) {
      expect(authFor(role).canManageRole(role)).toBe(false);
    }
    expect(authFor('owner').canManageRole('admin')).toBe(true);
    expect(authFor('admin').canManageRole('owner')).toBe(false);
  });
});
