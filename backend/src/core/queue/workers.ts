import { Worker, type Job } from 'bullmq';

import { logger } from '../logger.js';
import { createBullConnection } from '../redis.js';
import {
  getQueue,
  QUEUE_NAMES,
  safeJobId,
  type JobName,
  type JobPayloads,
  type QueueName,
} from './queues.js';

/**
 * Worker runtime.
 *
 * Modules register their handlers with `registerJobHandler` at import time;
 * `startWorkers` then spins up one BullMQ worker per queue and schedules the
 * repeatable jobs. Keeping the registry here means a module never has to know
 * about BullMQ wiring, and a missing handler is a loud error rather than a job
 * that silently disappears.
 */

type JobHandler<N extends JobName> = (payload: JobPayloads[N], job: Job) => Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlers = new Map<JobName, JobHandler<any>>();

export function registerJobHandler<N extends JobName>(name: N, handler: JobHandler<N>): void {
  if (handlers.has(name)) throw new Error(`Duplicate job handler registered for "${name}"`);
  handlers.set(name, handler);
}

const CONCURRENCY: Record<QueueName, number> = {
  notifications: 10,
  scheduler: 2,
  maintenance: 1,
};

/**
 * Cron-scheduled work.
 *
 * Patterns are evaluated in **this process's timezone**, not UTC: BullMQ passes
 * them to cron-parser without a `tz`, so the container's `TZ` decides — and
 * `infra/docker-compose.yml` sets `TZ: ${TZ:-Europe/Moscow}` on the backend.
 * The two readings differ by three hours, which matters for exactly one thing
 * here: staying clear of the VDI's nightly backup window (see
 * `maintenance.sweep-media` below). Jobs that care about a *family member's*
 * local wall time still read the timezone from `family_settings` themselves and
 * ignore this entirely.
 *
 * Exported so a test can assert a job is actually scheduled. The reverse
 * direction — scheduled with no handler — already stops the boot below; a
 * handler with no schedule is the silent half, and it is how the media sweep
 * sat written, tested and never running.
 */
export const REPEATABLE: ReadonlyArray<{ name: JobName; pattern: string }> = [
  // Extend the 90-day occurrence horizon and pick up anything the eager path missed.
  { name: 'scheduler.materialize-all', pattern: '0 0 * * *' },
  // Fire due reminders every five minutes.
  { name: 'scheduler.reminders', pattern: '*/5 * * * *' },
  // Flag overdue tasks and notify once per occurrence.
  { name: 'scheduler.overdue-sweep', pattern: '*/15 * * * *' },
  // Generate birthday events from `users.birth_date`.
  { name: 'scheduler.birthdays', pattern: '30 0 * * *' },
  // Weekly digest fan-out; per-user weekday/time filtering happens in the handler.
  { name: 'scheduler.weekly-digest', pattern: '0 * * * *' },
  // Expire stale swap offers, before the nightly sweeps.
  { name: 'chores.expire-swaps', pattern: '20 3 * * *' },
  // Housekeeping.
  { name: 'maintenance.prune-refresh-tokens', pattern: '15 3 * * *' },
  { name: 'maintenance.prune-oauth-transactions', pattern: '*/30 * * * *' },
  { name: 'maintenance.push-health-check', pattern: '45 3 * * *' },
  { name: 'maintenance.prune-activity-log', pattern: '0 4 * * 0' },
  /**
   * Reclaim abandoned drafts (24 h) and long-detached rows (30 days).
   *
   * Daily, because the shorter of the two windows is 24 h: any finer buys
   * nothing a member can perceive (a draft still lives out its full day; the
   * cutoff is in the query, not in the schedule) and any coarser leaves bytes
   * lying around for a multiple of a day that nothing needs.
   *
   * 05:20 rather than the small hours everything else uses, because this is the
   * only scheduled job that **writes to the object store**, and the nightly
   * backup mirrors that store's live volume: `infra/scripts/vdi-bootstrap.sh`
   * installs it at 03:30, its own header and `docs/DEPLOYMENT.md` §8 say 03:17.
   * Deleting objects while rsync walks the volume is how you get a mirror that
   * holds half of an object. 05:20 here is 05:20 Moscow / 02:20 UTC, and host
   * cron may itself be running in either zone, so the four combinations put this
   * between 57 and 123 minutes away from the backup — never inside it, under any
   * reading. The half-hourly oauth prune owns :00 and :30 on the same
   * single-slot maintenance queue, so :20 also avoids queueing behind it.
   */
  { name: 'maintenance.sweep-media', pattern: '20 5 * * *' },
];

async function scheduleRepeatables(): Promise<void> {
  /**
   * Every scheduled job must have a handler.
   *
   * This used to `continue` silently, which meant three maintenance sweeps were
   * scheduled, never ran, and nothing anywhere said so — `refresh_tokens`,
   * `oauth_transactions` and `activity_log` simply grew forever. A missing
   * handler is a wiring bug, and wiring bugs should stop the boot, not hide.
   */
  const missing = REPEATABLE.filter(({ name }) => !handlers.has(name)).map(({ name }) => name);
  if (missing.length > 0) {
    throw new Error(
      `Scheduled jobs have no registered handler: ${missing.join(', ')}. ` +
        'Register them in `src/modules/jobs.ts` or remove them from REPEATABLE.',
    );
  }

  for (const { name, pattern } of REPEATABLE) {
    const queue = getQueue(
      name.startsWith('scheduler.') ? QUEUE_NAMES.scheduler : QUEUE_NAMES.maintenance,
    );
    await queue.add(
      name,
      {},
      {
        repeat: { pattern },
        // A stable job id keeps the repeatable definition idempotent across restarts.
        // `repeat:<name>` contains `:`, which BullMQ refuses — every repeatable
        // job silently failed to schedule, so nothing recurring ever ran.
        jobId: safeJobId(`repeat:${name}`),
      },
    );
  }
}

/** Starts every worker. Returns a function that drains and closes them. */
export async function startWorkers(): Promise<() => Promise<void>> {
  const workers: Worker[] = [];

  for (const queueName of Object.values(QUEUE_NAMES)) {
    const worker = new Worker(
      queueName,
      async (job: Job) => {
        const handler = handlers.get(job.name as JobName);
        if (!handler) {
          throw new Error(`No handler registered for job "${job.name}" on queue "${queueName}"`);
        }
        await handler(job.data as JobPayloads[JobName], job);
      },
      { connection: createBullConnection(), concurrency: CONCURRENCY[queueName] },
    );

    worker.on('failed', (job, err) => {
      logger.error(
        { queue: queueName, job: job?.name, jobId: job?.id, attempt: job?.attemptsMade, err },
        'job failed',
      );
    });
    worker.on('error', (err) => logger.error({ queue: queueName, err }, 'worker error'));

    workers.push(worker);
  }

  await scheduleRepeatables();
  logger.info({ queues: Object.values(QUEUE_NAMES), handlers: handlers.size }, 'workers started');

  return async () => {
    await Promise.allSettled(workers.map((w) => w.close()));
    const { closeQueues } = await import('./queues.js');
    await closeQueues();
  };
}
