import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { addDaysToKey, dateKeyToLocalNoon, todayKey, type DateKey } from '../calendar-model';

/**
 * The date header of an agenda section.
 *
 * "Сегодня" / "Завтра" are decided against the family timezone, not the device
 * one — the shared `dayLabel()` helper compares against the device clock, which
 * is the wrong question for a family calendar.
 */
export function DayHeading(props: { dateKey: DateKey; timeZone: string; className?: string }) {
  const today = todayKey(props.timeZone);
  const relative =
    props.dateKey === today
      ? COMMON.today
      : props.dateKey === addDaysToKey(today, 1)
        ? COMMON.tomorrow
        : props.dateKey === addDaysToKey(today, -1)
          ? COMMON.yesterday
          : null;

  const date = dateKeyToLocalNoon(props.dateKey);
  const isPast = props.dateKey < today;

  return (
    <h2
      className={cn(
        'flex items-baseline gap-2 text-sm font-semibold text-foreground',
        isPast && 'text-muted-foreground',
        props.className,
      )}
    >
      {relative ? <span>{relative}</span> : null}
      <span className={cn(relative && 'text-xs font-normal text-muted-foreground')}>
        {format(date, relative ? 'd MMMM' : 'EEEE, d MMMM', { locale: ru })}
      </span>
    </h2>
  );
}
