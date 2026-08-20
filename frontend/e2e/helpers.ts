import { execSync } from 'node:child_process';

import { expect, type APIRequestContext, type ConsoleMessage, type Page, type Request } from '@playwright/test';

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

/** Where `auth.setup.ts` parks the signed-in session for every other project. */
export const AUTH_STATE = 'e2e/.auth/user.json';

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
 * The one account the whole suite runs as.
 *
 * Fixed rather than freshly minted per run, because `POST /api/auth/register`
 * is capped at **5 per hour per IP** — a sound production control that a suite
 * re-running all evening would otherwise exhaust, turning every run red for a
 * reason that has nothing to do with the code. Registration itself is still
 * covered, by its own test, once per run.
 */
const E2E_OWNER_EMAIL = 'e2e-owner@example.test';
const E2E_OWNER_PASSWORD = 'E2ePassw0rd!2345';

function psql(sql: string): string {
  return execSync(
    `docker exec family-dev-postgres-1 psql -U family -d family -tAc "${sql.replaceAll('"', '\\"')}"`,
    { encoding: 'utf8' },
  ).trim();
}

/**
 * Registers the shared owner if it does not exist yet, and makes sure it is
 * approved. Idempotent: after the first ever run this costs one `SELECT`.
 *
 * Registration is admin-gated by design (D3) — there is no self-serve path to
 * an active account, and there should not be one — so approval happens the same
 * way a first-run operator would do it.
 */
export async function ensureApprovedOwner(
  request: APIRequestContext,
  api: string,
): Promise<{ email: string; password: string }> {
  const exists = psql(`select 1 from users where email = '${E2E_OWNER_EMAIL}'`) === '1';

  if (!exists) {
    const res = await request.post(`${api}/api/auth/register`, {
      data: { email: E2E_OWNER_EMAIL, password: E2E_OWNER_PASSWORD, displayName: 'Тест' },
    });
    expect(res.ok(), `register failed: ${res.status()} ${await res.text()}`).toBeTruthy();
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
