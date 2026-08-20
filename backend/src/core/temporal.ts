import type { Temporal as TemporalPolyfill } from 'temporal-polyfill';

/**
 * Temporal bootstrap.
 *
 * Node 24 does not expose `Temporal` (it ships unflagged only in Node 26), and
 * the recurrence engine depends on it for DST-correct wall-clock arithmetic
 * (D2). Install the polyfill only when the runtime lacks it, so the app picks up
 * the native implementation for free on a future Node upgrade.
 *
 * Import this module for its side effect **before** anything that touches
 * `Temporal` — `main.ts` does so on its first line.
 */

declare global {
  var Temporal: typeof TemporalPolyfill | undefined;
}

export async function installTemporal(): Promise<void> {
  if (typeof globalThis.Temporal === 'undefined') {
    await import('temporal-polyfill/global');
  }
}

/**
 * Fails fast if the container's tzdata is stale or ICU is trimmed.
 *
 * A container built months ago can carry outdated timezone rules, which would
 * silently resolve every recurring task to the wrong instant. Better a refusal
 * to boot than a family that misses appointments.
 */
export function assertTimeZoneDataIsUsable(): void {
  const temporal = globalThis.Temporal;
  if (!temporal) throw new Error('Temporal is not available — call installTemporal() first');

  // Moscow has been permanent UTC+3 since 26 Oct 2014.
  const moscow = temporal.ZonedDateTime.from('2026-01-15T12:00[Europe/Moscow]');
  if (moscow.offset !== '+03:00') {
    throw new Error(
      `tzdata looks wrong: Europe/Moscow resolved to ${moscow.offset}, expected +03:00. ` +
        'The container image probably has stale timezone data or a trimmed ICU build.',
    );
  }

  // A DST-observing zone, to prove the rules are real and not a UTC stub.
  const berlinSummer = temporal.ZonedDateTime.from('2026-07-15T12:00[Europe/Berlin]');
  if (berlinSummer.offset !== '+02:00') {
    throw new Error(
      `tzdata looks wrong: Europe/Berlin in July resolved to ${berlinSummer.offset}, expected +02:00.`,
    );
  }
}
