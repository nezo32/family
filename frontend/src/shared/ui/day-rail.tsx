import type { ElementType, ReactNode } from 'react';

import { cn } from '@/shared/lib/utils';

/**
 * The day rail — the app's signature (§A, §C3).
 *
 * ```
 *  56px │  rest of the row
 * ──────┼──────────────────────────────────────
 *       │  ЗАВТРА                              ← DayRailDivider
 * 19:00 ┃  Ужин у бабушки                      ← DayRailRow, ┃ = 3px MemberTick
 *       │  Ул. Садовая, 12
 * 18:00 ┃  Родительское собрание
 * ```
 *
 * ## Why a rail rather than an indent
 *
 * Сегодня, Задачи, Календарь and the week strip are four views of *one* list —
 * things with a time — and before this only Календарь admitted it. Each screen
 * had invented its own time treatment: a 64px muted column here, a `w-14`
 * `text-xs` there, an eyebrow chip on the third. A fixed 56px column carrying
 * the time and a 3px tick in the responsible member's colour is what makes them
 * read as three views of one board instead of three separate products — and on
 * a desktop it becomes a real column rather than an indent that gets lost in a
 * 720px measure.
 *
 * It earns its width because it carries information — *when*, and *whose* — so
 * it is not the decorative numbered eyebrow it replaces.
 *
 * ## Rules baked in here
 *
 * - The rail is `--spacing-rail` (56px) at **every** breakpoint. It does not
 *   grow; the content column does.
 * - Rail text is `meta` 13/500, `tabular-nums`, right-aligned, and top-aligned
 *   with the row title's cap height — hence `py-3` matching the row's own, not
 *   a vertical centring that drifts as a row gains a second line.
 * - The row's content stops at `--spacing-row-measure` (720px, §C2), so a
 *   trailing chevron sits beside the text rather than 900px away from it.
 * - Rows **without** a time do not use the rail at all (a shopping item, a
 *   settings row). Do not pass an empty string to fake one.
 */

export interface DayRailRowProps {
  /**
   * What goes in the 56px column: «19:00», «весь день», «сб 22». Omitted
   * renders an empty rail, which is correct for a continuation row.
   */
  rail?: ReactNode;
  /** The 3px tick — a `<MemberTick>`. Omitted leaves the tick column empty. */
  tick?: ReactNode;
  /** Muted rail text: a past day, a cancelled row. */
  muted?: boolean;
  children: ReactNode;
  /** A trailing slot outside the text column — attendee discs, a chevron. */
  trailing?: ReactNode;
  /** `<button>` for a tappable row, `<div>` otherwise. */
  as?: ElementType;
  className?: string;
  /** Classes for the inner measure box, not the full-bleed surface. */
  contentClassName?: string;
  /**
   * Forwarded verbatim to the rendered element: `onClick`, `type`, `data-*`,
   * `aria-*`. Typed loosely on purpose — the row does not know or care which
   * element it has been asked to be.
   */
  elementProps?: Record<string, unknown>;
}

export function DayRailRow({
  rail,
  tick,
  muted = false,
  children,
  trailing,
  as,
  className,
  contentClassName,
  elementProps,
}: DayRailRowProps) {
  const Component: ElementType = as ?? 'div';

  return (
    <Component data-slot="day-rail-row" className={cn('block w-full', className)} {...elementProps}>
      <span className={cn('flex w-full max-w-row-measure items-stretch gap-3 pe-4', contentClassName)}>
        <span
          className={cn(
            'w-rail shrink-0 py-3 pe-1 ps-4 text-right text-[13px] leading-6 font-medium tabular-nums',
            muted ? 'text-muted-foreground/70' : 'text-muted-foreground',
          )}
        >
          {rail}
        </span>
        {/* The tick is full row height minus 8px (§C3) — `my-1` on a stretched
            child, so it grows with a two-line row instead of being pinned. */}
        <span className="flex shrink-0 items-stretch py-1">{tick}</span>
        <span className="flex min-w-0 flex-1 flex-col justify-center py-3">{children}</span>
        {trailing ? <span className="flex shrink-0 items-center py-3">{trailing}</span> : null}
      </span>
    </Component>
  );
}

/**
 * «ЗАВТРА», «СУББОТА, 22 АВГУСТА» — a day marker *inside* one railed list.
 *
 * Not a `<Section>` header: this divides a list that is already one surface, so
 * a second surface would break the object in half. It is a `label` (12/600
 * uppercase, §B2) sitting in the rail column with the date beside it, which is
 * why the eye still scans one left edge down the whole list.
 */
export function DayRailDivider(props: {
  /** «СЕГОДНЯ» / «ЗАВТРА» / «СБ». Uppercased by the caller's copy, not by CSS. */
  label: ReactNode;
  /** «20 августа». Optional — a bare «ЗАВТРА» needs no second half. */
  detail?: ReactNode;
  /** «3 дела», right-aligned. */
  count?: ReactNode;
  as?: ElementType;
  className?: string;
}) {
  const Component: ElementType = props.as ?? 'div';
  return (
    <Component
      data-slot="day-rail-divider"
      className={cn('block w-full bg-muted/40', props.className)}
    >
      <span className="flex w-full max-w-row-measure items-baseline gap-3 py-2 pe-4">
        <span className="w-rail shrink-0 pe-1 ps-4 text-right text-[12px] leading-4 font-semibold tracking-[0.06em] text-muted-foreground uppercase">
          {props.label}
        </span>
        <span className="min-w-0 flex-1 truncate ps-[3px] text-[13px] leading-[18px] font-medium text-muted-foreground">
          {props.detail}
        </span>
        {props.count !== undefined ? (
          <span className="shrink-0 text-[13px] leading-[18px] font-medium text-muted-foreground tabular-nums">
            {props.count}
          </span>
        ) : null}
      </span>
    </Component>
  );
}
