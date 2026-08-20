import { getDb, type Db } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { registerJobHandler } from '../../core/queue/workers.js';
import { bumpRevisions } from '../../core/revisions.js';
import * as repo from './chores.repository.js';

/**
 * Background work for chores: swap expiry
 * (`docs/architecture/scheduling.md` §9).
 *
 * The handler is a **sweep**, not a per-entity job, and it is written to be
 * safe under a retry, a redeploy mid-run and two workers racing: expiry is one
 * conditional bulk UPDATE (`WHERE status = 'pending' AND expires_at < now`), so
 * re-running it can only ever expire rows that are still pending.
 *
 * There used to be a second sweep here that rebuilt streaks nightly. It went
 * with the rest of the score system (D5) — a streak is a number that punishes a
 * child for one missed Tuesday, which is the opposite of what a family app
 * should do — and nothing replaced it: fairness is now read straight off
 * `task_occurrences`, so there is no derived state left to repair.
 *
 * This emits no notification. "Ваше предложение обмена истекло" is not worth a
 * push, and notification fatigue is the failure mode that kills these apps
 * (D11).
 */

/* -------------------------------------------------------------------------- */
/* Handlers — exported so they are testable without BullMQ                     */
/* -------------------------------------------------------------------------- */

export async function runSwapExpiry(db: Db, now = new Date()): Promise<number> {
  const expired = await repo.expirePendingSwaps(db, now);
  if (expired.length > 0) {
    logger.info({ count: expired.length }, 'chores: expired pending swaps');
  }
  return expired.length;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export const CHORE_JOBS = {
  expireSwaps: 'chores.expire-swaps',
} as const;

export type ChoreJobName = (typeof CHORE_JOBS)[keyof typeof CHORE_JOBS];

let registered = false;

/**
 * Idempotent: `registerJobHandler` throws on a duplicate name, and this module
 * is imported both for its side effect (below) and, in tests, directly.
 */
export function registerChoreJobs(): void {
  if (registered) return;
  registered = true;

  registerJobHandler(CHORE_JOBS.expireSwaps, async () => {
    const expired = await runSwapExpiry(getDb());
    // Swaps render on the tasks screens, so an expiry moves the `tasks`
    // counter. A worker's writes never reach the HTTP hook (D12, §4.3).
    if (expired > 0) await bumpRevisions(['tasks']);
  });
}

// Self-registering on import, matching `notifications.jobs.ts` and
// `events.jobs.ts`: `modules/jobs.ts` is a barrel of bare imports.
registerChoreJobs();
