import { useState } from 'react';
import { SmilePlus } from 'lucide-react';
import type { EntityRef, ReactionSummary } from '@family/shared';
import { useCan } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { MemberDiscGroup } from '@/shared/ui/member-disc';
import { cn } from '@/shared/lib/utils';
import { useReactionState, useRoster, useToggleReaction, type Roster } from '../hooks';
import { REACTION_EMOJI, WALL_RU, reactorLabel, reactorMembers } from '../locale';

/**
 * Reactions — **faces, never digits** (§D7.7, D13).
 *
 * ```
 * ❤️ (М)(Л)   👍 (П)   ☺+
 * ```
 *
 * On a board a per-note count was defensible: it belonged to a note rather
 * than to a person, and notes were grouped by kind. In a feed that argument
 * weakens, and it weakens because of the redesign itself — cards by different
 * authors are now adjacent, in one column, with the count at a fixed position
 * on every card. «❤️ 3» under Мама's note sitting 120px above «❤️ 1» under
 * Лизы's is a comparison the reader performs without any effort at all, and
 * the child reading the smaller number learns the same wrong thing D5 removed
 * the points to prevent.
 *
 * The alternative is not "no signal". With six people in the family the useful
 * fact was never the quantity — it is **who**.
 *
 * > **Rule.** A reaction renders as its emoji plus the discs of the people who
 * > used it. No digit anywhere: not on the chip, not in a tooltip, not in a
 * > `title`, not in an `aria-label`.
 *
 * The accessible name is exactly what is drawn — «❤️ — Мама, Лиза» — because a
 * screen-reader-only count is precisely how this crept back last time: a load
 * bar on Семья read «40 % (своя доля 33 %)» aloud while drawing no numbers at
 * all. `wall.test.tsx` asserts the rendered subtree contains no per-person
 * digit, markup included.
 *
 * Two details that are not decoration:
 *
 * - `MemberDiscGroup` is capped at the family size, so «+N» never renders. Six
 *   people is the bound that makes this work — the worst case is five emoji
 *   with one disc each, ≈260px, one line at 358px. This design does not
 *   generalise past a household and does not have to.
 * - A reader without `kudos:give` (a guest) gets the chips as **static text**,
 *   not disabled buttons: a control that can be focused and pressed to no
 *   effect is worse than no control.
 */

/** Six people, and «+N» must never render — see the note above. */
const DISC_CAP = 12;

export function ReactionBar(props: {
  target: EntityRef;
  reactions: readonly ReactionSummary[];
  /** Passed in where the card already holds one; fetched otherwise. */
  roster?: Roster;
  className?: string;
}) {
  const fallbackRoster = useRoster();
  const roster = props.roster ?? fallbackRoster;
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
      {summaries.map((summary) => {
        const members = reactorMembers(summary, roster);
        const label = reactorLabel(summary, (id) => roster.byId.get(id)?.displayName);
        const face = (
          <>
            <span aria-hidden className="text-base leading-none">
              {summary.emoji}
            </span>
            {members.length > 0 ? (
              <MemberDiscGroup members={members} max={DISC_CAP} size="sm" />
            ) : null}
          </>
        );

        // Nobody may react here: the chip is a statement, not a control.
        if (!mayReact) {
          return (
            <span
              key={summary.emoji}
              role="img"
              aria-label={label}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-transparent px-2.5"
            >
              {face}
            </span>
          );
        }

        return (
          <button
            key={summary.emoji}
            type="button"
            onClick={() => {
              react(summary.emoji);
            }}
            aria-pressed={summary.reacted}
            aria-label={label}
            className={cn(
              // Every chip carries a border, transparent when unreacted, so
              // toggling one does not shift the row it sits in by 2px.
              'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-2.5',
              'text-[13px] leading-[18px] font-medium transition-colors',
              'touch-manipulation no-callout',
              summary.reacted
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-muted/60',
            )}
          >
            {face}
          </button>
        );
      })}

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
