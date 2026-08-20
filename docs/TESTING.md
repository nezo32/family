# Testing

Two suites live in one Vitest run.

| suite                                                                           | needs   | runs by default                      |
| ------------------------------------------------------------------------------- | ------- | ------------------------------------ |
| **unit** — pure functions, fake repositories, `app.inject()` without a database | nothing | yes                                  |
| **integration** — the real app against a real Postgres and Redis                | Docker  | only when `TEST_DATABASE_URL` is set |

Every DB-backed block is wrapped in `describe.skipIf(!process.env.TEST_DATABASE_URL)`,
so `pnpm test` on a laptop with no Docker still passes — it just skips the
integration half. Nothing is silently green: the skipped tests are reported as
skipped.

---

## "Will CI pass?" — answered before pushing

```bash
make verify-ci          # or: pnpm run verify:ci, or: bash infra/scripts/verify-ci.sh
```

`infra/scripts/verify-ci.sh` runs **the same commands as
`.github/workflows/ci.yml`, in its jobs' order**, against the working tree. It
takes a few minutes and it answers "is the required `CI` check going to be
green". There are two scripts and they are not the same gate:

| script          | covers                                                                                                                                                                                               | when                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `verify-ci.sh`  | seven of the eight CI jobs: shared build, `pnpm -r run lint`, `format:check`, `typecheck`, backend `test:cov` (with object storage), frontend `test:cov`, `vite build`, the service-worker assertion | before pushing                      |
| `verify-all.sh` | the same ground plus the two things `verify-ci.sh` leaves out — the Playwright suite, which is CI's eighth job, and both Docker images at `--target build`, which are `docker.yml`'s                 | before calling a piece of work done |

The eighth CI job is `e2e`, and `verify-ci.sh` does not run it: `verify-all.sh`
already orchestrates a full stack and Playwright against it, and a second copy
of that here would double this script's runtime for coverage that already
exists. So — `verify-ci.sh` when you want to know quickly whether the push will
go red, `verify-all.sh` when you are finishing a piece of work.

### Run the CI command, not a local approximation of it

The script exists because of a repeated failure shape: a gate that passes
locally and fails in the place that counts. Three instances so far.

1. A path alias `tsc` accepted and the container could not resolve
   (`docs/CONVENTIONS.md` rule 6).
2. `playwright.config.ts` importing from `e2e/`, which `.dockerignore` withholds
   from the image build context (rule 7).
3. **`eslint .` versus `eslint src`.** Every local gate — `verify-all.sh`
   included — linted `src`. CI runs `pnpm -r run lint`, and each package's
   `lint` script is `eslint .`, which also covers `eslint.config.js`,
   `vitest.config.ts`, `drizzle.config.ts` and `e2e/`. `backend/eslint.config.js`
   was a hard parsing error under `eslint .` for as long as it had existed, and
   no local run could see it. It failed the `lint + format` job on every push.

The cause of (3) is worth knowing, because it will recur the next time a `.js`
file is added to a package whose ESLint config is type-aware. The backend preset
is `recommendedTypeChecked` with `projectService: true`, so the parser demands a
TypeScript program containing every file it lints. `backend/tsconfig.json` listed
`eslint.config.js` in `include` — but `allowJs` is off, so a `.js` path in
`include` is dropped from the program silently, and the project service then
reports `was not found by the project service`. The fix is the `**/*.js` block at
the end of `backend/eslint.config.js`, which drops type-aware linting for JS.
That block must stay **after** the one that sets `projectService`: flat config is
last-match-wins.

### `format:check` and line endings

`.prettierrc` sets `endOfLine: lf` and `.gitattributes` sets `* text=auto
eol=lf`, so a CI checkout is always LF and the literal `pnpm run format:check` is
right there. On a Windows working tree it is not: anything an editor or an agent
wrote lands as CRLF and the literal command reports several hundred files. That
number is noise, and treating it as noise is how **106 genuinely misformatted
files** stayed invisible — including files that had been flagged and skipped over
by three separate agents as "pre-existing deviations".

`verify-ci.sh` therefore runs the check with `--end-of-line auto`. Because
`text=auto` normalises to LF in the index, no file can reach CI with CRLF
whatever the working tree holds — so ignoring line endings locally is the same
check as CI's, with a platform artefact removed, not a weaker one. Pass
`VERIFY_CI_STRICT_EOL=1` to run the literal command.

To reproduce CI's view faithfully by hand instead, check out into a fresh
directory, which yields LF:

```bash
git worktree add ../family-ci main --detach
cd ../family-ci && pnpm install --frozen-lockfile
```

### What CI runs, and the one thing it does not

`ci.yml` has eight jobs: `setup`, `lint`, `typecheck`, `test-backend`,
`test-frontend`, `build-frontend`, `e2e`, and the `ci` aggregate that the branch
protection rule points at. Every suite in this document runs in one of them.

- **The backend suite runs whole.** The `test-backend` job provides Postgres,
  Redis **and** a RustFS service container, so the object-storage suite is
  exercised rather than skipped: 1040 tests, none skipped. See "Object storage".
- **Playwright runs.** The `e2e` job builds the frontend, starts a real API and
  a `vite preview` in front of it, and drives all 95 tests over both browser
  projects. It is slower than the other jobs (~1 worker, 2 retries) and it is
  part of the required check, on pull requests as well as pushes — a gate that
  does not run where merges happen cannot stop anything.
- **The Docker images are the exception.** They live in
  `.github/workflows/docker.yml`, a separate workflow that runs on push to
  `main` and builds both images in full. `verify-all.sh` builds their `build`
  stage locally; `verify-ci.sh` does not.

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

With it set the run is 1040 tests and nothing is skipped; without it, 1026 pass
and 14 skip — one whole test file. `infra/scripts/verify-all.sh` always passes
it.

**CI runs it too.** The `test-backend` job in `.github/workflows/ci.yml` has a
`rustfs` service container beside Postgres and Redis, and passes the same four
`TEST_S3_*` variables, so a push exercises all 1040 tests. Before that service
existed the job was green having run 1026 of them, with `s3.adapter.ts` at 17%
coverage, `storage.service.ts` at 10% and `storage.repository.ts` at 5% — on the
code path that handles user-uploaded files.

RustFS rather than MinIO for a mechanical reason: a GitHub `services:` entry can
pass environment variables and docker-create options but **never a `command:`**,
and MinIO needs `server /data`. RustFS takes all of its configuration from the
environment, needs no volume for a single job, and the suite creates its own
bucket. The job also does a `curl` against the health endpoint before running
the tests — a service container that is healthy on its own network but not
reachable on the mapped port would otherwise put the suite straight back to
skipping itself, silently, behind a green tick.

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

### It runs in CI, and one detail keeps it there

`.github/workflows/ci.yml` has an `e2e` job that does exactly what the three
commands above do: start the backing services, migrate, seed, `vite build`,
start the API and a `vite preview` in front of it, then run the suite. It is a
transcription of `infra/scripts/verify-all.sh`, and the two should be changed
together rather than allowed to drift.

Three things in that job are load-bearing, and all three are the lessons above
written as YAML:

- **It brings the services up with `docker compose -f
infra/docker-compose.dev.yml`, not with a `services:` block.** `helpers.ts`
  sweeps its debris by shelling out to `docker exec family-dev-postgres-1 psql
-U family -d family`, and that container name is the one the dev compose
  project produces. A GitHub service container is named by the runner and
  cannot be renamed, so the sweep would die on "no such container". The
  alternative — teaching `e2e/` to find the database some other way — is
  editing the suite to suit CI, which is how a local gate and a CI gate start
  drifting apart. **If you change how `helpers.ts` reaches the database, that
  job changes with it.**
- **`RATE_LIMIT_FACTOR=100`,** for the reason in the previous section.
- **`NODE_ENV` is not set.** A job-level `NODE_ENV=development` reaches every
  step, and `vite build` then emits the React development bundle — 940 KB
  against 695 KB, measured — so the suite would be exercising a bundle no user
  receives. `core/config.ts` already defaults NODE_ENV to `development`, which
  is what keeps `RATE_LIMIT_FACTOR` from being forced back to 1, so the backend
  needs nothing set either.

The job uploads `playwright-report/` and `test-results/` as an artifact on every
run, and tails the API log on failure — a failing spec is usually a failing
request, and the reason for it is in the server log rather than in the trace.

### Two runs at once are fine — unlike the backend suite

Where the integration suite refuses to start a second run (the advisory lock
above), the end-to-end suite is designed for it: two agents, or a rerun started
before the first finished, can share one stack. Three things make that true.

**Each run gets its own owner account.** `playwright.config.ts` mints `RUN_ID`
once per `playwright test` invocation and publishes it as `process.env.E2E_RUN_ID`;
`helpers.ts` reads it back and registers `e2e-owner-<run id>@example.test`. The
seeding happens in the **runner** process because Playwright evaluates the config
there before forking any worker, and workers inherit the runner's environment —
so the `??=` in a worker, and the one in `helpers.ts`, only ever read the value
back. Set `E2E_RUN_ID` yourself to pin a run (CI job id, say) or to make two
invocations deliberately share an account.

This matters because a _shared_ account is where two runs collide. Refresh-token
reuse detection revokes a family the other run is still holding, and the
per-account login throttle (8 attempts / 15 min, `login-throttle.ts`) counts both
runs' sign-ins together. Both are correct behaviour; both surface as unrelated
tests failing with the login screen («С возвращением») in the snapshot, which
reads like a broken app rather than two harnesses fighting.

The direction of that dependency is load-bearing and was learned the hard way.
It used to run the other way — `playwright.config.ts` imported `RUN_ID` from
`e2e/helpers.ts` — which is tidier and broke the production frontend image:
`frontend/tsconfig.node.json` typechecks the config, `.dockerignore` excludes
`**/e2e` from the build context on purpose, and `tsc -b` inside the container
died with `TS2307: Cannot find module './e2e/helpers'` after three green
`verify-all.sh` runs. **Nothing the build typechecks may import anything under
`e2e/`** (hard rule 7 in `docs/CONVENTIONS.md`). If the specs and the config
need to share a value, the config owns it and `e2e/` reads it back.

`helpers.ts` still mints its own id when `E2E_RUN_ID` is unset — that is not
dead code, it is the path for anything that imports the helpers without a
Playwright config in sight (a `tsx`/`vitest` script poking at
`ensureApprovedOwner`), which would otherwise register
`e2e-owner-undefined@example.test` and share one account with every other such
caller.

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

### The images are a gate too

`infra/scripts/verify-all.sh` builds `frontend/Dockerfile` and
`backend/Dockerfile` up to `--target build` on every run, by default.

It is there because the suites above all run against the **working tree** and
the images do not: `.dockerignore` withholds `**/e2e`, `**/dist`, `docs` and
`.env*` from the build context, so a file that compiles here can fail to
compile in the container. That is not hypothetical — see the `RUN_ID` note
above, which passed three consecutive green `verify-all.sh` runs and then held
a production deploy for forty minutes. CI builds the images on push, but that
is the wrong end of the loop.

`--target build` stops at the stage where `tsc` and `vite build` run, which is
where the whole class of failure lives, and skips the runtime stages. Both
builds are started in the background **before the first gate** and collected
after the frontend production build, so BuildKit runs them underneath the
backend integration suite and they add close to nothing to wall clock. Layer
caching means an unchanged dependency set replays instantly.

`SKIP_IMAGE_BUILDS=1` opts out, and the script also skips them with a warning
if `docker` is not on `PATH`. Reach for it only when you are offline; a flag
that is set by default is the state that let the last one through.

To reproduce a failure by hand:

```bash
docker build -f frontend/Dockerfile --target build -t family-frontend-probe .
docker build -f backend/Dockerfile  --target build -t family-backend-probe  .
```

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

**Rows the specs write — thirty minutes.** These are _not_ inert, and deleting the
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

### `process.env` is shared by the whole run — and it is guarded

`vitest.config.ts` pins `pool: 'forks'` with `singleFork: true`, so all 42 files
run in **one operating-system process**. Module state does not cross that
boundary — Vitest gives each file a fresh module registry, so `getConfig()`'s
memo is per-file — but `process.env` does. A file that writes a variable and
does not put it back reconfigures the application for every file after it.

Which files those are is decided by Vitest's sequencer, and it does not decide
the same way twice: it orders by **cached per-file durations**, falling back to
file size when `node_modules/.vite/vitest` is absent. A CI checkout is always
cold, so CI runs largest-first; a developer's tree is warm and runs a different
order entirely. A leak is therefore a coin flip that lands one way here and the
other way there.

That is not hypothetical. `notifications.test.ts` and `emission.test.ts` each
set `TELEGRAM_BOT_TOKEN` in a `vi.hoisted()` block and never restored it. Cold,
they sort ahead of `oauth.test.ts`; `config.oauth.telegram.enabled` is just
`Boolean(TELEGRAM_BOT_TOKEN)`, so the leaked token switched the provider on, the
503 preflight was skipped, the callback took the replay branch and the run died
on `expected null to be 'SERVICE_UNAVAILABLE'` — in a file nobody had touched,
green on every developer machine.

**`src/test/env-guard.ts` closes that class.** It snapshots `process.env` while
the setup file is still evaluating — before the test file is imported, which is
the only moment earlier than a `vi.hoisted()` block — and diffs it in an
`afterAll`. If anything differs it restores the snapshot, calls
`resetConfigForTests()`, and **fails the file**, naming it and every variable it
left behind:

```
FAIL src/modules/notifications/zz-example.test.ts
Error: This test file changed process.env and did not put it back:
  - TELEGRAM_BOT_TOKEN: (unset) -> "123456:deliberate-leak"
```

Restoring as well as reporting is deliberate: without it one leak produces a
failure in the guilty file _plus_ a cascade in innocent ones, and the loudest
output is the least informative. With it there is exactly one failure and it
points at the cause.

Two things about that mechanism are load-bearing:

- **`sequence: { hooks: 'stack' }` in `vitest.config.ts`.** That is Vitest's
  default, pinned explicitly. Setup-file hooks are registered first, and only
  `stack` unwinds `afterAll` in reverse registration order — so the guard runs
  _after_ a file's own teardown. Under `parallel` or `list` it runs before, and
  reports leaks that were about to be cleaned up.
- **Restoring the variable is only half of it.** `getConfig()` memoizes, so
  putting `TELEGRAM_BOT_TOKEN` back while leaving the parsed config in place is
  the same bug wearing a different hat. Always pair the restore with
  `resetConfigForTests()`.

**If your file needs a variable**, save it, set it, and put it back — the
pattern in `src/modules/identity/oauth/oauth-callback.integration.test.ts`, and
in the `vi.hoisted()` blocks of the two notifications files for the case where
the write has to happen above the imports.

**If a variable is genuinely meant to be process-wide**, declare it in
`src/test/setup.ts`. That runs before the snapshot is taken for every file, so
it becomes part of the baseline instead of a diff against it. `DATABASE_URL`,
`REDIS_URL` and the throwaway secrets live there for exactly this reason —
`DATABASE_URL` was moved to prefer `TEST_DATABASE_URL` there rather than only in
`src/test/db.ts`, whose module-scope assignment runs later and disagreed with the
baseline whenever the shell exported one. Do not add an ignore list to the guard;
a variable everyone needs to see belongs where everyone can see it declared.

**Pinning the value globally is not a fix, and was tried.** `enabled` is
`Boolean(<token>)` for every provider, so setting `TELEGRAM_BOT_TOKEN=''` in
`setup.ts` up front stops the `??=` in `notifications.test.ts` from firing at all
and breaks its D11 arrival-receipt test. Those files genuinely need the value;
it just must not escape them.

### Reproducing CI's file order

```bash
cd backend
rm -rf node_modules/.vite/vitest    # what a fresh CI checkout has
npx vitest run
```

Run it both ways — cold and warm — after touching anything that reads
configuration. The sequencer's cold fallback is by _file size_, which is not a
stable contract, so the guard rather than the ordering is what actually keeps
the two environments agreeing.

---

## How isolation works

`resetDatabase()` (in `src/test/harness.ts`, called from `beforeEach`) does two
things:

1. `TRUNCATE <every public table> RESTART IDENTITY CASCADE` — one statement, so
   the FK graph never has to be topologically ordered and a new module's table is
   picked up automatically. The drizzle migration journal is preserved.
2. Deletes the `rl:*` keys from Redis. `@fastify/rate-limit` keeps its counters
   there, and they survive both a truncate and a process restart — without this
   the _second_ run of the suite would hit the registration limit (5/hour) while
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

| file                                                      | covers                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/test/db.ts`                                          | test-database wiring, `truncateAll()`                                                                                               |
| `src/test/harness.ts`                                     | app lifecycle, `request()`, role fixtures                                                                                           |
| `src/test/env-guard.ts`                                   | the per-file `process.env` boundary — fails any file that leaves a variable changed                                                 |
| `src/modules/identity/auth-lifecycle.integration.test.ts` | register → approve → login → refresh → logout, concurrent approval, suspension, refresh rotation under concurrency, reuse detection |
| `src/modules/identity/permissions.integration.test.ts`    | the role matrix through the real router, 404-vs-403, escalation guards                                                              |
| `src/modules/goals/money.integration.test.ts`             | balance ≡ ledger sum, idempotent `clientId`, row-lock serialisation, bigint precision                                               |
| `src/modules/tasks/recurrence.integration.test.ts`        | materialization, idempotency, completion counted once, `this_and_future` split, rotation fairness                                   |
| `src/modules/events/ics-feed.integration.test.ts`         | ICS document validity, ETag/304, feed-token rotation and revocation                                                                 |
| `src/modules/notifications/fanout.integration.test.ts`    | fan-out per preference, quiet-hours deferral, ack idempotency                                                                       |
| `src/core/queue/queues.integration.test.ts`               | the BullMQ `jobId` contract                                                                                                         |

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
