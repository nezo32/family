import { Queue, type JobsOptions } from 'bullmq';

import { createBullConnection } from '../redis.js';

/**
 * Background work.
 *
 * Three queues, separated by failure domain rather than by feature: a stuck
 * notification must never delay tomorrow's occurrence materialization, and
 * neither should block routine cleanup.
 */

export const QUEUE_NAMES = {
  /** Fan-out and delivery of notification intents. */
  notifications: 'notifications',
  /** Recurrence materialization, reminders, digests, birthdays. */
  scheduler: 'scheduler',
  /** Token sweeps, subscription health checks, backups, log pruning. */
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Job payload map. Adding a job type here makes `enqueue` type-safe for it. */
export interface JobPayloads {
  // notifications
  'notification.dispatch': { intentId: string };
  'notification.deliver': { deliveryId: string };
  'notification.escalate': { intentId: string };
  // scheduler
  'scheduler.materialize-all': Record<string, never>;
  'scheduler.materialize-series': { kind: 'task' | 'event'; seriesId: string };
  'scheduler.reminders': Record<string, never>;
  'scheduler.overdue-sweep': Record<string, never>;
  'scheduler.birthdays': Record<string, never>;
  'scheduler.weekly-digest': Record<string, never>;
  // chores
  'chores.expire-swaps': Record<string, never>;
  // maintenance
  'maintenance.prune-refresh-tokens': Record<string, never>;
  'maintenance.prune-oauth-transactions': Record<string, never>;
  'maintenance.push-health-check': Record<string, never>;
  'maintenance.prune-activity-log': Record<string, never>;
  'maintenance.sweep-media': Record<string, never>;
}

export type JobName = keyof JobPayloads;

const QUEUE_FOR_JOB: Record<JobName, QueueName> = {
  'notification.dispatch': 'notifications',
  'notification.deliver': 'notifications',
  'notification.escalate': 'notifications',
  'scheduler.materialize-all': 'scheduler',
  'scheduler.materialize-series': 'scheduler',
  'scheduler.reminders': 'scheduler',
  'scheduler.overdue-sweep': 'scheduler',
  'scheduler.birthdays': 'scheduler',
  'scheduler.weekly-digest': 'scheduler',
  'chores.expire-swaps': 'maintenance',
  'maintenance.prune-refresh-tokens': 'maintenance',
  'maintenance.prune-oauth-transactions': 'maintenance',
  'maintenance.push-health-check': 'maintenance',
  'maintenance.prune-activity-log': 'maintenance',
  'maintenance.sweep-media': 'maintenance',
};

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 500 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: createBullConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, queue);
  }
  return queue;
}

/**
 * Enqueue a job.
 *
 * Pass `jobId` for idempotency: BullMQ refuses a duplicate id, which is how we
 * collapse a burst of edits into one notification and how a retried domain
 * event avoids double-notifying (D10).
 */
export async function enqueue<N extends JobName>(
  name: N,
  payload: JobPayloads[N],
  options?: JobsOptions & { jobId?: string },
): Promise<void> {
  const opts = options?.jobId ? { ...options, jobId: safeJobId(options.jobId) } : options;
  await withTimeout(
    getQueue(QUEUE_FOR_JOB[name]).add(name, payload, opts),
    ENQUEUE_TIMEOUT_MS,
    `enqueue ${name}`,
  );
}

/**
 * How long an enqueue may take before we give up on it.
 *
 * Every caller enqueues *after* committing its domain write, and several wrap
 * the call in a try/catch precisely so a queue outage cannot fail a request
 * that already succeeded. That contract only holds if the promise settles —
 * and it did not: BullMQ manages its own connection and reinstates ioredis's
 * offline queue, so with `maxRetriesPerRequest: null` an unreachable Redis
 * left `add()` pending forever and the HTTP request hung after the money was
 * already in the ledger.
 *
 * Setting the option on the connection is not enough, so the guarantee is made
 * here instead, where it is ours to make.
 */
const ENQUEUE_TIMEOUT_MS = 5_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * BullMQ rejects a custom job id containing `:` — it uses that character in its
 * own Redis key layout, and `Job.addJob` throws `Custom Id cannot contain :`.
 *
 * Nearly every dedupe key in this codebase is naturally written `scope:uuid`,
 * so the throw landed on the enqueue path of most notifications and every
 * repeatable job. Worse, it surfaced *after* the domain write had committed, so
 * the symptom was a 500 on a request that had already succeeded.
 *
 * Sanitising centrally rather than at each call site means a caller can keep
 * writing the readable `scope:id` form and cannot reintroduce the bug. `:` is
 * the only forbidden character, and mapping it to `~` keeps ids unique.
 */
export function safeJobId(id: string): string {
  return id.replaceAll(':', '~');
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
}
