import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { closeDb, createDbClient } from '../core/db.js';
import { logger } from '../core/logger.js';
import { pathToFileURL } from 'node:url';

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
// Hand-building a `file://` string gets the slash count wrong on Windows
// (`file://E:/...` vs the real `file:///E:/...`), so this guard silently never
// fired and the script exited having done nothing. Let Node do the conversion.
const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  try {
    await runMigrations();
    await closeDb();
    process.exit(0);
  } catch (err) {
    logger.fatal({ err }, 'migration failed');
    process.exit(1);
  }
}
