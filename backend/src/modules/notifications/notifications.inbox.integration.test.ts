import { describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';

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
