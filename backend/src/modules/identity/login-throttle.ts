import { AppError } from '../../core/errors.js';
import { getRedis } from '../../core/redis.js';

/**
 * Per-account login throttling.
 *
 * The per-IP limiter cannot stop the attack that matters here: a botnet spread
 * across many addresses walking one account's password list, with every
 * individual address staying comfortably under its own limit. That needs a
 * counter keyed on the *email being attacked*.
 *
 * It is hand-rolled rather than delegated to `@fastify/rate-limit` because that
 * plugin's `fastify.rateLimit()` factory only functions as an `onRequest` hook,
 * and `onRequest` runs before the body is parsed — so there is no email to key
 * on. Attaching it as a `preHandler` instead is silently inert: the
 * `keyGenerator` never runs and no counter is kept. That is exactly the state
 * this module replaces.
 */

const WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 8;

function keyFor(email: string): string {
  return `login:email:${email.trim().toLowerCase()}`;
}

/**
 * Counts one attempt against the account and throws once the window is spent.
 *
 * Fails **open** on a Redis outage. Locking the whole family out of their own
 * app because a cache is down is a worse outcome than briefly losing a
 * secondary brute-force defence — the per-IP limiter and argon2id both still
 * apply.
 */
export async function assertLoginAttemptAllowed(email: string): Promise<void> {
  const key = keyFor(email);

  let attempts: number;
  try {
    const redis = getRedis();
    attempts = await redis.incr(key);
    // Only the first attempt sets the TTL, so the window is fixed from the
    // first failure rather than sliding forward with every new guess.
    if (attempts === 1) await redis.expire(key, WINDOW_SECONDS);
  } catch {
    return;
  }

  if (attempts > MAX_ATTEMPTS) {
    throw new AppError('RATE_LIMITED', 'Too many sign-in attempts for this account', {
      context: { scope: 'login:email' },
    });
  }
}

/** Clears the counter after a successful sign-in. */
export async function clearLoginThrottle(email: string): Promise<void> {
  try {
    await getRedis().del(keyFor(email));
  } catch {
    // A stale counter expires on its own; never fail a successful login here.
  }
}
