/**
 * Progress as a whole percent — the one definition.
 *
 * There were four, and they disagreed about two different things at once:
 *
 * 1. **Rounding.** `goals.repository.ts` used exact integer arithmetic while
 *    `dashboard.service.ts`, `features/goals/money.ts` and `shared/lib/format.ts`
 *    used `Math.round(c / t * 100)`. Those are not the same function:
 *    `285 / 1000` is `28.499999999999996` in IEEE 754, so the float route
 *    rounds it **down** to 28 while the exact route gives 29.
 * 2. **The ceiling.** `contracts/goals.ts` says progress is deliberately not
 *    capped, `contracts/dashboard.ts` capped it at 100 — so an over-funded goal
 *    read «112 %» on the goals screen and «100 %» on the home screen.
 *
 * Resolution: {@link percentOf} is exact and uncapped everywhere, because a
 * family that has saved more than it set out to save should be told so. The
 * clamp survives only as {@link ringPercent}, which answers a different
 * question — how full to draw an arc that cannot go past full.
 */

/**
 * `round(current / target * 100)`, computed with **integer arithmetic only**.
 *
 * The identity is `round(c / t * 100) === floor((c * 200 + t) / (2t))` for
 * `t > 0`. No float ever enters the calculation, so the answer is the same on
 * every machine and matches the SQL projection (`PROGRESS_PERCENT_EXPR` in
 * `goals.repository.ts`) exactly.
 *
 * Floored at 0 — a negative balance is "no progress", not negative progress.
 * **Not** capped at 100: an over-funded goal reads «112 %» and means it.
 * A zero or negative target is 0 rather than a division by zero.
 */
export function percentOf(current: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(Math.floor((current * 200 + target) / (2 * target)), 0);
}

/**
 * How full to draw a progress ring or bar: 0–100.
 *
 * This clamp is a **visual bound and nothing else**. An arc cannot render past
 * full, so 112 % fills the same ring as 100 %. Never use it for the number
 * printed next to the ring — that number is {@link percentOf}, uncapped, and
 * the whole point of the two functions being separate is that the label and the
 * drawing are allowed to differ.
 */
export function ringPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}
