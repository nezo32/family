import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { RevisionMap } from '@family/shared';

import { REVISION_HASH_KEY } from '../../core/revisions.js';
import { hasTestDb } from '../../test/db.js';
import {
  closeHarness,
  createMember,
  createOwner,
  expectStatus,
  request,
  startHarness,
  type Harness,
  type TestUser,
} from '../../test/harness.js';

/**
 * The change feed end to end: a real write through the real router bumps a real
 * counter, and the endpoint hands back what the caller is allowed to see.
 *
 * The unit test proves `ROUTE_DOMAINS` classifies a *pattern*. Only this file
 * proves the `onResponse` hook is actually mounted, sees the pattern with its
 * `/api` prefix, and fires after the response — a mistake in any of those three
 * is invisible to a table test and would ship a feed that never moves.
 */
describe.skipIf(!hasTestDb)('GET /api/changes (integration)', () => {
  let h: Harness;
  let owner: TestUser;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await closeHarness();
  });

  beforeEach(async () => {
    // `createOwner` truncates; the counters live in Redis and survive that, so
    // they are cleared explicitly. The endpoint must also be correct when the
    // hash does not exist at all, which is the state each test starts in.
    const { getRedis } = await import('../../core/redis.js');
    await getRedis().del(REVISION_HASH_KEY);
    owner = await createOwner(h.app);
  });

  async function revisions(user: TestUser): Promise<RevisionMap> {
    const response = await request(h.app, {
      method: 'GET',
      url: '/api/changes',
      token: user.accessToken,
    });
    expectStatus(response, 200);
    return response.json<{ rev: RevisionMap }>().rev;
  }

  async function createList(user: TestUser, name: string): Promise<string> {
    const response = await request(h.app, {
      method: 'POST',
      url: '/api/shopping/lists',
      token: user.accessToken,
      payload: { name },
    });
    expectStatus(response, 201);
    return response.json<{ id: string }>().id;
  }

  it('starts empty, which the client reads as a baseline rather than as zeroes', async () => {
    expect(await revisions(owner)).toEqual({});
  });

  it('moves exactly the domain that was written', async () => {
    const listId = await createList(owner, 'Продукты');
    const before = await revisions(owner);
    expect(before.shopping).toBeGreaterThan(0);

    const item = await request(h.app, {
      method: 'POST',
      url: `/api/shopping/lists/${listId}/items`,
      token: owner.accessToken,
      payload: { name: 'Молоко' },
    });
    expect([200, 201]).toContain(item.statusCode);

    const after = await revisions(owner);
    expect(after.shopping).toBe((before.shopping ?? 0) + 1);
    // Nothing else moved — the map is per domain, not a single global counter.
    expect(after.tasks).toBeUndefined();
    expect(after.wall).toBeUndefined();
  });

  it('moves tasks — and not shopping — when an occurrence is completed', async () => {
    await createList(owner, 'Продукты');

    const series = await request(h.app, {
      method: 'POST',
      url: '/api/tasks/series',
      token: owner.accessToken,
      payload: {
        title: 'Вынести мусор',
        recurrence: {
          mode: 'once',
          dtstartLocal: '2025-01-06T09:00:00',
          timezone: 'Europe/Moscow',
        },
      },
    });
    expectStatus(series, 201);

    const list = await request(h.app, {
      method: 'GET',
      url: '/api/tasks/occurrences',
      token: owner.accessToken,
    });
    expectStatus(list, 200);
    const occurrenceId = list.json<{ items: { id: string }[] }>().items[0]?.id;
    expect(occurrenceId, 'the series should have materialized an occurrence').toBeTruthy();

    const before = await revisions(owner);

    const complete = await request(h.app, {
      method: 'POST',
      url: `/api/tasks/occurrences/${occurrenceId}/complete`,
      token: owner.accessToken,
      payload: {},
    });
    expectStatus(complete, 200);

    const after = await revisions(owner);
    expect(after.tasks).toBe((before.tasks ?? 0) + 1);
    expect(after.shopping).toBe(before.shopping);
  });

  it('moves nothing when the write is rejected', async () => {
    const before = await revisions(owner);

    const bad = await request(h.app, {
      method: 'POST',
      url: '/api/shopping/lists',
      token: owner.accessToken,
      payload: { name: '' },
    });
    expect(bad.statusCode).toBe(400);

    expect(await revisions(owner)).toEqual(before);
  });

  it('moves nothing on a read', async () => {
    await createList(owner, 'Продукты');
    const before = await revisions(owner);

    const read = await request(h.app, {
      method: 'GET',
      url: '/api/shopping/lists',
      token: owner.accessToken,
    });
    expectStatus(read, 200);

    // Two more reads of the feed itself, which is also a GET.
    expect(await revisions(owner)).toEqual(before);
  });

  it('omits a domain the caller may not read, and keeps the ungated ones', async () => {
    const child = await createMember(h.app, owner, 'child');

    // Move every domain the owner can move that the child cannot read.
    await createList(owner, 'Продукты');
    const goal = await request(h.app, {
      method: 'POST',
      url: '/api/goals',
      token: owner.accessToken,
      payload: { title: 'Велосипед', targetAmount: 1500000, currency: 'RUB' },
    });
    expectStatus(goal, 201);

    const seen = await revisions(child);
    // A child holds no `goal:*` permission at all (D4), so the number must not
    // even appear — a zero would be a difference and therefore a refetch.
    expect(seen).not.toHaveProperty('goals');
    // …but the wall and their own inbox are never gated.
    expect(await revisions(owner)).toHaveProperty('goals');
    expect(seen.shopping).toBeGreaterThan(0);
  });

  it('answers 401 to an anonymous caller, never 403', async () => {
    const response = await request(h.app, { method: 'GET', url: '/api/changes' });
    expect(response.statusCode).toBe(401);
  });
});
