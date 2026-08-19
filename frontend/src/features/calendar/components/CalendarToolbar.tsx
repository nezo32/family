import { CalendarRange, ChevronLeft, ChevronRight, List } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { MONTHS_NOMINATIVE } from '@/shared/lib/i18n';
import { cn } from '@/shared/lib/utils';
import type { MonthKey } from '../calendar-model';
import type { CalendarView } from '../hooks';
import { CALENDAR_RU } from '../locale';

/**
 * Month navigation plus the view switch.
 *
 * The switch is a labelled segmented control, not an icon-only toggle: on a
 * phone the two views are genuinely different products and the user has to be
 * able to find the other one without experimenting.
 */
export function CalendarToolbar(props: {
  view: CalendarView;
  onViewChange: (view: CalendarView) => void;
  monthKey: MonthKey;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={CALENDAR_RU.prevMonth}
          onClick={props.onPrevious}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <span className="min-w-0 truncate text-base font-semibold text-foreground">
          {monthTitle(props.monthKey)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={CALENDAR_RU.nextMonth}
          onClick={props.onNext}
        >
          <ChevronRight aria-hidden />
        </Button>
        <Button variant="ghost" className="h-11 px-3" onClick={props.onToday}>
          {CALENDAR_RU.today}
        </Button>
      </div>

      <div
        role="radiogroup"
        aria-label={CALENDAR_RU.viewLabel}
        className="flex items-center gap-1 rounded-lg bg-muted p-1"
      >
        <ViewButton
          active={props.view === 'agenda'}
          label={CALENDAR_RU.viewAgenda}
          onClick={() => {
            props.onViewChange('agenda');
          }}
          icon={<List className="size-4" aria-hidden />}
        />
        <ViewButton
          active={props.view === 'month'}
          label={CALENDAR_RU.viewMonth}
          onClick={() => {
            props.onViewChange('month');
          }}
          icon={<CalendarRange className="size-4" aria-hidden />}
        />
      </div>
    </div>
  );
}

function ViewButton(props: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.active}
      onClick={props.onClick}
      className={cn(
        'flex h-11 items-center gap-1.5 rounded-md px-3 text-sm transition-colors',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        props.active
          ? 'bg-background font-medium text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {props.icon}
      {props.label}
    </button>
  );
}

/** "Сентябрь 2026" — nominative, capitalised. */
function monthTitle(monthKey: MonthKey): string {
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  const name = MONTHS_NOMINATIVE[monthIndex] ?? '';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${monthKey.slice(0, 4)}`;
}
