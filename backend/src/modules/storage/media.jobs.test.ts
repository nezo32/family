import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../core/db.js';
import type { JobName } from '../../core/queue/queues.js';
import type * as Workers from '../../core/queue/workers.js';
import type * as MediaJobs from './media.jobs.js';
import type { SweepResult } from './media.service.js';

/**
 * The wiring of `maintenance.sweep-media`, asserted without a database.
 *
 * The bug this file guards against is not a wrong result — it is a handler that
 * exists, passes its own tests, and is never called. That was the state of
 * `sweepOrphanedMedia` for the whole of the media pass: written, tested, and
 * absent from `REPEATABLE`, so the bucket only ever grew. `scheduleRepeatables`
 * already stops the boot for the mirror image of that mistake (scheduled, no
 * handler); this covers the silent half.
 *
 * Everything below is deliberately unit-level. That the sweep genuinely removes
 * bytes belongs against a real object store, and lives in
 * `media.integration.test.ts`.
 */

const state = vi.hoisted(() => ({
  registrations: [] as string[],
  handlers: new Map<string, (payload: unknown, job: Job) => Promise<void>>(),
  /** Queued results for the mocked sweep, one per pass. */
  passes: [] as SweepResult[],
  calls: 0,
  storage: { present: true },
}));

vi.mock('../../core/queue/workers.js', () => ({
  registerJobHandler: (name: string, handler: (payload: unknown, job: Job) => Promise<void>) => {
    // Records rather than throwing, the way `notifications.jobs.test.ts` does:
    // a real duplicate is that file's assertion, not this one's.
    state.registrations.push(name);
    state.handlers.set(name, handler);
  },
  startWorkers: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ getDb: () => ({}) as Db }));

vi.mock('./s3.adapter.js', () => ({
  getStorage: () => (state.storage.present ? {} : null),
}));

vi.mock('./media.service.js', () => ({
  DRAFT_TTL_HOURS: 24,
  DETACHED_GRACE_DAYS: 30,
  sweepOrphanedMedia: (): Promise<SweepResult> => {
    const result = state.passes[state.calls] ?? { drafts: 0, detached: 0, failed: 0 };
    state.calls += 1;
    return Promise.resolve(result);
  },
}));

const SWEEP_MEDIA = 'maintenance.sweep-media' satisfies JobName;

async function loadModule(): Promise<typeof MediaJobs> {
  state.registrations.length = 0;
  state.handlers.clear();
  vi.resetModules();
  return import('./media.jobs.js');
}

async function runHandler(): Promise<void> {
  const handler = state.handlers.get(SWEEP_MEDIA);
  if (!handler) throw new Error('handler not registered');
  await handler({}, {} as Job);
}

beforeEach(() => {
  state.passes.length = 0;
  state.calls = 0;
  state.storage.present = true;
});

describe('maintenance.sweep-media wiring', () => {
  it('is registered by importing the module, exactly once', async () => {
    const media = await loadModule();
    expect(state.registrations).toEqual([SWEEP_MEDIA]);

    // Importing a module twice must not become a duplicate registration: the
    // real `registerJobHandler` throws on one, and that throw takes the worker
    // down at boot.
    media.registerMediaJobs();
    expect(state.registrations).toEqual([SWEEP_MEDIA]);
  });

  it('is actually scheduled, on the maintenance queue, clear of the backup window', async () => {
    const { REPEATABLE } = await vi.importActual<typeof Workers>('../../core/queue/workers.js');

    const row = REPEATABLE.find((entry) => entry.name === SWEEP_MEDIA);
    expect(row, 'the sweep must be in REPEATABLE or it never runs').toBeDefined();

    const [minute, hour, ...rest] = (row?.pattern ?? '').split(' ');
    expect(rest).toEqual(['*', '*', '*']); // daily, every month, every weekday
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);

    /*
     * The nightly backup mirrors the live RustFS volume at 03:17–03:30 host
     * local time (`infra/scripts/vdi-bootstrap.sh`, `docs/DEPLOYMENT.md` §8),
     * and this is the only scheduled job that deletes objects out from under
     * it. Host cron and this process need not agree on a timezone, so the whole
     * 03:00–04:00 band is out of bounds in either reading — and so is the same
     * band shifted by the three hours between UTC and Europe/Moscow.
     */
    const FORBIDDEN_HOURS = [3, 4, 6, 7];
    expect(FORBIDDEN_HOURS, `hour ${String(hour)} collides with the backup window`).not.toContain(
      Number(hour),
    );

    // `scheduleRepeatables` routes anything not prefixed `scheduler.` to the
    // maintenance queue, whose concurrency is 1 — a slow sweep cannot delay a
    // reminder.
    expect(SWEEP_MEDIA.startsWith('scheduler.')).toBe(false);
  });
});

describe('the sweep handler', () => {
  it('drains a backlog across passes, and stops as soon as one comes back empty', async () => {
    state.passes.push(
      { drafts: 200, detached: 200, failed: 0 },
      { drafts: 40, detached: 0, failed: 0 },
      { drafts: 0, detached: 0, failed: 0 },
    );

    const { runMediaOrphanSweep } = await loadModule();
    const result = await runMediaOrphanSweep({} as Db);

    expect(result).toEqual({ drafts: 240, detached: 200, failed: 0, passes: 2 });
    // Three calls: two that reclaimed something and the one that proved there
    // was nothing left.
    expect(state.calls).toBe(3);
  });

  it('is a no-op the second time: nothing reclaimed, no further passes', async () => {
    const { runMediaOrphanSweep } = await loadModule();

    state.passes.push({ drafts: 3, detached: 1, failed: 0 }, { drafts: 0, detached: 0, failed: 0 });
    expect(await runMediaOrphanSweep({} as Db)).toMatchObject({ drafts: 3, detached: 1 });

    state.calls = 0;
    state.passes.length = 0; // every further pass now reports an empty window
    expect(await runMediaOrphanSweep({} as Db)).toEqual({
      drafts: 0,
      detached: 0,
      failed: 0,
      passes: 0,
    });
    expect(state.calls).toBe(1);
  });

  it('throws when the object store refused a delete, so the run is not recorded clean', async () => {
    // A store that is down reclaims nothing and leaves every row where it was.
    // Returning quietly here would look identical to "there were no orphans" —
    // for as long as the outage lasts.
    state.passes.push({ drafts: 0, detached: 0, failed: 7 });

    await loadModule();
    await expect(runHandler()).rejects.toThrow(/7 object\(s\) unreclaimed/);

    // One pass, not twenty-five: a failing pass reclaims nothing, which ends
    // the loop.
    expect(state.calls).toBe(1);
  });

  it('does not sweep at all when storage is switched off', async () => {
    state.storage.present = false;
    state.passes.push({ drafts: 1, detached: 1, failed: 0 });

    await loadModule();
    await runHandler();

    expect(state.calls).toBe(0);
  });
});
