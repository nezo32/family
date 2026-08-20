import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MemberListItem, PublicUser } from '@family/shared';

import { getDb } from '../../core/db.js';
import { hasTestDb } from '../../test/db.js';
import {
  closeHarness,
  createMember,
  createOwner,
  errorCode,
  expectStatus,
  nextClientAddress,
  pendingIdOf,
  registerUser,
  request,
  resetDatabase,
  startHarness,
  type Harness,
  type TestUser,
} from '../../test/harness.js';
import { auditLog, userIdentities } from './identity.schema.js';
import { resolveOAuthIdentityAndNotify, type OAuthProfile } from './oauth/linking.js';
import { users } from './users.schema.js';

/**
 * Rejecting a join request has to hand the sign-in identity back.
 *
 * ## The incident
 *
 * The owner opened the app from the wrong account by accident, the stray
 * sign-in raised a join request, and they declined it. Production then looked
 * like this:
 *
 * ```
 * Веган Потата            active    admin  telegram 808850864
 * nezo.prod32@gmail.com   active    owner  google
 * nezo                    rejected  child  telegram 835007860
 * ```
 *
 * — and the owner could no longer link Telegram to their real profile:
 * «я случайно зашел с другого аккаунта - отклонил присоединение и теперь не могу
 * привязать телеграм». `UNIQUE (provider, provider_user_id)` had bound subject
 * `835007860` to a row nobody would ever sign into again, and there is no
 * un-reject transition to free it. A declined request cost the person their
 * identity, permanently.
 *
 * ## What is asserted here, and why it needs a database
 *
 * The requirement is a **round trip**, not a vanished row: reject, then have
 * the same provider subject sign up again and land in the approval queue as a
 * stranger. Every part of that lives in constraints and predicates — the unique
 * index, the partial `users_email_lower_uq`, the `ALREADY_EXISTS` check in
 * `register`, the `email_belongs_to_existing_user` branch — so a mocked
 * repository would agree with itself while production kept refusing.
 *
 * The OAuth halves go through `resolveOAuthIdentityAndNotify`, which is the
 * exact function every provider callback and both Telegram fallbacks call once
 * the token has been verified. What it is handed here is what a verified
 * Telegram id_token produces; skipping the token exchange keeps the test off
 * the network without skipping any of the identity resolution.
 */
describe.skipIf(!hasTestDb)('rejection releases the sign-in identity (integration)', () => {
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

  /** The owner's stray account, as Telegram hands it to us. */
  const TELEGRAM_SUBJECT = '835007860';

  function telegramProfile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
    return {
      provider: 'telegram',
      providerUserId: TELEGRAM_SUBJECT,
      // Telegram never yields an email. Ever. That is not an omission here.
      email: null,
      emailVerified: false,
      displayName: 'nezo',
      username: 'nezo',
      avatarUrl: null,
      rawProfile: {},
      ...overrides,
    };
  }

  /** A Telegram signup, exactly as a verified callback performs one. */
  async function telegramSignup(profile = telegramProfile()) {
    return resolveOAuthIdentityAndNotify(getDb(), {
      profile,
      intent: 'login',
      sessionUserId: null,
    });
  }

  async function reject(owner: TestUser, targetId: string, reason?: string) {
    return request(h.app, {
      method: 'POST',
      url: `/api/members/${targetId}/reject`,
      token: owner.accessToken,
      ...(reason === undefined ? {} : { payload: { reason } }),
    });
  }

  /* ====================================================================== */
  /* the round trip                                                          */
  /* ====================================================================== */

  it('frees a rejected Telegram subject, and the second signup lands in the queue', async () => {
    const owner = await createOwner(h.app);

    /* ---- the accident --------------------------------------------------- */

    const first = await telegramSignup();
    expect(first.outcome).toBe('created');
    expect(first.user.status).toBe('pending_approval');

    const declined = await reject(owner, first.userId, 'случайный вход');
    expectStatus(declined, 200);
    expect(declined.json<MemberListItem>().status).toBe('rejected');

    /*
     * The row survives — it is the record that somebody asked to join and was
     * told no — but nothing that can be signed in with does.
     */
    const [tombstone] = await h.db.select().from(users).where(eq(users.id, first.userId));
    expect(tombstone?.status).toBe('rejected');
    expect(tombstone?.displayName).toBe('nezo');
    expect(tombstone?.rejectedReason).toBe('случайный вход');
    expect(tombstone?.email).toBeNull();
    expect(tombstone?.passwordHash).toBeNull();

    const orphans = await h.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, first.userId));
    expect(orphans).toHaveLength(0);

    /* ---- the invariant: the subject is free ------------------------------ */

    // Not "a row disappeared" — the same Telegram account gets in again, which
    // is the thing that was actually broken.
    const second = await telegramSignup();
    expect(second.outcome).toBe('created');
    expect(second.userId).not.toBe(first.userId);

    // A stranger, not a returning member: no role, no session, no shortcut.
    expect(second.user.status).toBe('pending_approval');
    expect(second.user.role).toBe('child');
    expect(second.user.approvedAt).toBeNull();

    /* ---- and it lands in the queue, not in the family --------------------- */

    const queue = await request(h.app, {
      method: 'GET',
      url: '/api/members/pending',
      token: owner.accessToken,
    });
    expectStatus(queue, 200);
    const queued = queue.json<{ items: MemberListItem[]; pendingCount: number }>();
    expect(queued.pendingCount).toBe(1);
    expect(queued.items.map((m) => m.id)).toEqual([second.userId]);
  });

  /**
   * The generalisation of the same bug: `users.email` is a sign-in key too.
   *
   * Deleting only the `user_identities` rows would free a Telegram subject and
   * leave a Google address or a password login just as stuck — `register`
   * answers `ALREADY_EXISTS` off `users_email_lower_uq`, and the OAuth callback
   * answers `IDENTITY_ALREADY_LINKED` off `email_belongs_to_existing_user`.
   * Neither has a way out either, so the release covers the address and the
   * password hash as well as the identity rows.
   */
  it('frees the email of a rejected password signup so it can register again', async () => {
    const owner = await createOwner(h.app);

    const { response, email, password, displayName } = await registerUser(h.app, {
      displayName: 'Случайный гость',
    });
    expectStatus(response, 200);
    const applicantId = await pendingIdOf(h.app, owner, displayName);

    expectStatus(await reject(owner, applicantId), 200);

    // Same address, brand new request, and a different secret — so "the login
    // works again" cannot be satisfied by the tombstone's surviving hash.
    const newPassword = `${password}-second`;
    const again = await request(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'x-forwarded-for': nextClientAddress() },
      payload: { email, password: newPassword, displayName },
    });
    expectStatus(again, 200);
    expect(again.json<{ session: unknown; pending: unknown }>().pending).not.toBeNull();
    // Still no session for a second-time applicant — bootstrap is spent.
    expect(again.json<{ session: unknown }>().session).toBeNull();

    // Two rows now: the tombstone and the live request. Only one holds the
    // address, and it is the live one.
    const rows = await h.db.select().from(users);
    const holders = rows.filter((r) => r.email?.toLowerCase() === email.toLowerCase());
    expect(holders).toHaveLength(1);
    expect(holders[0]?.status).toBe('pending_approval');

    // The old secret is dead — the tombstone's hash was nulled, so there is
    // nothing left for `verifyPassword` to match.
    const stale = await request(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': nextClientAddress() },
      payload: { email, password },
    });
    expect(errorCode(stale)).toBe('INVALID_CREDENTIALS');

    // The new one resolves to the new row — which is waiting for a decision,
    // not signed in. A released address buys a place in the queue, nothing more.
    const fresh = await request(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': nextClientAddress() },
      payload: { email, password: newPassword },
    });
    expect(errorCode(fresh)).toBe('ACCOUNT_PENDING_APPROVAL');
  });

  /**
   * Rejecting the same person twice must not collide.
   *
   * Their second attempt is a different `users` row — the subject no longer
   * resolves to the first — so the conditional transition, the release and
   * `UNIQUE (provider, provider_user_id)` all operate on rows that never meet.
   * The failure this rules out is a release that tried to reuse the tombstone.
   */
  it('survives the same person being rejected twice', async () => {
    const owner = await createOwner(h.app);

    const first = await telegramSignup();
    expectStatus(await reject(owner, first.userId), 200);

    const second = await telegramSignup();
    expectStatus(await reject(owner, second.userId), 200);

    const third = await telegramSignup();
    expect(third.user.status).toBe('pending_approval');

    const tombstones = await h.db.select().from(users).where(eq(users.status, 'rejected'));
    expect(tombstones).toHaveLength(2);

    // Exactly one live binding for the subject, and it belongs to the newcomer.
    const bindings = await h.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.providerUserId, TELEGRAM_SUBJECT));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.userId).toBe(third.userId);
  });

  /**
   * The release is not amnesia — it moves the record, it does not erase it.
   *
   * `audit_log.target_id` is a loose uuid, deliberately not a foreign key, so
   * it keeps pointing at the tombstone; the identity that was handed back is
   * written into the same entry, inside the same transaction as the rejection.
   * Without this, «кто это вообще был» would have no answer anywhere.
   */
  it('records the released identity in the audit entry', async () => {
    const owner = await createOwner(h.app);
    const created = await telegramSignup();

    expectStatus(await reject(owner, created.userId, 'не знаю этого человека'), 200);

    const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.action, 'member:reject'));

    expect(entry?.actorId).toBe(owner.id);
    expect(entry?.targetId).toBe(created.userId);

    const metadata = entry?.metadata as {
      reason?: string;
      released?: { identities?: { provider?: string; providerUserId?: string }[] };
    };
    expect(metadata.reason).toBe('не знаю этого человека');
    expect(metadata.released?.identities).toEqual([
      expect.objectContaining({ provider: 'telegram', providerUserId: TELEGRAM_SUBJECT }),
    ]);
  });

  /* ====================================================================== */
  /* rejected users are not family members                                   */
  /* ====================================================================== */

  describe('the roster', () => {
    async function rosterOf(user: TestUser, query = '') {
      const response = await request(h.app, {
        method: 'GET',
        url: `/api/members${query}`,
        token: user.accessToken,
      });
      expectStatus(response, 200);
      return response.json<{ items: (MemberListItem | PublicUser)[]; pendingCount: number }>();
    }

    it('omits rejected applicants for everyone, the owner included', async () => {
      const owner = await createOwner(h.app);
      const child = await createMember(h.app, owner, 'child', { displayName: 'Ребёнок' });

      const created = await telegramSignup();
      expectStatus(await reject(owner, created.userId), 200);

      // The owner's «Семья» screen is fed by exactly this call.
      const ownerRoster = await rosterOf(owner);
      expect(ownerRoster.items.map((m) => m.id)).not.toContain(created.userId);

      // And every picker in the app is fed by the same one.
      const childRoster = await rosterOf(child);
      expect(childRoster.items.map((m) => m.id)).not.toContain(created.userId);
      expect(childRoster.items.every((m) => m.status !== 'rejected')).toBe(true);
    });

    it('still shows suspended and pending members — only rejected is subtracted', async () => {
      const owner = await createOwner(h.app);
      const member = await createMember(h.app, owner, 'adult', { displayName: 'Взрослый' });

      expectStatus(
        await request(h.app, {
          method: 'POST',
          url: `/api/members/${member.id}/suspend`,
          token: owner.accessToken,
        }),
        200,
      );

      const { response, displayName } = await registerUser(h.app, { displayName: 'Ждущий' });
      expectStatus(response, 200);
      const waitingId = await pendingIdOf(h.app, owner, displayName);

      const roster = await rosterOf(owner);
      const byId = new Map(roster.items.map((m) => [m.id, m]));
      // A suspension is reversible and a pending request is undecided; neither
      // is a person who was turned away. Widening the subtraction to either
      // would hide a member the family still has.
      expect(byId.get(member.id)?.status).toBe('suspended');
      expect(byId.get(waitingId)?.status).toBe('pending_approval');
    });

    /**
     * The subtraction must be exactly one status wide.
     *
     * The family's `admin` signed in through Telegram — no email, a non-owner
     * role, and an identity row that looks exactly like the rejected
     * applicant's. She is the shape a careless predicate catches: filter on
     * "not the owner", or on "has no email", or on "came in through Telegram",
     * and she disappears from every picker in the app instead of the person who
     * was turned away. The predicate is `status <> 'rejected'` and nothing else,
     * and this is the test that says so.
     */
    it('keeps an active Telegram admin everywhere she belongs', async () => {
      const owner = await createOwner(h.app);

      const wife = await telegramSignup(
        telegramProfile({ providerUserId: '808850864', displayName: 'Веган Потата' }),
      );
      const approved = await request(h.app, {
        method: 'POST',
        url: `/api/members/${wife.userId}/approve`,
        token: owner.accessToken,
        payload: { role: 'admin' },
      });
      expectStatus(approved, 200);

      // Somebody else being rejected must not disturb her.
      const stray = await telegramSignup();
      expectStatus(await reject(owner, stray.userId), 200);

      for (const query of ['', '?includeRejected=true', '?role=admin']) {
        const roster = await rosterOf(owner, query);
        const row = roster.items.find((m) => m.id === wife.userId);
        expect(row, `missing from /members${query}`).toBeDefined();
        expect(row?.status).toBe('active');
        expect(row?.role).toBe('admin');
      }

      // And from a child's view of the roster, which is the one every picker
      // in the app is actually built from.
      const child = await createMember(h.app, owner, 'child', { displayName: 'Ребёнок' });
      const seen = await rosterOf(child);
      expect(seen.items.map((m) => m.id)).toContain(wife.userId);
      expect(seen.items.map((m) => m.id)).not.toContain(stray.userId);

      // Her Telegram binding is untouched — releasing one identity releases one.
      const bindings = await h.db
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.userId, wife.userId));
      expect(bindings.map((b) => b.providerUserId)).toEqual(['808850864']);
    });

    it('lets an admin opt back in, and never lets a child', async () => {
      const owner = await createOwner(h.app);
      const child = await createMember(h.app, owner, 'child', { displayName: 'Ребёнок' });

      const created = await telegramSignup();
      expectStatus(await reject(owner, created.userId), 200);

      // The moderation screen: an admin who declined somebody by accident has
      // to be able to see what they declined.
      const optedIn = await rosterOf(owner, '?includeRejected=true');
      expect(optedIn.items.map((m) => m.id)).toContain(created.userId);

      const narrow = await rosterOf(owner, '?status=rejected');
      expect(narrow.items.map((m) => m.id)).toEqual([created.userId]);

      // The opt-in is permission-gated, not a querystring anybody can type.
      // D4: outside your read scope the answer is emptiness, not a 403.
      const childOptIn = await rosterOf(child, '?includeRejected=true');
      expect(childOptIn.items.map((m) => m.id)).not.toContain(created.userId);
      expect(await rosterOf(child, '?status=rejected')).toMatchObject({ items: [] });
    });

    /**
     * `?includeRejected=false` has to mean false.
     *
     * `z.coerce.boolean()` is `Boolean(value)` and every non-empty string is
     * truthy, so the naive schema turns the explicit opt-*out* into an opt-in.
     * `queryBooleanSchema` exists for this; asserted over the wire because that
     * is where the coercion actually happens.
     */
    it('does not read ?includeRejected=false as true', async () => {
      const owner = await createOwner(h.app);
      const created = await telegramSignup();
      expectStatus(await reject(owner, created.userId), 200);

      const roster = await rosterOf(owner, '?includeRejected=false');
      expect(roster.items.map((m) => m.id)).not.toContain(created.userId);
    });
  });
});
