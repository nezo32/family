import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { COMMON } from '@/shared/lib/i18n';
import { addDaysToKey, dateKeyToLocalNoon, todayKey, type DateKey } from '../calendar-model';

/**
 * The date header of one agenda day — «СЕГОДНЯ · 20 августа», «сб, 22 августа».
 *
 * It renders **inline content**, not a heading element. The heading is the
 * `Section`'s own `<h2>` (§E), and a day group is a section: one label outside
 * the surface, one surface of hairline-separated rows. Nesting an `<h2>` inside
 * an `<h2>` to get a date on screen is how a list of nine events ends up
 * announcing nine level-2 headings.
 *
 * «Сегодня» / «Завтра» are decided against the **family** timezone, not the
 * device one — `dayLabel()` in `shared/lib` compares against the device clock,
 * which is the wrong question for a family calendar (D2).
 */
export function DayHeading(props: { dateKey: DateKey; timeZone: string }) {
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

  // `inline-flex` with a gap rather than literal spaces: inside `Section`'s
  // truncating `<h2>` the whitespace between two `<span>`s collapses away and
  // the label renders as «СЕГОДНЯ·20 АВГУСТА».
  return (
    <span className="inline-flex items-baseline gap-1.5">
      {relative ? <span>{relative}</span> : null}
      {relative ? <span aria-hidden>·</span> : null}
      <span>{format(date, relative ? 'd MMMM' : 'EEEE, d MMMM', { locale: ru })}</span>
    </span>
  );
}
