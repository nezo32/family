import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { createDbClient } from '../../core/db.js';
import { hasTestDb, TEST_DATABASE_URL } from '../../test/db.js';
import { users } from '../identity/users.schema.js';
import { notificationDeliveries, notificationIntents } from './notifications.schema.js';
import * as repo from './notifications.repository.js';

/**
 * Inbox pagination against a real database.
 *
 * Deliberately its own file: `notifications.test.ts` mocks the repository
 * module-wide, so an "integration" test living there would import the mock
 * while claiming to exercise Postgres. It used to hold a placeholder that
 * asserted `TEST_DATABASE_URL` was set and nothing else — coverage that reads
 * as green while testing nothing.
 *
 * What it caught: the keyset predicate interpolated `cursor.createdAt` — a real
 * `Date` — into a raw `sql` template. `drizzle-orm/postgres-js` nulls that
 * driver's timestamp serialisers, so the query threw at *bind* time and the
 * second page of the notification inbox was a 500.
 *
 * `markUnread` (the undo behind §G4's «Отменить») is tested here for the same
 * reason: all of it is SQL. The scoping predicate, the `case` that walks
 * `status` back and the columns that are deliberately *absent* from the `set`
 * are the whole of the behaviour, and a mocked repository asserts nothing about
 * any of them.
 */

describe.skipIf(!hasTestDb)('notification inbox (integration)', () => {
  it('pages through the inbox with a cursor', async () => {
    const { sql: client, db } = createDbClient(TEST_DATABASE_URL);
    const intentIds: string[] = [];
    let userId = '';

    try {
      const [user] = await db
        .insert(users)
        .values({ displayName: 'Инбокс (тест)', role: 'adult', status: 'active' })
        .returning();
      if (!user) throw new Error('fixture user was not created');
      userId = user.id;

      // Three deliveries a millisecond apart: enough to page, and close enough
      // together that the `(createdAt, id)` tiebreak actually matters.
      const base = Date.parse('2026-08-19T11:00:00Z');
      for (let i = 0; i < 3; i++) {
        const [intent] = await db
          .insert(notificationIntents)
          .values({
            type: 'task_overdue',
            entityType: 'task_occurrence',
            payload: {},
            audience: { users: [userId] },
            priority: 'high',
            createdAt: new Date(base + i),
          })
          .returning();
        if (!intent) throw new Error('fixture intent was not created');
        intentIds.push(intent.id);

        await db.insert(notificationDeliveries).values({
          intentId: intent.id,
          userId,
          channel: 'in_app',
          status: 'delivered',
          createdAt: new Date(base + i),
        });
      }

      const first = await repo.listInbox(db, userId, { limit: 2 });
      expect(first).toHaveLength(2);

      const last = first.at(-1);
      expect(last).toBeDefined();

      const second = await repo.listInbox(db, userId, {
        limit: 2,
        cursor: { createdAt: last!.createdAt, id: last!.id },
      });

      expect(second).toHaveLength(1);

      // A cursor that repeats rows is the failure this shape exists to prevent.
      const seen = new Set(first.map((r) => r.id));
      expect(second.some((r) => seen.has(r.id))).toBe(false);
    } finally {
      if (intentIds.length > 0) {
        await db.delete(notificationIntents).where(inArray(notificationIntents.id, intentIds));
      }
      if (userId) await db.delete(users).where(inArray(users.id, [userId]));
      await client.end({ timeout: 5 });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The undo behind «Прочитано» (§G4)                                           */
/* -------------------------------------------------------------------------- */

type TestDb = ReturnType<typeof createDbClient>['db'];

/**
 * Two members, one in-app delivery each off the same intent, with the D11
 * receipt columns already filled in so the assertions can prove they survive.
 */
async function undoFixture(db: TestDb) {
  const [owner] = await db
    .insert(users)
    .values({ displayName: 'Отмена (тест)', role: 'adult', status: 'active' })
    .returning();
  const [stranger] = await db
    .insert(users)
    .values({ displayName: 'Чужой (тест)', role: 'adult', status: 'active' })
    .returning();
  if (!owner || !stranger) throw new Error('fixture users were not created');

  const [intent] = await db
    .insert(notificationIntents)
    .values({
      type: 'task_overdue',
      entityType: 'task_occurrence',
      payload: {},
      audience: { users: [owner.id, stranger.id] },
      priority: 'high',
    })
    .returning();
  if (!intent) throw new Error('fixture intent was not created');

  const sentAt = new Date('2026-08-19T11:00:00Z');
  const deliveredAt = new Date('2026-08-19T11:00:05Z');
  const rows = await db
    .insert(notificationDeliveries)
    .values(
      [owner.id, stranger.id].map((userId) => ({
        intentId: intent.id,
        userId,
        channel: 'in_app' as const,
        status: 'delivered' as const,
        sentAt,
        deliveredAt,
      })),
    )
    .returning();

  const ownerDelivery = rows.find((r) => r.userId === owner.id);
  const strangerDelivery = rows.find((r) => r.userId === stranger.id);
  if (!ownerDelivery || !strangerDelivery) throw new Error('fixture deliveries were not created');

  return { owner, stranger, intent, ownerDelivery, strangerDelivery, sentAt, deliveredAt };
}

async function dropFixture(db: TestDb, intentId: string, userIds: string[]): Promise<void> {
  await db.delete(notificationIntents).where(inArray(notificationIntents.id, [intentId]));
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
}

describe.skipIf(!hasTestDb)('markUnread (integration)', () => {
  it('reverses markRead exactly, and leaves the D11 receipts alone', async () => {
    const { sql: client, db } = createDbClient(TEST_DATABASE_URL);
    try {
      const f = await undoFixture(db);
      try {
        const readAt = new Date('2026-08-19T12:00:00Z');
        expect(await repo.markRead(db, f.owner.id, { ids: [f.ownerDelivery.id] }, readAt)).toBe(1);
        expect(await repo.countUnread(db, f.owner.id)).toBe(0);

        expect(await repo.markUnread(db, f.owner.id, [f.ownerDelivery.id])).toBe(1);

        const [after] = await db
          .select()
          .from(notificationDeliveries)
          .where(eq(notificationDeliveries.id, f.ownerDelivery.id));
        expect(after).toBeDefined();

        // The row is back on the bell.
        expect(after?.readAt).toBeNull();
        expect(await repo.countUnread(db, f.owner.id)).toBe(1);

        // `status` is restored from the receipts rather than guessed: this row
        // has a `deliveredAt`, so it goes back to `delivered`, not to `sent`.
        expect(after?.status).toBe('delivered');

        // And the delivery-confirmation record — the evidence for "did this
        // actually reach them" — is untouched. Corrupting it would be a worse
        // outcome than shipping no undo at all.
        expect(after?.sentAt?.getTime()).toBe(f.sentAt.getTime());
        expect(after?.deliveredAt?.getTime()).toBe(f.deliveredAt.getTime());
        expect(after?.interactedAt).toBeNull();
        expect(after?.acknowledgedAt).toBeNull();

        // A replayed undo is a no-op, not an error and not a second write.
        expect(await repo.markUnread(db, f.owner.id, [f.ownerDelivery.id])).toBe(0);
      } finally {
        await dropFixture(db, f.intent.id, [f.owner.id, f.stranger.id]);
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it("cannot un-read another member's delivery", async () => {
    const { sql: client, db } = createDbClient(TEST_DATABASE_URL);
    try {
      const f = await undoFixture(db);
      try {
        const readAt = new Date('2026-08-19T12:00:00Z');
        await repo.markRead(db, f.stranger.id, { ids: [f.strangerDelivery.id] }, readAt);

        /*
         * The precedent is the IDOR found on the receipt endpoints. A delivery
         * id is "guessable" in the only sense that matters — it is handed to
         * whoever holds the row — and a write scoped by id alone would let one
         * family member push a notification back onto somebody else's bell.
         *
         * The answer is zero rows and no error. Silence rather than a 403: a
         * 403 confirms the row exists, which is what D4 forbids.
         */
        expect(await repo.markUnread(db, f.owner.id, [f.strangerDelivery.id])).toBe(0);

        const [victim] = await db
          .select()
          .from(notificationDeliveries)
          .where(eq(notificationDeliveries.id, f.strangerDelivery.id));
        expect(victim?.readAt?.getTime()).toBe(readAt.getTime());
        expect(await repo.countUnread(db, f.stranger.id)).toBe(0);

        // Mixing a stolen id in with a legitimate one does not smuggle it past
        // the predicate either: one row moves, and it is the caller's own.
        await repo.markRead(db, f.owner.id, { ids: [f.ownerDelivery.id] }, readAt);
        expect(
          await repo.markUnread(db, f.owner.id, [f.ownerDelivery.id, f.strangerDelivery.id]),
        ).toBe(1);
        expect(await repo.countUnread(db, f.stranger.id)).toBe(0);
        expect(await repo.countUnread(db, f.owner.id)).toBe(1);
      } finally {
        await dropFixture(db, f.intent.id, [f.owner.id, f.stranger.id]);
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('never drags a row back down the D11 ladder', async () => {
    const { sql: client, db } = createDbClient(TEST_DATABASE_URL);
    try {
      const f = await undoFixture(db);
      try {
        const acknowledgedAt = new Date('2026-08-19T12:30:00Z');
        const interactedAt = new Date('2026-08-19T12:20:00Z');
        await db
          .update(notificationDeliveries)
          .set({
            status: 'acknowledged',
            readAt: new Date('2026-08-19T12:00:00Z'),
            interactedAt,
            acknowledgedAt,
          })
          .where(eq(notificationDeliveries.id, f.ownerDelivery.id));

        expect(await repo.markUnread(db, f.owner.id, [f.ownerDelivery.id])).toBe(1);

        const [after] = await db
          .select()
          .from(notificationDeliveries)
          .where(eq(notificationDeliveries.id, f.ownerDelivery.id));

        // The bell state is the member's to change...
        expect(after?.readAt).toBeNull();
        // ...but `acknowledged` is what stopped an escalation chain, and undoing
        // a swipe must never restart one.
        expect(after?.status).toBe('acknowledged');
        expect(after?.interactedAt?.getTime()).toBe(interactedAt.getTime());
        expect(after?.acknowledgedAt?.getTime()).toBe(acknowledgedAt.getTime());
      } finally {
        await dropFixture(db, f.intent.id, [f.owner.id, f.stranger.id]);
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
