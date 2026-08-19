import type postgres from 'postgres';

import type { Db } from '../core/db.js';

/**
 * The database seam for integration tests.
 *
 * Everything DB-backed reads `TEST_DATABASE_URL` and skips itself when it is
 * absent, so `pnpm test` stays runnable without Docker. See `docs/TESTING.md`.
 *
 * Two rules make the suite rerunnable:
 *
 * 1. `DATABASE_URL` is pointed at the test database **before** `core/config.ts`
 *    is ever parsed, so the process-wide `getDb()` — which is what `buildApp()`
 *    and every route uses — lands on the same database the fixtures write to.
 *    There is no second connection pool and no "which db am I on" ambiguity.
 * 2. `truncateAll()` wipes every table except `drizzle`'s migration bookkeeping,
 *    so a rerun starts from the same empty state as the first run. Nothing here
 *    depends on the dev seed.
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** `describe.skipIf(!hasTestDb)` — the guard every DB-backed suite uses. */
export const hasTestDb = Boolean(TEST_DATABASE_URL);

/**
 * Point the whole process at the test database.
 *
 * Must run before anything imports `core/config.js`, which memoizes the parsed
 * environment on first use. Calling it at module scope of a test file (i.e.
 * during collection, before `beforeAll`) is the reliable way to get that
 * ordering, because Vitest hoists imports above `beforeAll` bodies.
 */
export function useTestDatabaseUrl(): void {
  if (!TEST_DATABASE_URL) return;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  /**
   * Redis is not optional for an integration run.
   *
   * `core/plugins/security.ts` registers `@fastify/rate-limit` globally with a
   * Redis store and **without** `skipOnError`, so an unreachable Redis turns
   * every single request into a 500 — and `flushIntents` in the goals service
   * hangs forever rather than failing, because BullMQ's connections use
   * `maxRetriesPerRequest: null`.
   *
   * `src/test/setup.ts` defaults `REDIS_URL` to a password-less local URL, which
   * the dev stack (`infra/docker-compose.dev.yml`, `--requirepass family`)
   * rejects with `NOAUTH`. Override it here with the dev credentials unless the
   * runner names one explicitly through `TEST_REDIS_URL`.
   */
  process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://:family@127.0.0.1:6379/1';
}

useTestDatabaseUrl();

let sqlClient: postgres.Sql | undefined;
let dbHandle: Db | undefined;

/**
 * The shared connection.
 *
 * Deliberately the *same* handle `getDb()` returns, so a fixture insert and the
 * request under test see one another without a transaction-visibility puzzle.
 */
export async function getTestDb(): Promise<Db> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  if (!dbHandle) {
    const { getDb, getSqlClient } = await import('../core/db.js');
    dbHandle = getDb();
    sqlClient = getSqlClient();
  }
  return dbHandle;
}

/** Raw `postgres.js` handle, for truncation and for assertions in plain SQL. */
export async function getTestSql(): Promise<postgres.Sql> {
  await getTestDb();
  return sqlClient as postgres.Sql;
}

export async function closeTestDb(): Promise<void> {
  const { closeDb } = await import('../core/db.js');
  await closeDb();
  sqlClient = undefined;
  dbHandle = undefined;
}

/**
 * Tables that must survive a wipe: drizzle's migration journal.
 *
 * Everything else is derived state and gets truncated. `RESTART IDENTITY
 * CASCADE` in one statement means the FK graph never has to be topologically
 * sorted here — a job that would silently rot the first time a module adds a
 * table.
 */
const KEEP = new Set(['__drizzle_migrations']);

let cachedTables: string[] | undefined;

async function listTables(): Promise<string[]> {
  if (cachedTables) return cachedTables;
  const sql = await getTestSql();
  const rows = await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public'
  `;
  cachedTables = rows.map((r) => r.tablename).filter((t) => !KEEP.has(t));
  return cachedTables;
}

/**
 * Wipe every table.
 *
 * One `TRUNCATE ... CASCADE` for the whole schema: faster than per-table
 * deletes, and immune to insertion-order bugs. Call it in `beforeEach` (or at
 * least `beforeAll`) of any suite that asserts on counts.
 */
export async function truncateAll(): Promise<void> {
  const sql = await getTestSql();
  const tables = await listTables();
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t}"`).join(', ');
  await sql.unsafe(`truncate table ${list} restart identity cascade`);
}
