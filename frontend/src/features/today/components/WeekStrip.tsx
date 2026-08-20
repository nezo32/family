import { Link } from 'react-router-dom';
import { ROUTES } from '@/shared/lib/routes';
import { WEEKDAYS_SHORT } from '@/shared/lib/i18n';
import { Section } from '@/shared/ui/section';
import { DayRailRow } from '@/shared/ui/day-rail';
import { cn } from '@/shared/lib/utils';
import { TODAY_RU, eventCount, taskCount } from '../locale';
import type { DashboardWeekDay, WeekResponse } from '../types';

/**
 * «Неделя» — seven compact day rows, the side column's first block (§C4).
 *
 * ```
 *  пн 17 │ 2 дела · 1 событие
 *  вт 18 │ свободно
 *  ср 19 │ 1 дело
 * ```
 *
 * This is the block that answers "is this week going to be bad" without
 * leaving the home screen, and it is the reason the side column is not filler:
 * the data was already being fetched (`GET /dashboard/week`) and spent on a
 * single line of text at the bottom of a card.
 *
 * **What it deliberately is not.** The thing that used to sit in this slot was
 * «Ваша неделя» — my own `doneCount` and my `sharePercent` as a bar and two
 * stat tiles. A number attached to a person that goes up when they do chores is
 * a scoreboard however it is labelled (D5), and it was the last survivor of the
 * removed points system. The week ahead is a *schedule*, not a tally: it counts
 * what is coming, for the whole family, and nobody's name appears on it.
 *
 * ## Why it is desktop-only
 *
 * §C4's rule is that the side column collapses to the bottom of the main
 * column below the two-column breakpoint rather than disappearing — and that is
 * right for Копилка and Заявки, which the phone layout in §D1 does show. It is
 * wrong for this one: seven more rows at the bottom of the phone screen is
 * ~230px against a 1100px budget, spent on the least urgent thing here. So the
 * strip is hidden below 1088px rather than moved. It is an *enrichment* of the
 * wide layout, which is exactly what a side column is supposed to be.
 */
export function WeekStrip(props: { week: WeekResponse | undefined }) {
  const days = props.week?.days ?? [];
  if (days.length === 0) return null;

  return (
    <div className="hidden min-[1088px]:block">
      <Section
        label={TODAY_RU.weekTitle}
        action={
          <Link
            to={ROUTES.calendar}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {TODAY_RU.linkEverything} ›
          </Link>
        }
      >
        {days.map((day) => (
          <WeekDayRow key={day.date} day={day} />
        ))}
      </Section>
    </div>
  );
}

function WeekDayRow(props: { day: DashboardWeekDay }) {
  const { day } = props;
  const weekday = WEEKDAYS_SHORT[day.weekday] ?? '';
  // `date` is a family-local calendar date (`YYYY-MM-DD`), so the day number is
  // read straight out of the string. Parsing it into a `Date` to call
  // `getDate()` would re-introduce the timezone shift the contract already
  // resolved (D2).
  const dayOfMonth = Number(day.date.slice(8, 10));

  const parts = [
    day.tasks.length > 0 ? taskCount(day.tasks.length) : null,
    day.events.length > 0 ? eventCount(day.events.length) : null,
  ].filter((part): part is string => part !== null);

  return (
    <DayRailRow
      rail={
        <span className={cn(day.isToday && 'text-foreground')}>
          {weekday} {dayOfMonth}
        </span>
      }
      contentClassName="min-h-11"
    >
      <span
        className={cn(
          'truncate text-[15px] leading-[22px]',
          parts.length > 0 ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {parts.length > 0 ? parts.join(' · ') : TODAY_RU.weekNothing}
      </span>
    </DayRailRow>
  );
}
