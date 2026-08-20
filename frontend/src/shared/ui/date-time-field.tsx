import { useId } from 'react';

import { cn } from '@/shared/lib/utils';
import { joinFloating, splitFloating } from '@/shared/lib/datetime';
import { Label } from '@/shared/ui/label';
import { DateField } from '@/shared/ui/date-field';
import { TimeField } from '@/shared/ui/time-field';

export const DATE_TIME_FIELD_RU = {
  date: 'Дата',
  time: 'Время',
};

/**
 * Дата + Время as one control over one value: a **floating local datetime**,
 * `2026-09-07T09:00:00` — no offset, no `Z`, seconds always `:00` (D2). The
 * halves are only a presentation split; the string that goes back to the caller
 * is byte-for-byte the one `<input type="date">` + `<input type="time">` used to
 * assemble.
 *
 * ## The layout
 *
 * Stacked below Tailwind's `sm`, side by side above it. The pair used to be a
 * hard `grid-cols-2` at every width, which at 320–390px left each native input
 * narrower than the value iOS insists on drawing inside it; the overflow leaked
 * past the column and painted what looked like a scrollbar between Дата and
 * Время, over the time field's own border. Stacking removes the squeeze on the
 * screen where it happens and `min-w-0` on both halves means neither can push
 * the row wider than its container even when they do sit side by side.
 */
export function DateTimeField(props: {
  /** `YYYY-MM-DDTHH:mm:ss`. */
  value: string;
  onChange: (value: string) => void;
  dateLabel?: string;
  timeLabel?: string;
  /** Omit the time half — an all-day event has no clock. */
  withTime?: boolean;
  disabled?: boolean;
  /** Earliest selectable day, as a `YYYY-MM-DD` key. */
  min?: string;
  max?: string;
  /** Force the stacked layout even on a desktop. */
  stacked?: boolean;
  /**
   * The whole value is optional — the date may be cleared back to `''`.
   * A time without a day is not a datetime, so the time half goes disabled
   * while there is no date.
   */
  clearable?: boolean;
  /** Time used when a date is chosen for a previously empty field. */
  defaultTime?: string;
  className?: string;
  idPrefix?: string;
}) {
  const generatedId = useId();
  const idPrefix = props.idPrefix ?? generatedId;
  const withTime = props.withTime ?? true;
  const defaultTime = props.defaultTime ?? '12:00';

  const { date, time } = splitFloating(props.value);
  const dateLabel = props.dateLabel ?? DATE_TIME_FIELD_RU.date;
  const timeLabel = props.timeLabel ?? DATE_TIME_FIELD_RU.time;

  return (
    <div
      data-slot="date-time-field"
      className={cn(
        'grid gap-3',
        withTime && !props.stacked && 'sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]',
        props.className,
      )}
    >
      <div className="min-w-0 space-y-1.5">
        <Label htmlFor={`${idPrefix}-date`}>{dateLabel}</Label>
        <DateField
          id={`${idPrefix}-date`}
          label={dateLabel}
          value={date}
          disabled={props.disabled}
          clearable={props.clearable}
          {...(props.min === undefined ? {} : { min: props.min })}
          {...(props.max === undefined ? {} : { max: props.max })}
          onChange={(next) => {
            // Clearing the day clears the whole value: `T09:00:00` is not a
            // datetime, and half a value is worse than none.
            props.onChange(next === '' ? '' : joinFloating(next, time === '' ? defaultTime : time));
          }}
        />
      </div>

      {withTime ? (
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`${idPrefix}-time`}>{timeLabel}</Label>
          <TimeField
            id={`${idPrefix}-time`}
            label={timeLabel}
            value={time}
            disabled={props.disabled === true || date === ''}
            onChange={(next) => {
              if (date === '') return;
              props.onChange(joinFloating(date, next));
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
