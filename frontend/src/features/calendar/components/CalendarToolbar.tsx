import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { MONTHS_NOMINATIVE } from '@/shared/lib/i18n';
import { cn } from '@/shared/lib/utils';
import type { MonthKey } from '../calendar-model';
import type { CalendarView } from '../hooks';
import { CALENDAR_RU } from '../locale';

/**
 * Month navigation, as the **page title** (§D3).
 *
 * The phone screen used to spend ~370px — 44 % of the viewport — on chrome
 * before the first event: a title, a subtitle, a full-width «+ Событие» button,
 * a month stepper with «Сегодня», and a Список/Месяц control. Five rows to say
 * what one row says.
 *
 * So the month *is* the title: `‹ Август 2026 ›`, handed to `PageHeader`, which
 * from `md` up hoists it into the app bar where the section name used to sit
 * with a thousand pixels of nothing beside it. «Сегодня» appears only when the
 * reader is not on the current month — a button that does nothing is worse than
 * no button, and this one is dead for eleven months out of twelve.
 */
export function MonthStepper(props: {
  monthKey: MonthKey;
  onPrevious: () => void;
  onNext: () => void;
  /** `undefined` while the current month is already on screen. */
  onToday?: (() => void) | undefined;
}) {
  return (
    <span className="flex min-w-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className="size-11 shrink-0"
        aria-label={CALENDAR_RU.prevMonth}
        onClick={props.onPrevious}
      >
        <ChevronLeft aria-hidden />
      </Button>
      <span className="min-w-0 truncate">{monthTitle(props.monthKey)}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-11 shrink-0"
        aria-label={CALENDAR_RU.nextMonth}
        onClick={props.onNext}
      >
        <ChevronRight aria-hidden />
      </Button>
      {props.onToday ? (
        <Button
          variant="ghost"
          className="h-11 shrink-0 px-3 text-[15px] leading-[22px] font-medium text-muted-foreground"
          onClick={props.onToday}
        >
          {CALENDAR_RU.today}
        </Button>
      ) : null}
    </span>
  );
}

/**
 * Список / Месяц.
 *
 * §D3 makes this phone-only, on the grounds that from `lg` up the month grid
 * and the day's agenda are on screen together and the switch has nothing to
 * switch. It is kept at every width here, and the reason is worth stating: the
 * side column shows **the selected day**, not the month's agenda, so a desktop
 * reader who has chosen «Список» and then loses the control has no way back to
 * the list of everything coming up. The control is one 44px row inside the
 * single control row — the 370px of chrome §D3 is actually complaining about
 * has gone either way.
 */
export function ViewSwitch(props: {
  view: CalendarView;
  onViewChange: (view: CalendarView) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={CALENDAR_RU.viewLabel}
      className="flex h-11 w-fit shrink-0 items-center gap-1 rounded-lg bg-muted p-1"
    >
      <ViewButton
        active={props.view === 'agenda'}
        label={CALENDAR_RU.viewAgenda}
        onClick={() => {
          props.onViewChange('agenda');
        }}
      />
      <ViewButton
        active={props.view === 'month'}
        label={CALENDAR_RU.viewMonth}
        onClick={() => {
          props.onViewChange('month');
        }}
      />
    </div>
  );
}

function ViewButton(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.active}
      onClick={props.onClick}
      className={cn(
        'flex h-9 min-w-16 items-center justify-center rounded-md px-3 text-[15px] leading-[22px] transition-colors',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        props.active
          ? 'bg-card font-medium text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {props.label}
    </button>
  );
}

/** «Сентябрь 2026» — nominative, capitalised. */
function monthTitle(monthKey: MonthKey): string {
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  const name = MONTHS_NOMINATIVE[monthIndex] ?? '';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${monthKey.slice(0, 4)}`;
}
