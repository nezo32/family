import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/utils';

/**
 * A quiet uppercase label, an optional single right-hand link, and
 * hairline-separated rows on **one** L1 surface.
 *
 * ```
 *  МОИ ДЕЛА                                              3 · все ›
 *  ┌──────────────────────────────────────────────────────────────┐
 *  │ ○  Разобрать посудомойку                                     │
 *  ├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤
 *  │ ○  Забрать Лизу из садика                                    │
 *  └──────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Why this replaces `WidgetCard`
 *
 * Сегодня currently stacks six white cards of near-identical weight and height
 * — 1661px of them on an 844px screen — each with its own icon, its own count
 * and its own «Все задачи ›» footer. «Все задачи» appears **twice on one
 * screen**. Six things shouting is a screen where nothing was decided.
 *
 * A section is the opposite move: the chrome (label, count, the one link) sits
 * *outside* the surface at `meta` weight, and the surface holds nothing but
 * rows. Nine rows then read as one object instead of nine boxes, which is what
 * the settings rebuild already demonstrated. (Design §A2, §B3, §E.)
 *
 * ## The hairline, and why it is inset
 *
 * Rows are separated by a 1px `--hairline` **inset by the row's left padding**,
 * so the rule starts under the text rather than under the tick — the standard
 * iOS list rule. `--hairline` is not `--border`: `--border` outlines a surface,
 * `--hairline` divides rows inside one. Using the same token for both is what
 * makes a list look like a stack of cards.
 *
 * It is done with a `::before` on every child but the first rather than with
 * `divide-y`, because `divide-y` puts the border on the child's own box and a
 * border cannot be inset.
 */

/**
 * `[&>*+*]` — every direct child after the first. `content-['']` is required
 * for the pseudo-element to exist at all; `ms-4` is the row's 16px left padding.
 */
const INSET_HAIRLINE = cn(
  '[&>*+*]:relative',
  "[&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-0 [&>*+*]:before:top-0 [&>*+*]:before:ms-4 [&>*+*]:before:h-px [&>*+*]:before:bg-hairline [&>*+*]:before:content-['']",
);

export type SectionSurface = 'card' | 'attention' | 'calm' | 'none';

const surfaceClass: Record<SectionSurface, string> = {
  // L1 (§B3): --card, 1px --border, radius 12, and **no shadow**. The warm
  // palette already separates white from sand; a shadow on top of that is belt,
  // braces and a third belt, and it is what makes equal cards read as tiles.
  card: 'rounded-xl border border-border bg-card text-card-foreground',
  // Band 2 (§C2). At most one of these per screen, chosen by a fixed
  // precedence: overdue tasks → pending approvals → urgent shopping → nothing.
  //
  // The edge is the wash's own foreground at 15 %, not `--border`. Measured,
  // the §B1 clay wash sits **1.08:1** against the page ground in light mode and
  // 1.19:1 in dark — it is a tint, not a boundary, and on a phone in daylight a
  // tint that faint is nearly nothing. A tinted hairline in the same hue gives
  // the block a real edge without turning it into a card.
  attention:
    'rounded-xl border border-surface-attention-foreground/15 bg-surface-attention text-surface-attention-foreground',
  // «Сделано» / «Куплено» / «Собрано» — a group that is finished, not a group
  // that needs you.
  calm: 'rounded-xl border border-surface-calm-foreground/15 bg-surface-calm text-surface-calm-foreground',
  none: '',
};

export interface SectionProps {
  /** `label` type: 12/600, +0.06em, uppercase. Section labels only — never content (§B2). */
  label?: ReactNode;
  /**
   * The count, right-aligned next to the link: «3». Kept separate from
   * `action` so a section can have a count without gaining a link.
   */
  count?: ReactNode;
  /**
   * **One** link per section, on the header — «все ›» — never a footer row on
   * every card. The six footer links on Сегодня are ~330px of pure chrome.
   */
  action?: ReactNode;
  surface?: SectionSurface;
  /** Hairline rules between direct children. Off for a section holding one block. */
  divided?: boolean;
  children: ReactNode;
  className?: string;
  /** Classes for the surface itself, not for the header. */
  bodyClassName?: string;
  /** Rendered under the surface at `meta` weight: «Сегодня в семье закрыли 2 дела.» */
  footnote?: ReactNode;
}

export function Section({
  label,
  count,
  action,
  surface = 'card',
  divided = true,
  children,
  className,
  bodyClassName,
  footnote,
}: SectionProps) {
  const hasHeader = Boolean(label) || Boolean(count) || Boolean(action);

  return (
    <section data-slot="section" className={cn('flex flex-col', className)}>
      {hasHeader ? (
        // 8px between a section label and its first row (§B3).
        <div className="flex min-h-6 items-center justify-between gap-3 px-4 pb-2">
          {label ? (
            <h2 className="truncate text-[12px] leading-4 font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              {label}
            </h2>
          ) : (
            <span />
          )}
          {count !== undefined || action ? (
            <div className="flex shrink-0 items-center gap-2 text-[13px] leading-[18px] font-medium text-muted-foreground tabular-nums">
              {count !== undefined ? <span>{count}</span> : null}
              {action}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        data-slot="section-body"
        className={cn(
          'overflow-hidden',
          surfaceClass[surface],
          divided && INSET_HAIRLINE,
          bodyClassName,
        )}
      >
        {children}
      </div>

      {footnote ? (
        <p className="px-4 pt-2 text-[13px] leading-[18px] font-medium text-muted-foreground">
          {footnote}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The gap between sections is 24px and the gap between groups inside one
 * section is 8px (§B3). Wrapping a screen's bands in this is how that stays
 * true without every page re-deciding it.
 */
export function SectionStack({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex flex-col gap-6', className)}>{children}</div>;
}
