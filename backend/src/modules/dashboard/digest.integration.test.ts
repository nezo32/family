import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import type { Db } from '../../core/db.js';
import { getTestDb, hasTestDb } from '../../test/db.js';
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
import { runWeeklyDigestSweep } from './dashboard.jobs.js';
import { createDigestPort, createNotificationIntentPort } from './digest.service.js';

/**
 * The weekly digest sweep, against a real driver.
 *
 * Two of the port's loaders interpolated a `Date` straight into a **raw** `sql`
 * template — `loadWallCounts` (the `UNION ALL` over posts and kudos) and
 * `loadGoalContributions`. `drizzle-orm/postgres-js` nulls postgres.js's
 * timestamp serialisers, so those bind with
 * «The "string" argument must be of type string … Received an instance of
 * Date» (the trap `core/sql.ts` exists to document).
 *
 * What made it invisible is the sweep's own resilience: `runWeeklyDigestSweep`
 * catches per subscriber, so that one bad row cannot cost the rest of the
 * family their digest. Every subscriber threw, every throw was caught and
 * logged, and the function returned `[]` — a value indistinguishable from
 * "nobody was due this hour". **No weekly digest had ever been sent**, and the
 * job reported success every time.
 *
 * Hence the shape of these tests. Asserting "it did not throw" proves nothing
 * here, because it never threw. The assertion has to be that the sweep
 * **returns a result for every subscriber it considered**, and that the result
 * says `sent`.
 */
describe.skipIf(!hasTestDb)('weekly digest sweep (integration)', () => {
  let h: Harness;
  let db: Db;
  let owner: TestUser;
  let adult: TestUser;

  const TIMEZONE = 'Europe/Moscow';

  beforeAll(async () => {
    h = await startHarness();
    db = await getTestDb();
  });

  afterAll(async () => {
    await closeHarness();
  });

  beforeEach(async () => {
    await resetDatabase();
    owner = await createOwner(h.app);
    adult = await createMember(h.app, owner, 'adult', { displayName: 'Взрослый' });
  });

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

  /** `digest_subscriptions.weekday` (0=Sunday) for `at` in the family timezone. */
  function weekdayIn(at: Date): number {
    const label = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      weekday: 'short',
    }).format(at);
    const index = WEEKDAYS.indexOf(label as (typeof WEEKDAYS)[number]);
    if (index < 0) throw new Error(`unexpected weekday label ${label}`);
    return index;
  }

  /**
   * Subscribe `user` to a slot earlier today, so `digestDueDecision` says
   * "due" and the sweep proceeds to actually gather and compose.
   */
  async function subscribe(user: TestUser, now: Date, timeOfDay = '00:01'): Promise<void> {
    const response = await request(h.app, {
      method: 'PUT',
      url: '/api/notifications/digest',
      token: user.accessToken,
      payload: {
        enabled: true,
        weekday: weekdayIn(now),
        timeOfDay,
        sections: ['tasks', 'events', 'goals', 'shopping', 'wall', 'birthdays'],
      },
    });
    expectStatus(response, 200);
  }

  /** Content in every section the digest reads, so no loader is skipped. */
  async function seedFamilyData(): Promise<void> {
    const post = await request(h.app, {
      method: 'POST',
      url: '/api/wall/posts',
      token: owner.accessToken,
      payload: { title: 'Объявление', body: 'Собрание в субботу' },
    });
    expectStatus(post, 201);

    const kudos = await request(h.app, {
      method: 'POST',
      url: '/api/chores/kudos',
      token: owner.accessToken,
      payload: { toUserId: adult.id, emoji: '👏', message: 'Спасибо' },
    });
    expectStatus(kudos, 201);

    const goal = await request(h.app, {
      method: 'POST',
      url: '/api/goals',
      token: owner.accessToken,
      payload: { title: 'Отпуск', targetAmount: 1_000_00 },
    });
    expectStatus(goal, 201);

    const contribution = await request(h.app, {
      method: 'POST',
      url: `/api/goals/${goal.json<{ id: string }>().id}/contributions`,
      token: owner.accessToken,
      payload: { amount: 250_00, note: 'Взнос' },
    });
    expectStatus(contribution, 201);
  }

  function sweep(now: Date) {
    return runWeeklyDigestSweep(
      createDigestPort(db),
      createNotificationIntentPort(db),
      TIMEZONE,
      now,
    );
  }

  it('sends a digest to every due subscriber', async () => {
    const now = new Date();
    await seedFamilyData();
    await subscribe(owner, now);
    await subscribe(adult, now);

    const results = await sweep(now);

    // A result **per subscriber**. Before the fix this was `[]`: every send
    // threw inside the per-subscriber catch and nothing was recorded at all.
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.sent)).toBe(true);
    expect(results.map((r) => r.reason)).toEqual(['due', 'due']);
    expect(new Set(results.map((r) => r.userId))).toEqual(new Set([owner.id, adult.id]));
  });

  it('sends at most one digest per subscriber per ISO week', async () => {
    const now = new Date();
    await seedFamilyData();
    await subscribe(owner, now);

    const first = await sweep(now);
    expect(first.map((r) => r.sent)).toEqual([true]);

    // The whole idempotency claim in the file header of `dashboard.jobs.ts`:
    // a retried job, a redeploy mid-sweep or an extra tick must not re-send.
    const second = await sweep(now);
    expect(second.map((r) => r.sent)).toEqual([false]);
    expect(second.map((r) => r.reason)).toEqual(['already_sent']);
  });

  it('writes one digest intent per subscriber', async () => {
    const now = new Date();
    await seedFamilyData();
    await subscribe(owner, now);
    await sweep(now);
    await sweep(now);

    const rows = await db.execute<{ n: string }>(sql`
      select count(*)::text as n
        from notification_intents
       where dedupe_key like 'weekly_digest:%'
    `);
    expect(Number([...rows][0]?.n ?? '0')).toBe(1);
  });

  /**
   * `POST /dashboard/digest/preview` — every field of its body is optional, so
   * "show me my digest as configured" is a POST with **no body**, which Fastify
   * delivers as `null`. The bare object schema rejected that with a 400; the
   * `.nullish()` wrapper is the rule `tasks.routes.ts` already documents.
   *
   * Latent rather than observed in production: today's client always sends
   * `{}`. It is here so the next caller — or the next hand-rolled `curl` — does
   * not have to rediscover it.
   */
  it('previews the digest for a POST with no body at all', async () => {
    await seedFamilyData();

    const response = await request(h.app, {
      method: 'POST',
      url: '/api/dashboard/digest/preview',
      token: owner.accessToken,
    });
    expectStatus(response, 200);
    expect(response.json<{ weekKey: string; text: string }>().weekKey).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('previews the digest with an explicit section override', async () => {
    await seedFamilyData();

    const response = await request(h.app, {
      method: 'POST',
      url: '/api/dashboard/digest/preview',
      token: owner.accessToken,
      payload: { sections: ['goals', 'wall'] },
    });
    expectStatus(response, 200);
    const blocks = response.json<{ blocks: { section: string }[] }>().blocks;
    expect(blocks.map((b) => b.section)).toEqual(['goals', 'wall']);
  });

  /**
   * A stored section that a later release retired must stay **readable**.
   *
   * `digest_subscriptions.sections` is a `text[]`, so dropping a value from
   * `DIGEST_SECTIONS` leaves live rows saying `points`, and then `load`, behind
   * on purpose: filtering them out on read is exactly what makes retiring a
   * section need no migration. `GET /api/notifications/digest` broke that
   * promise by casting the row into its zod-validated response unchecked, so
   * every such subscriber got a **500** on the notification settings screen
   * instead of a digest without that block.
   *
   * `load` is the value that is actually sitting in dev and test databases
   * today, but the invariant is about any retired one — the next removal lands
   * in the identical trap.
   */
  it('reads a subscription whose stored sections still name a retired one', async () => {
    await subscribe(owner, new Date());

    // Written in SQL because the API cannot produce it any more, which is the
    // point: only history can put `load` in that column now.
    await db.execute(sql`
      update digest_subscriptions
         set sections = array['tasks', 'load', 'events']::text[]
       where user_id = ${owner.id}::uuid
    `);

    const response = await request(h.app, {
      method: 'GET',
      url: '/api/notifications/digest',
      token: owner.accessToken,
    });
    expectStatus(response, 200);
    expect(response.json<{ sections: string[] }>().sections).toEqual(['tasks', 'events']);

    // And it is still sendable — the sweep reads the same column.
    const results = await sweep(new Date());
    expect(results.map((r) => r.userId)).toContain(owner.id);
  });

  /**
   * The write path deliberately does **not** extend the same tolerance. Storage
   * has history in it; a request body does not. A client sending a section this
   * release does not have is a broken client, and a 400 says so — where
   * silently dropping it would answer a `PUT` with a body different from the
   * one that was sent, which is the harder bug to notice.
   */
  it('rejects a retired section in the request body instead of dropping it', async () => {
    const response = await request(h.app, {
      method: 'PUT',
      url: '/api/notifications/digest',
      token: owner.accessToken,
      payload: { enabled: true, weekday: 1, timeOfDay: '19:00', sections: ['tasks', 'load'] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('still records a result for a subscriber whose slot has not arrived', async () => {
    // A fixed instant, so the boundary is not "whatever time CI happens to run
    // at": 09:00 Monday in Moscow, against a 20:00 Monday slot.
    const mondayMorning = new Date('2026-08-17T06:00:00.000Z');
    await seedFamilyData();
    await subscribe(owner, mondayMorning, '20:00');

    const results = await sweep(mondayMorning);

    expect(results).toHaveLength(1);
    expect(results[0]?.sent).toBe(false);
    expect(results[0]?.reason).toBe('not_yet');
  });
});
