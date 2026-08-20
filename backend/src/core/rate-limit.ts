import { getConfig } from './config.js';

/**
 * Scales a rate-limit ceiling by the configured factor.
 *
 * The factor is 1 everywhere except an automated end-to-end run — and is forced
 * to 1 in production regardless of the environment — so the number written at
 * the call site is the number that ships. See `RATE_LIMIT_FACTOR` in
 * `core/config.ts` for why the knob exists at all.
 */
export function scaledLimit(max: number): number {
  return max * getConfig().rateLimitFactor;
}
