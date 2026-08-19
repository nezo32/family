import { beforeAll } from 'vitest';

import { installTemporal } from '../core/temporal.js';

/**
 * Global test setup.
 *
 * Provides a deterministic environment so unit tests never depend on the
 * developer's shell. Integration tests that need a real database read
 * `TEST_DATABASE_URL` (see `src/test/db.ts`) and skip themselves when it is
 * absent, so `pnpm test` stays runnable without Docker.
 */

process.env.NODE_ENV = 'test';
process.env.TZ = 'Europe/Moscow';

process.env.DATABASE_URL ??= 'postgres://family:family@localhost:5432/family_test';

/**
 * Redis for the DB-backed half of the suite.
 *
 * The dev stack runs `redis-server --requirepass family`, so a password-less URL
 * fails authentication — and the failure mode is a **hang**, not an error: the
 * BullMQ connections use `maxRetriesPerRequest: null`, which queues a command
 * until the connection recovers instead of rejecting it. A DB-gated test that
 * writes a notification intent then sits there until Vitest's timeout, with no
 * indication that Redis was ever involved.
 *
 * Defaulted only when `TEST_DATABASE_URL` is present, so the pure unit run keeps
 * its inert placeholder and still opens no socket. Override with
 * `TEST_REDIS_URL` if your Redis is elsewhere.
 */
process.env.REDIS_URL ??= process.env.TEST_DATABASE_URL
  ? (process.env.TEST_REDIS_URL ?? 'redis://:family@127.0.0.1:6379/1')
  : 'redis://localhost:6379/1';
process.env.APP_PUBLIC_URL ??= 'http://localhost:5173';

const TEST_SECRET = 'test-secret-value-that-is-definitely-long-enough-000000';
process.env.JWT_ACCESS_SECRET ??= TEST_SECRET;
process.env.JWT_REFRESH_SECRET ??= TEST_SECRET;
process.env.COOKIE_SECRET ??= TEST_SECRET;
process.env.ENCRYPTION_KEY ??= TEST_SECRET;

process.env.ENABLE_WORKERS ??= 'false';
process.env.ENABLE_SWAGGER ??= 'false';
// `silent` is a valid pino level but NOT a member of the LOG_LEVEL enum in
// `core/config.ts`, so it made `loadConfig()` throw and any test importing
// `core/logger.js` fail at import time. Silencing in tests is handled by
// `buildLoggerOptions()` itself (`config.isTest` forces level `silent`).
process.env.LOG_LEVEL ??= 'fatal';

beforeAll(async () => {
  await installTemporal();
});
