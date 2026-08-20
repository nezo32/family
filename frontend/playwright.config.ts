import { defineConfig, devices } from '@playwright/test';

import { RUN_ID } from './e2e/helpers';

const PORT = 4173;
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * Authentication is a **worker-scoped fixture** (`e2e/fixtures.ts`), not a
 * setup project writing one shared state file.
 *
 * Refresh tokens rotate and a replayed one revokes its whole family — correct
 * behaviour that parallel workers sharing one saved cookie trip constantly.
 * Each worker therefore signs in once and keeps its own session.
 *
 * The account those sessions belong to is minted **per run**, so two suites can
 * run side by side without revoking each other (again: reuse detection). The id
 * behind it is seeded by importing `RUN_ID` here: this module is evaluated in
 * the runner before any worker is forked, and workers inherit the resulting
 * `E2E_RUN_ID` through the environment. Recording it in `metadata` also puts it
 * in the report, which is how you tell two interleaved runs apart.
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
