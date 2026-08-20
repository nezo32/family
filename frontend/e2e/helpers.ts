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
 * Playwright re-evaluates the config module inside each worker process, so
 * minting an id there would give every worker a different one. What makes this
 * work is that workers are forked from the runner and inherit its
 * `process.env`: the runner's evaluation is the only one that finds the
 * variable unset, and every later `??=` reads the inherited value back. Hence
 * *one* id per run, and a different id for a run started alongside it.
 * `playwright.config.ts` imports this so the seeding always happens in the
 * runner, before any worker exists. Set `E2E_RUN_ID` yourself to pin it.
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

function psql(sql: string): string {
  return execSync(
    `docker exec family-dev-postgres-1 psql -U family -d family -tAc "${sql.replaceAll('"', '\\"')}"`,
    { encoding: 'utf8' },
  ).trim();
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
 * Drops what earlier runs left in the development database.
 *
 * Two cutoffs, because the two kinds of litter cost different things:
 *
 * - **Accounts, six hours.** They are inert — an extra `users` row slows nothing
 *   down and hides no data — so the cutoff is set for safety, not tidiness.
 * - **Written rows, thirty minutes.** These are what tips a capped list over, so
 *   they cannot be left for six hours. Thirty minutes is still an order of
 *   magnitude beyond the longest run measured here (2.1 minutes for a full
 *   suite, ~3.5 with `--workers=1`), which leaves room for a run being stepped
 *   through in `PWDEBUG` and never touches a concurrent one.
 *
 * Every predicate is deliberately timid, because a wrong match here deletes
 * another agent's fixtures out from under a live run — and `task_series`
 * cascades into its occurrences. Nothing seeded can match any of them: the
 * seeded family is `@example.com` (plus the child with no email at all), its
 * chores are named in Russian without an `E2E ` prefix, and its shopping items
 * are bare words with no timestamp. Other suites' `@example.test` fixtures do
 * not carry the `e2e-owner-` prefix, and the pre-existing fixed
 * `e2e-owner@example.test` has no `-` after `owner`, so it is left alone — a
 * suite running the previous code may still be using it.
 */
function sweepStaleFixtures(): void {
  if (swept) return;
  swept = true;

  psql(
    `delete from users where email like 'e2e-owner-%@example.test'` +
      ` and created_at < now() - interval '6 hours'`,
  );

  for (const debris of SUITE_DEBRIS) {
    psql(
      `delete from ${debris.table} where (${debris.match})` +
        ` and created_at < now() - interval '30 minutes'`,
    );
  }
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
