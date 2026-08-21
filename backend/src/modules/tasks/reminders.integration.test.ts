import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../core/db.js';
import { hasTestDb } from '../../test/db.js';
import {
  closeHarness,
  createMember,
  createOwner,
  request,
  resetDatabase,
  startHarness,
  type Harness,
  type TestUser,
} from '../../test/harness.js';
import { notificationIntents } from '../notifications/notifications.schema.js';
import { runTaskReminders } from './tasks.jobs.js';
import { taskOccurrences } from './tasks.schema.js';

/**
 * Task reminders, against a real database.
 *
 * ## Why this file exists at all
 *
 * Event reminders were dead for the entire life of this project and nothing
 * noticed. `listDueReminders` interpolated a raw `Date` into a raw `sql`
 * template, `drizzle-orm/postgres-js` nulls that driver's timestamp
 * serialisers, and the query therefore threw at **bind** time — every fifteen
 * minutes, forever. A scheduled job that throws logs and retries, so from the
 * outside the system looked healthy; the only symptom was that nobody was ever
 * reminded of anything. The events fix came with a test against a real
 * database, and this is the same test for tasks, written before anyone has had
 * a chance to trust the query by reading it.
 *
 * So: no mocked repository anywhere in this file. Every assertion goes through
 * Postgres, and the two that matter most are the ones a unit test cannot make —
 * that the SQL binds at all, and that running the sweep twice tells the family
 * once.
 */
describe.skipIf(!hasTestDb)('task reminders (integration)', () => {
  let h: Harness;
  let owner: TestUser;
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
    teen = await createMember(h.app, owner, 'teen', { displayName: 'Подросток' });
  });

  /* -------------------------------- helpers ----------------------------- */

  /** 19:00 Moscow on 10 September 2026 is 16:00Z. Every clock below is derived. */
  const DTSTART_LOCAL = '2026-09-10T19:00:00';
  const STARTS_AT = '2026-09-10T16:00:00.000Z';

  async function createSeries(
    overrides: Record<string, unknown> = {},
  ): Promise<{ seriesId: string; occurrenceId: string }> {
    const response = await request(h.app, {
      method: 'POST',
      url: '/api/tasks/series',
      token: owner.accessToken,
      payload: {
        title: 'Вынести мусор',
        recurrence: {
          mode: 'once',
          dtstartLocal: DTSTART_LOCAL,
          timezone: 'Europe/Moscow',
          rdatesLocal: [],
          exdatesLocal: [],
        },
        ...overrides,
      },
    });
    expect([200, 201], JSON.stringify(response.json())).toContain(response.statusCode);
    const seriesId = response.json<{ id: string }>().id;

    const db = getDb();
    const [occurrence] = await db
      .select({ id: taskOccurrences.id })
      .from(taskOccurrences)
      .where(eq(taskOccurrences.seriesId, seriesId))
      .limit(1);
    expect(occurrence, 'the create should have materialized one occurrence').toBeDefined();

    return { seriesId, occurrenceId: occurrence?.id ?? '' };
  }

  /** The intents the sweep wrote for one occurrence, by dedupe key. */
  async function intentsFor(
    occurrenceId: string,
  ): Promise<Array<{ type: string; dedupeKey: string | null; payload: Record<string, unknown> }>> {
    const db = getDb();
    return db
      .select({
        type: notificationIntents.type,
        dedupeKey: notificationIntents.dedupeKey,
        payload: notificationIntents.payload,
      })
      .from(notificationIntents)
      .where(
        and(
          eq(notificationIntents.entityId, occurrenceId),
          inArray(notificationIntents.type, ['task_due_soon', 'task_started']),
        ),
      );
  }

  /* -------------------------------- the sweep ---------------------------- */

  it('fires each configured lead time exactly once, against a real database', async () => {
    const { occurrenceId } = await createSeries({
      reminderOffsets: [60, 1440],
      defaultAssigneeId: teen.id,
    });

    const db = getDb();

    // An hour before the start: only the 60-minute lead is due. The day-ahead
    // one fired (or was missed) yesterday.
    const emitted = await runTaskReminders(db, new Date('2026-09-10T15:00:00.000Z'));
    expect(emitted, 'one reminder, and not the at-start one — the task has not started').toBe(1);

    const first = await intentsFor(occurrenceId);
    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe('task_due_soon');
    expect(first[0]?.dedupeKey).toBe(`task_due_soon:${occurrenceId}:60m`);
    expect(first[0]?.payload.offsetMinutes).toBe(60);

    // The sweep runs every five minutes over a thirty-minute window, so it sees
    // the same pair six times. It must tell the family once.
    const again = await runTaskReminders(db, new Date('2026-09-10T15:05:00.000Z'));
    expect(again, 'the dedupe key absorbed the overlap').toBe(0);
    expect(await intentsFor(occurrenceId)).toHaveLength(1);
  });

  it('fires the day-ahead lead on its own day, keyed separately from the hour-ahead one', async () => {
    const { occurrenceId } = await createSeries({
      reminderOffsets: [60, 1440],
      defaultAssigneeId: teen.id,
    });
    const db = getDb();

    // 1440 minutes before 16:00Z on the 10th is 16:00Z on the 9th.
    await runTaskReminders(db, new Date('2026-09-09T16:00:00.000Z'));
    await runTaskReminders(db, new Date('2026-09-10T15:00:00.000Z'));

    const keys = (await intentsFor(occurrenceId)).map((i) => i.dedupeKey).sort();
    expect(keys, 'two leads, two keys — a key without the offset would collapse them').toEqual(
      [`task_due_soon:${occurrenceId}:1440m`, `task_due_soon:${occurrenceId}:60m`].sort(),
    );
  });

  it('emits the at-start notification for a task that configured no reminders at all', async () => {
    // The whole point of «обязательное оповещение прям во время начала дела»:
    // the family chose nothing, and it still arrives.
    const { occurrenceId } = await createSeries({ defaultAssigneeId: teen.id });
    const db = getDb();

    const emitted = await runTaskReminders(db, new Date(STARTS_AT));
    expect(emitted).toBe(1);

    const intents = await intentsFor(occurrenceId);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.type).toBe('task_started');
    expect(intents[0]?.dedupeKey).toBe(`task_started:${occurrenceId}`);

    // Once per occurrence, ever — not once per sweep.
    await runTaskReminders(db, new Date('2026-09-10T16:05:00.000Z'));
    expect(await intentsFor(occurrenceId)).toHaveLength(1);
  });

  it('reaches the creator when the chore is «Любой» and nobody has taken it', async () => {
    // `defaultAssigneeId` is null — the form's default. Under the rule this
    // replaced (`if (assigneeId === null) continue`) the mandatory notification
    // would have applied to almost no task in the app.
    const { occurrenceId } = await createSeries();
    const db = getDb();

    await runTaskReminders(db, new Date(STARTS_AT));

    const intents = await intentsFor(occurrenceId);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.type).toBe('task_started');

    // …and it is addressed to a person, not to nobody. Fan-out itself is a
    // separate BullMQ step that no worker runs in this harness, so the
    // producer's declared audience on the intent is the thing to assert — the
    // same seam `notifications/emission.test.ts` pins for every other producer.
    const [row] = await getDb()
      .select({ audience: notificationIntents.audience })
      .from(notificationIntents)
      .where(eq(notificationIntents.entityId, occurrenceId))
      .limit(1);
    expect(row?.audience).toEqual({ users: [owner.id] });
  });

  it('does not fire a reminder whose moment passed more than the lookback ago', async () => {
    const { occurrenceId } = await createSeries({
      reminderOffsets: [60],
      defaultAssigneeId: teen.id,
    });
    const db = getDb();

    // The 60-minute lead was due at 15:00Z. A worker that comes back at 16:00Z
    // is an hour late; the reminder is dropped rather than sent stale.
    await runTaskReminders(db, new Date('2026-09-10T15:50:00.000Z'));

    const leads = (await intentsFor(occurrenceId)).filter((i) => i.type === 'task_due_soon');
    expect(leads, 'a late worker does not deliver yesterday’s reminders').toHaveLength(0);
  });

  it('leaves a completed occurrence alone', async () => {
    const { occurrenceId } = await createSeries({
      reminderOffsets: [60],
      defaultAssigneeId: teen.id,
    });

    const done = await request(h.app, {
      method: 'POST',
      url: `/api/tasks/occurrences/${occurrenceId}/complete`,
      token: teen.accessToken,
      payload: {},
    });
    expect([200, 201]).toContain(done.statusCode);

    const db = getDb();
    await runTaskReminders(db, new Date('2026-09-10T15:00:00.000Z'));
    await runTaskReminders(db, new Date(STARTS_AT));

    expect(await intentsFor(occurrenceId)).toHaveLength(0);
  });

  /* ------------------------------ the contract --------------------------- */

  it('round-trips reminderOffsets through create, read and update', async () => {
    const { seriesId } = await createSeries({ reminderOffsets: [60, 1440, 60] });

    const read = await request(h.app, {
      method: 'GET',
      url: `/api/tasks/series/${seriesId}`,
      token: owner.accessToken,
    });
    expect(read.statusCode).toBe(200);
    // Normalized: de-duplicated and furthest-first, so «за день и за час» reads
    // in the order a person says it and the UI never re-sorts server state.
    expect(read.json<{ reminderOffsets: number[] }>().reminderOffsets).toEqual([1440, 60]);

    const updated = await request(h.app, {
      method: 'PATCH',
      url: `/api/tasks/series/${seriesId}`,
      token: owner.accessToken,
      payload: { scope: 'all', reminderOffsets: [] },
    });
    expect(updated.statusCode, JSON.stringify(updated.json())).toBe(200);
    expect(updated.json<{ reminderOffsets: number[] }>().reminderOffsets).toEqual([]);
  });

  it('refuses a zero offset — the start is not a lead time and is not optional', async () => {
    const response = await request(h.app, {
      method: 'POST',
      url: '/api/tasks/series',
      token: owner.accessToken,
      payload: {
        title: 'Вынести мусор',
        reminderOffsets: [0],
        recurrence: {
          mode: 'once',
          dtstartLocal: DTSTART_LOCAL,
          timezone: 'Europe/Moscow',
          rdatesLocal: [],
          exdatesLocal: [],
        },
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
