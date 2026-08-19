import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { closeDb, createDbClient } from '../core/db.js';
import { logger } from '../core/logger.js';

/**
 * Applies pending SQL migrations from `drizzle/`.
 *
 * Run as a one-shot container step before the API starts (see the deploy
 * workflow), or in-process on boot when `RUN_MIGRATIONS_ON_BOOT=true`, which is
 * convenient for a single-node self-hosted install.
 */
export async function runMigrations(): Promise<void> {
  const { sql, db } = createDbClient();
  try {
    logger.info('running migrations');
    await migrate(db, { migrationsFolder: 'drizzle' });
    logger.info('migrations applied');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Executed directly: `pnpm --filter @family/backend run db:migrate`
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  try {
    await runMigrations();
    await closeDb();
    process.exit(0);
  } catch (err) {
    logger.fatal({ err }, 'migration failed');
    process.exit(1);
  }
}
