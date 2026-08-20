import { randomUUID } from 'node:crypto';

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * Identifier for **this `playwright test` invocation**, shared by every worker.
 *
 * Minted *here*, in the config, and published through `process.env` — the
 * runner evaluates this module before it forks a single worker, and workers
 * inherit its environment, so the `??=` is settled exactly once per run. Every
 * later reader (`e2e/helpers.ts`, and the workers' own re-evaluation of this
 * file) finds the variable already set and reads the inherited value back.
 * Set `E2E_RUN_ID` yourself to pin a run, or to make two invocations
 * deliberately share an account.
 *
 * ── Why the mint lives here and not in `e2e/helpers.ts` ─────────────────────
 * It used to be `import { RUN_ID } from './e2e/helpers'`, which read better and
 * broke the production image build. `tsconfig.node.json` typechecks this file,
 * and `.dockerignore` excludes every `e2e` directory from the build context on
 * purpose — so `tsc -b` inside the container typechecked a config whose only
 * dependency was not there: `TS2307: Cannot find module './e2e/helpers'`.
 * Green on every local gate, fatal in the image — same shape as the path-alias
 * rule in `docs/CONVENTIONS.md`, and now hard rule 7 there.
 *
 * Inverting it costs one `??=` expression duplicated in `helpers.ts` and buys
 * an invariant that cannot rot: **nothing typechecked by the build may import
 * anything under `e2e/`.** Keep this file's imports to `@playwright/test` and
 * node builtins. The duplication is safe by construction — `??=` means
 * whichever module is evaluated first wins, so the two mints can never both
 * apply, and `helpers.ts` keeping its own is what lets a direct `vitest`/`tsx`
 * import of the helpers work with no config in sight.
 */
const RUN_ID: string =
  (process.env.E2E_RUN_ID ??= `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);

/**
 * Authentication is a **worker-scoped fixture** (`e2e/fixtures.ts`), not a
 * setup project writing one shared state file.
 *
 * Refresh tokens rotate and a replayed one revokes its whole family — correct
 * behaviour that parallel workers sharing one saved cookie trip constantly.
 * Each worker therefore signs in once and keeps its own session.
 *
 * The account those sessions belong to is minted **per run** from `RUN_ID`
 * above, so two suites can run side by side without revoking each other
 * (again: reuse detection). Recording it in `metadata` also puts it in the
 * report, which is how you tell two interleaved runs apart.
 */
export default defineConfig({
  testDir: './e2e',
  metadata: { e2eRunId: RUN_ID },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 15'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm run preview --port ${PORT} --strictPort`,
        port: PORT,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
