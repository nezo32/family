# Testing

Two suites live in one Vitest run.

| suite | needs | runs by default |
|---|---|---|
| **unit** — pure functions, fake repositories, `app.inject()` without a database | nothing | yes |
| **integration** — the real app against a real Postgres and Redis | Docker | only when `TEST_DATABASE_URL` is set |

Every DB-backed block is wrapped in `describe.skipIf(!process.env.TEST_DATABASE_URL)`,
so `pnpm test` on a laptop with no Docker still passes — it just skips the
integration half. Nothing is silently green: the skipped tests are reported as
skipped.

---

## Running the unit suite

```bash
pnpm --filter @family/backend test
```

No services, no environment. `src/test/setup.ts` pins `NODE_ENV=test`,
`TZ=Europe/Moscow` and a set of throwaway secrets so a test never depends on the
developer's shell.

---

## Running the integration suite

### 1. Start the backing services

```bash
docker compose -f infra/docker-compose.dev.yml --env-file .env up -d
```

Both are bound to loopback: `127.0.0.1:5432` (Postgres) and `127.0.0.1:6379`
(Redis, `--requirepass family`).

### 2. Create the test database — once

Use a **separate** database. The suite truncates every table between tests, so
pointing it at the dev database would destroy your seed data.

```bash
docker exec family-dev-postgres-1 psql -U family -d postgres -c "create database family_test"
```

### 3. Apply the migrations to it

```bash
cd backend
DATABASE_URL=postgres://family:family@127.0.0.1:5432/family_test pnpm run db:migrate
```

Re-run this after every new migration; the test database is not migrated
automatically.

### 4. Run

```bash
cd backend
TEST_DATABASE_URL=postgres://family:family@127.0.0.1:5432/family_test pnpm test
```

Or a single file:

```bash
TEST_DATABASE_URL=postgres://family:family@127.0.0.1:5432/family_test \
  npx vitest run src/modules/identity/auth-lifecycle.integration.test.ts
```

### Object storage

The avatar suite needs a real S3-compatible endpoint and **skips itself
silently** without one, so the whole upload path ships unexercised unless you
offer it:

```bash
TEST_DATABASE_URL=postgres://family:family@127.0.0.1:5432/family_test \
  TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
  TEST_S3_ACCESS_KEY_ID=family TEST_S3_SECRET_ACCESS_KEY=familysecret \
  npx vitest run
```

With it set the run is 959 tests and nothing is skipped; without it, 945 and 14
skips. `infra/scripts/verify-all.sh` always passes it.

### Only one integration run at a time

The DB-backed suites share `family_test` and truncate it between tests, so two
runs at once destroy each other's fixtures. `src/test/global-setup.ts` takes a
Postgres advisory lock for the duration of a run and a second run refuses to
start:

```
Another integration run already holds the test database.
```

That message replaced a much worse failure mode: ~50 foreign-key violations and
"User no longer exists" scattered across unrelated modules, which reads exactly
like a regression in whatever you just changed. It sent three separate
investigations chasing defects that did not exist. Nothing leaks — Postgres
drops the lock when the connection closes, so a crashed run blocks nothing.

To genuinely run two at once, give the second its own database:

```bash
TEST_DATABASE_URL=postgres://family:family@127.0.0.1:5432/family_test_2 npx vitest run
```

There is no `test:integration` script in `backend/package.json` yet. If you want
one:

```json
"test:integration": "TEST_DATABASE_URL=postgres://family:family@127.0.0.1:5432/family_test vitest run"
```

(on Windows, prefix with `cross-env` or export the variable first).

---

## Environment the suite sets for itself

`src/test/db.ts` runs at import time, before `core/config.ts` parses anything,
and does two things:

- **`DATABASE_URL := TEST_DATABASE_URL`.** The app's `getDb()` is a process-wide
  singleton; without this the fixtures and the request under test would talk to
  two different databases.
- **`REDIS_URL := TEST_REDIS_URL ?? redis://:family@127.0.0.1:6379/1`.** Redis is
  not optional for an integration run. `core/plugins/security.ts` registers
  `@fastify/rate-limit` globally with a Redis store and no `skipOnError`, so an
  unreachable Redis turns **every** request into a 500; and `flushIntents` in
  `goals.service.ts` hangs forever rather than failing, because BullMQ's
  connections use `maxRetriesPerRequest: null` and queue commands instead of
  rejecting them. `src/test/setup.ts` defaults `REDIS_URL` to a password-less
  URL, which the dev stack rejects with `NOAUTH`; this override fixes that.

Set `TEST_REDIS_URL` if your Redis is elsewhere.

---

## How isolation works

`resetDatabase()` (in `src/test/harness.ts`, called from `beforeEach`) does two
things:

1. `TRUNCATE <every public table> RESTART IDENTITY CASCADE` — one statement, so
   the FK graph never has to be topologically ordered and a new module's table is
   picked up automatically. The drizzle migration journal is preserved.
2. Deletes the `rl:*` keys from Redis. `@fastify/rate-limit` keeps its counters
   there, and they survive both a truncate and a process restart — without this
   the *second* run of the suite would hit the registration limit (5/hour) while
   building fixtures and fail for a reason unrelated to what it tests.

Fixtures never depend on the dev seed or on any fixed id. `createOwner()`
registers the bootstrap owner into an empty family; `createMember()` registers,
has the owner approve at a role, and logs in — the real journey, not a row
insert. Each fixture request carries a distinct `X-Forwarded-For` so per-IP rate
limits do not bleed between fixtures (`buildApp()` sets `trustProxy: true`).

The Fastify app is built **once per worker** and shared; `vitest.config.ts` pins
`poolOptions.forks.singleFork`, so there is exactly one app, one connection pool
and one Redis client for the whole run. Isolation comes from the truncate, not
from rebuilding the app.

---

## Where the tests live

| file | covers |
|---|---|
| `src/test/db.ts` | test-database wiring, `truncateAll()` |
| `src/test/harness.ts` | app lifecycle, `request()`, role fixtures |
| `src/modules/identity/auth-lifecycle.integration.test.ts` | register → approve → login → refresh → logout, concurrent approval, suspension, refresh rotation under concurrency, reuse detection |
| `src/modules/identity/permissions.integration.test.ts` | the role matrix through the real router, 404-vs-403, escalation guards |
| `src/modules/goals/money.integration.test.ts` | balance ≡ ledger sum, idempotent `clientId`, row-lock serialisation, bigint precision |
| `src/modules/tasks/recurrence.integration.test.ts` | materialization, idempotency, completion counted once, `this_and_future` split, rotation fairness |
| `src/modules/events/ics-feed.integration.test.ts` | ICS document validity, ETag/304, feed-token rotation and revocation |
| `src/modules/notifications/fanout.integration.test.ts` | fan-out per preference, quiet-hours deferral, ack idempotency |
| `src/core/queue/queues.integration.test.ts` | the BullMQ `jobId` contract |

Existing module suites (`*.test.ts`) also contain DB-gated blocks; they run
under the same `TEST_DATABASE_URL`.

---

## Tests that are expected to fail

Some integration tests are marked **`KNOWN FAILURE — documents a real bug, do
not relax`** in a comment above them. They assert the behaviour the code is
supposed to have and fail against the behaviour it currently has. Do not weaken
the assertion to make the suite green — fix the code, then the test passes and
the comment comes out.

Each one names the file and line of the defect it pins down.
