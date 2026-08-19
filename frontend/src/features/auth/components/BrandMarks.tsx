import { cn } from '@/shared/lib/utils';

/**
 * Brand marks and platform glyphs, inline as SVG.
 *
 * Two reasons they are not emoji or icon-font stand-ins:
 *  - Google's and Apple's brand guidelines require their actual mark on a
 *    sign-in button, in the right colours; a coloured circle reads as a phishing
 *    page, which is exactly the impression a login screen must not give.
 *  - The iOS share glyph has to be *recognisable*. Users do not map the word
 *    «Поделиться» onto the square-with-an-arrow they are looking for, so the
 *    instructions draw the icon they will actually see on screen.
 *
 * Everything is `aria-hidden`: the label next to the mark carries the meaning.
 */

interface MarkProps {
  className?: string;
}

/** The four-colour Google "G". Fixed colours by brand rule — never `currentColor`. */
export function GoogleMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={cn('size-5', className)} aria-hidden focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/**
 * The Apple mark. Apple requires it monochrome and matching the button's label
 * colour, so this one *does* use `currentColor` — that is what keeps it correct
 * in both the light and the dark theme.
 */
export function AppleMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 384 512" className={cn('size-5', className)} aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zM262.1 104.5c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"
      />
    </svg>
  );
}

/** Telegram: the paper plane knocked out of the brand-blue disc. */
export function TelegramMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-5', className)} aria-hidden focusable="false">
      <circle cx="12" cy="12" r="12" fill="#2AABEE" />
      <path
        fill="#FFFFFF"
        d="M5.49 11.79c3.6-1.57 6-2.6 7.2-3.11 3.43-1.43 4.14-1.68 4.6-1.69.1 0 .33.02.47.14.12.1.16.23.17.33.02.1.04.32.02.49-.18 1.94-.98 6.64-1.39 8.81-.17.92-.51 1.22-.84 1.25-.72.07-1.27-.47-1.96-.93-1.09-.72-1.71-1.16-2.77-1.86-1.22-.81-.43-1.25.27-1.98.18-.19 3.35-3.07 3.41-3.33.01-.03.01-.15-.06-.21-.07-.06-.18-.04-.25-.02-.11.02-1.85 1.18-5.23 3.46-.5.34-.94.51-1.34.5-.44-.01-1.29-.25-1.92-.46-.77-.25-1.39-.38-1.33-.81.03-.22.34-.45.93-.68z"
      />
    </svg>
  );
}

/**
 * The iOS share glyph — a rounded box with an arrow leaving the top. This is the
 * icon the user has to find in Safari's toolbar, drawn as they will see it.
 */
export function IOSShareGlyph({ className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('size-5', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M12 3v11" />
      <path d="M8.5 6.5 12 3l3.5 3.5" />
      <path d="M7.5 10H6.6A2.6 2.6 0 0 0 4 12.6v5.8A2.6 2.6 0 0 0 6.6 21h10.8a2.6 2.6 0 0 0 2.6-2.6v-5.8A2.6 2.6 0 0 0 17.4 10h-.9" />
    </svg>
  );
}

/** The "На экран «Домой»" row icon: a home-screen square with a plus. */
export function AddToHomeGlyph({ className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('size-5', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <path d="M12 8.5v7" />
      <path d="M8.5 12h7" />
    </svg>
  );
}
