import { hash, verify, type Options } from '@node-rs/argon2';

/**
 * Password hashing (argon2id).
 *
 * `@node-rs/argon2` is a native NAPI binding — no build step in the Alpine
 * image, and it releases the libuv thread while hashing, so a slow verify does
 * not block the event loop the way a pure-JS implementation would.
 *
 * The parameters below are the OWASP "second recommended option" for argon2id:
 * 19 MiB of memory, 2 iterations, 1 degree of parallelism. Memory cost is the
 * knob that actually hurts GPU crackers; iteration count is the cheap one.
 */

/**
 * `Algorithm.Argon2id` cannot be referenced: `@node-rs/argon2` declares it as an
 * ambient `const enum`, and this package compiles with `verbatimModuleSyntax`,
 * which forbids reading ambient const enum members (TS2748). The numeric value
 * is part of the published NAPI ABI, so pinning it here is safe — and pinning it
 * explicitly is better than relying on the binding's default.
 */
const ARGON2ID = 2;

/** KiB. 19456 = 19 MiB. */
const MEMORY_COST = 19_456;
const TIME_COST = 2;
const PARALLELISM = 1;

const ARGON2_OPTIONS: Options = {
  algorithm: ARGON2ID,
  memoryCost: MEMORY_COST,
  timeCost: TIME_COST,
  parallelism: PARALLELISM,
  outputLen: 32,
};

/**
 * A hash of a value nobody knows, verified against when the account does not
 * exist or has no password.
 *
 * Without it `POST /auth/login` answers in ~1 ms for an unknown email and in
 * ~50 ms for a known one, which turns the login form into an account
 * enumeration oracle — and this app's whole registration flow is admin-gated
 * precisely so that outsiders learn nothing about the family.
 *
 * Computed once, lazily, so importing this module costs nothing.
 */
let dummyHashPromise: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hash(
    // Not a secret; its only job is to be a well-formed argon2id digest.
    'argon2id-timing-equalisation-placeholder',
    ARGON2_OPTIONS,
  );
  return dummyHashPromise;
}

/** Warm the dummy hash at boot so the first failed login is not the slow one. */
export async function warmPasswordHasher(): Promise<void> {
  await getDummyHash();
}

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * Verifies `plain` against `stored`.
 *
 * `stored` is deliberately nullable: pass `user?.passwordHash ?? null` straight
 * from the lookup. A `null` hash still performs a full argon2 verification
 * against the dummy digest before returning `false`, so the response time of an
 * unknown email is indistinguishable from a wrong password.
 *
 * Never throws — a corrupt or truncated digest in the database is a `false`,
 * not a 500 that tells the caller the row exists.
 */
export async function verifyPassword(stored: string | null | undefined, plain: string): Promise<boolean> {
  if (!stored) {
    await verify(await getDummyHash(), plain, ARGON2_OPTIONS).catch(() => false);
    return false;
  }

  try {
    return await verify(stored, plain, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * True when `stored` was produced with weaker parameters than the current ones
 * and should be transparently re-hashed on the next successful login.
 *
 * The encoded digest looks like
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`, so the parameters are readable
 * without a library call.
 */
export function needsRehash(stored: string): boolean {
  const match = /^\$argon2(id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
  if (!match) return true;

  const [, variant, , memory, time, parallelism] = match;
  if (variant !== 'id') return true;

  return (
    Number(memory) < MEMORY_COST ||
    Number(time) < TIME_COST ||
    Number(parallelism) !== PARALLELISM
  );
}
