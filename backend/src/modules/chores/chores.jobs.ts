import type { Job } from 'bullmq';

import { getDb, type Db } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { registerJobHandler } from '../../core/queue/workers.js';
import * as repo from './chores.repository.js';
import { ChoresService } from './chores.service.js';

/**
 * Background work for chores: swap expiry and streak maintenance
 * (`docs/architecture/scheduling.md` §9).
 *
 * Both handlers are **sweeps**, not per-entity jobs, and both are written to be
 * safe under a retry, a redeploy mid-run and two workers racing:
 *
 * - expiry is one conditional bulk UPDATE (`WHERE status = 'pending' AND
 *   expires_at < now`), so re-running it can only ever expire rows that are
 *   still pending;
 * - streak maintenance folds forward from each member's stored resume point, so
 *   an overlapping window re-folds nothing.
 *
 * Neither emits a notification. "Ваше предложение обмена истекло" is not worth
 * a push, and notification fatigue is the failure mode that kills these apps
 * (D11).
 */

/** How far back the streak sweep looks for work that has come due. */
const STREAK_LOOKBACK_DAYS = 3;

const MS_PER_DAY = 86_400_000;

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

/**
 * Repair every streak touched by work that has come due since the last sweep.
 *
 * The live completion path already folds its own occurrence in, so this exists
 * for the cases it cannot see: a chore nobody ever touched (which must break
 * the run), a skip, and any crash between the status write and the streak
 * write.
 */
export async function runStreakMaintenance(db: Db, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - STREAK_LOOKBACK_DAYS * MS_PER_DAY);
  const userIds = await repo.listUsersWithResolvedWork(db, since);
  if (userIds.length === 0) return 0;

  const service = new ChoresService(db, { now: () => now });
  for (const userId of userIds) {
    // One transaction per member: a single poisoned row must not roll back
    // everybody else's streak repair.
    await db.transaction((tx) => service.points.refreshStreak(tx, userId, now));
  }
  logger.info({ count: userIds.length }, 'chores: refreshed streaks');
  return userIds.length;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export const CHORE_JOBS = {
  expireSwaps: 'chores.expire-swaps',
  streaks: 'chores.streaks',
} as const;

export type ChoreJobName = (typeof CHORE_JOBS)[keyof typeof CHORE_JOBS];

/**
 * `JobPayloads` / `QUEUE_FOR_JOB` in `core/queue/queues.ts` carry no `chores.*`
 * entries yet, and that file is owned by the lead (module agents must not edit
 * `src/core/**`). Declaration-merging the interface is not an option either: it
 * would make the `Record<JobName, QueueName>` literal in that file incomplete
 * and break its own typecheck.
 *
 * So registration goes through **one** narrowly typed adapter instead of an
 * `any` at each call site. Runtime behaviour is identical — the worker registry
 * is a `Map` keyed by the raw job name string. Once the lead adds the two names
 * to `JobPayloads`, `QUEUE_FOR_JOB` and the `REPEATABLE` schedule, this alias
 * can be deleted and the calls below will typecheck unchanged.
 */
const registerChoreJob = registerJobHandler as unknown as (
  name: ChoreJobName,
  handler: (payload: Record<string, never>, job: Job) => Promise<void>,
) => void;

let registered = false;

/**
 * Idempotent: `registerJobHandler` throws on a duplicate name, and this module
 * is imported both for its side effect (below) and, in tests, directly.
 */
export function registerChoreJobs(): void {
  if (registered) return;
  registered = true;

  registerChoreJob(CHORE_JOBS.expireSwaps, async () => {
    await runSwapExpiry(getDb());
  });

  registerChoreJob(CHORE_JOBS.streaks, async () => {
    await runStreakMaintenance(getDb());
  });
}

// Self-registering on import, matching `notifications.jobs.ts` and
// `events.jobs.ts`: `modules/jobs.ts` is a barrel of bare imports.
registerChoreJobs();
