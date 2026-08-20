import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, ChevronRight, PiggyBank, Plus } from 'lucide-react';
import type { GoalResponse, PublicUser } from '@family/shared';
import { ActionSheet, type ActionSheetItem } from '@/shared/ui/action-sheet';
import { useCoarsePointer } from '@/shared/ui/use-coarse-pointer';
import { useLongPress } from '@/shared/ui/use-long-press';
import { formatMoney } from '@/shared/lib/format';
import { displayEmoji } from '@/shared/lib/emoji';
import { memberSlot } from '@/shared/ui/member-disc';
import { cn } from '@/shared/lib/utils';
import { GOALS_RU, GOAL_STATUS_RU, daysLeftLabel } from '../locale';
import { goalProgressPercent, ringPercent } from '../money';
import { daysUntil } from '../dates';
import { goalDetailPath } from '../paths';
import { useGoalAbilities } from '../hooks';
import { ContributorAvatars } from './ContributorAvatars';
import { ContributeDialog } from './ContributeDialog';

/**
 * One goal, as a **row** (§D4).
 *
 * ```
 *  🏕  Поездка в Карелию                                          63 %
 *      ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░
 *      112 500 из 180 000 ₽ · до 01.06                    (П)(М)   ›
 * ```
 *
 * ## One indicator, not two
 *
 * The card this replaces carried a **percentage ring at the top-left and a
 * progress bar glued to the bottom edge** — two drawings of one number, per
 * card, three cards to a screen. That is the data-dashboard furniture §A rules
 * out in as many words. The bar wins because it is the shape that reads at a
 * glance in a stack: five bars in a column can be compared with one eye
 * movement, five rings cannot. The ring survives on the goal *detail* screen,
 * where it is the hero and there is no bar next to it.
 *
 * ## «Пополнить» is not on the row
 *
 * It used to be, and because each card's title wrapped to a different number of
 * lines the button floated at a different height in every card. More
 * importantly it is a second filled primary in a list of them (§B4: one per
 * view). Contributing is the primary action of the goal's own screen, which is
 * one tap away — and the row itself is that tap.
 *
 * ## Gestures (§C-gestures)
 *
 * **No swipe.** §G4's table names exactly three row types — shopping items,
 * chores and notifications — and a goal has no one-tap reversible action to put
 * on a gesture. «Пополнить» writes to an append-only ledger; the only reversal
 * is a second, visible transaction, so it fails the "swipe carries the
 * reversible action or nothing" rule.
 *
 * **Long-press** brings «Пополнить» back as a shortcut, in a sheet, beside
 * «Открыть копилку». Both live on the goal's own screen as well, which is what
 * keeps §G1 true — nothing here is reachable only by gesture.
 */
export function GoalCard(props: {
  goal: GoalResponse;
  roster: Map<string, PublicUser>;
  /** Unused now that «Пополнить» lives on the detail screen. Kept for the caller's signature. */
  canContribute?: boolean;
}) {
  const { goal } = props;
  const navigate = useNavigate();
  const coarse = useCoarsePointer();
  const { canContribute } = useGoalAbilities();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [contributing, setContributing] = useState(false);
  const longPress = useLongPress({
    onLongPress: () => {
      setSheetOpen(true);
    },
  });

  const percent = goalProgressPercent(goal.currentAmount, goal.targetAmount);
  const reached = goal.status === 'reached' || goal.currentAmount >= goal.targetAmount;
  const muted = goal.status === 'archived' || goal.status === 'cancelled';
  const days = daysUntil(goal.deadline);
  const urgent = days !== null && days <= 14 && !reached;
  // A stored colour is honoured (a family may have picked one); the fallback is
  // the theme's five-colour ramp rather than a free hue, so a wall of goals
  // stays inside the palette (§B1/§B4).
  const accent = goal.color ?? `var(--chart-${String(memberSlot(goal.id))})`;
  // Never `goal.icon` straight into the DOM: the field is free-form and older
  // rows hold a lucide icon *name*, which used to print as the word "palmtree".
  const emoji = displayEmoji(goal.icon);

  /**
   * «70 000 ₽ из 200 000 ₽ · до 01.06» — and deliberately **not** the remaining
   * amount as well. «осталось собрать 130 000 ₽» is the same fact as the two
   * figures beside it and the percentage above them: a third statement of one
   * number, which at 393px pushed the deadline off the end of the line
   * entirely. It survives on the goal's own screen, where there is room for it
   * to be the headline.
   */
  const meta = [
    `${formatMoney(goal.currentAmount)} ${GOALS_RU.of} ${formatMoney(goal.targetAmount)}`,
    muted ? GOAL_STATUS_RU[goal.status] : null,
  ].filter((part): part is string => part !== null);

  const live = goal.status === 'active' || goal.status === 'reached';
  const items: ActionSheetItem[] = [];
  if (canContribute && live) {
    items.push({
      id: 'contribute',
      label: GOALS_RU.contribute,
      icon: Plus,
      onSelect: () => {
        setContributing(true);
      },
    });
  }
  items.push({
    id: 'open',
    label: GOALS_RU.openGoal,
    icon: ChevronRight,
    onSelect: () => {
      void navigate(goalDetailPath(goal.id));
    },
  });

  return (
    <>
      <Link
        to={goalDetailPath(goal.id)}
        /*
         * Only on a thumb (§G2). The touch handlers would never fire for a
         * mouse anyway, but `onContextMenu` would — and swallowing right-click
         * on a desktop is a gesture nobody asked for.
         */
        {...(coarse ? longPress.handlers : {})}
        className={cn(
          'block w-full max-w-row-measure px-4 py-3 transition-colors no-callout',
          'hover:bg-muted/40 active:bg-muted/60',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          muted && 'opacity-70',
        )}
      >
        <span className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-lg"
            style={{ backgroundColor: `color-mix(in oklab, ${accent} 18%, transparent)` }}
          >
            {emoji ?? <PiggyBank className="size-4 text-muted-foreground" />}
          </span>

          <span className="min-w-0 flex-1 truncate text-[17px] leading-6 font-medium text-foreground">
            {goal.title}
          </span>

          {reached ? (
            <span className="flex shrink-0 items-center gap-1 text-[13px] leading-[18px] font-medium text-success">
              <CheckCircle2 className="size-4" aria-hidden />
              {GOALS_RU.reachedShort}
            </span>
          ) : (
            <span className="shrink-0 text-[13px] leading-[18px] font-medium text-muted-foreground tabular-nums">
              {percent} %
            </span>
          )}

          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </span>

        {/* The one indicator. 6px, the goal's own colour, inset inside the row's
          padding so it can never collide with the surface's own radius. */}
        {reached ? null : (
          <span
            className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-secondary"
            role="img"
            aria-label={`${goal.title}: ${String(percent)} %`}
          >
            <span
              className="block h-full rounded-full transition-[width] duration-700 ease-out"
              style={{ width: `${String(ringPercent(percent))}%`, backgroundColor: accent }}
            />
          </span>
        )}

        <span className="mt-1.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-medium text-muted-foreground tabular-nums">
            {meta.join(' · ')}
            {goal.deadline ? (
              <>
                {' · '}
                <span className={cn(urgent && 'text-warning')}>
                  {days === null ? goal.deadline : daysLeftLabel(days)}
                </span>
              </>
            ) : null}
          </span>

          {/* `contributors` only exists on the detail response — a row must not
            assume it is there. */}
          <ContributorAvatars contributors={goal.contributors} roster={props.roster} max={3} />
        </span>
      </Link>

      {/*
        Siblings of the row, never children of the `<Link>`: a React portal still
        bubbles its events through the React tree, so a sheet rendered inside the
        anchor would route every tap in it back through that anchor. Neither
        renders a DOM node while closed, so `Section`'s `[&>*+*]` hairline still
        sees exactly one child.
      */}
      <ActionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={goal.title}
        description={GOALS_RU.rowSheet}
        items={items}
      />
      {contributing ? (
        <ContributeDialog
          goal={goal}
          mode="contribute"
          open
          onOpenChange={(next) => {
            if (!next) setContributing(false);
          }}
        />
      ) : null}
    </>
  );
}
