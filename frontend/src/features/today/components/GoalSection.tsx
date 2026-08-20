import { Link } from 'react-router-dom';
import { ROUTES } from '@/shared/lib/routes';
import { formatMoney } from '@/shared/lib/format';
import { Section } from '@/shared/ui/section';
import { TODAY_RU } from '../locale';
import type { DashboardMilestone } from '../types';

/**
 * The nearest savings milestone — **one** indicator (§D1, §A "what it rules
 * out").
 *
 * The card this replaces carried a percentage in the header *and* a progress
 * bar underneath: two indicators for one number, which is the exact
 * data-dashboard furniture the direction rules out. The bar survives; the
 * duplicate goes.
 *
 * This is finance, so it renders **only** behind `goal:read` — a child holds no
 * `goal:*` permission at all (D4) and must never see a rouble figure on the
 * home screen. The page owns that gate and the server sends `null` for the same
 * caller; this component assumes both passed.
 *
 * Every amount arrives as integer minor units and is formatted exactly once,
 * here, by `formatMoney` (D6).
 *
 * When there is no active goal this renders nothing at all. The old build gave
 * a whole surface to «Пока нет активных копилок» — a card that occupies 96px to
 * say that a thing the reader was not asking about does not exist.
 */
export function GoalSection(props: { milestone: DashboardMilestone | null }) {
  const milestone = props.milestone;
  if (!milestone) return null;

  const reached = milestone.remainingAmount <= 0;
  // A visual bound only: an over-funded goal still *reads* «112 %» beside the
  // bar, because that is the true number and a bar cannot draw it.
  const fill = Math.max(0, Math.min(100, milestone.progressPercent));
  const money = { currency: milestone.currency };

  return (
    <Section
      label={TODAY_RU.goalTitle}
      action={
        <Link
          to={ROUTES.goals}
          className="rounded-sm underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {TODAY_RU.linkAll} ›
        </Link>
      }
      divided={false}
    >
      <Link
        to={ROUTES.goals}
        className="block w-full max-w-row-measure px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[17px] leading-6 font-medium text-foreground">
            {milestone.title}
          </span>
          <span className="shrink-0 text-[13px] leading-[18px] font-medium text-muted-foreground tabular-nums">
            {milestone.progressPercent} %
          </span>
        </span>

        {milestone.title !== milestone.goalTitle ? (
          <span className="block truncate text-[13px] leading-[18px] font-medium text-muted-foreground">
            {milestone.goalTitle}
          </span>
        ) : null}

        <span
          className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-secondary"
          role="img"
          aria-label={`${milestone.title}: ${String(milestone.progressPercent)} %`}
        >
          <span
            className="block h-full rounded-full bg-primary"
            style={{ width: `${String(fill)}%` }}
          />
        </span>

        <span className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 text-[13px] leading-[18px] font-medium tabular-nums">
          <span className="text-foreground">{formatMoney(milestone.savedAmount, money)}</span>
          <span className="text-muted-foreground">
            {reached
              ? TODAY_RU.goalReached
              : `${TODAY_RU.goalRemaining} ${formatMoney(milestone.remainingAmount, money)}`}
          </span>
        </span>
      </Link>
    </Section>
  );
}
