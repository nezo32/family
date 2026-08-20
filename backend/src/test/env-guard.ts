import { afterAll, expect } from 'vitest';

/**
 * The per-file `process.env` boundary.
 *
 * `vitest.config.ts` pins `pool: 'forks'` with `singleFork: true`, so the whole
 * backend suite is **one operating-system process** and `process.env` is shared
 * by every file in it. Module state is not — Vitest gives each file a fresh
 * module registry, so `getConfig()`'s memo is per-file — but the environment
 * that memo is parsed *from* is not. A file that writes a variable and does not
 * put it back therefore reconfigures the application for every file that runs
 * after it.
 *
 * Which files those are is decided by Vitest's sequencer, which orders by
 * **cached per-file durations** and falls back to file size when there is no
 * cache. CI checks out fresh, so it has no `node_modules/.vite` and runs
 * largest-first; a developer's machine is warm and runs a different order
 * entirely. The two environments genuinely disagree about who is downstream of
 * whom, so a leak is a coin-flip that lands differently here and there.
 *
 * That is how `notifications.test.ts` leaking `TELEGRAM_BOT_TOKEN` came to fail
 * `oauth.test.ts` in CI and nowhere else: `oauth.telegram.enabled` is
 * `Boolean(TELEGRAM_BOT_TOKEN)`, so the leaked token switched the provider on,
 * the 503 preflight was skipped and the callback took a different branch —
 * `expected null to be 'SERVICE_UNAVAILABLE'`, in a file that had not changed.
 *
 * This guard turns that class of bug from an ordering-dependent failure in an
 * innocent file into an immediate, local failure in the guilty one:
 *
 * 1. Snapshot `process.env` while the setup file is still being evaluated —
 *    Vitest runs setup files once per test file and finishes them *before* it
 *    imports the test file, which is the only moment early enough. A `beforeAll`
 *    would be too late: `vi.hoisted()` blocks run during collection, above the
 *    file's imports, so the very writes this guard exists to catch would already
 *    be in the snapshot.
 * 2. In an `afterAll`, diff it. If anything differs, **restore the snapshot**,
 *    drop the memoized config so the *parsed* view is restored too, and throw —
 *    naming the file and every variable it left behind.
 *
 * Restoring as well as reporting is deliberate. Without it one leak produces a
 * failure here plus a cascade of unrelated ones downstream, and the loudest
 * output is the least informative. With it there is exactly one failure and it
 * points at the file that caused it.
 *
 * Resetting the config memo is not optional either: putting the variable back
 * while leaving `getConfig()` holding a value parsed from the poisoned
 * environment is the same bug wearing a different hat.
 *
 * ## If a variable is *supposed* to be process-wide
 *
 * Set it in `src/test/setup.ts`. That runs before this snapshot is taken for
 * every file, so it becomes part of the baseline rather than a diff against it —
 * which is exactly what `DATABASE_URL`, `REDIS_URL` and the throwaway secrets
 * are. Do not add an ignore list here; a variable one file needs everyone to see
 * belongs in the setup file where everyone can see it declared.
 *
 * ## Hook ordering
 *
 * This `afterAll` must be the last one to run for the file, otherwise a file
 * that restores its own environment correctly would still be reported. Setup
 * files register their hooks first, and Vitest's default `sequence.hooks:
 * 'stack'` unwinds `afterAll` in reverse registration order, so this one runs
 * last. `vitest.config.ts` pins that setting explicitly rather than inheriting
 * it — under `parallel` or `list` this hook runs *before* the test file's own
 * teardown and the guard reports phantom leaks.
 */

type EnvSnapshot = Map<string, string | undefined>;

function snapshot(): EnvSnapshot {
  return new Map(Object.entries(process.env));
}

const show = (value: string | undefined) =>
  value === undefined ? '(unset)' : JSON.stringify(value);

/** Every key whose value differs between the two snapshots, sorted. */
function diff(before: EnvSnapshot, after: EnvSnapshot): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    const from = before.get(key);
    const to = after.get(key);
    if (from !== to) changed.push(`  - ${key}: ${show(from)} -> ${show(to)}`);
  }
  return changed;
}

function restore(before: EnvSnapshot, after: EnvSnapshot): void {
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const value = before.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * Install the guard for the current test file. Called from `src/test/setup.ts`,
 * which Vitest runs once per file.
 */
export function installEnvLeakGuard(): void {
  const before = snapshot();

  afterAll(async () => {
    const after = snapshot();
    const changed = diff(before, after);
    if (changed.length === 0) return;

    restore(before, after);
    // Imported here rather than at module scope: the guard must not pull
    // `core/config.ts` into the graph before a test file's `vi.hoisted()` block
    // has had its say about the environment.
    const { resetConfigForTests } = await import('../core/config.js');
    resetConfigForTests();

    const file = expect.getState().testPath ?? '(unknown file)';
    throw new Error(
      `This test file changed process.env and did not put it back:\n${changed.join('\n')}\n\n` +
        `File: ${file}\n\n` +
        `The suite runs in a single fork (vitest.config.ts: singleFork), so that ` +
        `change outlives this file and reconfigures every file the sequencer ` +
        `happens to run next — a different set locally than in CI. Save the ` +
        `previous value, set yours, and restore it in afterAll together with ` +
        `resetConfigForTests(); see src/modules/identity/oauth/oauth-callback.integration.test.ts. ` +
        `If the variable is genuinely meant to be process-wide, declare it in ` +
        `src/test/setup.ts instead. (The environment has been restored, so the ` +
        `files after this one are unaffected.)`,
    );
  });
}
