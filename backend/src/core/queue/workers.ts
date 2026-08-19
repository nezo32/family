import { Worker, type Job } from 'bullmq';

import { logger } from '../logger.js';
import { createBullConnection } from '../redis.js';
import { getQueue, QUEUE_NAMES, type JobName, type JobPayloads, type QueueName } from './queues.js';

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
 * Cron-scheduled work. Times are UTC; jobs that care about local wall time read
 * the family timezone from `family_settings` themselves.
 */
const REPEATABLE: Array<{ name: JobName; pattern: string }> = [
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
  // Expire stale swap offers and refresh streaks, before the nightly sweeps.
  { name: 'chores.expire-swaps', pattern: '20 3 * * *' },
  { name: 'chores.streaks', pattern: '40 3 * * *' },
  // Housekeeping.
  { name: 'maintenance.prune-refresh-tokens', pattern: '15 3 * * *' },
  { name: 'maintenance.prune-oauth-transactions', pattern: '*/30 * * * *' },
  { name: 'maintenance.push-health-check', pattern: '45 3 * * *' },
  { name: 'maintenance.prune-activity-log', pattern: '0 4 * * 0' },
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
        jobId: `repeat:${name}`,
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
