/**
 * Guard for the free-form `icon` field on goals and shopping lists.
 *
 * The contract types that field as a plain `string` (`z.string().trim().max(64)`),
 * and the two ends of the app disagreed about what goes in it: the pickers write
 * an **emoji**, while seeded rows hold a **lucide icon name**. The cards printed
 * whatever they were handed, so «Отпуск на море» wore the word `palmtree` and a
 * shopping list wore a clipped `spray-can`.
 *
 * Emoji is the format this app writes, because it needs no icon registry and no
 * bundle. This is the read side of that decision: anything that is not actually
 * a pictograph is not drawable, and the caller falls back to a neutral glyph
 * rather than setting a word in the middle of a coloured circle.
 */

/** Matches any emoji/pictograph codepoint. */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/**
 * The longest we accept. A ZWJ sequence like 👨‍👩‍👧‍👦 is seven codepoints;
 * a sentence, an icon name or a pasted URL is longer and is not an icon.
 */
const MAX_CODEPOINTS = 8;

/**
 * The value if it can be rendered as an emoji, otherwise `null`.
 *
 * `null` means "draw the neutral fallback" — never "draw this string".
 */
export function displayEmoji(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if ([...trimmed].length > MAX_CODEPOINTS) return null;
  return PICTOGRAPHIC.test(trimmed) ? trimmed : null;
}
