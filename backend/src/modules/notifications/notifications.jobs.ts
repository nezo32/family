import { getDb } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { registerJobHandler } from '../../core/queue/workers.js';
import {
  deliver,
  dispatchIntent,
  escalateIntent,
  runPushHealthCheck,
} from './notifications.service.js';

/**
 * Background handlers for the notifications pipeline.
 *
 * **Every handler here is idempotent**, because BullMQ guarantees at-least-once
 * delivery and because our own recovery sweeps deliberately re-enqueue jobs that
 * may already have run. The idempotency is not in this file — it lives in the
 * service, where the status transitions and the conditional updates are — but
 * this is where it is relied upon:
 *
 * | Job | Idempotency mechanism |
 * |---|---|
 * | `notification.dispatch` | fan-out returns early when the intent already has deliveries |
 * | `notification.deliver`  | only `pending`/`scheduled` rows do anything; status moves forward first |
 * | `notification.escalate` | the ladder advances via `UPDATE ... WHERE escalation_state = <expected>` |
 * | `maintenance.push-health-check` | conditional counters and re-enqueues with stable job ids |
 * | `scheduler.weekly-digest` | `claimDigestSend` stamps `last_sent_at` conditionally |
 *
 * Retries use the queue's own exponential backoff (`attempts: 5`,
 * `backoff: exponential`, configured in `core/queue/queues.ts`). A handler
 * signals "retry me" by throwing; anything it can decide is permanent it records
 * on the row and returns normally, so a permanent failure never burns the retry
 * budget and never hides behind a red job.
 */

let registered = false;

export function registerNotificationJobs(): void {
  // Guarded because both `worker.ts` and any module that imports this file for
  // its side effect would otherwise trip `registerJobHandler`'s duplicate check.
  if (registered) return;
  registered = true;

  /**
   * Fan-out: one intent → delivery rows. Enqueued by `EmitIntentResult.dispatch()`
   * after the producer's transaction commits, with `jobId = fanout:<intentId>`.
   */
  registerJobHandler('notification.dispatch', async ({ intentId }) => {
    await dispatchIntent(getDb(), intentId);
  });

  /**
   * Send one delivery row through its channel adapter.
   *
   * Scheduled (quiet-hours-deferred and rate-limited) rows arrive here as BullMQ
   * *delayed* jobs — the delay is the release mechanism. The handler re-checks
   * quiet hours anyway, because a delayed job can fire early and preferences can
   * change in between.
   */
  registerJobHandler('notification.deliver', async ({ deliveryId }) => {
    await deliver(getDb(), deliveryId);
  });

  /**
   * The D11 enforcement loop for one intent: nobody confirmed receipt, so
   * re-deliver → try another channel → tell another person.
   *
   * Enqueued as a delayed job when a `high`/`critical` delivery is sent, and
   * re-enqueued by each rung. Quiet hours are respected: an offline phone
   * overnight defers the escalation instead of producing a 03:00 push.
   */
  registerJobHandler('notification.escalate', async ({ intentId }) => {
    const outcome = await escalateIntent(getDb(), intentId);
    if (outcome !== 'satisfied' && outcome !== 'too_early') {
      logger.info({ intentId, outcome }, 'escalation evaluated');
    }
  });

  /**
   * Daily. Marks subscriptions that have stopped acknowledging deliveries,
   * prunes dead rows, trims old deliveries, and re-enqueues anything a Redis
   * flush lost. Also runs the escalation sweep as the safety net behind the
   * per-intent delayed jobs.
   */
  registerJobHandler('maintenance.push-health-check', async () => {
    const result = await runPushHealthCheck(getDb());
    logger.info(result, 'push health check complete');
  });

  /**
   * `scheduler.weekly-digest` is deliberately NOT registered here. The dashboard
   * module owns it (`dashboard.jobs.ts`): its send-once claim is keyed on the
   * ISO week rather than a date plus a 23-hour window, so editing your preferred
   * weekday cannot produce two digests in one week, and a worker that misses a
   * tick does not silently skip the week. `registerJobHandler` throws on
   * duplicates, so registering it in both places would kill the worker at boot.
   */
}

registerNotificationJobs();
