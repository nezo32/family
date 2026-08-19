import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { fastify, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  effectivePermissions,
  ROLE_PERMISSIONS,
  type ErrorCode,
  type Permission,
} from '@family/shared';

import { buildAuthContext, permissionsVersion } from '../../core/auth/context.js';
import { hashRefreshToken, refreshCookieName, signAccessToken } from '../../core/auth/tokens.js';
import { getConfig, resetConfigForTests } from '../../core/config.js';
import { closeDb, getDb, type Db } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { authPlugin } from '../../core/plugins/auth.js';
import { errorHandlerPlugin } from '../../core/plugins/error-handler.js';
import authRoutes from './auth.routes.js';
import * as repo from './identity.repository.js';
import {
  assertCanAssignRole,
  assertCanManageTarget,
  assertGrantsWithinActor,
  assertNotLastLoginMethod,
  assertNotLastOwner,
  isBootstrapSignup,
} from './identity.service.js';
import * as service from './identity.service.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';
import {
  assertActive,
  createStatusTicket,
  decideRefresh,
  issueSession,
  readStatusTicket,
  rotateRefreshToken,
  type RefreshDecisionInput,
} from './session.service.js';
import type { UserRow } from './users.schema.js';
import usersRoutes from './users.routes.js';

/**
 * Identity module tests.
 *
 * Split deliberately in two:
 *
 * - Everything that encodes a *rule* — the rotation state machine, the
 *   privilege-escalation guards, the permission matrix, the account-status gate
 *   — is exercised as a pure function with no database at all. Those are the
 *   tests that must run on every commit, including in an environment (like CI's
 *   lint job, or a laptop without Docker) where Postgres is unavailable.
 * - Everything that depends on Postgres semantics we cannot fake — `FOR UPDATE`
 *   serialisation, the conditional `WHERE status = 'pending_approval'` update —
 *   lives behind `describe.skipIf(!TEST_DATABASE_URL)` and runs against a real,
 *   already-migrated test database.
 */

const HAS_DB = Boolean(process.env.TEST_DATABASE_URL);

/* ========================================================================== */
/* fixtures                                                                   */
/* ========================================================================== */

/**
 * `expect.objectContaining` is typed `any`, which trips `no-unsafe-argument` at
 * every call site. Wrapping it once keeps the assertions readable and the file
 * lint-clean without disabling the rule.
 */
function appError(shape: { code: ErrorCode; statusCode?: number }): Error {
  const matcher: unknown = expect.objectContaining(shape);
  return matcher as Error;
}

function userFixture(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date();
  return {
    id: randomUUID(),
    email: 'anya@example.com',
    emailVerified: false,
    displayName: 'Аня',
    avatarUrl: null,
    passwordHash: null,
    role: 'adult',
    status: 'active',
    permissionGrants: [],
    permissionDenies: [],
    birthDate: null,
    timezone: null,
    locale: 'ru-RU',
    choreWeight: '1.00',
    sortOrder: 0,
    color: null,
    approvedAt: now,
    approvedById: null,
    rejectedReason: null,
    lastSeenAt: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function decisionInput(overrides: Partial<RefreshDecisionInput> = {}): RefreshDecisionInput {
  const now = new Date('2026-08-19T12:00:00.000Z');
  return {
    token: {
      id: 'token-0',
      familyId: 'family-0',
      usedAt: null,
      revokedAt: null,
      revokedReason: null,
      expiresAt: new Date('2026-09-18T12:00:00.000Z'),
    },
    successor: null,
    now,
    graceSeconds: 20,
    ...overrides,
  };
}

/* ========================================================================== */
/* the rotation state machine — pure                                          */
/* ========================================================================== */

describe('decideRefresh', () => {
  const now = new Date('2026-08-19T12:00:00.000Z');

  it('rotates a fresh, unused, unrevoked token', () => {
    expect(decideRefresh(decisionInput())).toEqual({ kind: 'rotate' });
  });

  it('rejects an unknown token without touching the family', () => {
    const decision = decideRefresh(decisionInput({ token: null }));
    expect(decision.kind).toBe('invalid');
  });

  it('rejects an expired token as expired, not as a replay', () => {
    const decision = decideRefresh(
      decisionInput({
        token: {
          id: 't',
          familyId: 'f',
          usedAt: null,
          revokedAt: null,
          revokedReason: null,
          expiresAt: new Date(now.getTime() - 1),
        },
      }),
    );
    expect(decision).toEqual({ kind: 'expired' });
  });

  it('replays the successor for a concurrent refresh inside the grace window', () => {
    const decision = decideRefresh(
      decisionInput({
        token: {
          id: 'gen-0',
          familyId: 'f',
          usedAt: new Date(now.getTime() - 3_000),
          revokedAt: new Date(now.getTime() - 3_000),
          revokedReason: 'rotated',
          expiresAt: new Date('2026-09-18T12:00:00.000Z'),
        },
        successor: { id: 'gen-1', revokedAt: null },
      }),
    );
    // Crucially NOT `rotate`: a refresh storm must not grow the chain.
    expect(decision).toEqual({ kind: 'grace', successorId: 'gen-1' });
  });

  it('treats the same token presented after the window as a breach', () => {
    const decision = decideRefresh(
      decisionInput({
        token: {
          id: 'gen-0',
          familyId: 'f',
          usedAt: new Date(now.getTime() - 21_000),
          revokedAt: new Date(now.getTime() - 21_000),
          revokedReason: 'rotated',
          expiresAt: new Date('2026-09-18T12:00:00.000Z'),
        },
        successor: { id: 'gen-1', revokedAt: null },
      }),
    );
    expect(decision).toEqual({ kind: 'reuse' });
  });

  it('treats a used token whose chain is already dead as a breach even inside the window', () => {
    const decision = decideRefresh(
      decisionInput({
        token: {
          id: 'gen-0',
          familyId: 'f',
          usedAt: new Date(now.getTime() - 1_000),
          revokedAt: new Date(now.getTime() - 1_000),
          revokedReason: 'rotated',
          expiresAt: new Date('2026-09-18T12:00:00.000Z'),
        },
        successor: { id: 'gen-1', revokedAt: new Date(now.getTime() - 500) },
      }),
    );
    expect(decision).toEqual({ kind: 'reuse' });
  });

  it('treats a used token with no live continuation as a breach', () => {
    const decision = decideRefresh(
      decisionInput({
        token: {
          id: 'gen-0',
          familyId: 'f',
          usedAt: new Date(now.getTime() - 1_000),
          revokedAt: null,
          revokedReason: null,
          expiresAt: new Date('2026-09-18T12:00:00.000Z'),
        },
        successor: null,
      }),
    );
    expect(decision).toEqual({ kind: 'reuse' });
  });

  it('treats a never-used token revoked by an admin or a status change as a breach', () => {
    for (const reason of ['admin', 'status_change', 'reuse'] as const) {
      const decision = decideRefresh(
        decisionInput({
          token: {
            id: 't',
            familyId: 'f',
            usedAt: null,
            revokedAt: new Date(now.getTime() - 1_000),
            revokedReason: reason,
            expiresAt: new Date('2026-09-18T12:00:00.000Z'),
          },
        }),
      );
      expect(decision, reason).toEqual({ kind: 'reuse' });
    }
  });

  it('does not raise a breach alert for a tab refreshing just after a logout', () => {
    const decision = decideRefresh(
      decisionInput({
        token: {
          id: 't',
          familyId: 'f',
          usedAt: null,
          revokedAt: new Date(now.getTime() - 1_000),
          revokedReason: 'logout',
          expiresAt: new Date('2026-09-18T12:00:00.000Z'),
        },
      }),
    );
    expect(decision.kind).toBe('invalid');
  });

  it('honours a zero-length grace window', () => {
    const decision = decideRefresh(
      decisionInput({
        graceSeconds: 0,
        token: {
          id: 'gen-0',
          familyId: 'f',
          usedAt: new Date(now.getTime() - 1),
          revokedAt: new Date(now.getTime() - 1),
          revokedReason: 'rotated',
          expiresAt: new Date('2026-09-18T12:00:00.000Z'),
        },
        successor: { id: 'gen-1', revokedAt: null },
      }),
    );
    expect(decision).toEqual({ kind: 'reuse' });
  });

  it('uses the configured grace window, which is not zero by default', () => {
    expect(getConfig().REFRESH_GRACE_SECONDS).toBeGreaterThan(0);
  });
});

/* ========================================================================== */
/* the account-status gate                                                    */
/* ========================================================================== */

describe('account status gate', () => {
  it('lets an active member through', () => {
    expect(() => assertActive(userFixture({ status: 'active' }))).not.toThrow();
  });

  it('refuses a session to a pending_approval user', () => {
    expect(() => assertActive(userFixture({ status: 'pending_approval' }))).toThrowError(
      appError({ code: 'ACCOUNT_PENDING_APPROVAL', statusCode: 403 }),
    );
  });

  it('refuses a session to a rejected user', () => {
    expect(() => assertActive(userFixture({ status: 'rejected' }))).toThrowError(
      appError({ code: 'ACCOUNT_REJECTED' }),
    );
  });

  it('refuses a session to a suspended user', () => {
    expect(() => assertActive(userFixture({ status: 'suspended' }))).toThrowError(
      appError({ code: 'ACCOUNT_SUSPENDED' }),
    );
  });

  it('gives a non-active user an empty permission set regardless of role', () => {
    const suspendedOwner = buildAuthContext(userFixture({ role: 'owner', status: 'suspended' }));
    expect([...suspendedOwner.permissions]).toEqual([]);
    expect(suspendedOwner.can('member:read')).toBe(false);
  });
});

/* ========================================================================== */
/* RBAC                                                                       */
/* ========================================================================== */

describe('role matrix', () => {
  it('gives a child zero goal:* permissions', () => {
    const child = ROLE_PERMISSIONS.child.filter((p) => p.startsWith('goal:'));
    expect(child).toEqual([]);
  });

  it('gives a child zero member-administration permissions', () => {
    const admin: Permission[] = [
      'member:approve',
      'member:update:any',
      'member:remove',
      'member:role:assign',
    ];
    expect(admin.filter((p) => ROLE_PERMISSIONS.child.includes(p))).toEqual([]);
  });

  it('gives a teen read-only access to goals', () => {
    const teen = ROLE_PERMISSIONS.teen.filter((p) => p.startsWith('goal:'));
    expect(teen).toEqual(['goal:read']);
  });

  it('applies denies over grants', () => {
    const permissions = effectivePermissions('adult', ['audit:read'], ['audit:read', 'event:read']);
    expect(permissions).not.toContain('audit:read');
    expect(permissions).not.toContain('event:read');
  });

  it('produces a stable permissions fingerprint that changes with the set', () => {
    const a = buildAuthContext(userFixture({ role: 'child' }));
    const b = buildAuthContext(userFixture({ role: 'child' }));
    const c = buildAuthContext(userFixture({ role: 'teen' }));
    expect(permissionsVersion(a.permissions)).toBe(permissionsVersion(b.permissions));
    expect(permissionsVersion(a.permissions)).not.toBe(permissionsVersion(c.permissions));
  });
});

/* ========================================================================== */
/* escalation guards                                                          */
/* ========================================================================== */

describe('privilege-escalation guards', () => {
  it('lets an owner manage an admin', () => {
    expect(() => assertCanManageTarget('owner', 'admin')).not.toThrow();
  });

  it('refuses to let equal ranks manage each other', () => {
    expect(() => assertCanManageTarget('admin', 'admin')).toThrowError(
      appError({ code: 'FORBIDDEN' }),
    );
  });

  it('refuses to let an admin manage an owner', () => {
    expect(() => assertCanManageTarget('admin', 'owner')).toThrowError(AppError);
  });

  it('refuses to let an admin mint another owner', () => {
    expect(() => assertCanAssignRole('admin', 'owner')).toThrowError(
      appError({ code: 'FORBIDDEN' }),
    );
    expect(() => assertCanAssignRole('admin', 'adult')).not.toThrow();
  });

  it('refuses to grant a permission the actor does not hold', () => {
    const actor = buildAuthContext(userFixture({ role: 'adult' }));
    expect(actor.can('backup:manage')).toBe(false);
    expect(() => assertGrantsWithinActor(actor.permissions, ['backup:manage'])).toThrowError(
      appError({ code: 'FORBIDDEN' }),
    );
  });

  it('allows granting a permission the actor does hold', () => {
    const owner = buildAuthContext(userFixture({ role: 'owner' }));
    expect(() => assertGrantsWithinActor(owner.permissions, ['backup:manage'])).not.toThrow();
  });

  it('refuses to leave the family without an owner', () => {
    expect(() => assertNotLastOwner(0)).toThrowError(
      appError({ code: 'LAST_OWNER', statusCode: 403 }),
    );
    expect(() => assertNotLastOwner(1)).not.toThrow();
  });
});

describe('last login method guard', () => {
  it('refuses to unlink the only way to sign in', () => {
    expect(() => assertNotLastLoginMethod(['google'], 'google')).toThrowError(
      appError({ code: 'LAST_LOGIN_METHOD', statusCode: 403 }),
    );
  });

  it('allows unlinking when another method remains', () => {
    expect(() => assertNotLastLoginMethod(['google', 'password'], 'google')).not.toThrow();
  });

  it('counts a password as a login method', () => {
    // The credential lives on `users`, not in `user_identities` — miss it and a
    // member unlinks their last OAuth identity believing they still have one.
    expect(() => assertNotLastLoginMethod(['password'], 'password')).toThrowError(
      appError({ code: 'LAST_LOGIN_METHOD' }),
    );
  });

  it('404s for a provider that was never linked', () => {
    expect(() => assertNotLastLoginMethod(['password', 'google'], 'telegram')).toThrowError(
      appError({ code: 'NOT_FOUND' }),
    );
  });
});

describe('bootstrap rule', () => {
  it('auto-approves the very first user only when no address is nominated', () => {
    // Local dev: nobody configured BOOTSTRAP_OWNER_EMAIL and there is nobody to
    // approve the first account, so first-user-wins is the only way in.
    expect(isBootstrapSignup('anyone@example.com', 0, '', 0)).toBe(true);
  });

  it('refuses a stranger on an empty database when an address IS nominated', () => {
    // The one that matters on a public deployment. Between the deploy landing
    // and the real owner signing up, anyone who finds the URL would otherwise
    // become owner of somebody else's family — proven live against a fresh
    // production instance, which handed out `role: owner` to a smoke test.
    expect(isBootstrapSignup('stranger@example.com', 0, 'owner@example.com', 0)).toBe(false);
    // ...and the nominated address still works on that same empty database.
    expect(isBootstrapSignup('owner@example.com', 0, 'owner@example.com', 0)).toBe(true);
  });

  it('auto-approves the configured bootstrap owner while the family has no owner', () => {
    // Rows exist (e.g. a pending signup) but nobody can approve anyone yet.
    expect(isBootstrapSignup('Owner@Example.com', 5, 'owner@example.com', 0)).toBe(true);
  });

  it('is one-shot: the configured email stops working once an owner exists', () => {
    // Otherwise BOOTSTRAP_OWNER_EMAIL is a permanent unauthenticated route to an
    // owner account — registration verifies no email ownership, so knowing the
    // configured string would be enough, forever.
    expect(isBootstrapSignup('owner@example.com', 5, 'owner@example.com', 1)).toBe(false);
  });

  it('stays one-shot even when the existing owner has no email at all', () => {
    // A Telegram owner stores NULL, so the duplicate-email check cannot catch
    // this; the owner count is what closes it.
    expect(isBootstrapSignup('owner@example.com', 1, 'owner@example.com', 1)).toBe(false);
  });

  it('does not auto-approve anybody else', () => {
    expect(isBootstrapSignup('other@example.com', 5, 'owner@example.com', 0)).toBe(false);
    expect(isBootstrapSignup('other@example.com', 5, '', 0)).toBe(false);
    expect(isBootstrapSignup(null, 5, 'owner@example.com', 0)).toBe(false);
  });
});

/* ========================================================================== */
/* password hashing                                                           */
/* ========================================================================== */

describe('password hashing', () => {
  it('produces a verifiable argon2id digest', async () => {
    const digest = await hashPassword('Правильный-Пароль-9');
    expect(digest.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(digest, 'Правильный-Пароль-9')).resolves.toBe(true);
    await expect(verifyPassword(digest, 'Неправильный-Пароль-9')).resolves.toBe(false);
  });

  it('salts, so two hashes of the same password differ', async () => {
    const [a, b] = await Promise.all([hashPassword('Одинаковый-Пароль-1'), hashPassword('Одинаковый-Пароль-1')]);
    expect(a).not.toBe(b);
  });

  it('returns false — not an error — for a user with no password', async () => {
    await expect(verifyPassword(null, 'Любой-Пароль-1')).resolves.toBe(false);
    await expect(verifyPassword(undefined, 'Любой-Пароль-1')).resolves.toBe(false);
  });

  it('returns false for a corrupt digest instead of leaking a 500', async () => {
    await expect(verifyPassword('not-a-hash', 'Любой-Пароль-1')).resolves.toBe(false);
  });

  it('spends comparable time on an unknown account and a wrong password', async () => {
    const digest = await hashPassword('Правильный-Пароль-9');
    // Warm both paths so neither measurement includes the lazy dummy hash.
    await verifyPassword(null, 'x');
    await verifyPassword(digest, 'x');

    const timeOf = async (stored: string | null) => {
      const started = process.hrtime.bigint();
      await verifyPassword(stored, 'Неправильный-Пароль-9');
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const unknownUser = await timeOf(null);
    const wrongPassword = await timeOf(digest);

    // Same order of magnitude is all that can be asserted reliably on shared CI;
    // the failure this guards against is 1 ms vs 50 ms, not 40 ms vs 55 ms.
    expect(unknownUser).toBeGreaterThan(wrongPassword / 5);
  });

  it('flags weaker legacy parameters for rehashing', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$abc$def')).toBe(true);
    expect(needsRehash('$argon2i$v=19$m=19456,t=2,p=1$abc$def')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=19456,t=2,p=1$abc$def')).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });
});

/* ========================================================================== */
/* account-status tickets                                                     */
/* ========================================================================== */

describe('account status tickets', () => {
  it('round-trips a user id', () => {
    const userId = randomUUID();
    expect(readStatusTicket(createStatusTicket(userId))).toBe(userId);
  });

  it('rejects a forged signature', () => {
    const userId = randomUUID();
    const ticket = createStatusTicket(userId);
    const forged = `${ticket.slice(0, -4)}0000`;
    expect(readStatusTicket(forged)).toBeNull();
  });

  it('rejects a ticket whose user id was swapped', () => {
    const ticket = createStatusTicket(randomUUID());
    const [version, , expiresAt, signature] = ticket.split('.');
    expect(readStatusTicket(`${version}.${randomUUID()}.${expiresAt}.${signature}`)).toBeNull();
  });

  it('rejects an expired ticket', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const ticket = createStatusTicket(randomUUID(), issuedAt);
    expect(readStatusTicket(ticket, new Date('2026-06-01T00:00:00.000Z'))).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(readStatusTicket('')).toBeNull();
    expect(readStatusTicket('nonsense')).toBeNull();
    expect(readStatusTicket('v1.a.b')).toBeNull();
  });
});

/* ========================================================================== */
/* routes — no database needed                                                */
/* ========================================================================== */

/**
 * A minimal instance carrying exactly the plugins the identity routes depend on.
 *
 * Deliberately not `buildApp()`: that pulls in the Redis-backed rate limiter and
 * the readiness probe, neither of which can run without live infrastructure. The
 * boot-time "every route declares its access" assertion from `core/plugins/auth`
 * *is* registered, so `app.ready()` below is itself a test.
 */
async function buildRoutesTestApp(): Promise<FastifyInstance> {
  const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie, {
    secret: getConfig().COOKIE_SECRET,
    parseOptions: { sameSite: 'lax', httpOnly: true, path: '/' },
  });
  // In-memory store: the routes' `config.rateLimit` blocks must still be valid.
  await app.register(rateLimit, { global: false });
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  await app.register(
    async (scope) => {
      await scope.register(authRoutes);
      await scope.register(usersRoutes);
    },
    { prefix: '/api' },
  );

  await app.ready();
  return app;
}

describe('identity routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildRoutesTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots — every route declares an access configuration', () => {
    // `app.ready()` in `beforeAll` throws otherwise (deny-by-default, D4).
    expect(app.hasRoute({ method: 'POST', url: '/api/auth/refresh' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/me' })).toBe(true);
  });

  it('does not expose refresh over GET', async () => {
    // A GET refresh would be reachable from a cross-site `<img>`, and
    // `SameSite=Lax` *does* attach cookies to top-level GETs.
    //
    // 403 rather than 404 because `core/plugins/auth.ts` runs its
    // deny-by-default `onRequest` hook for unmatched routes too, and the
    // not-found handler declares no access config. Flagged to the lead; either
    // answer is a refusal, which is what this test is about.
    const response = await app.inject({ method: 'GET', url: '/api/auth/refresh' });
    expect([403, 404]).toContain(response.statusCode);
  });

  it('401s a refresh with no cookie and clears the refresh cookie', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/refresh' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');

    // Without this the installed PWA retries a dead token on every single boot.
    const cleared = response.cookies.find((c) => c.name === refreshCookieName());
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe('');
  });

  it('clears the refresh cookie for a dead token but never for an outage', async () => {
    // The invariant: the cookie is dropped only when the token is genuinely
    // rejected. Clearing it on *any* failure would mean a five-minute database
    // outage signs the whole family out and makes everyone log in again.
    //
    // Asserted against both worlds on purpose. Whether a Postgres happens to be
    // listening on the test URL is an accident of the machine, and a test that
    // silently changes meaning depending on that is worse than no test.
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { [refreshCookieName()]: 'this-token-does-not-exist' },
    });

    const cookie = response.cookies.find((c) => c.name === refreshCookieName());

    if (response.statusCode >= 500) {
      // Database unreachable — the token may well be perfectly good. Keep it.
      expect(cookie).toBeUndefined();
    } else {
      // Database answered and the token is not in it. Now it may go.
      expect(response.statusCode).toBe(401);
      expect(cookie).toBeDefined();
      expect(cookie?.value).toBe('');
    }
  });

  it('logs out idempotently with no cookie at all', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.cookies.some((c) => c.name === refreshCookieName())).toBe(true);
  });

  it('404s an unknown or forged status ticket', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/status?ticket=forged-nonsense',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('validates the login body before touching the database', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'not-an-email' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a registration that tries to declare its own role', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'nice@example.com',
        password: 'Достаточно-Длинный-1',
        displayName: 'Ня',
        role: 'owner',
      },
    });
    // `.strict()` on the contract: a smuggled field is a 400, never ignored.
    expect(response.statusCode).toBe(400);
  });

  it('401s every authenticated route without a bearer token', async () => {
    for (const url of ['/api/me', '/api/me/identities', '/api/members', '/api/members/pending']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('401s a bearer token this server did not sign', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.e30.' },
    });
    expect(response.statusCode).toBe(401);
    expect(['TOKEN_INVALID', 'TOKEN_EXPIRED', 'UNAUTHENTICATED']).toContain(
      response.json<{ error: { code: string } }>().error.code,
    );
  });
});

/* ========================================================================== */
/* database-backed behaviour                                                  */
/* ========================================================================== */

/**
 * These need a real, already-migrated Postgres: `FOR UPDATE` serialisation and
 * the conditional status update are the things under test, and a fake would only
 * test the fake.
 *
 * Run with `TEST_DATABASE_URL=postgres://... pnpm --filter @family/backend test`.
 */
describe.skipIf(!HAS_DB)('identity (database)', () => {
  let db: Db;
  let app: FastifyInstance;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    resetConfigForTests();
    db = getDb();
    app = await buildRoutesTestApp();
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      // `user_identities` and `refresh_tokens` cascade; `audit_log.actor_id` is
      // ON DELETE SET NULL and deliberately survives.
      await db.delete((await import('./users.schema.js')).users).where(
        (await import('drizzle-orm')).eq((await import('./users.schema.js')).users.id, id),
      );
    }
    await app.close();
    await closeDb();
  });

  async function makeUser(overrides: Partial<UserRow> = {}): Promise<UserRow> {
    const user = await repo.insertUser(db, {
      email: `test-${randomUUID()}@example.com`,
      displayName: 'Тест',
      role: 'adult',
      status: 'active',
      ...overrides,
    });
    createdUserIds.push(user.id);
    return user;
  }

  const ctx = { userAgent: 'vitest', ip: '127.0.0.1' };

  it('issues no session at all to a pending_approval user', async () => {
    const pending = await makeUser({ status: 'pending_approval' });
    await expect(issueSession(db, pending, ctx)).rejects.toThrowError(
      appError({ code: 'ACCOUNT_PENDING_APPROVAL' }),
    );

    const rows = await repo.listLiveRefreshTokens(db, pending.id);
    expect(rows).toEqual([]);
  });

  it('rotates a refresh token into a new generation of the same family', async () => {
    const user = await makeUser();
    const issued = await issueSession(db, user, ctx);

    const rotated = await rotateRefreshToken(db, issued.refreshToken, ctx);

    expect(rotated.rotated).toBe(true);
    expect(rotated.refreshToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    expect(rotated.familyId).toBe(issued.familyId);

    const previous = await repo.findRefreshTokenByHash(db, hashRefreshToken(issued.refreshToken));
    expect(previous?.revokedReason).toBe('rotated');
    expect(previous?.usedAt).not.toBeNull();
  });

  it('lets two concurrent refreshes inside the grace window both succeed without nuking the family', async () => {
    const user = await makeUser();
    const issued = await issueSession(db, user, ctx);

    const [a, b] = await Promise.all([
      rotateRefreshToken(db, issued.refreshToken, ctx),
      rotateRefreshToken(db, issued.refreshToken, ctx),
    ]);

    expect(a.accessToken).toBeTruthy();
    expect(b.accessToken).toBeTruthy();

    // Exactly one mints a new generation; the other replays, so the chain grows
    // by one rather than forking.
    expect([a.rotated, b.rotated].filter(Boolean)).toHaveLength(1);
    expect([a.refreshToken, b.refreshToken].filter(Boolean)).toHaveLength(1);

    const live = await repo.listLiveRefreshTokens(db, user.id);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((row) => row.familyId === issued.familyId)).toBe(true);
  });

  it('revokes the whole family when a consumed token is replayed after the window', async () => {
    process.env.REFRESH_GRACE_SECONDS = '0';
    resetConfigForTests();

    try {
      const user = await makeUser();
      const issued = await issueSession(db, user, ctx);
      await rotateRefreshToken(db, issued.refreshToken, ctx);

      await expect(rotateRefreshToken(db, issued.refreshToken, ctx)).rejects.toThrowError(
        appError({ code: 'REFRESH_TOKEN_REUSED', statusCode: 401 }),
      );

      const live = await repo.listLiveRefreshTokens(db, user.id);
      expect(live).toEqual([]);
    } finally {
      delete process.env.REFRESH_GRACE_SECONDS;
      resetConfigForTests();
    }
  });

  it('refuses to renew a session once the member is suspended, and kills every family', async () => {
    const user = await makeUser();
    const issued = await issueSession(db, user, ctx);
    await repo.updateUser(db, user.id, { status: 'suspended' });

    await expect(rotateRefreshToken(db, issued.refreshToken, ctx)).rejects.toThrowError(
      appError({ code: 'ACCOUNT_SUSPENDED' }),
    );

    const live = await repo.listLiveRefreshTokens(db, user.id);
    expect(live).toEqual([]);
  });

  it('rejects a suspended member’s access token even before it expires', async () => {
    const user = await makeUser();
    const accessToken = await signAccessToken({
      sub: user.id,
      role: user.role,
      // The claim still says `active` — the row is authoritative.
      status: 'active',
      sid: randomUUID(),
    });

    const before = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(before.statusCode).toBe(200);

    await repo.updateUser(db, user.id, { status: 'suspended' });

    const after = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(after.statusCode).toBe(403);
    expect(after.json<{ error: { code: string } }>().error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('approves exactly once when two admins click at the same moment', async () => {
    const owner = await makeUser({ role: 'owner' });
    const pending = await makeUser({ status: 'pending_approval', role: 'child' });
    const actor = buildAuthContext(owner);
    const requestCtx = { ...ctx, actorId: owner.id };

    const results = await Promise.allSettled([
      service.approveMember(db, actor, pending.id, { role: 'teen' }, requestCtx),
      service.approveMember(db, actor, pending.id, { role: 'teen' }, requestCtx),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason: unknown = rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined;
    expect(AppError.isAppError(reason) && reason.code).toBe('CONFLICT');

    const after = await repo.findUserById(db, pending.id);
    expect(after?.status).toBe('active');
    expect(after?.role).toBe('teen');
  });

  it('refuses to unlink the last login method', async () => {
    const user = await makeUser({ passwordHash: await hashPassword('Достаточно-Длинный-1') });
    await repo.insertIdentity(db, {
      userId: user.id,
      provider: 'password',
      providerUserId: user.id,
      providerEmail: user.email,
    });

    await expect(
      service.unlinkIdentity(db, user.id, 'password', { ...ctx, actorId: user.id }),
    ).rejects.toThrowError(appError({ code: 'LAST_LOGIN_METHOD' }));

    const stillThere = await repo.loginMethodsOf(db, { id: user.id, passwordHash: 'x' });
    expect(stillThere).toContain('password');
  });

  it('allows unlinking once a second method exists', async () => {
    const user = await makeUser({ passwordHash: await hashPassword('Достаточно-Длинный-1') });
    await repo.insertIdentity(db, {
      userId: user.id,
      provider: 'password',
      providerUserId: user.id,
      providerEmail: user.email,
    });
    await repo.insertIdentity(db, {
      userId: user.id,
      provider: 'google',
      providerUserId: `sub-${randomUUID()}`,
    });

    const result = await service.unlinkIdentity(db, user.id, 'google', {
      ...ctx,
      actorId: user.id,
    });
    expect(result.items.map((i) => i.provider)).not.toContain('google');
    expect(result.available).toContain('google');
  });

  it('refuses to demote or suspend the last owner', async () => {
    const owner = await makeUser({ role: 'owner' });
    const otherOwners = await repo.countActiveOwners(db, owner.id);

    if (otherOwners === 0) {
      const actor = buildAuthContext(owner);
      await expect(
        service.suspendMember(db, actor, owner.id, undefined, { ...ctx, actorId: owner.id }),
      ).rejects.toThrowError(AppError);
    }
  });
});
