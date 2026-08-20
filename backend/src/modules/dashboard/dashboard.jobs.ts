import { sql } from 'drizzle-orm';

import { getDb } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { registerJobHandler } from '../../core/queue/workers.js';
import { familySettings } from '../identity/identity.schema.js';
import {
  createDigestPort,
  createNotificationIntentPort,
  digestDueDecision,
  resolveTimezoneForSubscriber,
  sendDigest,
  type DigestPort,
  type DigestSendResult,
  type NotificationIntentPort,
} from './digest.service.js';

/**
 * `scheduler.weekly-digest` — the hourly sweep behind the one notification a
 * family will not switch off.
 *
 * ## Why hourly, and why the filtering is per user
 *
 * The repeatable job is registered as `0 * * * *` (see `core/queue/workers.ts`),
 * i.e. every hour **in UTC**. It does not know and must not know what time it is
 * for any particular person: each subscriber's `weekday` + `timeOfDay` are
 * floating local wall clock in *their* timezone (D2), so the handler resolves
 * each one individually and sends only to those whose slot has arrived. A single
 * cron expression cannot express "19:00 for Аня in Moscow and 19:00 for Паша in
 * Berlin"; sixty-something rows of arithmetic can.
 *
 * ## Idempotency
 *
 * Three guards, none of which depends on the job running exactly once:
 *
 * - `digest_subscriptions.last_sent_at` is advanced by a **conditional** update,
 *   so two workers produce one winner.
 * - The intent's `dedupe_key` is `weekly_digest:<userId>:<isoWeekKey>` behind a
 *   partial unique index — the actual guarantee that nobody is told twice.
 * - The dispatch enqueue carries a `jobId`, which BullMQ deduplicates.
 *
 * A retried job, a redeploy mid-sweep, or a manual re-run therefore all result
 * in **at most one digest per (user, ISO week)**. That is the property that
 * matters: a duplicate weekly digest is the exact kind of noise that makes a
 * parent turn notifications off, and D10/D11 spend most of their length making
 * that impossible.
 *
 * ## Failure isolation
 *
 * One subscriber's bad row must not cost the rest of the family their digest —
 * the sweep is their only chance this week — so each send is caught
 * individually and logged, and the job as a whole still succeeds. A thrown job
 * would be retried by BullMQ and would re-walk everyone, which the dedupe keys
 * make harmless but pointless.
 *
 * ## Ownership
 *
 * This module owns `scheduler.weekly-digest`, alone. `notifications` used to
 * register the same name with a second implementation of the whole sweep, which
 * made the winner a function of import order in `modules/jobs.ts` — and the
 * loser logged one line at boot and then silently never ran. That is how a
 * family stops receiving the digest with a green worker and no error anywhere.
 *
 * This one won on the merits: its send-once claim is keyed on the ISO week
 * rather than a date plus a trailing 23 hours, so editing your preferred
 * weekday cannot produce two digests in one week; its due check is "the slot
 * has passed, this week" rather than a one-hour window that skips the week
 * whenever a worker misses a tick. The notifications sweep has been deleted,
 * not disabled, and `notifications.jobs.test.ts` fails if any job name is ever
 * claimed by two modules again.
 */

/** Family scale; the cap exists so a corrupted table cannot wedge the worker. */
export const DIGEST_SWEEP_LIMIT = 200;

/**
 * The sweep, factored out of the BullMQ registration so the test can drive it
 * with a fake port, a fake clock and no Redis.
 */
export async function runWeeklyDigestSweep(
  port: DigestPort,
  intents: NotificationIntentPort,
  familyTimezone: string,
  now: Date,
  limit: number = DIGEST_SWEEP_LIMIT,
): Promise<DigestSendResult[]> {
  const subscribers = await port.listSubscribers(limit);
  const results: DigestSendResult[] = [];

  for (const subscriber of subscribers) {
    // Cheap pre-check before any data gathering: most hours, for most people,
    // the answer is "not yet" and we should not touch a single domain table.
    const timezone = resolveTimezoneForSubscriber(subscriber, familyTimezone);
    const decision = digestDueDecision({ schedule: subscriber.schedule, timezone, now });
    if (!decision.due) {
      results.push({
        userId: subscriber.userId,
        sent: false,
        reason: decision.reason,
        weekKey: decision.weekKey,
      });
      continue;
    }

    try {
      results.push(await sendDigest(port, intents, subscriber, familyTimezone, now));
    } catch (error) {
      logger.error(
        { userId: subscriber.userId, weekKey: decision.weekKey, err: error },
        'weekly digest failed for one subscriber; continuing with the rest',
      );
    }
  }

  return results;
}

/** Reads the singleton family timezone (D1) — the fallback for users without one. */
async function loadFamilyTimezone(): Promise<string> {
  const db = getDb();
  const [row] = await db
    .select({ timezone: familySettings.timezone })
    .from(familySettings)
    .where(sql`${familySettings.singleton}`)
    .limit(1);
  return row?.timezone ?? 'Europe/Moscow';
}

/**
 * The job name. Exported so `worker.ts` can assert the handler is registered.
 *
 * Importing this module is what registers it — `core/queue/workers.ts` reads
 * its registry at import time and `scheduleRepeatables()` silently skips a
 * repeatable whose handler is absent. The lead must therefore import this
 * module (directly, or via the module registry) from `worker.ts`, or the digest
 * never runs and nothing says so.
 */
export const WEEKLY_DIGEST_JOB = 'scheduler.weekly-digest' as const;

let registered = false;

/**
 * Mirrors `registerNotificationJobs()` so the lead can wire either module
 * explicitly rather than relying on import order.
 *
 * `registerJobHandler` is called bare, on purpose. It throws on a duplicate
 * name, and that throw should take the boot down: a duplicate means two modules
 * believe they own this job, and exactly one of them is running — which is the
 * failure that cost this family every weekly digest it should have received.
 * A crash at boot is loud, immediate and fixed in minutes; a caught error is a
 * log line nobody reads and a feature that quietly stops existing.
 */
export function registerDashboardJobs(): void {
  if (registered) return;
  registered = true;

  registerJobHandler(WEEKLY_DIGEST_JOB, async () => {
    const db = getDb();
    const familyTimezone = await loadFamilyTimezone();
    const now = new Date();

    const results = await runWeeklyDigestSweep(
      createDigestPort(db),
      createNotificationIntentPort(db),
      familyTimezone,
      now,
    );

    const sent = results.filter((r) => r.sent).length;
    const raced = results.filter((r) => r.reason === 'raced' || r.reason === 'already_sent').length;
    logger.info(
      { considered: results.length, sent, raced, familyTimezone },
      'weekly digest sweep finished',
    );
  });
}

registerDashboardJobs();
