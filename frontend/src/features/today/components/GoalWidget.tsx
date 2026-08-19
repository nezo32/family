import { PiggyBank } from 'lucide-react';
import { ROUTES } from '@/shared/lib/routes';
import { formatDateShort, formatMoney } from '@/shared/lib/format';
import { Progress } from '@/shared/ui/progress';
import { TODAY_RU } from '../locale';
import type { DashboardMilestone } from '../types';
import { WidgetCard } from './WidgetCard';

/**
 * The nearest savings milestone.
 *
 * This card is finance, so it renders **only** behind `goal:read` — a child
 * holds no `goal:*` permission at all (D4) and must never see a rouble figure
 * on the home screen. The page owns that gate, and the server sends `null` for
 * the same caller; this component assumes both passed.
 *
 * Every amount arrives as integer minor units and is formatted exactly once,
 * here, by `formatMoney` (D6).
 */
export function GoalWidget(props: { milestone: DashboardMilestone | null }) {
  const milestone = props.milestone;

  if (!milestone) {
    return (
      <WidgetCard title={TODAY_RU.goalTitle} icon={PiggyBank} tone="quiet">
        <p className="py-2 text-sm text-muted-foreground">{TODAY_RU.goalEmpty}</p>
      </WidgetCard>
    );
  }

  const reached = milestone.remainingAmount <= 0;

  return (
    <WidgetCard
      title={TODAY_RU.goalTitle}
      icon={PiggyBank}
      meta={`${String(milestone.progressPercent)} %`}
      linkTo={ROUTES.goals}
      linkLabel={TODAY_RU.goalAll}
    >
      <p className="truncate text-sm font-medium text-foreground">{milestone.title}</p>
      {milestone.title !== milestone.goalTitle ? (
        <p className="truncate text-xs text-muted-foreground">{milestone.goalTitle}</p>
      ) : null}

      <Progress value={milestone.progressPercent} className="mt-3 h-2.5" aria-label={milestone.title} />

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-foreground">
          {formatMoney(milestone.savedAmount, { currency: milestone.currency })}
        </span>
        <span className="text-xs text-muted-foreground">
          {reached
            ? TODAY_RU.goalReached
            : `${TODAY_RU.goalRemaining} ${formatMoney(milestone.remainingAmount, {
                currency: milestone.currency,
              })}`}
        </span>
      </div>

      {milestone.deadline ? (
        <p className="pt-1 text-xs text-muted-foreground">
          {/* A bare `YYYY-MM-DD` parses as midnight UTC and then renders as the
              previous day west of Greenwich. Noon UTC survives every zone. */}
          {TODAY_RU.goalDeadline} {formatDateShort(`${milestone.deadline}T12:00:00Z`)}
        </p>
      ) : null}
    </WidgetCard>
  );
}
