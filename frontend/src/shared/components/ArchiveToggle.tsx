import type { ReactNode } from 'react';
import { Archive, ArchiveX } from 'lucide-react';

import { Button } from '../ui/button';
import { cn } from '../lib/utils';

/**
 * «Показать архив» / «Скрыть архив» — the one way this app reveals archived
 * rows, shared by Копилки and Покупки so the two cannot drift again.
 *
 * ## Why it sits on the filter row, to the right of the tabs
 *
 * It used to sit at the **bottom of the list**, which §D5 asked for and which
 * is right for exactly one of the two states this control has to survive.
 *
 * With a list on screen, a control under the last row is fine: the rows it
 * reveals land directly above the thing that revealed them. With **no** list on
 * screen there is nothing to be at the bottom *of*, and the control ends up
 * under an `EmptyState`, attached to nothing. Measured on an empty Покупки:
 *
 *  - 320 × 800 — the button's box at y = 467, with **289px of empty background
 *    under it**. Not at the bottom of anything; adrift in the middle.
 *  - iPhone 15 (393 × 659 visible) — y = 685. **Past the fold**, so the only
 *    way to reach the archive on a screen with nothing on it was to scroll a
 *    page that had nothing to scroll.
 *
 * Empty is not an unusual state for these two screens; it is the first one a
 * new family sees. The filter row is the one anchor that exists in **both**
 * states: tabs on the left, archive on the right, one 44px row directly under
 * the app bar — so the control is attached to the head of the list whether or
 * not the list has anything in it. Same empty Покупки, after: y = 129 at 320,
 * y = 347 on an iPhone 15, on screen at every width. §D5 now says this.
 *
 * ## Why it is a button and not a bare link
 *
 * The Копилки copy of this was a bare `<button>` of 13px text: **128 × 18 px**,
 * measured — less than half of §F1's 44px minimum on a coarse pointer. `min-h-11`
 * with `min-w-11` is the floor; `ghost` keeps it boxless until it is touched,
 * which is what "quiet" means here, and quiet is what keeps it from reading as
 * a second primary next to the filled one in the app bar (§B4). The icon is the
 * second, non-colour signal for the pressed state (§B4: never colour alone) —
 * `aria-pressed` carries it for assistive tech.
 *
 * ## Why the label can collapse
 *
 * Measured: «Все / Семейные / Мои» is 214.5px and «🗄 Показать архив» is
 * 151.8px. A 320px viewport leaves 288px of column and a 393px iPhone leaves
 * 361px — so the pair needs 374px of column and does not fit on either. The
 * arithmetic puts the crossover at 406px; the breakpoint is **420px**, which
 * keeps 13.7px of slack at its own edge and more above it.
 *
 * Something has to give below that, and it is not the tabs — a truncated
 * «Семейн…» costs the user the filter they are standing in. So a row that also
 * carries tabs drops the label to `text-[0px]`: zero width, still in the DOM,
 * so the **accessible name is unchanged** and the icon-only button is still
 * «Показать архив» to a screen reader and to every test that queries it by
 * name. This is the same collapse `PageHeader` already performs on the app-bar
 * action, for the same reason.
 *
 * A row with **no** tabs has the whole column to itself and keeps its label at
 * every width — Покупки has no scope filter, and an unlabelled icon alone above
 * an empty list would be a worse riddle than the one this change fixes. One
 * component, one rule; the two screens differ only where their inputs do.
 *
 * The archive being empty is a state the control must speak for. Otherwise the
 * user presses «Показать архив», nothing moves, and the button reads as broken
 * — which is precisely what Копилки did, and Копилки has no way to archive a
 * goal at all, so it was the *only* thing it ever did.
 */
export function ArchiveToggle(props: {
  expanded: boolean;
  onToggle: () => void;
  /** «Показать архив» */
  showLabel: string;
  /** «Скрыть архив» */
  hideLabel: string;
  /**
   * The screen's segmented tabs, rendered at the left of the same row. Omit it
   * on a screen that has no filter — the control then owns the row alone and
   * keeps its label at every width.
   */
  tabs?: ReactNode;
  /**
   * Rendered under the control while it is expanded and the archive turned out
   * to hold nothing. Omit it when there is something to show.
   */
  emptyHint?: string;
  className?: string;
}) {
  const Icon = props.expanded ? ArchiveX : Archive;
  const label = props.expanded ? props.hideLabel : props.showLabel;
  // Only a row that has to seat tabs as well can run out of room at 320px.
  const crowded = props.tabs !== undefined;

  return (
    <div className={cn('flex max-w-row-measure flex-col items-stretch', props.className)}>
      <div className="flex items-center gap-2">
        {props.tabs}

        <Button
          type="button"
          variant="ghost"
          aria-pressed={props.expanded}
          onClick={props.onToggle}
          // 44px in both axes (§F1) — `min-w-11` is what keeps the collapsed,
          // icon-only form a legal target. `has-[>svg]:px-4` re-states the
          // padding the button's own `default` size drops to 12px as soon as an
          // icon is inside it, so the label keeps the section headings' gutter.
          className={cn(
            'ml-auto min-h-11 min-w-11 shrink-0 px-4 text-[13px] leading-[18px] font-medium text-muted-foreground has-[>svg]:px-4',
            crowded && 'max-[419px]:gap-0 max-[419px]:px-0 max-[419px]:has-[>svg]:px-0',
          )}
        >
          <Icon className="size-4" aria-hidden />
          {/*
            `text-[0px]`, not `hidden`: the word stays in the accessibility tree
            and in the DOM, so the button's accessible name never changes with
            the viewport. Same device as `PageHeader`'s app-bar collapse.
          */}
          <span className={cn(crowded && 'max-[419px]:text-[0px]')}>{label}</span>
        </Button>
      </div>

      {props.expanded && props.emptyHint !== undefined ? (
        <p className="px-4 pt-1 text-[13px] leading-[18px] font-medium text-pretty text-muted-foreground">
          {props.emptyHint}
        </p>
      ) : null}
    </div>
  );
}
