import type { EventOccurrenceResponse } from '@family/shared';
import { WEEKDAYS_SHORT } from '@/shared/lib/i18n';
import { cn } from '@/shared/lib/utils';
import {
  buildMonthGrid,
  dayOfMonth,
  monthKeyOf,
  sundayWeekdayIndex,
  todayKey,
  type DateKey,
  type MonthKey,
} from '../calendar-model';
import { CALENDAR_RU } from '../locale';
import { EventChip, EventDot } from './EventChip';

const CHIPS_PER_CELL = 3;

/**
 * The month grid, Monday first (`WEEK_STARTS_ON` in `shared/lib/i18n`).
 *
 * Every cell is one button: it is the only tap target that can be ≥ 44 px on a
 * phone, and selecting a day is what reveals the readable rows underneath.
 * Below `sm` the chips collapse to coloured dots — a 45 px column cannot show
 * a title, and pretending otherwise is how a month grid becomes unusable.
 */
export function MonthGrid(props: {
  monthKey: MonthKey;
  byDay: Map<DateKey, EventOccurrenceResponse[]>;
  selectedDay: DateKey;
  onSelectDay: (dateKey: DateKey) => void;
  timeZone: string;
}) {
  const weeks = buildMonthGrid(props.monthKey);
  const today = todayKey(props.timeZone);

  return (
    <div className="max-w-row-measure overflow-hidden rounded-xl border border-border bg-border">
      <div className="grid grid-cols-7 gap-px">
        {weeks[0]?.map((dateKey) => (
          <div
            key={`head-${dateKey}`}
            className="bg-muted/70 py-1.5 text-center text-[11px] font-medium text-muted-foreground"
          >
            {WEEKDAYS_SHORT[sundayWeekdayIndex(dateKey)]}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-px">
        {weeks.flat().map((dateKey) => {
          const items = props.byDay.get(dateKey) ?? [];
          const inMonth = monthKeyOf(dateKey) === props.monthKey;
          const isToday = dateKey === today;
          const isSelected = dateKey === props.selectedDay;
          const overflow = items.length - CHIPS_PER_CELL;

          return (
            <button
              key={dateKey}
              type="button"
              aria-pressed={isSelected}
              aria-current={isToday ? 'date' : undefined}
              data-testid="month-cell"
              data-date={dateKey}
              onClick={() => {
                props.onSelectDay(dateKey);
              }}
              className={cn(
                'flex min-h-11 min-w-0 flex-col items-stretch gap-0.5 bg-card p-1 text-left transition-colors sm:min-h-24',
                'focus-visible:z-10 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                // Recede, don't darken. `bg-muted/35` gave the days that are not
                // in this month a *heavier* fill than the days that are, so the
                // grid's strongest blocks were its least relevant cells.
                !inMonth && 'bg-background',
                isSelected && 'bg-accent/60',
                'hover:bg-accent/40',
              )}
            >
              <span className="flex items-center justify-between">
                <span
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full text-xs tabular-nums',
                    inMonth ? 'text-foreground' : 'text-muted-foreground/60',
                    isToday && 'bg-primary font-semibold text-primary-foreground',
                  )}
                >
                  {dayOfMonth(dateKey)}
                </span>
              </span>

              {/*
                Phones: **up to two 3px ticks and a count** (§D3). A 45px column
                cannot show a title, and it could not show four dots either —
                four 6px dots with gaps is 30px of the 45, which is why the row
                wrapped and the cell grew. Two ticks say "something, and it is
                these colours"; the number says how much.
              */}
              {items.length > 0 ? (
                <span className="flex items-center gap-1 sm:hidden">
                  {items.slice(0, 2).map((occurrence) => (
                    <EventDot key={occurrence.id} occurrence={occurrence} />
                  ))}
                  <span className="text-[10px] leading-none font-medium text-muted-foreground tabular-nums">
                    {items.length}
                  </span>
                </span>
              ) : null}

              {/* ≥ sm: real chips with time and title. */}
              <span className="hidden min-w-0 flex-col gap-0.5 sm:flex">
                {items.slice(0, CHIPS_PER_CELL).map((occurrence) => (
                  <EventChip
                    key={occurrence.id}
                    occurrence={occurrence}
                    timeZone={props.timeZone}
                  />
                ))}
                {overflow > 0 ? (
                  <span className="px-1 text-[10px] text-muted-foreground">
                    {CALENDAR_RU.moreEvents(overflow)}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
