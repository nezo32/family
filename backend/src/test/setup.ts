import { beforeAll } from 'vitest';

import { installTemporal } from '../core/temporal.js';
import { installEnvLeakGuard } from './env-guard.js';

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

/**
 * Pointed at the test database **here**, not only in `src/test/db.ts`.
 *
 * `db.ts` assigns `DATABASE_URL := TEST_DATABASE_URL` at its own module scope,
 * which is after this file has run — so with an ambient `DATABASE_URL` in the
 * shell the two disagreed, and the per-file environment guard below correctly
 * reported the first DB-backed file as having changed the process. Deciding it
 * once, in the one place that runs before every test file, makes `db.ts`'s
 * assignment a value-identical no-op and keeps the baseline honest.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://family:family@localhost:5432/family_test';

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

/**
 * The bootstrap owner is a production affordance, and it has to be *absent*.
 *
 * `BOOTSTRAP_OWNER_EMAIL` narrows auto-approval to one address, so with it set
 * the harness's randomly-addressed first registration comes back
 * `pending_approval` carrying no session, and `createOwner()` throws for every
 * DB-backed suite at once — 147 tests across 14 files, every one of them
 * reading like an authentication regression.
 *
 * Assigned, not defaulted with `??=`: overruling an ambient value is the entire
 * point. `backend/.env` carries one, and although `vitest` never reads `.env`
 * (only `dev`, `db:migrate` and `db:seed` pass `--env-file-if-exists`),
 * anything that exports it into the shell first — a wrapper script, a
 * compose-based runner — would otherwise take the suite down.
 *
 * The provider credentials are deliberately **not** pinned here.
 * `notifications.test.ts` needs a real-looking `TELEGRAM_BOT_TOKEN` and sets
 * one with `??=`, which an empty pin would silently defeat; the suite that
 * needs them absent — `oauth route plugin` in `oauth/oauth.test.ts` — clears
 * them for its own duration instead.
 */
process.env.BOOTSTRAP_OWNER_EMAIL = '';

/**
 * Object storage for the avatar suite.
 *
 * Gated on `TEST_S3_ENDPOINT` being offered explicitly, exactly like
 * `TEST_DATABASE_URL`: with it unset, `config.storage.enabled` stays false, the
 * app boots without an S3 client and `avatar.integration.test.ts` skips itself.
 * It has to be done **here** rather than in the test file, because `getApp()`
 * builds one app for the whole run and `getConfig()` memoizes on its first
 * call — whichever suite happens to run first would otherwise freeze a config
 * with no storage in it.
 */
if (process.env.TEST_S3_ENDPOINT) {
  process.env.S3_ENDPOINT ??= process.env.TEST_S3_ENDPOINT;
  process.env.S3_ACCESS_KEY_ID ??= process.env.TEST_S3_ACCESS_KEY_ID ?? 'family';
  process.env.S3_SECRET_ACCESS_KEY ??= process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'familysecret';
  process.env.S3_BUCKET ??= process.env.TEST_S3_BUCKET ?? 'family-media-test';
}

process.env.ENABLE_WORKERS ??= 'false';
process.env.ENABLE_SWAGGER ??= 'false';
// `silent` is a valid pino level but NOT a member of the LOG_LEVEL enum in
// `core/config.ts`, so it made `loadConfig()` throw and any test importing
// `core/logger.js` fail at import time. Silencing in tests is handled by
// `buildLoggerOptions()` itself (`config.isTest` forces level `silent`).
process.env.LOG_LEVEL ??= 'fatal';

/**
 * `process.env` is shared by the whole run — see `env-guard.ts` for why, and for
 * what to do when a variable is genuinely meant to be process-wide (answer: set
 * it in this file, above).
 */
installEnvLeakGuard();

beforeAll(async () => {
  await installTemporal();
});
