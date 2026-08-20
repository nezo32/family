import { Archive, ArchiveX } from 'lucide-react';

import { Button } from '../ui/button';
import { cn } from '../lib/utils';

/**
 * «Показать архив» / «Скрыть архив» — the one way this app reveals archived
 * rows, shared by Копилки and Покупки so the two cannot drift again.
 *
 * ## Why it lives at the bottom of the list
 *
 * §C2 gives every screen four bands and puts "counts, links, hints — meta, no
 * box" in band 4, at the bottom. §D5 says the same thing about this exact
 * control by name: it "is currently a right-aligned orphan above the first row.
 * Move it to the bottom of the list as a quiet `meta` link."
 *
 * That is not only the spec's word against the build's. Measured on Покупки at
 * 320 × 800 with one archived list: the control sat at y = 427 and the row it
 * reveals appeared at y ≈ 1100 — you press at the top and the screen changes
 * two viewports below your thumb, out of sight. At the bottom the revealed rows
 * land directly above the control that revealed them. It also stops the toggle
 * being a second right-aligned button stacked immediately under the screen's
 * one filled primary in the app bar (§B4).
 *
 * ## Why it is a button and not a bare link
 *
 * The Копилки copy of this was a bare `<button>` of 13px text: **128 × 18 px**,
 * measured — less than half of §F1's 44px minimum on a coarse pointer, on a
 * control that lives at the very bottom of a scrolling page. `min-h-11` is the
 * floor; `ghost` keeps it boxless until it is touched, which is what "quiet"
 * means here. The icon is the second, non-colour signal for the pressed state
 * (§B4: never colour alone) — `aria-pressed` carries it for assistive tech.
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
   * Rendered under the control while it is expanded and the archive turned out
   * to hold nothing. Omit it when there is something to show.
   */
  emptyHint?: string;
  className?: string;
}) {
  const Icon = props.expanded ? ArchiveX : Archive;

  return (
    <div className={cn('flex max-w-row-measure flex-col items-start', props.className)}>
      <Button
        type="button"
        variant="ghost"
        aria-pressed={props.expanded}
        onClick={props.onToggle}
        // 44px (§F1). `has-[>svg]:px-4` re-states the padding the button's own
        // `default` size drops to 12px as soon as an icon is inside it, so the
        // label starts on the same 16px gutter as the section headings above.
        className="min-h-11 px-4 text-[13px] leading-[18px] font-medium text-muted-foreground has-[>svg]:px-4"
      >
        <Icon className="size-4" aria-hidden />
        {props.expanded ? props.hideLabel : props.showLabel}
      </Button>

      {props.expanded && props.emptyHint !== undefined ? (
        <p className="px-4 pt-1 text-[13px] leading-[18px] font-medium text-pretty text-muted-foreground">
          {props.emptyHint}
        </p>
      ) : null}
    </div>
  );
}
