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

/**
 * Changing an event's guest list, against a real driver.
 *
 * `removeAttendeesExcept` used to express "keep these people" as a raw
 * template — `sql`${col} <> all(${keepUserIds}::uuid[])`` — and Drizzle spreads
 * a JS array into **one placeholder per element**. So the query Postgres
 * actually received was `all(($1)::uuid[])` for one id (rejected: «malformed
 * array literal», the driver sent a bare string where an array literal was
 * expected) and `all(($1, $2)::uuid[])` for two (rejected: «cannot cast type
 * record to uuid[]», that is a row constructor). Every non-empty guest list was
 * a 500.
 *
 * Nothing caught it because nothing executed it: a mocked repository binds no
 * parameters, and the three call sites are all "edit an existing event's
 * attendees", which no test did. These cases therefore go through
 * `app.inject()` to a real Postgres — the assertion that matters is not the
 * response shape, it is that the statement binds at all.
 *
 * The list sizes are deliberate: **one** and **two** are the two distinct
 * failure modes above, and **zero** is the branch that always worked and must
 * keep working.
 */
describe.skipIf(!hasTestDb)('event attendees (integration)', () => {
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

  /** A daily series with three occurrences, everybody invited. */
  async function createSeries(): Promise<string> {
    const response = await request(h.app, {
      method: 'POST',
      url: '/api/events/series',
      token: owner.accessToken,
      payload: {
        title: 'Семейный ужин',
        durationMinutes: 60,
        attendeeIds: [owner.id, adult.id, teen.id],
        recurrence: {
          mode: 'preset',
          preset: { kind: 'daily', interval: 1 },
          ends: { type: 'after', count: 3 },
          dtstartLocal: '2026-09-07T19:00:00',
          timezone: 'Europe/Moscow',
          rdatesLocal: [],
          exdatesLocal: [],
        },
      },
    });
    expectStatus(response, 201);
    return response.json<{ id: string }>().id;
  }

  async function setAttendees(
    seriesId: string,
    attendeeIds: string[],
    scope: 'all' | 'this' | 'this_and_future' = 'all',
  ): Promise<string[]> {
    const response = await request(h.app, {
      method: 'PUT',
      url: `/api/events/series/${seriesId}/attendees`,
      token: owner.accessToken,
      payload: { scope, attendeeIds },
    });
    expectStatus(response, 200);
    return response.json<{ attendeeIds: string[] }>().attendeeIds;
  }

  it('narrows the guest list to a single member', async () => {
    const seriesId = await createSeries();

    // One kept id — the «malformed array literal» case.
    expect(await setAttendees(seriesId, [owner.id])).toEqual([owner.id]);
  });

  it('narrows the guest list to two members', async () => {
    const seriesId = await createSeries();

    // Two kept ids — the «cannot cast type record to uuid[]» case.
    const kept = await setAttendees(seriesId, [owner.id, adult.id]);
    expect([...kept].sort()).toEqual([owner.id, adult.id].sort());
  });

  it('clears the guest list entirely', async () => {
    const seriesId = await createSeries();

    expect(await setAttendees(seriesId, [])).toEqual([]);
  });

  it('applies a narrowed guest list to a single occurrence', async () => {
    const seriesId = await createSeries();

    // `scope: this` deletes from exactly one occurrence, so the series still
    // reports everybody — the point is that the statement binds.
    const kept = await setAttendees(seriesId, [teen.id], 'this');
    expect(kept).toContain(teen.id);
  });

  it('narrows the guest list through a series update', async () => {
    const seriesId = await createSeries();

    // The second call site: `applyToAll` inside `PATCH /events/series/:id`.
    const response = await request(h.app, {
      method: 'PATCH',
      url: `/api/events/series/${seriesId}`,
      token: owner.accessToken,
      payload: { scope: 'all', attendeeIds: [adult.id] },
    });
    expectStatus(response, 200);

    const occurrences = await request(h.app, {
      method: 'GET',
      url: `/api/events/occurrences?seriesId=${seriesId}&limit=50`,
      token: owner.accessToken,
    });
    expectStatus(occurrences, 200);
    const items = occurrences.json<{
      items: { attendees: { userId: string }[] }[];
    }>().items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.attendees.map((a) => a.userId)).toEqual([adult.id]);
    }
  });

  it('narrows the guest list of one occurrence through an override', async () => {
    const seriesId = await createSeries();

    const listed = await request(h.app, {
      method: 'GET',
      url: `/api/events/occurrences?seriesId=${seriesId}&limit=50`,
      token: owner.accessToken,
    });
    expectStatus(listed, 200);
    const first = listed.json<{ items: { id: string }[] }>().items[0];
    expect(first).toBeDefined();

    // The third call site: `applyThisOnly`.
    const response = await request(h.app, {
      method: 'PATCH',
      url: `/api/events/series/${seriesId}`,
      token: owner.accessToken,
      payload: {
        scope: 'this',
        occurrenceId: first?.id,
        attendeeIds: [owner.id, teen.id],
      },
    });
    expectStatus(response, 200);

    const after = await request(h.app, {
      method: 'GET',
      url: `/api/events/occurrences/${first?.id}`,
      token: owner.accessToken,
    });
    expectStatus(after, 200);
    const attendees = after
      .json<{ attendees: { userId: string }[] }>()
      .attendees.map((a) => a.userId);
    expect([...attendees].sort()).toEqual([owner.id, teen.id].sort());
  });
});
