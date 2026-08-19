import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, PiggyBank, Plus, Trophy, Users } from 'lucide-react';
import type { GoalResponse, PublicUser } from '@family/shared';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Card, CardContent } from '@/shared/ui/card';
import { formatMoney } from '@/shared/lib/format';
import { displayEmoji } from '@/shared/lib/emoji';
import { cn } from '@/shared/lib/utils';
import { GOALS_RU, GOAL_STATUS_RU, daysLeftLabel } from '../locale';
import { goalProgressPercent, remainingAmount, ringPercent } from '../money';
import { daysUntil } from '../dates';
import { goalDetailPath } from '../paths';
import { ContributorAvatars } from './ContributorAvatars';
import { ProgressRing } from './ProgressRing';
import { ContributeDialog } from './ContributeDialog';

/**
 * One goal, as a card in the grid.
 *
 * The brief for this screen is "a goal at 78 % should look like an
 * achievement": the ring dominates, the collected amount is the largest number
 * on the card, and the strip along the bottom fills with the goal's own colour
 * so a wall of cards reads as a wall of progress rather than a table.
 *
 * The whole card is a link to the detail page (a stretched `::after` over the
 * title), while the «Пополнить» button sits above it on its own layer — so the
 * common tap and the deliberate tap never fight.
 */
export function GoalCard(props: {
  goal: GoalResponse;
  roster: Map<string, PublicUser>;
  /** From `useGoalAbilities()` — never from a role check (D4). */
  canContribute: boolean;
}) {
  const [contributeOpen, setContributeOpen] = useState(false);
  const { goal } = props;

  const percent = goalProgressPercent(goal.currentAmount, goal.targetAmount);
  const remaining = remainingAmount(goal.currentAmount, goal.targetAmount);
  const reached = goal.status === 'reached' || goal.currentAmount >= goal.targetAmount;
  const muted = goal.status === 'archived' || goal.status === 'cancelled';
  const days = daysUntil(goal.deadline);
  const urgent = days !== null && days <= 14 && !reached;
  const accent = goal.color ?? 'var(--primary)';
  // Never `goal.icon` straight into the DOM: the field is free-form and older
  // rows hold a lucide icon *name*, which used to print as the word "palmtree".
  const emoji = displayEmoji(goal.icon);

  return (
    <>
      <Card
        className={cn(
          'group relative overflow-hidden py-0 transition-shadow duration-200 hover:shadow-md focus-within:ring-2 focus-within:ring-ring/50',
          muted && 'opacity-75',
        )}
      >
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="flex items-start gap-4">
            <ProgressRing
              percent={percent}
              size={88}
              color={accent}
              muted={muted}
              caption={reached ? undefined : GOALS_RU.progressLabel}
            />

            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-start gap-2">
                {goal.icon ? (
                  <span
                    aria-hidden
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-lg"
                    style={{ backgroundColor: `color-mix(in oklab, ${accent} 18%, transparent)` }}
                  >
                    {emoji ?? <PiggyBank className="size-4 text-muted-foreground" />}
                  </span>
                ) : null}
                <h3 className="min-w-0 text-base leading-snug font-semibold text-balance">
                  <Link
                    to={goalDetailPath(goal.id)}
                    className="rounded-sm outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
                  >
                    {goal.title}
                  </Link>
                </h3>
              </div>

              {/*
                The figure is `text-foreground`, not the goal's own colour. The
                colour is an *identity* — which goal this is — and it already says
                so on the ring and the strip below. Painting the headline number
                with a seeded sky-blue or emerald made the most important text on
                the card the least legible thing on it, and made two goals look
                like two different apps.
              */}
              <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <span className="text-lg font-semibold text-foreground tabular-nums">
                  {formatMoney(goal.currentAmount)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {GOALS_RU.of} {formatMoney(goal.targetAmount)}
                </span>
              </p>

              <p className="text-xs text-muted-foreground">
                {reached ? (
                  <span className="inline-flex items-center gap-1 font-medium text-success">
                    <Trophy className="size-3.5" aria-hidden />
                    {GOALS_RU.reachedBanner}
                  </span>
                ) : (
                  <>
                    {GOALS_RU.remaining}:{' '}
                    <span className="tabular-nums">{formatMoney(remaining)}</span>
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="gap-1 font-normal">
              <Users className="size-3" aria-hidden />
              {goal.ownerId === null ? GOALS_RU.sharedGoal : GOALS_RU.personalGoal}
            </Badge>
            {muted ? (
              <Badge variant="outline" className="font-normal">
                {GOAL_STATUS_RU[goal.status]}
              </Badge>
            ) : null}
            {goal.deadline ? (
              <Badge
                variant="outline"
                className={cn('gap-1 font-normal', urgent && 'border-warning text-warning')}
              >
                <CalendarDays className="size-3" aria-hidden />
                {days === null ? goal.deadline : daysLeftLabel(days)}
              </Badge>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3">
            {/* `contributors` only exists on the detail response — a card must
                not assume it is there. */}
            <ContributorAvatars
              contributors={goal.contributors}
              roster={props.roster}
              showTotalLine
            />
            {props.canContribute && !muted ? (
              <Button
                type="button"
                size="sm"
                className="relative z-10 ml-auto h-11 min-w-11 gap-1.5 px-4"
                onClick={() => {
                  setContributeOpen(true);
                }}
              >
                <Plus className="size-4" aria-hidden />
                {GOALS_RU.contribute}
              </Button>
            ) : null}
          </div>
        </CardContent>

        {/* The progress strip: a wall of these is a wall of progress.
            `rounded-b-xl` matches the card so the fill follows the corner
            instead of squaring it off against the card's own border. */}
        <div className="h-1.5 w-full overflow-hidden rounded-b-xl bg-secondary" aria-hidden>
          <div
            className="h-full transition-[width] duration-700 ease-out"
            style={{ width: `${String(ringPercent(percent))}%`, backgroundColor: accent }}
          />
        </div>
      </Card>

      {props.canContribute ? (
        <ContributeDialog
          goal={goal}
          mode="contribute"
          open={contributeOpen}
          onOpenChange={setContributeOpen}
        />
      ) : null}
    </>
  );
}
