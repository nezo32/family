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

## The frontend end-to-end suite

Playwright, in `frontend/e2e/`, against a **running stack**: a real backend, the
dev Postgres, and the built frontend served by `vite preview`. 88 tests over two
projects (`desktop-chrome`, `mobile-safari`).

```bash
# backend
BACKEND_PORT=3102 APP_PUBLIC_URL=http://localhost:5175 RATE_LIMIT_FACTOR=100 \
  npx tsx --env-file-if-exists=.env src/main.ts

# frontend
npx vite build
VITE_API_PROXY_TARGET=http://localhost:3102 npx vite preview --port 5175 --strictPort

# the suite
E2E_BASE_URL=http://localhost:5175 E2E_API_URL=http://localhost:5175 npx playwright test
```

Two things about that command are load-bearing:

- **`localhost`, never `127.0.0.1`.** They are different origins to CORS, and the
  allow-list is built from `APP_PUBLIC_URL`. Point the suite at the IP form and
  every POST comes back `403 Origin not allowed`.
- **`RATE_LIMIT_FACTOR=100`.** Without it the dev backend enforces the production
  limits — registration 5/hour/IP, login 10/15min/IP, refresh 60/min/IP — and a
  suite that signs in a few times per run exhausts them in minutes. The symptom
  is a wall of `429 RATE_LIMITED` from the fixtures, not from anything the tests
  assert. The factor is forced to 1 in production (`core/config.ts`), so raising
  it here weakens nothing that ships. If registration is rate-limited anyway,
  `ensureApprovedOwner` copies an earlier e2e owner's row into this run's email
  rather than fall back to sharing one account — the suite still runs, but the
  429 is telling you the backend was started without the factor.

### Two runs at once are fine — unlike the backend suite

Where the integration suite refuses to start a second run (the advisory lock
above), the end-to-end suite is designed for it: two agents, or a rerun started
before the first finished, can share one stack. Three things make that true.

**Each run gets its own owner account.** `helpers.ts` derives `RUN_ID` once per
`playwright test` invocation and registers `e2e-owner-<run id>@example.test`.
The id comes from `process.env.E2E_RUN_ID` if it is set, and is otherwise minted
the first time the value is read. That happens in the **runner** process, because
`playwright.config.ts` imports `RUN_ID`: Playwright evaluates the config in the
runner before forking any worker, and workers inherit its environment, so the
`??=` inside a worker only ever reads the value back. Set `E2E_RUN_ID` yourself
to pin a run (CI job id, say) or to make two invocations deliberately share an
account.

This matters because a *shared* account is where two runs collide. Refresh-token
reuse detection revokes a family the other run is still holding, and the
per-account login throttle (8 attempts / 15 min, `login-throttle.ts`) counts both
runs' sign-ins together. Both are correct behaviour; both surface as unrelated
tests failing with the login screen («С возвращением») in the snapshot, which
reads like a broken app rather than two harnesses fighting.

**Session files are keyed by run and by worker** —
`frontend/e2e/.auth/run-<run id>/worker-<n>.json` — so concurrent runs cannot
overwrite each other's saved session with one belonging to a different user.

**A worker's session is handed on, not replayed.** The app keeps its access
token in memory, so every test's fresh browser context posts `/api/auth/refresh`
on its first page load and rotates the cookie. If each test replayed the same
saved token, only the first would rotate; the rest would be answered out of the
20-second `REFRESH_GRACE_SECONDS` window, and the first test to start after that
window closed would be treated as reuse — killing the family and every test
after it in that worker. So `fixtures.ts` writes the context's cookies back
after each test and hands the next test the generation the last one produced.
One sign-in per worker covers a whole run, and the grace window stops being
load-bearing. A run of 44 tests in one worker leaves a single token family 32
generations long and no `reuse` rows.

One thing is still shared: `test-results/`. Playwright empties its output
directory when a run starts, so a second run launched mid-flight deletes the
first one's screenshots and traces — the tests are unaffected, but a failure you
wanted to look at comes back empty-handed. Pass `--output=<dir>` to one of the
runs when you care about the artefacts.

### Housekeeping

Every run leaves two kinds of litter — the account it signed in as, and the rows
its tests wrote — and `ensureApprovedOwner` collects both before it does anything
else. Every predicate is deliberately timid, because a wrong match deletes
another agent's fixtures out from under a live run, and both `users` and
`task_series` cascade.

**Accounts and state files — six hours.**

- users matching `e2e-owner-%@example.test`. Not the seeded family
  (`@example.com`, and the child with no email at all), not other suites'
  `@example.test` fixtures, and not the legacy fixed `e2e-owner@example.test`,
  which has no `-` after `owner` — a suite on the previous code may still use it.
- `e2e/.auth/run-*` directories untouched for six hours.

Six hours because these are inert: an extra `users` row slows nothing down and
hides no data, so the cutoff is set for safety rather than tidiness.

**Rows the specs write — thirty minutes.** These are *not* inert, and deleting the
account does not take them with it: the seeded family owns some of the same
data, and a task created through the UI outlives its creator. The tasks list
fetches `limit: 100`, so once ~125 `E2E дело` series had accumulated, the task
`deep.spec.ts › creating a task through the UI` had just created fell off the end
of the page and the test failed about one run in three — with nothing wrong in
the code it was exercising.

- `task_series` whose title starts with `E2E ` (occurrences cascade with them).
- `shopping_items` whose name ends in a 13-digit `Date.now()`. The seeded items
  are the bare words — `Молоко`, `Хлеб` — with no suffix, so they never match.

Thirty rather than six hundred minutes because these are what tips a capped list
over; and thirty rather than five because it is an order of magnitude beyond the
longest run measured here (2.1 minutes for a full suite, ~3.5 with
`--workers=1`), which leaves room for a run being stepped through under
`PWDEBUG` and cannot reach a concurrent one.

The patterns live in `SUITE_DEBRIS` in `e2e/helpers.ts`; add a row when a spec
starts writing something new. Keep them **ASCII** — they travel through a shell
into `docker exec psql`, and a Cyrillic literal that survives one machine's
console codepage can arrive mangled on another's. That fails safe, in that it
matches nothing, but it also silently stops collecting.

**Better still, do not create the litter.** The sweep is a safety net for a run
that dies mid-test; the create-flow test deletes its own task when it is done
(`forgetTaskSeries`), so a healthy run's footprint is zero rows. Note that no
assertion could have been written to survive the dirty database instead: every
one of those tasks is due today, so neither narrowing the date window nor
filtering the list gets under the `limit: 100`. Housekeeping is the fix, and
prevention is the cheaper half of it.

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
