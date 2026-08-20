import { useState } from 'react';
import { SmilePlus } from 'lucide-react';
import type { EntityRef, ReactionSummary } from '@family/shared';
import { useCan } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { cn } from '@/shared/lib/utils';
import { useReactionState, useToggleReaction } from '../hooks';
import { REACTION_EMOJI, WALL_RU, reactorLabel } from '../locale';

/**
 * Emoji reactions for any note on the board.
 *
 * The toggle is optimistic: the counter moves on the tap and rolls back if the
 * request fails (see `useToggleReaction`). The server endpoint is idempotent
 * and answers with the fresh summary, so an offline double-tap converges rather
 * than oscillating. The digit width is reserved with `tabular-nums` so a count
 * going 9 → 10 does not shift the row (§D7).
 *
 * ## The one count on this screen that is allowed to exist
 *
 * D5 removes scores, and «Спасибо» prints no per-person total at all. A
 * reaction count is a different object: it belongs to a *note*, not to a
 * person, it cannot be accumulated across the family, and nothing sorts by it.
 * The accessible name is exactly what is drawn — «❤️ 3» — so a screen reader
 * hears the screen rather than a hidden tally; the tooltip adds «Вы и ещё 2»,
 * which is the same sentence a sighted reader gets on hover.
 *
 * Reacting needs `kudos:give`, which a guest does not hold: they see the counts
 * and no controls.
 */
export function ReactionBar(props: {
  target: EntityRef;
  reactions: readonly ReactionSummary[];
  className?: string;
}) {
  const summaries = useReactionState(props.target, props.reactions);
  const toggle = useToggleReaction(props.target);
  const { can } = useCan();
  const [pickerOpen, setPickerOpen] = useState(false);

  const mayReact = can('kudos:give');

  const react = (emoji: string): void => {
    setPickerOpen(false);
    toggle.mutate(emoji);
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-1', props.className)}>
      {summaries.map((summary) => (
        <Tooltip key={summary.emoji}>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={!mayReact}
              onClick={() => {
                react(summary.emoji);
              }}
              aria-pressed={summary.reacted}
              aria-label={`${summary.emoji} ${String(summary.count)}`}
              className={cn(
                // Every chip carries a border, transparent when unreacted, so
                // toggling one does not shift the row it sits in by 2px.
                'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-2.5',
                'text-[13px] leading-[18px] font-medium transition-colors',
                'touch-manipulation no-callout',
                'disabled:cursor-default disabled:opacity-70',
                summary.reacted
                  ? 'border-primary/40 bg-primary/10 text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-muted/60',
              )}
            >
              <span aria-hidden className="text-base leading-none">
                {summary.emoji}
              </span>
              <span className="tabular-nums">{summary.count}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{reactorLabel(summary)}</TooltipContent>
        </Tooltip>
      ))}

      {mayReact ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="size-11 rounded-full p-0 text-muted-foreground"
              aria-label={WALL_RU.reactions.addAria}
            >
              <SmilePlus className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-1.5">
            <div className="flex items-center gap-0.5">
              {REACTION_EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    react(emoji);
                  }}
                  aria-label={emoji}
                  className="flex size-11 items-center justify-center rounded-md text-xl hover:bg-accent"
                >
                  <span aria-hidden>{emoji}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
