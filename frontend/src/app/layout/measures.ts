/**
 * The layout system (design §C1), as four class strings.
 *
 * They live in one file because the app bar has to line up with the content
 * column, and two copies of the same arithmetic in two components is how a bar
 * ends up 24px out at one breakpoint and nobody notices for a month.
 *
 * ## The numbers
 *
 * | Range           | Gutter | Column(s)                                  |
 * |-----------------|--------|--------------------------------------------|
 * | `< 768`         | 16     | one, full width, capped at 720             |
 * | `768–1087`      | 32     | one, max 640, **left-aligned**             |
 * | `1088–1279`     | 32     | main `minmax(420, 720)` + side 320, gap 24 |
 * | `≥ 1280`        | 40     | main `minmax(480, 720)` + side 360, gap 32 |
 *
 * The container max is the exact sum of the tracks — 1064 in the middle band,
 * 1112 above `xl` — so there is never leftover space inside the grid and
 * "≥ 1536: grow the gutters, not the columns" falls out of `mx-auto` for free.
 * At 1440 with the 240px sidebar this resolves to a main column of **exactly
 * 720** next to a 360 side column.
 *
 * ## Two deliberate departures from §C1, both stated rather than smuggled
 *
 * 1. **The second column starts at 1088, not at `lg` (1024).** §C1's own
 *    numbers do not fit at 1024: the sidebar takes 240, two 32px gutters take
 *    64, and `minmax(420px, …) + 24 + 320` needs 764 of the 720 that are left.
 *    It overflows by 44px — and a `minmax` floor overflows, it does not shrink.
 *    1088 is the width at which the spec's own minimums first fit
 *    (240 + 32 + 420 + 24 + 320 + 32 = 1068, plus 20px of slack for a classic
 *    scrollbar). Between 1024 and 1088 the layout is the one-column `md` case.
 *
 * 2. **The main column tops out at 720 at every breakpoint, not 760 at `xl`.**
 *    §C1 says `minmax(480px, 760px)`; §C2 says a row is never wider than 720.
 *    Since practically everything in this app is a row, a 760 track would make
 *    the 720 rule a class each screen has to remember — which is exactly the
 *    failure mode §C2 exists to remove. Capping the *track* at 720 makes the
 *    rule structural: no row anywhere in the app can be wider than its column,
 *    and no column anywhere is wider than 720. The 40px goes to the gutters.
 *    The cost is that §C2's exemption for genuine tables (the notification
 *    matrix, the members admin list) cannot use 760 either; no current screen
 *    needs it, and a full-bleed escape hatch can be added when one does.
 *
 * ## Why `min-[768px]:` and `min-[1280px]:` and not `md:` and `xl:`
 *
 * Tailwind v4 emits **every** arbitrary `min-[…]` variant in one block *before*
 * the named breakpoints, ordered among themselves by width. So for a property
 * two of these rules both set, `md:` beats `min-[1088px]:` at 1200px purely on
 * source order — which is how the container came out capped at 640 on a
 * 1200px-wide desktop in the first build of this file, verified in
 * `dist/assets/*.css` rather than assumed. Mixing the two families is therefore
 * a trap; where these strings set the same property at several widths they use
 * one family throughout. `SHELL_GUTTER` sets a property no arbitrary variant
 * touches and stays on the named ones.
 */

/** Page gutter: 16 → 32 → 40 (§B3/§C1). Applied to `<main>` and to the app bar. */
export const SHELL_GUTTER = 'px-4 md:px-8 xl:px-10';

/**
 * The content container inside `<main>`'s gutters.
 *
 * `mx-auto` only from the two-column breakpoint up: §C1 is explicit that the
 * single column is left-aligned and "not centred in a void", and centring it
 * would also slide every page sideways at exactly the widths where the void
 * appears.
 */
export const SHELL_CONTAINER =
  'w-full max-w-[45rem] min-[768px]:max-w-[40rem] min-[1088px]:mx-auto min-[1088px]:max-w-[66.5rem] min-[1280px]:max-w-[69.5rem]';

/**
 * The same container for the app bar, minus the single-column caps: below 1088
 * the bar spans the full width so the bell and the avatar sit on the right
 * gutter rather than 88px short of it. From 1088 up it tracks the content
 * container exactly, so the app-bar title starts on the main column's left edge
 * and the avatar ends on the side column's right edge.
 *
 * The numbers are 64/80px larger than `SHELL_CONTAINER`'s because the gutter
 * sits *inside* this element (`box-sizing: border-box`) and *outside* that one,
 * where it belongs to `<main>`. Measured, not reasoned about: with the same
 * numbers on both, the bar title landed 40px right of the column it was
 * supposed to head at 1440.
 */
export const SHELL_BAR_CONTAINER =
  'w-full min-[1088px]:mx-auto min-[1088px]:max-w-[70.5rem] min-[1280px]:max-w-[74.5rem]';

/**
 * The grid itself. One column below 1088 — which is what makes the side column
 * *collapse to the bottom of the main column* rather than disappear (§C4) —
 * two above it.
 */
export const SHELL_GRID =
  'grid grid-cols-1 gap-6 min-[1088px]:grid-cols-[minmax(420px,45rem)_20rem] min-[1088px]:items-start min-[1280px]:grid-cols-[minmax(480px,45rem)_22.5rem] min-[1280px]:gap-8';

/**
 * The side column.
 *
 * `empty:hidden` is load-bearing: the `<aside>` is always in the DOM because it
 * is the portal target, and a screen with nothing to put in it must not leave a
 * 24px gap under its content on a phone. `:empty` is live, so it un-hides the
 * moment a portal lands.
 *
 * Sticky with an inner scroller, not just sticky: a side column taller than the
 * viewport that only sticks has an unreachable bottom. The offset clears the
 * app bar (`--spacing-appbar` + the status-bar inset) plus 16px, and the height
 * is `dvh` — never `vh` (§F5).
 */
export const SHELL_SIDE = [
  'min-w-0 empty:hidden',
  'min-[1088px]:sticky',
  'min-[1088px]:top-[calc(var(--spacing-appbar)+env(safe-area-inset-top,0px)+1rem)]',
  'min-[1088px]:max-h-[calc(100dvh-var(--spacing-appbar)-env(safe-area-inset-top,0px)-2rem)]',
  'min-[1088px]:overflow-y-auto',
].join(' ');
