import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hasTestDb } from '../../test/db.js';
import {
  closeHarness,
  createMember,
  createOwner,
  expectStatus,
  request,
  resetDatabase,
  startHarness,
  type Harness,
  type TestUser,
} from '../../test/harness.js';
import { notificationDeliveries, notificationIntents } from './notifications.schema.js';

/**
 * Notification fan-out, against the real database.
 *
 * The pure halves — quiet-hours arithmetic, the preference matrix, the ack
 * clamp — are already unit-tested. What is not, and cannot be without Postgres:
 * that `dispatchIntent` writes exactly one delivery row per (recipient,
 * channel), that the in-app row is written *regardless* of preferences and
 * quiet hours, that quiet hours produce a `scheduled` row rather than dropping
 * one, and that a replayed ack is a genuine no-op rather than a second write.
 *
 * Since D12 it also covers the change-feed bump: fan-out is what makes an
 * in-app notification exist, so fan-out is what has to tell the feed.
 */
describe.skipIf(!hasTestDb)('notification fan-out (integration)', () => {
  let h: Harness;
  let owner: TestUser;
  let adult: TestUser;
  let teen: TestUser;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await closeHarness();
  });

  beforeEach(async () => {
    await resetDatabase();
    owner = await createOwner(h.app);
    adult = await createMember(h.app, owner, 'adult', { displayName: 'Взрослый' });
    teen = await createMember(h.app, owner, 'teen', { displayName: 'Подросток' });
  });

  /* -------------------------------- helpers ----------------------------- */

  async function emitAndDispatch(
    input: {
      type?: string;
      actorId?: string;
      audience?: Record<string, unknown>;
      dedupeKey?: string | null;
      payload?: Record<string, unknown>;
      priority?: string;
    } = {},
    now = new Date(),
  ): Promise<string> {
    const service = await import('./notifications.service.js');
    const result = await service.emitIntent(h.db, {
      type: (input.type ?? 'announcement_posted') as never,
      actorId: input.actorId ?? owner.id,
      audience: (input.audience ?? { everyone: true }) as never,
      ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
      ...(input.priority === undefined ? {} : { priority: input.priority as never }),
      payload: input.payload ?? { title: 'Объявление' },
    });
    // `dispatch()` is the BullMQ hand-off; the worker would call
    // `dispatchIntent`. Calling it directly keeps the test independent of a
    // running worker while exercising the same code path a worker would.
    await service.dispatchIntent(h.db, result.intentId, now);
    return result.intentId;
  }

  async function deliveriesOf(intentId: string) {
    return h.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.intentId, intentId));
  }

  /* ====================================================================== */
  /* fan-out                                                                */
  /* ====================================================================== */

  it('fans an intent out to every eligible member, and never to the actor', async () => {
    const intentId = await emitAndDispatch({ actorId: owner.id, audience: { everyone: true } });

    const rows = await deliveriesOf(intentId);
    const recipients = new Set(rows.map((r) => r.userId));

    // §3.4 self-suppression: you are never told about your own action.
    expect(recipients.has(owner.id)).toBe(false);
    expect(recipients.has(adult.id)).toBe(true);
    expect(recipients.has(teen.id)).toBe(true);

    // The in-app row is the durable record and is always written.
    for (const userId of [adult.id, teen.id]) {
      const inApp = rows.filter((r) => r.userId === userId && r.channel === 'in_app');
      expect(inApp).toHaveLength(1);
      expect(inApp[0]?.status).toBe('sent');
    }
  });

  it('addresses a role audience without touching anybody else', async () => {
    const intentId = await emitAndDispatch({
      actorId: owner.id,
      audience: { roles: ['adult'] },
    });

    const recipients = new Set((await deliveriesOf(intentId)).map((r) => r.userId));
    expect(recipients).toEqual(new Set([adult.id]));
  });

  it('writes the in-app row even when every channel is switched off', async () => {
    // The teen turns the whole type off.
    const off = await request(h.app, {
      method: 'PUT',
      url: '/api/notifications/preferences',
      token: teen.accessToken,
      payload: {
        preferences: [
          {
            type: 'announcement_posted',
            enabled: false,
            channelPush: false,
            channelTelegram: false,
            channelInApp: false,
          },
        ],
      },
    });
    expectStatus(off, 200);

    const intentId = await emitAndDispatch({ actorId: owner.id });
    const rows = (await deliveriesOf(intentId)).filter((r) => r.userId === teen.id);

    // Exactly one row, in_app, `sent`. §3.7: suppressing it would lose
    // information the user can never recover, so a preference cannot delete it.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe('in_app');
    expect(rows[0]?.status).toBe('sent');

    // …and the adult, who changed nothing, still gets the full fan-out.
    const adultRows = (await deliveriesOf(intentId)).filter((r) => r.userId === adult.id);
    expect(adultRows.length).toBeGreaterThanOrEqual(1);
  });

  it('records a push row as suppressed when there is no subscribed device', async () => {
    const intentId = await emitAndDispatch({ actorId: owner.id });
    const rows = (await deliveriesOf(intentId)).filter(
      (r) => r.userId === adult.id && r.channel === 'push',
    );

    // A record, not silence: the UI has to be able to say honestly «push
    // включён, но ни одного устройства не подписано».
    for (const row of rows) {
      expect(row.status).toBe('suppressed');
      expect(row.subscriptionId).toBeNull();
    }
  });

  it('is idempotent: dispatching the same intent twice writes no second row', async () => {
    const service = await import('./notifications.service.js');
    const intentId = await emitAndDispatch({ actorId: owner.id });
    const before = await deliveriesOf(intentId);

    await service.dispatchIntent(h.db, intentId, new Date());

    const after = await deliveriesOf(intentId);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
  });

  it('collapses a duplicate dedupeKey into one intent', async () => {
    const service = await import('./notifications.service.js');
    const key = 'announcement_posted:same-post';

    const first = await service.emitIntent(h.db, {
      type: 'announcement_posted',
      actorId: owner.id,
      audience: { everyone: true },
      dedupeKey: key,
      payload: { title: 'Раз' },
    });
    const second = await service.emitIntent(h.db, {
      type: 'announcement_posted',
      actorId: owner.id,
      audience: { everyone: true },
      dedupeKey: key,
      payload: { title: 'Два' },
    });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.intentId).toBe(first.intentId);

    const intents = await h.db
      .select()
      .from(notificationIntents)
      .where(eq(notificationIntents.dedupeKey, key));
    expect(intents).toHaveLength(1);
  });

  /* ====================================================================== */
  /* quiet hours defer rather than drop                                     */
  /* ====================================================================== */

  it('defers a push into a quiet window instead of dropping it', async () => {
    // 22:00 → 07:30 Moscow, the common wrapping case.
    const set = await request(h.app, {
      method: 'PUT',
      url: '/api/notifications/quiet-hours',
      token: adult.accessToken,
      payload: {
        windows: [{ dayOfWeek: null, startsAt: '22:00', endsAt: '07:30', mode: 'defer' }],
      },
    });
    expectStatus(set, 200);

    // 2026-09-07T23:30 Moscow = 20:30Z. Squarely inside the window.
    const insideWindow = new Date('2026-09-07T20:30:00Z');
    const intentId = await emitAndDispatch({ actorId: owner.id }, insideWindow);

    const rows = (await deliveriesOf(intentId)).filter((r) => r.userId === adult.id);

    // The durable in-app record still lands immediately — quiet hours are about
    // the *interrupting* channels.
    const inApp = rows.find((r) => r.channel === 'in_app');
    expect(inApp?.status).toBe('sent');

    // Nothing was dropped. Every interrupting row is either scheduled for the
    // end of the window, or suppressed for a reason unrelated to quiet hours
    // (no subscribed device).
    const interrupting = rows.filter((r) => r.channel !== 'in_app');
    expect(interrupting.length).toBeGreaterThan(0);
    for (const row of interrupting) {
      expect(['scheduled', 'suppressed']).toContain(row.status);
      if (row.status === 'scheduled') {
        expect(row.scheduledFor).not.toBeNull();
        // Released at 07:30 Moscow the next morning = 04:30Z.
        expect(row.scheduledFor?.toISOString()).toBe('2026-09-08T04:30:00.000Z');
      }
    }

    // The member who set no quiet hours is unaffected by somebody else's.
    const teenRows = (await deliveriesOf(intentId)).filter(
      (r) => r.userId === teen.id && r.channel !== 'in_app',
    );
    for (const row of teenRows) {
      expect(row.status).not.toBe('scheduled');
    }
  });

  it('lets a critical alert through a quiet window', async () => {
    const set = await request(h.app, {
      method: 'PUT',
      url: '/api/notifications/quiet-hours',
      token: adult.accessToken,
      payload: {
        windows: [{ dayOfWeek: null, startsAt: '22:00', endsAt: '07:30', mode: 'defer' }],
      },
    });
    expectStatus(set, 200);

    const insideWindow = new Date('2026-09-07T20:30:00Z');
    const intentId = await emitAndDispatch(
      { type: 'system_alert', actorId: owner.id, priority: 'critical' },
      insideWindow,
    );

    const rows = (await deliveriesOf(intentId)).filter(
      (r) => r.userId === adult.id && r.channel !== 'in_app',
    );
    for (const row of rows) {
      expect(row.status).not.toBe('scheduled');
    }
  });

  /* ====================================================================== */
  /* acks move the delivery forward, and a replay is a no-op                */
  /* ====================================================================== */

  /**
   * KNOWN FAILURE — documents a real bug, do not relax.
   *
   * `notifications.repository.ts:710` builds
   *
   *   .set({ [field]: sql`coalesce(${column}, ${at})` })
   *
   * where `at` is a JavaScript `Date`. A raw `sql` fragment bypasses the column
   * encoder, and `drizzle-orm/postgres-js/driver.js` has replaced postgres.js's
   * timestamp serializers with an identity function, so the `Date` reaches the
   * wire encoder unconverted and the statement throws `ERR_INVALID_ARG_TYPE`.
   *
   * Net effect: `POST /notifications/deliveries/:id/delivered`,
   * `/interacted` and `/acknowledge` are all 500s. Every receipt the service
   * worker sends is lost, which also means push-subscription health never
   * recovers and escalation deadlines never see an ack.
   */
  it('moves a delivery forward on ack and is idempotent on replay', async () => {
    const intentId = await emitAndDispatch({ actorId: owner.id });
    const inApp = (await deliveriesOf(intentId)).find(
      (r) => r.userId === adult.id && r.channel === 'in_app',
    );
    if (!inApp) throw new Error('no in-app delivery to ack');

    const ack = (kind: 'delivered' | 'interacted' | 'acknowledge', payload = {}) =>
      request(h.app, {
        method: 'POST',
        url: `/api/notifications/deliveries/${inApp.id}/${kind}`,
        token: adult.accessToken,
        payload,
      });

    const first = await ack('delivered');
    expectStatus(first, 200);
    const firstBody = first.json<{ status: string; deliveredAt: string | null }>();
    expect(firstBody.deliveredAt).not.toBeNull();

    // A replay from an IndexedDB queue hours later must stamp nothing new and
    // must not move the status backwards.
    const replay = await ack('delivered');
    expectStatus(replay, 200);
    const replayBody = replay.json<{ status: string; deliveredAt: string | null }>();
    expect(replayBody.deliveredAt).toBe(firstBody.deliveredAt);
    expect(replayBody.status).toBe(firstBody.status);

    // Forward only: interacting after delivering advances the row.
    const interacted = await ack('interacted');
    expectStatus(interacted, 200);
    const interactedBody = interacted.json<{
      deliveredAt: string | null;
      interactedAt: string | null;
    }>();
    expect(interactedBody.interactedAt).not.toBeNull();
    // The earlier observation survives — `coalesce` keeps the first one.
    expect(interactedBody.deliveredAt).toBe(firstBody.deliveredAt);

    // A later `delivered` replay cannot undo the interaction.
    const late = await ack('delivered');
    expectStatus(late, 200);
    expect(late.json<{ interactedAt: string | null }>().interactedAt).toBe(
      interactedBody.interactedAt,
    );

    const [row] = await h.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, inApp.id));
    expect(row?.deliveredAt).not.toBeNull();
    expect(row?.interactedAt).not.toBeNull();
  });

  it("404s an ack for somebody else's delivery", async () => {
    const intentId = await emitAndDispatch({ actorId: owner.id });
    const theirs = (await deliveriesOf(intentId)).find(
      (r) => r.userId === teen.id && r.channel === 'in_app',
    );
    if (!theirs) throw new Error('no delivery for the teen');

    const response = await request(h.app, {
      method: 'POST',
      url: `/api/notifications/deliveries/${theirs.id}/delivered`,
      token: adult.accessToken,
      payload: {},
    });
    // 404, not 403: confirming that a delivery id exists would leak which
    // notifications other family members received (D4).
    expect(response.statusCode).toBe(404);
  });

  it('shows the fanned-out notification in the recipient’s inbox and unread count', async () => {
    await emitAndDispatch({ actorId: owner.id });

    const inbox = await request(h.app, {
      method: 'GET',
      url: '/api/notifications',
      token: adult.accessToken,
    });
    expectStatus(inbox, 200);
    expect(inbox.json<{ items: unknown[] }>().items).toHaveLength(1);

    const unread = await request(h.app, {
      method: 'GET',
      url: '/api/notifications/unread-count',
      token: adult.accessToken,
    });
    expectStatus(unread, 200);
    expect(unread.json<{ unread: number }>().unread).toBe(1);

    const read = await request(h.app, {
      method: 'POST',
      url: '/api/notifications/read',
      token: adult.accessToken,
      payload: { all: true },
    });
    expect(read.statusCode).toBeLessThan(400);

    const after = await request(h.app, {
      method: 'GET',
      url: '/api/notifications/unread-count',
      token: adult.accessToken,
    });
    expectStatus(after, 200);
    expect(after.json<{ unread: number }>().unread).toBe(0);
  });

  /* ====================================================================== */
  /* the change feed (D12)                                                  */
  /* ====================================================================== */

  /**
   * What a client would see in `GET /api/changes`.
   *
   * Read through the endpoint rather than out of Redis, so the assertion covers
   * the whole chain a user depends on — the worker's bump, the shared hash, and
   * the feed that serves it. `notifications` is ungated (your own inbox is
   * always yours to read), so any member sees its counter.
   *
   * `GET` never bumps anything, so reading the feed cannot disturb what it is
   * measuring.
   */
  async function notificationsRev(user: TestUser): Promise<number> {
    const response = await request(h.app, {
      method: 'GET',
      url: '/api/changes',
      token: user.accessToken,
    });
    expectStatus(response, 200);
    return response.json<{ rev: { notifications?: number } }>().rev.notifications ?? 0;
  }

  it('moves the notifications revision when a fan-out writes an inbox row', async () => {
    /*
     * The bell was the last surface in the app still waiting for a window focus
     * to notice anything. Everything else refreshes within seconds — and the
     * bell is what tells an owner that somebody is waiting to be let into the
     * family, a flow where a delay has already caused real confusion.
     */
    const before = await notificationsRev(adult);

    const intentId = await emitAndDispatch({ actorId: owner.id, audience: { everyone: true } });

    const rows = await deliveriesOf(intentId);
    expect(rows.some((r) => r.channel === 'in_app')).toBe(true);
    expect(await notificationsRev(adult)).toBe(before + 1);
  });

  it('moves it exactly once, however many times the intent is dispatched', async () => {
    // A retried BullMQ job, a duplicated `dispatch()` and the recovery sweep all
    // re-enter `dispatchIntent`. Fan-out is idempotent, and the bump has to be
    // too: a second increment costs every client in the family a second refetch
    // of an inbox that did not change.
    const service = await import('./notifications.service.js');

    const intentId = await emitAndDispatch({ actorId: owner.id, audience: { everyone: true } });
    const afterFirst = await notificationsRev(adult);

    await service.dispatchIntent(h.db, intentId);
    await service.dispatchIntent(h.db, intentId);

    expect(await notificationsRev(adult)).toBe(afterFirst);
  });

  it('leaves it alone when the fan-out reaches nobody', async () => {
    /*
     * The negative case, in the only shape that is reachable today.
     *
     * §3.7 writes an in-app row for *every* recipient, unconditionally — so
     * there is no such thing as a push-or-telegram-only fan-out to contrast
     * with. What there is: a fan-out that produces no delivery rows at all.
     * Here the only addressee is the actor, and §3.4 self-suppression removes
     * them, so `dispatchIntent` returns before it inserts anything.
     *
     * The guard is written as "did this produce an in-app row" rather than
     * "did this produce any row", so it stays correct if the in-app row ever
     * becomes suppressible.
     */
    const before = await notificationsRev(owner);

    const intentId = await emitAndDispatch({ actorId: owner.id, audience: { users: [owner.id] } });

    expect(await deliveriesOf(intentId)).toHaveLength(0);
    expect(await notificationsRev(owner)).toBe(before);
  });
});
