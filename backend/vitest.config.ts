import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    /**
     * Teardown unwinds in reverse of setup — Vitest's default, pinned here
     * because `src/test/env-guard.ts` depends on it.
     *
     * One fork means one shared `process.env`, so the guard registers an
     * `afterAll` from the setup file that fails any test file which leaves a
     * variable changed. Setup-file hooks are registered first, and only `stack`
     * makes an `afterAll` registered first run *last* — under `parallel` or
     * `list` the guard would run before a file's own restore hook and report
     * leaks that were about to be cleaned up.
     */
    sequence: { hooks: 'stack' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/db/migrate.ts', 'src/db/seed.ts'],
    },
  },
});
