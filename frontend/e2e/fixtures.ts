import { test as base, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { API, ensureApprovedOwner } from './helpers';

/**
 * One signed-in session **per worker**, not one for the whole run.
 *
 * A single shared session looks like token theft. Refresh tokens rotate, and
 * `session.service.ts` treats a second use of an already-rotated token as
 * reuse and revokes the whole family — which is exactly right, and exactly what
 * parallel workers replaying one saved cookie do. The symptom was maddening:
 * every suite passed with `--workers=1` and a different scattering of them
 * failed with `--workers=4`, always with "element(s) not found", because the
 * revoked worker had been quietly bounced to the login screen.
 *
 * Per-worker sessions are independent token families, so rotation stays honest
 * and the suite still runs in parallel.
 */

export const test = base.extend<Record<string, never>, { workerStorageState: string }>({
  storageState: ({ workerStorageState }, use) => use(workerStorageState),

  workerStorageState: [
    async ({ browser }, use) => {
      const id = test.info().parallelIndex;
      const dir = path.resolve(test.info().project.testDir, '.auth');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `worker-${String(id)}.json`);

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

      await page.context().storageState({ path: file });
      await page.close();

      await use(file);
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
