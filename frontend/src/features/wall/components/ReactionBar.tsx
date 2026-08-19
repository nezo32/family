import { useState } from 'react';
import { SmilePlus } from 'lucide-react';
import type { EntityRef, ReactionSummary } from '@family/shared';
import { useCan } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { cn } from '@/shared/lib/utils';
import { useReactionState, useToggleReaction } from '../hooks';
import { REACTION_EMOJI, WALL_RU } from '../locale';

/**
 * Emoji reactions for any commentable target.
 *
 * The toggle is optimistic: the counter moves on the tap and rolls back if the
 * request fails (see `useToggleReaction`). The server endpoint is idempotent
 * and answers with the fresh summary, so an offline double-tap converges rather
 * than oscillating.
 *
 * Reacting needs `kudos:give` — a guest sees the counts and no controls.
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
    <div className={cn('flex flex-wrap items-center gap-1.5', props.className)}>
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
                'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors',
                'disabled:cursor-default disabled:opacity-70',
                summary.reacted
                  ? 'border-primary/40 bg-primary/10 text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:bg-accent',
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
              className="min-h-9 rounded-full px-2.5 text-muted-foreground"
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

/**
 * Who is behind a chip.
 *
 * The summary contract carries `count` and "did I react", not the reactor ids,
 * so this says as much as is actually known. When the backend starts returning
 * reactor ids this is the one place that has to change.
 */
export function reactorLabel(summary: ReactionSummary): string {
  if (!summary.reacted) {
    return summary.count > 0 ? WALL_RU.reactions.others(summary.count) : WALL_RU.reactions.nobody;
  }
  const others = summary.count - 1;
  return others > 0 ? WALL_RU.reactions.youAndOthers(others) : WALL_RU.reactions.you;
}
