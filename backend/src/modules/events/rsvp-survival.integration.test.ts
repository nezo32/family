import { and, eq } from 'drizzle-orm';
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
import { eventAttendees } from './events.schema.js';

/**
 * «Кто придёт» must survive an edit of the event it hangs on.
 *
 * The bug this file pins down: `PATCH /events/series/:id` with `scope: 'all'`
 * decided it was a *reschedule* whenever `recurrence`, `durationMinutes` or
 * `isAllDay` were merely **present** in the body — and the form posts all three
 * on every save, renames included. A reschedule deleted every future
 * `scheduled` occurrence, `event_attendees.occurrence_id` is
 * `ON DELETE CASCADE`, and the re-invite that followed re-created the guest
 * list at the column default. So «приду» on every future date silently became
 * «не ответил» because somebody fixed a typo in the title.
 *
 * The three cases below are the whole rule:
 *
 * 1. a **rename** touches nothing — same occurrence rows, same answers;
 * 2. a **real time change** on a date that still exists keeps the answers,
 *    because the same people are still coming to the same dinner, an hour later;
 * 3. a date the new rule **no longer produces** takes its answers with it —
 *    there is nothing left to come to.
 */
describe.skipIf(!hasTestDb)('RSVP survival across a series edit (integration)', () => {
  let h: Harness;
  let owner: TestUser;
  let adult: TestUser;

  /** A Monday well inside the materialization horizon. */
  const DTSTART = '2026-09-07T18:00:00';
  const TZ = 'Europe/Moscow';

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
  });

  interface Occurrence {
    id: string;
    localDate: string;
    startsLocal: string;
    attendees: { userId: string; rsvp: string }[];
  }

  /** Six Monday dinners, both of us invited. */
  async function createSeries(): Promise<string> {
    const response = await request(h.app, {
      method: 'POST',
      url: '/api/events/series',
      token: owner.accessToken,
      payload: {
        title: 'Семейный ужин',
        durationMinutes: 60,
        attendeeIds: [owner.id, adult.id],
        recurrence: {
          mode: 'preset',
          preset: { kind: 'weekly', interval: 1, weekdays: ['MO'] },
          ends: { type: 'after', count: 6 },
          dtstartLocal: DTSTART,
          timezone: TZ,
          rdatesLocal: [],
          exdatesLocal: [],
        },
      },
    });
    expectStatus(response, 201);
    return response.json<{ id: string }>().id;
  }

  async function listOccurrences(seriesId: string): Promise<Occurrence[]> {
    const response = await request(h.app, {
      method: 'GET',
      url: `/api/events/occurrences?seriesId=${seriesId}&limit=50`,
      token: owner.accessToken,
    });
    expectStatus(response, 200);
    return response.json<{ items: Occurrence[] }>().items;
  }

  async function occurrenceOn(seriesId: string, localDate: string): Promise<Occurrence> {
    const found = (await listOccurrences(seriesId)).find((o) => o.localDate === localDate);
    expect(found, `нет экземпляра на ${localDate}`).toBeDefined();
    return found as Occurrence;
  }

  async function answerYes(occurrenceId: string, user: TestUser): Promise<void> {
    const response = await request(h.app, {
      method: 'PUT',
      url: `/api/events/occurrences/${occurrenceId}/rsvp`,
      token: user.accessToken,
      payload: { rsvp: 'yes' },
    });
    expectStatus(response, 200);
  }

  /**
   * Exactly what `EventFormDialog` posts: every field, every time. `overrides`
   * is the one thing the user actually touched.
   */
  function fullBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      scope: 'all',
      title: 'Семейный ужин',
      description: null,
      location: null,
      visibility: 'household',
      durationMinutes: 60,
      isAllDay: false,
      reminderOffsets: [],
      color: null,
      category: null,
      attendeeIds: [owner.id, adult.id],
      recurrence: {
        mode: 'preset',
        preset: { kind: 'weekly', interval: 1, weekdays: ['MO'] },
        ends: { type: 'after', count: 6 },
        dtstartLocal: DTSTART,
        timezone: TZ,
        rdatesLocal: [],
        exdatesLocal: [],
      },
      ...overrides,
    };
  }

  async function patchSeries(seriesId: string, body: Record<string, unknown>): Promise<void> {
    const response = await request(h.app, {
      method: 'PATCH',
      url: `/api/events/series/${seriesId}`,
      token: owner.accessToken,
      payload: body,
    });
    expectStatus(response, 200);
  }

  it('keeps every answer when only the title changes', async () => {
    const seriesId = await createSeries();
    const before = await occurrenceOn(seriesId, '2026-09-21');
    await answerYes(before.id, adult);

    await patchSeries(seriesId, fullBody({ title: 'Ужин у бабушки' }));

    const after = await occurrenceOn(seriesId, '2026-09-21');
    expect(after.attendees.find((a) => a.userId === adult.id)?.rsvp).toBe('yes');
    // The row itself must survive too: a new id means the answer was cascaded
    // away and merely happened to be re-created, and it is also what turns
    // every link the family already has into a 404.
    expect(after.id).toBe(before.id);
  });

  it('keeps every answer when the location changes', async () => {
    const seriesId = await createSeries();
    const before = await occurrenceOn(seriesId, '2026-09-28');
    await answerYes(before.id, adult);

    await patchSeries(seriesId, fullBody({ location: 'У бабушки' }));

    const after = await occurrenceOn(seriesId, '2026-09-28');
    expect(after.attendees.find((a) => a.userId === adult.id)?.rsvp).toBe('yes');
    expect(after.id).toBe(before.id);
  });

  it('keeps the answers on a date that survives a real time change', async () => {
    const seriesId = await createSeries();
    const before = await occurrenceOn(seriesId, '2026-09-21');
    await answerYes(before.id, adult);

    // 18:00 → 19:00. Every date still exists; the same people are still coming.
    await patchSeries(
      seriesId,
      fullBody({
        recurrence: {
          mode: 'preset',
          preset: { kind: 'weekly', interval: 1, weekdays: ['MO'] },
          ends: { type: 'after', count: 6 },
          dtstartLocal: '2026-09-07T19:00:00',
          timezone: TZ,
          rdatesLocal: [],
          exdatesLocal: [],
        },
      }),
    );

    const after = await occurrenceOn(seriesId, '2026-09-21');
    expect(after.startsLocal).toBe('2026-09-21T19:00:00');
    expect(after.attendees.find((a) => a.userId === adult.id)?.rsvp).toBe('yes');
    expect(after.id).toBe(before.id);
  });

  it('keeps the answers when only the duration changes', async () => {
    const seriesId = await createSeries();
    const before = await occurrenceOn(seriesId, '2026-09-14');
    await answerYes(before.id, adult);

    await patchSeries(seriesId, fullBody({ durationMinutes: 120 }));

    const after = await occurrenceOn(seriesId, '2026-09-14');
    expect(after.attendees.find((a) => a.userId === adult.id)?.rsvp).toBe('yes');
    expect(after.id).toBe(before.id);
  });

  it('drops the answers on a date the new rule no longer produces', async () => {
    const seriesId = await createSeries();
    const doomed = await occurrenceOn(seriesId, '2026-10-12');
    const kept = await occurrenceOn(seriesId, '2026-09-14');
    await answerYes(doomed.id, adult);
    await answerYes(kept.id, adult);

    // Six dinners become two: 21 September onwards never happens.
    await patchSeries(
      seriesId,
      fullBody({
        recurrence: {
          mode: 'preset',
          preset: { kind: 'weekly', interval: 1, weekdays: ['MO'] },
          ends: { type: 'after', count: 2 },
          dtstartLocal: DTSTART,
          timezone: TZ,
          rdatesLocal: [],
          exdatesLocal: [],
        },
      }),
    );

    const dates = (await listOccurrences(seriesId)).map((o) => o.localDate);
    expect(dates).not.toContain('2026-10-12');

    // The cascade is the point: no orphaned answer is left pointing at a date
    // that no longer exists.
    const orphans = await h.db
      .select({ id: eventAttendees.id })
      .from(eventAttendees)
      .where(and(eq(eventAttendees.occurrenceId, doomed.id), eq(eventAttendees.userId, adult.id)));
    expect(orphans).toHaveLength(0);

    // …and the date that did survive keeps its answer.
    const after = await occurrenceOn(seriesId, '2026-09-14');
    expect(after.attendees.find((a) => a.userId === adult.id)?.rsvp).toBe('yes');
    expect(after.id).toBe(kept.id);
  });
});
