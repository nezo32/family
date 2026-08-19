/**
 * Money helpers for the moneybox feature — D6.
 *
 * **Nothing is implemented here any more.** This file used to carry its own
 * amount parser and its own progress formula, and both of them had a twin:
 *
 * - `parseAmount` / `parseMinorUnits` / `parsePositiveAmount` were the strict
 *   parser, while `@/shared/lib/format` exported a *lax* `parseMoney` that
 *   stripped every non-digit **before** validating — so `"1234 руб"`,
 *   `"1234abc"`, `"1e5"` and `"5+5"` all became plausible amounts with nothing
 *   on screen to show the coercion. The strict parser won and moved into
 *   `@/shared/lib/format`; `parseMoney` is now an alias of it.
 * - `goalProgressPercent` was `Math.round(current / target * 100)`, which is
 *   not the server's function: `285/1000` is `28.499999999999996` in IEEE 754,
 *   so the client read 28 % where the API said 29 %. `percentOf` in
 *   `@family/shared` is the exact integer form both sides now call.
 *
 * The re-exports below stay so the goals components keep importing money
 * vocabulary from the feature they belong to, and so this file remains the
 * place to look for "how does this feature handle money".
 */

import { percentOf, ringPercent } from '@family/shared';

export type { MoneyParseError, MoneyParseResult } from '@/shared/lib/format';

export {
  /** Parse a typed amount into integer minor units, with a typed reason on failure. */
  parseAmount,
  /** `parseAmount` for callers that only care whether it worked. */
  parseMinorUnits,
  /** `parseAmount`, but zero and negative amounts are errors too. */
  parsePositiveAmount,
  /** Minor units → the ungrouped text an editable field should start with. */
  formatMinorUnitsForInput,
} from '@/shared/lib/format';

/**
 * Progress of a goal in whole percent: exact integer arithmetic, floored at 0,
 * **not** capped at 100 — an over-funded goal reads «112 %» rather than
 * pretending to be exactly full.
 */
export const goalProgressPercent = percentOf;

/**
 * What a progress ring or bar should actually fill: 0–100.
 *
 * A **visual bound only** — an arc cannot render past full. The number printed
 * beside the ring is {@link goalProgressPercent}, uncapped, and the two are
 * separate functions precisely so the label and the drawing may differ.
 */
export { ringPercent };

/** `targetAmount - currentAmount`, floored at 0 — same rule as the server. */
export function remainingAmount(currentAmount: number, targetAmount: number): number {
  return Math.max(0, targetAmount - currentAmount);
}
