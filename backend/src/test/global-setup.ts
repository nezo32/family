import postgres from 'postgres';

/**
 * Refuses to start a second integration run against the same database.
 *
 * The DB-backed suites share one `family_test` database and truncate it between
 * tests, so two runs at once destroy each other's fixtures. The symptom is
 * ~50 failures spread across unrelated modules — foreign-key violations and
 * "User no longer exists" — which reads exactly like a real regression in
 * whatever you just changed. It has already sent three separate investigations
 * chasing defects that were never there.
 *
 * A session-scoped advisory lock turns that into one clear sentence. Nothing
 * can leak: Postgres drops the lock when the connection closes, so a crashed
 * run leaves nothing behind for the next one to trip over.
 *
 * Runs once per `vitest` invocation (`pool: forks` + `singleFork`), not per
 * file.
 */

/** Arbitrary but stable pair; namespaced so it cannot collide with app locks. */
const LOCK_NAMESPACE = 0x66_61_6d_00 | 0; // "fam\0"
const LOCK_ID = 1;

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return undefined;

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  const [row] = await sql<{ locked: boolean }[]>`
    select pg_try_advisory_lock(${LOCK_NAMESPACE}, ${LOCK_ID}) as locked
  `;

  if (!row?.locked) {
    await sql.end({ timeout: 5 });
    throw new Error(
      'Another integration run already holds the test database.\n' +
        'Wait for it to finish, or point this run elsewhere with ' +
        'TEST_DATABASE_URL=postgres://family:family@127.0.0.1:5432/family_test_2.\n' +
        'Running two at once truncates one run out from under the other and ' +
        'produces dozens of unrelated-looking foreign-key failures.',
    );
  }

  return async () => {
    await sql`select pg_advisory_unlock(${LOCK_NAMESPACE}, ${LOCK_ID})`;
    await sql.end({ timeout: 5 });
  };
}
