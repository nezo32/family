import { PiggyBank } from 'lucide-react';
import { ROUTES } from '@/shared/lib/routes';
import { formatDateShort, formatMoney } from '@/shared/lib/format';
import { Progress } from '@/shared/ui/progress';
import { TODAY_RU } from '../locale';
import type { TodayGoalSection } from '../types';
import { WidgetCard } from './WidgetCard';

/**
 * The nearest savings milestone.
 *
 * This card is finance, so it is rendered **only** behind `goal:read` — a child
 * holds no `goal:*` permission at all (D4) and must never see a rouble figure
 * on the home screen. The page owns that gate; this component assumes it passed.
 *
 * Every amount arrives as integer minor units and is formatted exactly once,
 * here, by `formatMoney` (D6).
 */
export function GoalWidget(props: { goal: TodayGoalSection }) {
  const { goal } = props;
  const reached = goal.remainingAmount <= 0;
  const label = goal.milestoneTitle ?? goal.goalTitle;

  return (
    <WidgetCard
      title={TODAY_RU.goalTitle}
      icon={PiggyBank}
      meta={`${String(goal.progressPercent)} %`}
      linkTo={ROUTES.goals}
      linkLabel={TODAY_RU.goalAll}
    >
      <p className="truncate text-sm font-medium text-foreground">{label}</p>
      {goal.milestoneTitle ? (
        <p className="truncate text-xs text-muted-foreground">{goal.goalTitle}</p>
      ) : null}

      <Progress
        value={Math.min(100, goal.progressPercent)}
        className="mt-3 h-2.5"
        aria-label={label}
      />

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-foreground">
          {formatMoney(goal.currentAmount, { currency: goal.currency })}
        </span>
        <span className="text-xs text-muted-foreground">
          {reached
            ? TODAY_RU.goalReached
            : `${TODAY_RU.goalRemaining} ${formatMoney(goal.remainingAmount, {
                currency: goal.currency,
              })}`}
        </span>
      </div>

      {goal.deadline ? (
        <p className="pt-1 text-xs text-muted-foreground">
          {/* A bare `YYYY-MM-DD` parses as midnight UTC and then renders as the
              previous day west of Greenwich. Noon UTC survives every zone. */}
          {TODAY_RU.goalDeadline} {formatDateShort(`${goal.deadline}T12:00:00Z`)}
        </p>
      ) : null}
    </WidgetCard>
  );
}
