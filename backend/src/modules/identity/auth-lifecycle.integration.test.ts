import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hasTestDb } from '../../test/db.js';
import {
  closeHarness,
  createMember,
  createOwner,
  errorCode,
  expectStatus,
  login,
  nextClientAddress,
  pendingIdOf,
  refreshCookieOf,
  registerUser,
  request,
  resetDatabase,
  startHarness,
  type Harness,
} from '../../test/harness.js';
import { refreshTokens } from './identity.schema.js';
import { users } from './users.schema.js';

/**
 * The session lifecycle, end to end, against Postgres.
 *
 * These are the parts of D3 that unit tests structurally cannot reach: whether
 * the `FOR UPDATE` lock really serialises two simultaneous refreshes, whether a
 * conditional `UPDATE ... WHERE status = 'pending_approval'` really produces one
 * 200 and one 409, and whether the refresh-token *rows* end up in the state the
 * pure decision function assumes. `decideRefresh` can be right in isolation and
 * still be wired to a query that does not lock.
 */
describe.skipIf(!hasTestDb)('auth lifecycle (integration)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await closeHarness();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  /* ====================================================================== */
  /* registration → approval → login → refresh → logout                     */
  /* ====================================================================== */

  describe('registration → approval → login → refresh → logout', () => {
    it('gives a pending_approval user no session anywhere in the flow', async () => {
      const owner = await createOwner(h.app);

      const { response, email, password, displayName } = await registerUser(h.app, {
        displayName: 'Ожидающий',
      });
      expectStatus(response, 200);

      const body = response.json<{
        session: unknown;
        pending: { status: string; ticket: string } | null;
      }>();

      // 1. No session in the body.
      expect(body.session).toBeNull();
      expect(body.pending?.status).toBe('pending_approval');

      // 2. No refresh cookie either — the registration response must not set one.
      expect(await refreshCookieOf(response)).toBeUndefined();

      // 3. No refresh row in the database. This is the one that a service-level
      //    test cannot make: `issueSession` is simply never reached, and only
      //    the table can prove it.
      const pendingId = await pendingIdOf(h.app, owner, displayName);
      const rows = await h.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, pendingId));
      expect(rows).toHaveLength(0);

      // 4. Logging in is refused, with the status as the reason rather than a
      //    generic credential failure.
      const attempt = await request(h.app, {
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': nextClientAddress() },
        payload: { email, password },
      });
      expect(attempt.statusCode).toBe(403);
      expect(errorCode(attempt)).toBe('ACCOUNT_PENDING_APPROVAL');
      expect(await refreshCookieOf(attempt)).toBeUndefined();

      // 5. The unauthenticated status ticket is the only thing that works.
      const status = await request(h.app, {
        method: 'GET',
        url: `/api/auth/status?ticket=${encodeURIComponent(body.pending?.ticket ?? '')}`,
      });
      expectStatus(status, 200);
      expect(status.json()).toMatchObject({ status: 'pending_approval' });
    });

    it('runs the whole happy path and revokes the family on logout', async () => {
      const owner = await createOwner(h.app);
      const member = await createMember(h.app, owner, 'adult', { displayName: 'Взрослый' });

      // The access token works.
      const me = await request(h.app, {
        method: 'GET',
        url: '/api/me',
        token: member.accessToken,
      });
      expectStatus(me, 200);
      expect(me.json()).toMatchObject({ user: { id: member.id, role: 'adult' } });

      // Refresh rotates the cookie and mints a new access token.
      const refreshed = await request(h.app, {
        method: 'POST',
        url: '/api/auth/refresh',
        refreshToken: member.refreshToken,
      });
      expectStatus(refreshed, 200);
      const rotatedCookie = await refreshCookieOf(refreshed);
      expect(rotatedCookie?.value).toBeTruthy();
      expect(rotatedCookie?.value).not.toBe(member.refreshToken);

      // Exactly two generations exist, and only the newest is live.
      const live = await h.db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.userId, member.id), isNull(refreshTokens.revokedAt)));
      const all = await h.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, member.id));
      expect(all).toHaveLength(2);
      expect(live.filter((r) => r.usedAt === null)).toHaveLength(1);

      // Logout is a 200, clears the cookie and revokes the family.
      const out = await request(h.app, {
        method: 'POST',
        url: '/api/auth/logout',
        refreshToken: rotatedCookie?.value ?? '',
      });
      expectStatus(out, 200);
      expect((await refreshCookieOf(out))?.value).toBe('');

      const afterLogout = await h.db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.userId, member.id), isNull(refreshTokens.revokedAt)));
      expect(afterLogout).toHaveLength(0);

      // And the cookie is dead.
      const replay = await request(h.app, {
        method: 'POST',
        url: '/api/auth/refresh',
        refreshToken: rotatedCookie?.value ?? '',
      });
      expect(replay.statusCode).toBe(401);
    });

    it('approves conditionally: two simultaneous approvals produce one 200 and one 409', async () => {
      const owner = await createOwner(h.app);
      const admin = await createMember(h.app, owner, 'admin', { displayName: 'Второй админ' });

      const { response } = await registerUser(h.app, { displayName: 'Спорный' });
      expectStatus(response, 200);
      const targetId = await pendingIdOf(h.app, owner, 'Спорный');

      // Two admins clicking at the same moment. The conditional
      // `UPDATE ... WHERE status = 'pending_approval'` is the whole mechanism;
      // firing them sequentially would prove nothing.
      const [a, b] = await Promise.all([
        request(h.app, {
          method: 'POST',
          url: `/api/members/${targetId}/approve`,
          token: owner.accessToken,
          payload: { role: 'teen' },
        }),
        request(h.app, {
          method: 'POST',
          url: `/api/members/${targetId}/approve`,
          token: admin.accessToken,
          payload: { role: 'child' },
        }),
      ]);

      const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);
      expect(statuses).toEqual([200, 409]);

      const loser = a.statusCode === 409 ? a : b;
      expect(errorCode(loser)).toBe('CONFLICT');

      // Exactly one role choice survived — not a merge of the two.
      const [row] = await h.db.select().from(users).where(eq(users.id, targetId));
      expect(row?.status).toBe('active');
      expect(['teen', 'child']).toContain(row?.role);

      const winner = a.statusCode === 200 ? a : b;
      expect(winner.json<{ role: string }>().role).toBe(row?.role);
    });

    it('kills a suspended user: the access token stops working and every family is revoked', async () => {
      const owner = await createOwner(h.app);
      const member = await createMember(h.app, owner, 'adult', { displayName: 'Отстранённый' });

      // A second device, so "every family" means more than one row.
      const second = await login(h.app, member.email, member.password);

      const before = await request(h.app, {
        method: 'GET',
        url: '/api/me',
        token: member.accessToken,
      });
      expectStatus(before, 200);

      const suspend = await request(h.app, {
        method: 'POST',
        url: `/api/members/${member.id}/suspend`,
        token: owner.accessToken,
        payload: { reason: 'тест' },
      });
      expectStatus(suspend, 200);

      // The access token is cryptographically still valid and unexpired. The
      // status gate in `core/plugins/auth.ts` re-reads the row, which is the
      // only reason this fails — and only a real request can prove it does.
      const after = await request(h.app, {
        method: 'GET',
        url: '/api/me',
        token: member.accessToken,
      });
      expect(after.statusCode).toBe(403);
      expect(errorCode(after)).toBe('ACCOUNT_SUSPENDED');

      // Both refresh families are dead in the same transaction as the status
      // change, so the suspension cannot be renewed.
      const liveRows = await h.db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.userId, member.id), isNull(refreshTokens.revokedAt)));
      expect(liveRows).toHaveLength(0);

      for (const token of [member.refreshToken, second.refreshToken]) {
        const attempt = await request(h.app, {
          method: 'POST',
          url: '/api/auth/refresh',
          refreshToken: token,
        });
        expect(attempt.statusCode).toBeGreaterThanOrEqual(400);
        expect(attempt.statusCode).toBeLessThan(500);
      }

      // And a fresh login is refused too.
      const relogin = await request(h.app, {
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': nextClientAddress() },
        payload: { email: member.email, password: member.password },
      });
      expect(relogin.statusCode).toBe(403);
      expect(errorCode(relogin)).toBe('ACCOUNT_SUSPENDED');
    });
  });

  /* ====================================================================== */
  /* refresh rotation under concurrency                                     */
  /* ====================================================================== */

  describe('refresh rotation under concurrency', () => {
    it('holds the grace window: five simultaneous refreshes all succeed and the family survives', async () => {
      const owner = await createOwner(h.app);
      const member = await createMember(h.app, owner, 'adult', { displayName: 'Много вкладок' });

      // Five tabs resuming at once with the same cookie. Exactly one may win
      // the `FOR UPDATE` race and mint a successor; the other four must be
      // answered from the grace window with a fresh access token and NO
      // `Set-Cookie`, because the winner's cookie is already in the jar.
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(h.app, {
            method: 'POST',
            url: '/api/auth/refresh',
            refreshToken: member.refreshToken,
          }),
        ),
      );

      for (const response of responses) {
        expectStatus(response, 200);
        expect(response.json<{ accessToken: string }>().accessToken).toBeTruthy();
      }

      // No fork: exactly one successor generation was minted, not five.
      const rows = await h.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, member.id));
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.generation === 1)).toHaveLength(1);

      // The family is not revoked — a refresh storm must not look like a breach.
      expect(rows.filter((r) => r.revokedReason === 'reuse')).toHaveLength(0);
      const head = rows.find((r) => r.generation === 1);
      expect(head?.revokedAt).toBeNull();

      // Exactly one response carried a new cookie.
      const withCookie = (await Promise.all(responses.map((r) => refreshCookieOf(r)))).filter(
        (c) => c && c.value.length > 0,
      );
      expect(withCookie).toHaveLength(1);

      // The winner's cookie still works afterwards.
      const next = await request(h.app, {
        method: 'POST',
        url: '/api/auth/refresh',
        refreshToken: withCookie[0]?.value ?? '',
      });
      expectStatus(next, 200);
    });

    it('kills the whole family when a genuinely revoked token is replayed', async () => {
      const owner = await createOwner(h.app);
      const member = await createMember(h.app, owner, 'adult', { displayName: 'Утёкший токен' });

      // Walk the chain forward twice so generation 0 is well past any grace
      // window, then age it by hand: `used_at` in the distant past is what
      // "presented after the window with the chain moved on" means.
      const first = await request(h.app, {
        method: 'POST',
        url: '/api/auth/refresh',
        refreshToken: member.refreshToken,
      });
      expectStatus(first, 200);
      const gen1 = (await refreshCookieOf(first))?.value ?? '';

      const second = await request(h.app, {
        method: 'POST',
        url: '/api/auth/refresh',
        refreshToken: gen1,
      });
      expectStatus(second, 200);
      const gen2 = (await refreshCookieOf(second))?.value ?? '';

      const longAgo = new Date(Date.now() - 60 * 60 * 1000);
      await h.db
        .update(refreshTokens)
        .set({ usedAt: longAgo })
        .where(and(eq(refreshTokens.userId, member.id), eq(refreshTokens.generation, 0)));

      // The attacker replays the stolen generation-0 cookie.
      const replay = await request(h.app, {
        method: 'POST',
        url: '/api/auth/refresh',
        refreshToken: member.refreshToken,
      });
      expect(replay.statusCode).toBe(401);
      expect(errorCode(replay)).toBe('REFRESH_TOKEN_REUSED');

      // The entire family — including the *legitimate* holder's live cookie —
      // is revoked. That is the point: only killing everything evicts both
      // parties.
      const rows = await h.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, member.id));
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect(rows.some((r) => r.revokedReason === 'reuse')).toBe(true);

      const victim = await request(h.app, {
        method: 'POST',
        url: '/api/auth/refresh',
        refreshToken: gen2,
      });
      expect(victim.statusCode).toBe(401);

      // A 401 always clears the cookie, so the PWA stops retrying a dead token.
      expect((await refreshCookieOf(victim))?.value).toBe('');
    });

    it('does not slide the family expiry across generations', async () => {
      const owner = await createOwner(h.app);
      const member = await createMember(h.app, owner, 'adult', { displayName: 'Не продлевается' });

      const refreshed = await request(h.app, {
        method: 'POST',
        url: '/api/auth/refresh',
        refreshToken: member.refreshToken,
      });
      expectStatus(refreshed, 200);

      const rows = await h.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, member.id));
      const expiries = new Set(rows.map((r) => r.expiresAt.getTime()));
      // Every generation inherits the original expiry: a compromised session
      // cannot be renewed forever by refreshing it.
      expect(expiries.size).toBe(1);
    });

    it('treats a refresh after logout as invalid rather than as a breach', async () => {
      const owner = await createOwner(h.app);
      const member = await createMember(h.app, owner, 'adult', { displayName: 'Вышел' });

      const out = await request(h.app, {
        method: 'POST',
        url: '/api/auth/logout',
        refreshToken: member.refreshToken,
      });
      expectStatus(out, 200);

      const late = await request(h.app, {
        method: 'POST',
        url: '/api/auth/refresh',
        refreshToken: member.refreshToken,
      });
      expect(late.statusCode).toBe(401);
      // A background tab racing a sign-out is not a security incident.
      expect(errorCode(late)).toBe('TOKEN_INVALID');
    });
  });
});
