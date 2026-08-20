import { test as base, expect, type BrowserContext } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { API, RUN_ID, ensureApprovedOwner } from './helpers';

/**
 * One signed-in session **per worker**, handed on from test to test.
 *
 * Two hazards live here, and both are the identity layer behaving exactly as
 * designed:
 *
 * 1. **One session shared by parallel workers looks like token theft.** Refresh
 *    tokens rotate, and `session.service.ts` revokes the whole family the second
 *    time an already-rotated token is presented. Workers replaying one saved
 *    cookie do precisely that. Each worker therefore signs in for itself, into
 *    its own token family.
 *
 * 2. **Within a worker, the saved cookie has to move with the chain.** Every
 *    test starts a fresh browser context, and the app keeps its access token in
 *    memory only — so each context's first page load posts `/api/auth/refresh`
 *    and *rotates* the token. If every test replayed the same saved cookie, the
 *    first test would spend it and the rest would be answered out of the
 *    20-second concurrent-refresh grace window (`REFRESH_GRACE_SECONDS`). The
 *    moment a worker's slice of the suite runs longer than that — which
 *    `--workers=2` does easily, and two runs sharing a machine even more so —
 *    the next replay is counted as reuse, the family is revoked, and every
 *    later test in that worker lands on «С возвращением». Which reads as a
 *    broken app rather than as a spent token.
 *
 *    So the token is *carried forward*: after each test the context's cookies
 *    are written back, and the next test starts from the generation the last one
 *    left behind. Nothing ever presents a spent token and the grace window stops
 *    being load-bearing.
 *
 * The state files are keyed by run **and** worker. The account itself is
 * per-run (see `helpers.ts`), so a shared `worker-0.json` would let two
 * concurrent runs overwrite each other's session with one belonging to a
 * different user.
 */

/** The backend's refresh cookie. The access token is never persisted. */
const REFRESH_COOKIE = 'rt';

interface SavedState {
  cookies: Array<{ name: string; value: string }>;
}

function savedRefreshToken(file: string): string | null {
  const state = JSON.parse(readFileSync(file, 'utf8')) as SavedState;
  return state.cookies.find((c) => c.name === REFRESH_COOKIE)?.value ?? null;
}

/** Runs at most once per worker process; the sweep is idempotent anyway. */
let sweptAuthDirs = false;

/**
 * Drops the state directories of runs that finished hours ago.
 *
 * One directory per run is the filesystem's share of the same bookkeeping the
 * database gets in `helpers.ts`, and it needs the same restraint: a directory
 * touched within the last six hours may belong to a run still in flight, and
 * deleting it would sign that run's workers out mid-test.
 */
function sweepStaleAuthDirs(root: string): void {
  if (sweptAuthDirs) return;
  sweptAuthDirs = true;

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const dir = path.join(root, entry.name);
    if (statSync(dir).mtimeMs > cutoff) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}

interface WorkerSession {
  /** Path to a state file whose refresh token nothing has spent yet. */
  claim: () => Promise<string>;
  /** Hands the chain to the next test, or forces a fresh sign-in. */
  release: (context: BrowserContext) => Promise<void>;
}

export const test = base.extend<{ carrySession: void }, { workerSession: WorkerSession }>({
  // Playwright's fixture callback is conventionally named `use`; the
  // react-hooks rule reads that as a Hook called outside a component. It isn't.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  storageState: async ({ workerSession }, use) => use(await workerSession.claim()),

  /**
   * Auto fixture, so the hand-back happens for every test without any suite
   * having to remember it. It depends on `context`, which is what makes it tear
   * down *before* the context is disposed, while the cookies are still readable.
   */
  carrySession: [
    async ({ context, workerSession }, use) => {
      await use();
      await workerSession.release(context);
    },
    { auto: true },
  ],

  workerSession: [
    async ({ browser }, use) => {
      const id = test.info().parallelIndex;
      const root = path.resolve(test.info().project.testDir, '.auth');
      const dir = path.join(root, `run-${RUN_ID}`);
      mkdirSync(dir, { recursive: true });
      sweepStaleAuthDirs(root);
      const file = path.join(dir, `worker-${String(id)}.json`);

      /** The token handed to the test currently running. */
      let lent: string | null = null;
      /** Set when the next claim has to start from a fresh sign-in. */
      let spent = true;

      const signIn = async (): Promise<void> => {
        // `browser.newPage()` gets none of the project's `use` options, so the
        // base URL has to be handed over or every goto sees a bare path.
        const page = await browser.newPage({
          baseURL: test.info().project.use.baseURL,
          storageState: undefined,
        });
        const { email, password } = await ensureApprovedOwner(page.request, API);

        await page.goto('/login');
        await page.getByLabel('Почта', { exact: true }).fill(email);
        // Exact: the show/hide toggle's aria-label also contains «пароль».
        await page.getByLabel('Пароль', { exact: true }).fill(password);
        // Exact: «Войти через Google» and «Войти через Telegram» also match loosely.
        await page.getByRole('button', { name: 'Войти', exact: true }).click();
        await expect(page).toHaveURL(/\/($|\?)/, { timeout: 15_000 });

        // Signing in is not finished when the redirect lands: the app holds its
        // access token in memory, so it rotates the cookie once more of its own
        // accord a moment later. Capturing before that leaves an already-spent
        // token in the file, and then every test is answered out of the grace
        // window instead of rotating cleanly. Wait for the page to go quiet…
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        // …and then spend the current generation deliberately, so what gets
        // written out is one nobody has presented yet. `page.request` shares the
        // context's cookie jar, so the rotated cookie lands in the capture.
        const warmed = await page.request.post(`${API}/api/auth/refresh`);
        expect(warmed.ok(), `warm-up refresh failed: ${warmed.status()}`).toBeTruthy();

        await page.context().storageState({ path: file });
        await page.close();
        spent = false;
      };

      await use({
        async claim() {
          if (spent) await signIn();
          lent = savedRefreshToken(file);
          return file;
        },

        async release(context) {
          const cookies = await context.cookies();
          const carried = cookies.find((c) => c.name === REFRESH_COOKIE)?.value;

          // A deliberately anonymous context (`test.use({ storageState:
          // ANONYMOUS })`) has no cookie to give back, and writing its empty jar
          // to the file would sign the whole worker out.
          if (carried === undefined) return;

          // Unchanged means the test never rotated: either it never loaded the
          // app, or its refresh was answered from the grace window — which only
          // happens once the token has been spent already. Handing the same one
          // on would risk a reuse revocation, so start a new family instead:
          // rare, and one sign-in is cheaper than a dead worker.
          if (carried === lent) {
            spent = true;
            return;
          }

          await context.storageState({ path: file });
        },
      });
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
