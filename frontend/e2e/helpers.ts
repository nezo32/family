import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  expect,
  type APIRequestContext,
  type ConsoleMessage,
  type Page,
  type Request,
} from '@playwright/test';

/**
 * Shared plumbing for the end-to-end suites.
 *
 * Extracted so every suite signs in the same way — an auth helper that differs
 * between suites is how one of them ends up silently testing an anonymous
 * session.
 */

// `localhost` and `127.0.0.1` are different origins to CORS: the backend's
// allow-list is built from APP_PUBLIC_URL, which uses `localhost`. Pointing the
// suite at the IP form gets every POST a 403 "Origin not allowed".
export const API = process.env.E2E_API_URL ?? 'http://localhost:3100';

/** An explicitly signed-out context, for the screens that must be anonymous. */
export const ANONYMOUS = { cookies: [], origins: [] };

/** Console noise that is expected and not a defect. */
const IGNORED_CONSOLE = [
  /Download the React DevTools/i,
  /\[vite\]/i,
  /Service ?Worker/i,
  /Notification|PushManager/i, // absent in headless Chromium; the app degrades on purpose
  /favicon/i,
  // The browser logs one of these for every non-2xx response. The response
  // watcher below already records those *with their URL*, so keeping them here
  // just buries real script errors under duplicates.
  /Failed to load resource/i,
];

/** Requests whose failure is expected in a headless browser. */
const IGNORED_REQUESTS = [/vapid-public-key/i, /\/sw\.js/i, /manifest\.webmanifest/i];

export interface PageProblems {
  console: string[];
  failed: string[];
}

/** Starts recording console errors and failed/4xx/5xx requests for a page. */
export function watch(page: Page): PageProblems {
  const problems: PageProblems = { console: [], failed: [] };

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((r) => r.test(text))) return;
    problems.console.push(text);
  });

  page.on('pageerror', (err: Error) => {
    problems.console.push(`uncaught: ${err.message}`);
  });

  page.on('requestfailed', (req: Request) => {
    const url = req.url();
    if (IGNORED_REQUESTS.some((r) => r.test(url))) return;
    problems.failed.push(`${req.method()} ${url} — ${req.failure()?.errorText ?? 'failed'}`);
  });

  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('/api/')) return;
    if (IGNORED_REQUESTS.some((r) => r.test(url))) return;
    // A 401 from the session probe is the correct answer for a signed-out
    // visitor, not a defect — `/api/me` is how the app asks "is anyone there?".
    // A 401 from anything else still is one.
    const isSessionProbe = /\/api\/(me|auth\/)/.test(url);
    if (res.status() >= 400 && !(res.status() === 401 && isSessionProbe)) {
      problems.failed.push(`${res.status()} ${res.request().method()} ${url}`);
    }
  });

  return problems;
}

export function assertClean(problems: PageProblems, where: string): void {
  expect(problems.failed, `${where}: failing requests`).toEqual([]);
  expect(problems.console, `${where}: console errors`).toEqual([]);
}

/**
 * Identifier for **this `playwright test` invocation**, shared by every worker.
 *
 * Under Playwright the value is already set by the time this module loads:
 * `playwright.config.ts` mints it, the runner evaluates that config before it
 * forks a single worker, and workers inherit the runner's `process.env`. So the
 * runner's mint is the only one that ever finds the variable unset, and every
 * later `??=` — in a worker's re-evaluation of the config, and here — reads the
 * inherited value back. Hence *one* id per run, and a different id for a run
 * started alongside it. Set `E2E_RUN_ID` yourself to pin it.
 *
 * The `??=` below is **not** dead code, and must not be collapsed to a bare
 * read of `process.env.E2E_RUN_ID`. It is the mint for anything that imports
 * these helpers without a Playwright config in sight — a `vitest`/`tsx` script
 * poking at `ensureApprovedOwner`, say — which would otherwise derive
 * `e2e-owner-undefined@example.test` and quietly share one account with every
 * other such caller.
 *
 * It is also deliberately *not* the other way round. This module used to own
 * the mint and `playwright.config.ts` imported it, which is tidier and broke
 * the production image build: `tsconfig.node.json` typechecks the config,
 * `.dockerignore` excludes every `e2e` directory, and `tsc -b` in the container
 * failed with `TS2307: Cannot find module './e2e/helpers'`. Nothing the build
 * typechecks may import anything under `e2e/` — see the `RUN_ID` comment there.
 */
export const RUN_ID: string =
  (process.env.E2E_RUN_ID ??= `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);

/**
 * The owner account this run signs in as — **one per run**, not one fixed
 * account for all time.
 *
 * Do not collapse this back to a constant, however tempting. Two `playwright
 * test` invocations running side by side (two agents, or a rerun started before
 * the first finished) then authenticate as the same user, and the identity
 * layer treats that exactly as it should: refresh-token **reuse detection**
 * revokes a family the other run is still using, and the per-email login
 * throttle (8 attempts / 15 min, `login-throttle.ts`) counts both runs' logins
 * together. Either way the browser lands back on «С возвращением» and a
 * scattering of unrelated tests fails, which reads as a broken app rather than
 * as two harnesses colliding.
 *
 * The original reason for a fixed account — `POST /api/auth/register` is
 * capped at 5/hour/IP — no longer bites: the dev backend runs with
 * `RATE_LIMIT_FACTOR=100` (forced to 1 in production, see `core/config.ts`), so
 * one registration per run is comfortably affordable.
 */
const E2E_OWNER_EMAIL = `e2e-owner-${RUN_ID}@example.test`;
const E2E_OWNER_PASSWORD = 'E2ePassw0rd!2345';

/**
 * One statement through `docker exec psql`, with the failure spelled out.
 *
 * `stdio` is piped on purpose. The default lets psql's `ERROR: …` go straight
 * to the runner's stderr and leaves the thrown `Error` saying only `Command
 * failed: docker exec …` — so the one line that says *what went wrong* is in a
 * different place from the stack that says *who asked*, and under `--workers=8`
 * they are separated by several other workers' output. Capturing it means the
 * message thrown from here carries the statement **and** what Postgres said
 * about it, in one piece.
 */
function psql(sql: string): string {
  try {
    return execSync(
      `docker exec family-dev-postgres-1 psql -U family -d family -tAc "${sql.replaceAll('"', '\\"')}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (error) {
    throw new Error(explainPsqlFailure(sql, error));
  }
}

/** The `stderr`/`stdout` `execSync` hangs off the error it throws, if any. */
function capturedOutput(error: unknown, stream: 'stderr' | 'stdout'): string {
  if (typeof error !== 'object' || error === null) return '';
  const value = (error as Record<string, unknown>)[stream];
  return typeof value === 'string' ? value.trim() : '';
}

function explainPsqlFailure(sql: string, error: unknown): string {
  const said = capturedOutput(error, 'stderr') || capturedOutput(error, 'stdout');
  const reason = said || (error instanceof Error ? error.message : String(error));
  // Postgres answered and refused, versus never having been reached at all.
  // The two need different first sentences: one is a statement to fix, the
  // other is a container to start, and guessing wrong sends the reader to the
  // wrong place.
  const refused = /^ERROR:/m.test(reason);
  return (
    (refused
      ? 'Postgres refused a statement the end-to-end harness sent it.\n'
      : 'The end-to-end harness could not reach the development database.\n' +
        'It talks to Postgres through `docker exec family-dev-postgres-1`; ' +
        'this is not the app,\nnot the API and not authentication.\n') +
    `\n  statement: ${sql}\n` +
    `  psql said: ${reason.replaceAll('\n', '\n             ')}\n` +
    (refused
      ? ''
      : '\n  Is the dev stack up? ' +
        '`docker compose -f infra/docker-compose.dev.yml --env-file .env up -d`\n')
  );
}

/** Runs at most once per worker process; the sweeps below are idempotent. */
let swept = false;

/**
 * The rows the suite *writes*, and how to recognise them again.
 *
 * Deleting the account a run signed in as does **not** take this with it: the
 * seeded family owns some of the same data, and a task created through the UI
 * outlives the user that created it. Left alone it accumulates, and it does not
 * accumulate harmlessly — the tasks list fetches `limit: 100`, so once ~125
 * `E2E дело` series had piled up the freshly created one fell off the end of
 * the page and `deep.spec.ts › creating a task through the UI` failed about one
 * run in three, for a reason that had nothing to do with the code under test.
 *
 * Each predicate must be **ASCII**. These travel through a shell into
 * `docker exec psql`, and a Cyrillic literal that survives one machine's console
 * codepage may arrive mangled on another's — which fails safe (matching
 * nothing) but also silently stops collecting. Hence `title like 'E2E %'` rather
 * than the full Russian title, and `similar to` — which is anchored at both ends
 * — rather than a regex needing a `$` the shell might read as a variable.
 *
 * Add a row here when a spec starts writing something new.
 */
const SUITE_DEBRIS: Array<{ table: string; match: string; from: string }> = [
  // `E2E дело <run id>-<timestamp>`. Occurrences cascade with the series.
  { table: 'task_series', match: `title like 'E2E %'`, from: 'deep.spec.ts — creating a task' },
  // `Молоко <timestamp>` / `Хлеб <timestamp>`. The seeded items are the bare words with
  // no suffix, so requiring a 13-digit `Date.now()` never touches them.
  {
    table: 'shopping_items',
    match: `name similar to '% [0-9]{13}'`,
    from: 'gestures.spec.ts — adding an item',
  },
];

/**
 * The one predicate that decides which accounts this sweep may touch, written
 * once and reused by every statement below.
 *
 * Timid on purpose, because a wrong match deletes another agent's fixtures out
 * from under a live run. Nothing seeded can match it: the seeded family is
 * `@example.com` (plus the child with no email at all). Other suites'
 * `@example.test` fixtures do not carry the `e2e-owner-` prefix, and the
 * pre-existing fixed `e2e-owner@example.test` has no `-` after `owner`, so it is
 * left alone — a suite running the previous code may still be using it. Six
 * hours is two orders of magnitude beyond the longest run measured here, so it
 * cannot reach a concurrent one either.
 *
 * Takes the alias so it can be used as a `where` clause and as a subquery
 * without the wording drifting between the two.
 */
function staleOwner(alias: string): string {
  return (
    `${alias}.email like 'e2e-owner-%@example.test'` +
    ` and ${alias}.created_at < now() - interval '6 hours'`
  );
}

/** `select` form of {@link staleOwner}, for `… in (…)` and `… join …`. */
const STALE_OWNER_IDS = `select u.id from users u where ${staleOwner('u')}`;

/**
 * Tables that hold a stale owner **hostage** — asked of the catalogue, not
 * listed here.
 *
 * `users` is pointed at by forty foreign keys and eleven of them are `restrict`
 * or `no action`: the schema is deliberately hostile to deleting a member
 * (D3 — members are *suspended*, not hard-deleted, and there is no implemented
 * `DELETE /members/:id` precisely because "what happens to a departed member's
 * data" is an unanswered product question). Every one of those eleven can block
 * this sweep, and the twelfth — added by whoever ships the next module — would
 * have blocked it silently.
 *
 * So the sweep does not carry a list. It asks `pg_constraint` which columns
 * point at `users` without a cascade, and uses the answer both to *avoid* the
 * violation and to *name the table* when one still holds on. A new table is
 * therefore handled the day it appears, with no edit here.
 *
 * Deliberately **not** `$$`-quoted or wrapped in a `DO` block: this string
 * travels through a shell (`sh -c` in CI, `cmd.exe` on Windows) inside double
 * quotes, where `$` is a variable sigil on one of the two.
 */
function blockingReferences(): Array<{ table: string; column: string }> {
  const rows = psql(
    `select c.conrelid::regclass::text, a.attname from pg_constraint c` +
      ` join unnest(c.conkey) k(attnum) on true` +
      ` join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum` +
      ` where c.contype = 'f' and c.confrelid = 'users'::regclass` +
      ` and c.confdeltype in ('a', 'r') order by 1, 2`,
  );
  return rows
    .split(/\r?\n/)
    .map((line) => line.split('|'))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== '')
    .map(([table, column]) => ({ table, column }));
}

/**
 * Hands a stale owner's uploads back to the application's own orphan sweep.
 *
 * This is the one dependent table the sweep does something *other* than leave
 * alone, and the reason is the bytes. `media_attachments` rows point at objects
 * in RustFS, and `sweepOrphanedMedia` (`backend/src/modules/storage/media.service.ts`)
 * is **row-driven**: it selects candidate rows, removes the object, then removes
 * the row — object first, row second, so a store that is down costs nothing. The
 * `Storage` interface has no `list` operation and there is no reconciliation
 * pass against the bucket, so a row that disappears without going through that
 * function strands its object **permanently**. Nothing will ever find it again.
 *
 * That is also the argument against `on delete cascade` on `uploader_id`, which
 * would have been the tidy-looking schema fix: it deletes rows behind the
 * sweep's back, which is exactly the leak. `media.service.ts` says as much —
 * "the grace period is the whole reason the cascade does not delete objects".
 *
 * So instead of deleting anything, this does what the application itself does
 * when a post goes (`detachAllFrom`): **soft-delete the row**. It stays visible
 * to `listDetachedBefore`, and `maintenance.sweep-media` reclaims the object and
 * then the row after `DETACHED_GRACE_DAYS`. The uploader is re-pointed at the
 * oldest non-fixture account only because the column is `not null` and something
 * has to hold it; the row is soft-deleted in the same statement, so no screen
 * ever attributes the upload to them.
 *
 * If there is no such account — a database with nothing but fixtures in it —
 * the guard makes this a no-op rather than a `not null` violation, and the
 * owner is simply reported as held below.
 */
function handBackStaleUploads(): number {
  const handed = psql(
    `with keeper as (select id from users` +
      ` where email is not null and email not like 'e2e-%@example.test'` +
      ` order by created_at limit 1),` +
      ` done as (update media_attachments set uploader_id = (select id from keeper),` +
      ` deleted_at = coalesce(deleted_at, now()), updated_at = now()` +
      ` where uploader_id in (${STALE_OWNER_IDS})` +
      ` and (select count(*) from keeper) = 1 returning 1)` +
      ` select count(*) from done`,
  );
  return Number(handed) || 0;
}

/**
 * Drops what earlier runs left in the development database.
 *
 * Three passes, in this order, and the order is the fix for the bug this
 * function used to have:
 *
 * 1. **Written rows, thirty minutes.** `SUITE_DEBRIS` above. These are what tips
 *    a capped list over, so they cannot wait six hours. They go *first* because
 *    `task_series.created_by_id` and `shopping_items.requested_by_id` are both
 *    `restrict` against `users` — a thirty-minute-old task series belonging to a
 *    six-hour-old owner used to block the account delete that ran before it.
 * 2. **Uploads.** Handed to the application's orphan sweep, see above.
 * 3. **Accounts, six hours.** And *only* the accounts nothing points at any
 *    more. This used to be an unqualified `delete from users`, which is how one
 *    stale owner with an attachment took the whole authenticated suite down.
 *
 * ### Why it no longer insists
 *
 * Deleting a member is an operation this product does not support, and the
 * schema says so in eleven places. The sweep's job is to stop test accounts
 * accumulating, not to answer that question on the product's behalf — so it
 * takes the accounts it can have, leaves the ones it cannot, and *says which
 * table held them*. A held account costs one inert `users` row, which is what
 * the six-hour cutoff was already documented as being relaxed about; a failed
 * sweep used to cost every signed-in test in the run.
 *
 * Blanket-cascading those eleven foreign keys was the alternative and it is
 * worse: it is a product decision ("a departed member's savings goal vanishes")
 * taken to make a test helper's `DELETE` succeed, and for `media_attachments`
 * it silently leaks the objects — see {@link handBackStaleUploads}.
 */
function sweepStaleFixtures(): void {
  if (swept) return;
  swept = true;

  // Each pass is attempted on its own. A sweep is best effort by nature, and a
  // debris table that will not budge is no reason to skip the accounts — the
  // previous shape gave up at the first `psql` non-zero and, worse, took the
  // run with it.
  const failures: string[] = [];
  const attempt = (what: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      failures.push(`${what}:\n${(error instanceof Error ? error.message : String(error)).trim()}`);
    }
  };

  for (const debris of SUITE_DEBRIS) {
    attempt(`clearing ${debris.table} (${debris.from})`, () => {
      psql(
        `delete from ${debris.table} where (${debris.match})` +
          ` and created_at < now() - interval '30 minutes'`,
      );
    });
  }

  attempt('handing stale uploads to the media sweep', handBackStaleUploads);

  attempt('dropping stale e2e-owner accounts', () => {
    // `not exists` per blocking column, so the statement can only ever remove
    // accounts whose deletion cannot raise a foreign-key violation. Postgres
    // still enforces the constraints; this just means it never has to.
    const held = blockingReferences()
      .map((ref) => ` and not exists (select 1 from ${ref.table} b where b.${ref.column} = u.id)`)
      .join('');
    psql(`delete from users u where ${staleOwner('u')}${held}`);
  });

  attempt('reporting what it had to keep', reportHeldOwners);

  if (failures.length > 0) announceSweepFailure(failures);
}

/**
 * Says which table is keeping stale accounts alive, once per worker.
 *
 * A warning rather than a failure: an undeleted `users` row breaks nothing, and
 * the whole point of this rewrite is that housekeeping can no longer take the
 * suite with it. But it is not silent either — silence is how the *next* table
 * to point at `users` would go unnoticed until the dev database had thousands of
 * fixture accounts in it.
 */
function reportHeldOwners(): void {
  const remaining = Number(psql(`select count(*) from users u where ${staleOwner('u')}`)) || 0;
  if (remaining === 0) return;

  const breakdown = blockingReferences()
    .map(
      (ref) =>
        `select '${ref.table}.${ref.column}', count(*) from ${ref.table} b` +
        ` join users u on u.id = b.${ref.column} where ${staleOwner('u')}`,
    )
    .join(' union all ');
  const held = psql(`select * from (${breakdown}) t where count > 0 order by 1`);

  console.warn(
    `\ne2e housekeeping: kept ${String(remaining)} stale e2e-owner account(s) — ` +
      'something still points at them.\n' +
      'Nothing is wrong with the suite or with sign-in; this is bookkeeping.\n' +
      (held ? `${held.replace(/^/gm, '  ')}\n` : '') +
      'Each line is a table that still holds rows for those accounts. ' +
      '`media_attachments` should\n' +
      'never appear — it is handed to the app’s own media sweep. Anything ' +
      'else is either debris a\n' +
      'run failed to clear (see SUITE_DEBRIS) or a table added since this sweep ' +
      'was written, in\n' +
      'which case decide whether the run should clean it up or the inert rows ' +
      'are fine.\n',
  );
}

/**
 * Housekeeping failed. Say so, in those words, and let the run continue.
 *
 * The failure this replaces: a non-zero `psql` exit threw out of
 * `sweepStaleFixtures`, which is the first thing `ensureApprovedOwner` calls,
 * which is the first thing every worker's sign-in calls — so a foreign-key
 * violation on a `delete from users` surfaced as *every authenticated test
 * failing to sign in*, an error that points at authentication and reads like a
 * broken app. Four stale owners with sixteen attachments between them took a
 * whole suite down that way, twice.
 *
 * Cleaning up is not a precondition for signing in, so it does not get to stop
 * the run. What it gets is a paragraph with its own name on it.
 */
function announceSweepFailure(failures: readonly string[]): void {
  const detail = failures.join('\n\n');
  console.warn(
    '\ne2e housekeeping FAILED — the suite is running anyway.\n' +
      'This is `sweepStaleFixtures()` in e2e/helpers.ts clearing debris from ' +
      'earlier runs.\n' +
      'It is NOT authentication, NOT the API, and NOT the code under test: ' +
      'no assertion in this\n' +
      'run depends on it. What it does mean is that stale fixtures are ' +
      'accumulating in the dev\n' +
      'database, and eventually something capped — the tasks list fetches ' +
      '`limit: 100` — will\n' +
      'start dropping rows a spec expects to see.\n\n' +
      `${detail.replace(/^/gm, '  ')}\n`,
  );
}

/**
 * Removes the task a run created, named by the ASCII stamp in its title.
 *
 * The sweep above is the safety net for a run that dies mid-test; this is the
 * ordinary path, and it keeps the suite's footprint at zero rows per run.
 */
export function forgetTaskSeries(stamp: string): void {
  psql(`delete from task_series where title like 'E2E %${stamp}'`);
}

/**
 * Removes the shopping items a run created, named by the trailing `Date.now()`.
 *
 * The predicate is the timestamp alone, never the item's name: the gesture
 * suite writes «Молоко …» / «Позиция …», and a Cyrillic literal travelling
 * through a shell into `docker exec psql` may arrive mangled on a console with
 * a different codepage — which fails safe but silently stops deleting. Thirteen
 * digits are unique enough on their own, and nothing seeded carries any.
 */
export function forgetShoppingItems(stamp: string): void {
  psql(`delete from shopping_items where name like '%${stamp}'`);
}

/**
 * Registers this run's owner if it does not exist yet, and makes sure it is
 * approved. Idempotent: the second and later workers of a run find the account
 * already there and pay one `SELECT`.
 *
 * Registration is admin-gated by design (D3) — there is no self-serve path to
 * an active account, and there should not be one — so approval happens the same
 * way a first-run operator would do it.
 */
export async function ensureApprovedOwner(
  request: APIRequestContext,
  api: string,
): Promise<{ email: string; password: string }> {
  sweepStaleFixtures();

  const exists = psql(`select 1 from users where email = '${E2E_OWNER_EMAIL}'`) === '1';

  if (!exists) {
    const res = await request.post(`${api}/api/auth/register`, {
      data: { email: E2E_OWNER_EMAIL, password: E2E_OWNER_PASSWORD, displayName: 'Тест' },
    });

    // Two workers of the same run can both see the account missing and both
    // register; the loser gets 409 ALREADY_EXISTS, which is the outcome we
    // wanted anyway.
    if (!res.ok() && res.status() !== 409) {
      // 429 means the dev backend is running **without** `RATE_LIMIT_FACTOR`,
      // so `POST /api/auth/register` is back to its production 5/hour/IP and a
      // handful of runs have spent it. Falling back to one shared account is
      // what caused the flakiness this per-run scheme exists to remove, so copy
      // an earlier e2e owner's row instead: same password, so the credentials
      // below still open it, and this run still signs in as nobody else's user.
      expect(res.status(), `register failed: ${res.status()} ${await res.text()}`).toBe(429);
      // Wrapped in CTEs so psql prints one number and nothing else: a bare
      // `insert … returning` also emits its `INSERT 0 1` command tag.
      const cloned = psql(
        `with src as (select display_name, password_hash from users` +
          ` where email like 'e2e-owner%@example.test' and password_hash is not null` +
          ` order by created_at desc limit 1),` +
          ` ins as (insert into users (email, display_name, password_hash, role, status)` +
          ` select '${E2E_OWNER_EMAIL}', display_name, password_hash, 'owner', 'active' from src` +
          ` returning 1) select count(*) from ins`,
      );
      expect(
        cloned,
        'registration is rate limited and there is no earlier e2e owner to copy from — ' +
          'start the dev backend with RATE_LIMIT_FACTOR=100 (see docs/TESTING.md)',
      ).toBe('1');
    }
  }

  psql(`update users set status='active', role='owner' where email='${E2E_OWNER_EMAIL}'`);
  return { email: E2E_OWNER_EMAIL, password: E2E_OWNER_PASSWORD };
}

/**
 * Reads one id straight out of the development database.
 *
 * Used for routes the UI never links to — `/calendar/:eventId` is reached only
 * by tapping a push notification, so there is no row to click, and that is
 * precisely the path most worth proving still renders.
 */
export function firstId(table: string): string {
  return psql(`select id from ${table} order by created_at limit 1`);
}
