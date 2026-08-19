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
  // maintenance
  'maintenance.prune-refresh-tokens': Record<string, never>;
  'maintenance.prune-oauth-transactions': Record<string, never>;
  'maintenance.push-health-check': Record<string, never>;
  'maintenance.prune-activity-log': Record<string, never>;
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
  'maintenance.prune-refresh-tokens': 'maintenance',
  'maintenance.prune-oauth-transactions': 'maintenance',
  'maintenance.push-health-check': 'maintenance',
  'maintenance.prune-activity-log': 'maintenance',
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
  await getQueue(QUEUE_FOR_JOB[name]).add(name, payload, options);
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
}
