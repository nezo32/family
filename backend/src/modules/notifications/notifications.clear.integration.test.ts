import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import type { ClearInboxResponse, ClearableInbox, NotificationPriority } from '@family/shared';

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
 * «Очистить» on the bell, through the real stack and a real Postgres.
 *
 * Everything this feature promises is either SQL or a route guard, so a mocked
 * repository would assert none of it:
 *
 * - the D11 receipt columns are **absent** from the `UPDATE`, which is only
 *   observable by reading the row back after clearing it;
 * - `high`/`critical` deliveries with no acknowledgement are excluded by an
 *   `exists` against the *intent* table;
 * - the scoping is "the caller's rows and no others", and the interesting proof
 *   is the other member's inbox still being there afterwards.
 *
 * The last of those is the reason this file goes through `app.inject()` rather
 * than calling the service: an IDOR on notification receipts was found and
 * fixed in this project before, and the shape of that bug — a request naming a
 * delivery it does not own — is a *routing* fact, not a service one.
 */
describe.skipIf(!hasTestDb)('clearing the notification inbox (integration)', () => {
  let h: Harness;
  let owner: TestUser;
  let adult: TestUser;

  /*
    An explicit hook timeout, because `startHarness()` builds the whole Fastify
    app the first time any suite asks for it — every plugin, the rate limiters,
    the under-pressure watchdog — and whichever file the runner happens to
    schedule first pays for it. Vitest's default hook timeout is 10s, which this
    build exceeds on a loaded machine, so the file that goes first fails for a
    reason that has nothing to do with what it tests.
  */
  beforeAll(async () => {
    h = await startHarness();
  }, 60_000);

  afterAll(async () => {
    await closeHarness();
  });

  beforeEach(async () => {
    await resetDatabase();
    owner = await createOwner(h.app);
    adult = await createMember(h.app, owner, 'adult', { displayName: 'Взрослый' });
  });

  /* ------------------------------- fixtures ------------------------------- */

  interface InboxRowInput {
    userId: string;
    priority?: NotificationPriority;
    read?: boolean;
    acknowledged?: boolean;
    /** Written on the delivery, so the "receipts survive" assertion has something to see. */
    delivered?: boolean;
  }

  /** One intent plus its in-app delivery, written straight in — no fan-out. */
  async function inboxRow(input: InboxRowInput): Promise<string> {
    const at = new Date('2026-08-19T11:00:00Z');
    const [intent] = await h.db
      .insert(notificationIntents)
      .values({
        type: 'task_overdue',
        entityType: 'task_occurrence',
        payload: { title: 'Полить цветы' },
        audience: { users: [input.userId] },
        priority: input.priority ?? 'normal',
      })
      .returning();
    if (!intent) throw new Error('fixture intent was not created');

    const [delivery] = await h.db
      .insert(notificationDeliveries)
      .values({
        intentId: intent.id,
        userId: input.userId,
        channel: 'in_app',
        status: input.acknowledged ? 'acknowledged' : input.read ? 'read' : 'sent',
        sentAt: at,
        ...(input.delivered ? { deliveredAt: at } : {}),
        ...(input.read ? { readAt: at } : {}),
        ...(input.acknowledged ? { acknowledgedAt: at } : {}),
      })
      .returning();
    if (!delivery) throw new Error('fixture delivery was not created');
    return delivery.id;
  }

  const clearable = async (user: TestUser): Promise<ClearableInbox> => {
    const response = await request(h.app, {
      method: 'GET',
      url: '/api/notifications/clearable',
      token: user.accessToken,
    });
    expectStatus(response, 200);
    return response.json<ClearableInbox>();
  };

  const clear = async (
    user: TestUser,
    payload: { scope?: 'read' | 'all'; confirm?: boolean },
  ): Promise<ClearInboxResponse> => {
    const response = await request(h.app, {
      method: 'POST',
      url: '/api/notifications/clear',
      token: user.accessToken,
      payload,
    });
    expectStatus(response, 200);
    return response.json<ClearInboxResponse>();
  };

  const inboxIds = async (user: TestUser): Promise<string[]> => {
    const response = await request(h.app, {
      method: 'GET',
      url: '/api/notifications?limit=50',
      token: user.accessToken,
    });
    expectStatus(response, 200);
    return response.json<{ items: { id: string }[] }>().items.map((item) => item.id);
  };

  const unreadCount = async (user: TestUser): Promise<number> => {
    const response = await request(h.app, {
      method: 'GET',
      url: '/api/notifications/unread-count',
      token: user.accessToken,
    });
    expectStatus(response, 200);
    return response.json<{ unread: number }>().unread;
  };

  const deliveryRow = async (id: string) => {
    const [row] = await h.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, id))
      .limit(1);
    if (!row) throw new Error(`delivery ${id} disappeared — a clear must never delete it`);
    return row;
  };

  /* ------------------------------ the default ----------------------------- */

  it('clears what has been read and leaves what has not', async () => {
    const readOne = await inboxRow({ userId: owner.id, read: true, delivered: true });
    const readTwo = await inboxRow({ userId: owner.id, read: true });
    const unread = await inboxRow({ userId: owner.id });

    expect(await clearable(owner)).toMatchObject({ read: 2, all: 3, keptNeedsAck: 0 });

    // Without `confirm` nothing moves — the count is what the dialog states.
    expect(await clear(owner, { confirm: false })).toMatchObject({ matched: 2, cleared: 0 });
    expect(await inboxIds(owner)).toHaveLength(3);

    expect(await clear(owner, { scope: 'read', confirm: true })).toMatchObject({
      matched: 2,
      cleared: 2,
      keptNeedsAck: 0,
    });

    // The unread one is still on the bell, and still unread: clearing is not a
    // bulk «прочитать все» with extra steps.
    expect(await inboxIds(owner)).toEqual([unread]);
    expect(await unreadCount(owner)).toBe(1);

    // …and the two that went are still rows, with their receipts.
    const cleared = await deliveryRow(readOne);
    expect(cleared.clearedAt).toBeInstanceOf(Date);
    expect(cleared.deliveredAt).toBeInstanceOf(Date);
    expect(cleared.sentAt).toBeInstanceOf(Date);
    expect(cleared.readAt).toBeInstanceOf(Date);
    expect(cleared.status).toBe('read');
    expect((await deliveryRow(readTwo)).clearedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — a replayed clear moves nothing', async () => {
    await inboxRow({ userId: owner.id, read: true });

    const first = await clear(owner, { scope: 'read', confirm: true });
    const second = await clear(owner, { scope: 'read', confirm: true });

    expect(first.cleared).toBe(1);
    expect(second).toMatchObject({ matched: 0, cleared: 0 });
  });

  /* -------------------------- the deliberate scope ------------------------ */

  it('clears unread rows only under the explicit `all` scope', async () => {
    const unread = await inboxRow({ userId: owner.id });

    expect(await clear(owner, { scope: 'read', confirm: true })).toMatchObject({ cleared: 0 });
    expect(await inboxIds(owner)).toEqual([unread]);

    expect(await clear(owner, { scope: 'all', confirm: true })).toMatchObject({ cleared: 1 });
    expect(await inboxIds(owner)).toEqual([]);

    // The badge has to agree with the list. A count that still sees a row the
    // inbox refuses to show is the "badge that never clears" bug from inside.
    expect(await unreadCount(owner)).toBe(0);

    // Unread, and still unread. `cleared_at` is the only column that moved.
    const row = await deliveryRow(unread);
    expect(row.readAt).toBeNull();
    expect(row.status).toBe('sent');
    expect(row.clearedAt).toBeInstanceOf(Date);
  });

  /* --------------------------- D11: the ladder ---------------------------- */

  it('never clears a high/critical delivery that still owes an acknowledgement', async () => {
    const critical = await inboxRow({ userId: owner.id, priority: 'critical', read: true });
    const high = await inboxRow({ userId: owner.id, priority: 'high' });
    const acknowledged = await inboxRow({
      userId: owner.id,
      priority: 'critical',
      read: true,
      acknowledged: true,
    });
    const ordinary = await inboxRow({ userId: owner.id, read: true });

    expect(await clearable(owner)).toMatchObject({ read: 2, all: 2, keptNeedsAck: 2 });

    // Even the deliberate, destructive scope leaves them: «Подтвердить
    // получение» lives on the inbox row, and for a `critical` intent it is the
    // only signal that stops the chain waking somebody else.
    const result = await clear(owner, { scope: 'all', confirm: true });
    expect(result).toMatchObject({ matched: 2, cleared: 2, keptNeedsAck: 2 });

    const left = await inboxIds(owner);
    expect(left).toContain(critical);
    expect(left).toContain(high);
    expect(left).not.toContain(acknowledged);
    expect(left).not.toContain(ordinary);
  });

  it('leaves the escalation record exactly where it was', async () => {
    const id = await inboxRow({ userId: owner.id, read: true, delivered: true });
    const before = await deliveryRow(id);

    await clear(owner, { scope: 'all', confirm: true });
    const after = await deliveryRow(id);

    // The sweep reads `status` and the receipts (`listUnconfirmedDeliveries`,
    // `intentHasSignal`). None of them may move, or a clear would silently stop
    // a running chain — or restart a finished one.
    expect(after.status).toBe(before.status);
    expect(after.sentAt).toEqual(before.sentAt);
    expect(after.deliveredAt).toEqual(before.deliveredAt);
    expect(after.interactedAt).toEqual(before.interactedAt);
    expect(after.acknowledgedAt).toEqual(before.acknowledgedAt);

    const [intent] = await h.db
      .select()
      .from(notificationIntents)
      .where(eq(notificationIntents.id, after.intentId))
      .limit(1);
    expect(intent?.escalationState).toBe('none');
  });

  it('keeps a cleared row out of «прочитать все»', async () => {
    const id = await inboxRow({ userId: owner.id });
    await clear(owner, { scope: 'all', confirm: true });

    const markAll = await request(h.app, {
      method: 'POST',
      url: '/api/notifications/read',
      token: owner.accessToken,
      payload: { all: true },
    });
    expectStatus(markAll, 200);

    // Reading a row nobody can see would write an in-app signal for something
    // no human looked at.
    const row = await deliveryRow(id);
    expect(row.readAt).toBeNull();
    expect(row.status).toBe('sent');
  });

  /* ------------------------------ the scoping ----------------------------- */

  it('cannot touch another member’s inbox', async () => {
    const mine = await inboxRow({ userId: owner.id, read: true });
    const theirs = await inboxRow({ userId: adult.id, read: true });
    const theirsUnread = await inboxRow({ userId: adult.id });

    // The most destructive call this endpoint can express, from the most
    // privileged role in the family.
    const result = await clear(owner, { scope: 'all', confirm: true });
    expect(result.cleared).toBe(1);

    expect(await inboxIds(owner)).toEqual([]);
    expect((await inboxIds(adult)).sort()).toEqual([theirs, theirsUnread].sort());
    expect(await unreadCount(adult)).toBe(1);

    const rows = await h.db
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.userId, adult.id),
          eq(notificationDeliveries.channel, 'in_app'),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.clearedAt === null)).toBe(true);

    // …and the owner's own row is hidden rather than gone.
    expect((await deliveryRow(mine)).clearedAt).toBeInstanceOf(Date);
  });

  it('is available to every role, because it is your own bell', async () => {
    // `notification:manage:own` is the one permission every role holds, guest
    // included: tidying your own notifications must never be a privilege.
    const child = await createMember(h.app, owner, 'child', { displayName: 'Ребёнок' });
    await inboxRow({ userId: child.id, read: true });

    expect(await clearable(child)).toMatchObject({ read: 1 });
    expect(await clear(child, { scope: 'read', confirm: true })).toMatchObject({ cleared: 1 });
  });
});
