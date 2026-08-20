import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobName } from '../../core/queue/queues.js';

/**
 * Who owns which background job.
 *
 * ## Why this file exists
 *
 * `registerJobHandler` throws on a duplicate name, which sounds like enough —
 * except that a module may swallow the throw to avoid taking the whole worker
 * down with it, and `dashboard.jobs.ts` does exactly that. The result is the
 * worst shape a bug can have: two modules claim `scheduler.weekly-digest`, the
 * winner is decided by import order in `modules/jobs.ts`, the loser logs one
 * line at boot and then quietly never runs. Nothing errors. Nothing retries.
 * The weekly digest simply stops arriving, and the first person to notice is a
 * parent wondering why nobody told them about Tuesday.
 *
 * There is precedent for both halves of the fix in this codebase: `app.ts`
 * asserts at boot that every route declares an access rule, and `modules/
 * jobs.ts` composes `scheduler.reminders` in one place because tasks and events
 * both wanted it. This is the same idea for job ownership, enforced by a test
 * instead of by a comment.
 *
 * ## How
 *
 * `core/queue/workers.js` is mocked, so `registerJobHandler` records instead of
 * throwing. That matters: with the real implementation a module that catches
 * the duplicate error would hide the very thing being asserted. Every module
 * that registers handlers is then imported through the real barrel, and the
 * recorded names are checked for collisions.
 */

const registrations: JobName[] = [];

vi.mock('../../core/queue/workers.js', () => ({
  registerJobHandler: (name: JobName) => {
    registrations.push(name);
  },
  startWorkers: vi.fn(),
}));

/** Import the barrel fresh, with an empty ledger, and report what was claimed. */
async function collectRegistrations(): Promise<JobName[]> {
  registrations.length = 0;
  vi.resetModules();

  const { registerAllJobHandlers } = await import('../jobs.js');
  await registerAllJobHandlers();

  return [...registrations];
}

describe('background job ownership', () => {
  beforeEach(() => {
    registrations.length = 0;
  });

  it('gives every job name exactly one owner', async () => {
    const names = await collectRegistrations();
    expect(names.length).toBeGreaterThan(0);

    const seen = new Map<JobName, number>();
    for (const name of names) seen.set(name, (seen.get(name) ?? 0) + 1);

    const duplicated = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([name, count]) => `${name} (${String(count)}×)`);

    /*
     * A duplicate here is not a style problem. `registerJobHandler` refuses the
     * second registration, so one of the two modules is dead code from boot —
     * and which one depends on the order of the `import()` calls in
     * `modules/jobs.ts`, which nobody reads as load-bearing.
     *
     * If you are seeing this fail: pick one owner and delete the other
     * registration, or — when both were genuinely doing different work —
     * compose them into one handler in `modules/jobs.ts`, the way
     * `scheduler.reminders` folds the task and event sweeps together.
     */
    expect(duplicated).toEqual([]);
  });

  it('leaves the weekly digest to the dashboard module alone', async () => {
    /*
     * The specific collision that prompted this file. Both modules shipped a
     * complete weekly digest; the dashboard's claims the send once per ISO week
     * (the notifications one keyed on a date plus a trailing 23 hours, so
     * editing your weekday could produce two digests in one week).
     *
     * Asserted from both ends — that the name is claimed at all, and that this
     * module is not the one claiming it — because the two ways to break it are
     * opposite: deleting the surviving registration silences the digest, and
     * re-adding ours makes the outcome depend on import order again.
     */
    registrations.length = 0;
    vi.resetModules();
    await import('./notifications.jobs.js');

    expect(registrations).not.toContain('scheduler.weekly-digest');
    expect(registrations).toContain('notification.dispatch');

    const all = await collectRegistrations();
    expect(all).toContain('scheduler.weekly-digest');
  });
});
