import { getDb, type Db } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { registerJobHandler } from '../../core/queue/workers.js';
import { DETACHED_GRACE_DAYS, DRAFT_TTL_HOURS, sweepOrphanedMedia } from './media.service.js';
import { getStorage } from './s3.adapter.js';

/**
 * `maintenance.sweep-media` — the schedule the orphan sweep never had.
 *
 * `sweepOrphanedMedia` was written and tested and then called by nothing, so
 * neither of the two classes of orphan it exists for was ever reclaimed: an
 * upload that minted an id whose post was never created ({@link
 * DRAFT_TTL_HOURS}), and a row soft-deleted when its post or comment went
 * ({@link DETACHED_GRACE_DAYS}). Nothing broke — the bucket simply only ever
 * grew, which on a VDI with 13 GB free is a deadline, not a preference.
 *
 * ## Why this lives here and not in `modules/maintenance`
 *
 * The prunes there are one `DELETE … WHERE created_at < cutoff` each. This one
 * spans two stores and has an ordering rule that only makes sense next to the
 * code that knows it (object first, row second). `chores.expire-swaps` is the
 * precedent: the `maintenance.` prefix names the *queue* — the failure domain a
 * job belongs to, and the reason a slow sweep cannot delay a reminder — not the
 * directory the handler is written in.
 *
 * ## Idempotency
 *
 * Free, and load-bearing given `attempts: 5`. Both candidate queries select on
 * state the sweep itself removes (`entity_id is null and created_at < cutoff`;
 * `deleted_at < cutoff`), so the second run over an unchanged window returns
 * zeroes. A retry after a partial run reclaims only what the first pass did not.
 *
 * ## When the object store is down
 *
 * Nothing is lost and nothing is silently dropped. Each failed removal leaves
 * its row in place to be retried, so the database never points at bytes that
 * are gone; the handler then **throws**, because a sweep that reclaimed nothing
 * because the store refused every delete is not a clean run, and the one thing
 * this whole feature has already proved is that silence is the expensive
 * failure mode. BullMQ retries it, and if the store is still down the job lands
 * in the failed set where a human can see it.
 */

/** Up to 5000 objects a night. */
const MAX_PASSES = 25;

/**
 * One night's sweep, in batches.
 *
 * `sweepOrphanedMedia` takes at most `batch` rows of each class per call, which
 * is right for a bounded unit of work and wrong as a nightly ceiling: the first
 * run after this ships meets however many orphans accumulated while there was
 * no schedule at all, and at one batch a night a backlog drains over weeks.
 *
 * So: keep going while a pass still reclaims something, up to {@link
 * MAX_PASSES}. The loop cannot spin — a pass that reclaims nothing ends it, and
 * that is exactly the shape a failing store produces, so an outage costs one
 * pass rather than twenty-five.
 */
export async function runMediaOrphanSweep(
  db: Db,
  options: { now?: Date; batch?: number } = {},
): Promise<{ drafts: number; detached: number; failed: number; passes: number }> {
  let drafts = 0;
  let detached = 0;
  let failed = 0;
  let passes = 0;

  for (; passes < MAX_PASSES; passes += 1) {
    const result = await sweepOrphanedMedia(db, options);
    drafts += result.drafts;
    detached += result.detached;
    failed += result.failed;
    if (result.drafts + result.detached === 0) break;
  }

  return { drafts, detached, failed, passes };
}

let registered = false;

/**
 * Idempotent, like `registerChoreJobs`: this module is imported for its side
 * effect below and, in tests, directly. `registerJobHandler` throws on a
 * duplicate name and that throw is wanted — it must not be swallowed here, or
 * this sweep becomes the next thing that stops existing without saying so.
 */
export function registerMediaJobs(): void {
  if (registered) return;
  registered = true;

  registerJobHandler('maintenance.sweep-media', async () => {
    /*
     * Storage disabled (no `S3_*` in the environment) is a configuration, not a
     * fault: the deployment has no object store, every upload path already
     * answers 503, and there is nothing to reclaim. Sweeping anyway would log a
     * warning per candidate row every night and report a "clean" run.
     */
    if (!getStorage()) {
      logger.debug('media sweep skipped: object storage is not configured');
      return;
    }

    const { drafts, detached, failed, passes } = await runMediaOrphanSweep(getDb());

    if (drafts + detached > 0) {
      logger.info(
        {
          drafts,
          detached,
          passes,
          draftTtlHours: DRAFT_TTL_HOURS,
          graceDays: DETACHED_GRACE_DAYS,
        },
        'reclaimed orphaned media',
      );
    }

    if (failed > 0) {
      logger.warn({ failed, drafts, detached }, 'media sweep could not reach the object store');
      throw new Error(
        `media sweep left ${String(failed)} object(s) unreclaimed — the object store rejected the delete`,
      );
    }
  });
}

// Self-registering on import, matching the other `*.jobs.ts` modules:
// `modules/jobs.ts` is a barrel of bare imports.
registerMediaJobs();
