import { ChevronRight } from 'lucide-react';
import type { ComponentProps, ElementType, ReactNode } from 'react';

import { cn } from '@/shared/lib/utils';

/**
 * The row that states a value in words and opens a picker.
 *
 * ```
 *  🕘  Сегодня, 19:00 · 1 час                                          ›
 *  📍  Место                                          Ул. Садовая, 12  ›
 *  🔁  Повторение                                     не повторяется   ›
 * ```
 *
 * ## Why a row and not a labelled control
 *
 * A form field asks "what is the value of `startsAt`". A row *tells you the
 * plan* — «Сегодня, 19:00 · 1 час» — and opens a picker if that is not the
 * plan. The current build stacks «Весь день» + «Дата» + «Начало» +
 * «Длительность» as four labelled controls inside a nested bordered box; that
 * is four decisions where the family makes one. (Design §F4.)
 *
 * ## The 720px rule — this is where it is enforced (§C2)
 *
 * The row's *surface* may be full-bleed, but its content stops at 720px and
 * stays **left-aligned**, so the trailing chevron sits 24px from the value
 * rather than at the far edge of a 1024px column. This is not hypothetical:
 * `list-desktop-light` measured «Картошка» at x=386 and its delete button at
 * x=1325 — ≈ 900px of nothing between an item and the control that removes it.
 *
 * Baking it into the primitive is the point. A rule that lives in a document
 * comes back the next time someone adds a settings row; a rule that lives in
 * the component cannot.
 *
 * ## Sizing
 *
 * 56px (`min-h-14`) — 44px minimum tap target with room to spare — growing to
 * fit a two-line value. `py-3` per the §B3 scale; nothing here is 6, 10, 14 or
 * 20.
 */

export interface ValueRowProps {
  /** Small leading glyph. A lucide icon or an emoji; 20px box either way. */
  icon?: ReactNode;
  /** What the row is. `row` type: 17/500 (§B2). */
  label: ReactNode;
  /**
   * What it currently is. `undefined` / `null` / `''` renders «—», which reads
   * as "not set" rather than as an empty gap.
   */
  value?: ReactNode;
  /** A second, quieter line under the label. `meta`: 13/500. */
  hint?: ReactNode;
  /**
   * Replaces the trailing chevron — a `Switch`, a count badge, a delete button.
   * When present the row does not claim to open anything.
   */
  trailing?: ReactNode;
  /** Renders the chevron and makes the whole row a button. */
  onClick?: () => void;
  disabled?: boolean;
  /** Marks the row's own action destructive: «Удалить». Text and icon only. */
  tone?: 'default' | 'destructive';
  className?: string;
  /** Escape hatch for a row that must be an `<a>` or a router `<Link>`. */
  as?: ElementType;
  /** Forwarded to the rendered element (`to`, `href`, `aria-*`). */
  linkProps?: Record<string, unknown>;
}

/** «—»: the value is not set. Never an empty string — an empty row reads as broken. */
const EMPTY_VALUE = '—';

export function ValueRow({
  icon,
  label,
  value,
  hint,
  trailing,
  onClick,
  disabled = false,
  tone = 'default',
  className,
  as,
  linkProps,
}: ValueRowProps) {
  const interactive = Boolean(onClick) || Boolean(as);
  const Component: ElementType = as ?? (onClick ? 'button' : 'div');
  const showChevron = interactive && !trailing;
  const isEmpty = value === undefined || value === null || value === '';

  const elementProps: Record<string, unknown> = { ...linkProps };
  if (Component === 'button') {
    elementProps.type = 'button';
    elementProps.disabled = disabled;
  }
  if (onClick) elementProps.onClick = onClick;

  return (
    <Component
      data-slot="value-row"
      className={cn(
        // The *surface* is full width…
        'block w-full text-left',
        interactive && 'touch-manipulation no-callout',
        // Tailwind v4's `hover:` is already wrapped in `@media (hover: hover)`,
        // which is what §G8 asks for: on touch a :hover state sticks after the
        // tap and reads as a stuck selection.
        interactive && 'transition-colors hover:bg-muted/40 active:bg-muted/60',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
      {...elementProps}
    >
      {/* …and the *content* stops at 720px, left-aligned (§C2). */}
      <span className="flex min-h-14 w-full max-w-row-measure items-center gap-3 px-4 py-3">
        {icon ? (
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-5"
          >
            {icon}
          </span>
        ) : null}

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              'truncate text-[17px] leading-6 font-medium',
              tone === 'destructive' && 'text-destructive',
            )}
          >
            {label}
          </span>
          {hint ? (
            <span className="truncate text-[13px] leading-[18px] font-medium text-muted-foreground">
              {hint}
            </span>
          ) : null}
        </span>

        {value !== undefined ? (
          <span
            className={cn(
              'shrink-0 text-[15px] leading-[22px] tabular-nums',
              isEmpty ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {isEmpty ? EMPTY_VALUE : value}
          </span>
        ) : null}

        {trailing ? <span className="flex shrink-0 items-center">{trailing}</span> : null}
        {showChevron ? (
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : null}
      </span>
    </Component>
  );
}

/**
 * The same 720px content measure for anything that is *not* a `ValueRow` but
 * sits in the same list — a custom row, a composer, a chart. `max-w-row-measure`
 * comes from `--spacing-row-measure` in `index.css`, so the number lives in one
 * place and «720» never has to be re-typed (or mistyped) anywhere.
 */
export function RowMeasure({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('w-full max-w-row-measure', className)} {...props} />;
}
