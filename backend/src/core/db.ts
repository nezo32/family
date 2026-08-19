import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../db/schema.js';
import { getConfig } from './config.js';

/**
 * Postgres connection + Drizzle handle.
 *
 * `postgres.js` is used rather than `pg` because Drizzle's postgres-js driver
 * has the better prepared-statement story and no native build step, which keeps
 * the Alpine container small.
 */

export type Db = PostgresJsDatabase<typeof schema>;

/** A transaction handle. Services should accept `Db | Tx` so they compose. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything you can run a query on — a pool handle or an open transaction. */
export type Executor = Db | Tx;

let sqlClient: postgres.Sql | undefined;
let dbInstance: Db | undefined;

export function createDbClient(url?: string): { sql: postgres.Sql; db: Db } {
  const config = getConfig();
  const sql = postgres(url ?? config.DATABASE_URL, {
    max: config.DATABASE_POOL_MAX,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    // Dates come back as JS Date objects in UTC; we never rely on the server's
    // session timezone for correctness (see D2).
    transform: { undefined: null },
    onnotice: () => {},
  });

  return { sql, db: drizzle(sql, { schema, casing: 'snake_case' }) };
}

export function getDb(): Db {
  if (!dbInstance) {
    const created = createDbClient();
    sqlClient = created.sql;
    dbInstance = created.db;
  }
  return dbInstance;
}

export function getSqlClient(): postgres.Sql {
  if (!sqlClient) getDb();
  // `getDb()` always assigns both together.
  return sqlClient as postgres.Sql;
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = undefined;
    dbInstance = undefined;
  }
}

/** Liveness probe used by `/ready`. */
export async function pingDb(): Promise<boolean> {
  try {
    await getSqlClient()`select 1`;
    return true;
  } catch {
    return false;
  }
}
