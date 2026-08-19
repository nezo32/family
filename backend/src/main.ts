import { installTemporal, assertTimeZoneDataIsUsable } from './core/temporal.js';

// Temporal must exist before any module that does wall-clock arithmetic loads.
await installTemporal();
assertTimeZoneDataIsUsable();

const { default: closeWithGrace } = await import('close-with-grace');
const { buildApp } = await import('./app.js');
const { getConfig } = await import('./core/config.js');
const { closeDb } = await import('./core/db.js');
const { closeRedis } = await import('./core/redis.js');
const { logger } = await import('./core/logger.js');

const config = getConfig();

if (config.RUN_MIGRATIONS_ON_BOOT) {
  const { runMigrations } = await import('./db/migrate.js');
  await runMigrations();
}

const app = await buildApp();

let stopWorkers: (() => Promise<void>) | undefined;
if (config.ENABLE_WORKERS) {
  // Handlers register themselves on import, so this must precede startWorkers()
  // or every enqueued job would fail with "no handler registered".
  const { registerAllJobHandlers } = await import('./modules/jobs.js');
  await registerAllJobHandlers();

  const { startWorkers } = await import('./core/queue/workers.js');
  stopWorkers = await startWorkers();
}

closeWithGrace({ delay: 10_000 }, async ({ err, signal }) => {
  if (err) logger.error({ err }, 'shutting down after an unhandled error');
  else logger.info({ signal }, 'shutting down');

  // Stop accepting work, drain in-flight requests, then release resources.
  await app.close();
  if (stopWorkers) await stopWorkers();
  await closeRedis();
  await closeDb();
});

try {
  await app.listen({ host: config.HOST, port: config.BACKEND_PORT });
  logger.info(
    { port: config.BACKEND_PORT, env: config.NODE_ENV, docs: config.ENABLE_SWAGGER },
    'family api listening',
  );
} catch (err) {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
}
