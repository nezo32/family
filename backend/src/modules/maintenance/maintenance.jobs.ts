import { lt, sql } from 'drizzle-orm';

import { getDb } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { registerJobHandler } from '../../core/queue/workers.js';
import {
  deleteExpiredOAuthTransactions,
  deleteExpiredRefreshTokens,
} from '../identity/identity.repository.js';
import { activityLog } from '../wall/wall.schema.js';

/**
 * Cross-cutting housekeeping.
 *
 * These three sweeps were scheduled from day one but had no handler, and
 * `scheduleRepeatables` skipped them in silence — so `refresh_tokens`,
 * `oauth_transactions` and `activity_log` grew without bound on a box nobody
 * watches. The worker now refuses to skip a scheduled job quietly; this module
 * is what satisfies it.
 *
 * Owned by the lead because no single feature module owns "delete old rows".
 */

/**
 * How long the family feed keeps history.
 *
 * Long enough to answer "who deleted Grandma's birthday?" months later, which
 * is the whole reason the log exists, but not forever — it is an append-only
 * table on a self-hosted disk.
 */
const ACTIVITY_RETENTION_DAYS = 400;

export function registerMaintenanceJobs(): void {
  registerJobHandler('maintenance.prune-refresh-tokens', async () => {
    await deleteExpiredRefreshTokens(getDb());
    logger.debug('pruned expired refresh tokens');
  });

  registerJobHandler('maintenance.prune-oauth-transactions', async () => {
    // These carry a 10-minute TTL, so anything left is abandoned mid-flow.
    await deleteExpiredOAuthTransactions(getDb());
    logger.debug('pruned expired oauth transactions');
  });

  registerJobHandler('maintenance.prune-activity-log', async () => {
    const cutoff = new Date(Date.now() - ACTIVITY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const deleted = await getDb()
      .delete(activityLog)
      .where(lt(activityLog.createdAt, cutoff))
      .returning({ id: activityLog.id });

    if (deleted.length > 0) {
      logger.info(
        { deleted: deleted.length, retentionDays: ACTIVITY_RETENTION_DAYS },
        'pruned activity log',
      );
    }
  });
}

/**
 * A cheap liveness signal for the family's data. Not scheduled — exposed so an
 * operator can call it from a console when something looks wrong.
 */
export async function tableSizes(): Promise<Array<{ table: string; rows: number }>> {
  const rows = await getDb().execute<{ table: string; rows: number }>(sql`
    select relname as table, n_live_tup as rows
    from pg_stat_user_tables
    order by n_live_tup desc
    limit 20
  `);
  return [...rows];
}

registerMaintenanceJobs();
