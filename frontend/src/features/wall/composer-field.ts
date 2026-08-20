import { cn } from '@/shared/lib/utils';

/**
 * The fields a composer puts *inside* a `Section` row — the ones that draw
 * nothing at all.
 *
 * ## The rule
 *
 * All three composers behind «Что повесим на доску?» stand a field inside a
 * `Section surface="card"` row and expect the *section* to be the only surface
 * on screen — §D7.6's rule for the feed's cards, applied to the sheets that
 * write them: the row owns the ground, the radius and the 16/12 inset, and the
 * field owns none of them.
 *
 * ## Why it needs saying here rather than at each field
 *
 * Every one of them said so with its own copy of the same override string, and
 * every copy was wrong in the same two ways. Both are `tailwind-merge`
 * behaviours worth stating once rather than rediscovering per composer:
 *
 * 1. **A bare utility cannot cancel a variant one.** `Input` and `Textarea`
 *    both carry `dark:bg-input/30`; the composers answered with
 *    `bg-transparent`. Those are not a conflict to `twMerge` — different
 *    modifiers, so both survive — and in the built stylesheet
 *    `.dark\:bg-input\/30:is(.dark *)` is both later and more specific than
 *    `.bg-transparent`. So in dark mode every one of these fields kept a
 *    white-at-4.8% ground: a second rounded rectangle inset inside the card,
 *    which is the "field inside a field" that was reported against «Новое
 *    объявление» and was equally true of «Опрос» and «Спасибо». Cancelling a
 *    `dark:` utility takes a `dark:` utility.
 * 2. **What is never mentioned is never overridden.** Nothing named a radius,
 *    so `rounded-md` stayed — which is what gave that ground its rounded
 *    corners and made it read as an input rather than as a stray tint.
 *
 * Everything else the primitives draw *was* being cancelled correctly, because
 * `border-0`, `px-0`, `shadow-none` and `focus-visible:ring-0` each conflict
 * with the base utility in the same group **and** the same modifier, which is
 * the case `twMerge` resolves. That is the whole difference, and it is invisible
 * in the source — it has to be read off `dist/assets/*.css` or off a computed
 * style, never off the class list, which looked correct throughout.
 *
 * `p-0` is deliberate and not merely tidiness: the primitives' own `py-*`
 * stacked under the row's padding, so the note's first line sat 20px down while
 * the «Заголовок» row beneath it sits at 12px, and the two disagreed about where
 * a row starts. One owner for the inset, and it is the row.
 *
 * ## What is not here
 *
 * The size. `min-h-*` on a note and `h-11` on a one-line field are the things
 * that genuinely differ per call site, and `h-11` is load-bearing — 44px is the
 * tap-target floor — so each passes its own through `cn()`.
 */
export const composerFieldClass = cn(
  // Draws nothing: no ground in either theme, no radius, no border, no shadow,
  // no focus ring. The `Section` row around it is the only surface.
  'rounded-none border-0 bg-transparent p-0 shadow-none dark:bg-transparent',
  'focus-visible:ring-0',
  // Never below 16px, at any width: below it iOS Safari zooms the viewport on
  // focus and never zooms back (§F2). `md:text-[17px]` is what stops the
  // primitives' own `md:text-sm` taking it to 14 on a desktop.
  'text-[17px] md:text-[17px]',
);

/** The same, for a multi-line note: `resize-none`, because the row sizes it. */
export const composerNoteClass = cn(composerFieldClass, 'resize-none leading-6');
