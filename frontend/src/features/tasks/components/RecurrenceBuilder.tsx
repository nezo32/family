import type { RecurrenceEnd, Weekday } from '@family/shared';
import { DateField } from '@/shared/ui/date-field';
import { Input } from '@/shared/ui/input';
import { TASKS_RU, WEEKDAY_OPTIONS_RU } from '../locale';
import {
  clampCount,
  clampDayOfMonth,
  clampInterval,
  describeSchedule,
  kindOf,
  scheduleForKind,
  splitFloating,
  toggleWeekday,
  type ScheduleKind,
  type ScheduleValue,
} from '../recurrence';
import { SegmentedControl, ToggleChip, type SegmentOption } from './SegmentedControl';

/**
 * The **restricted** recurrence builder (D2, scheduling.md §7).
 *
 * It can only ever produce a `recurrencePresetSchema` value — there is no
 * free-text RRULE field and there must never be one: the rule text is compiled
 * server-side, and a client that authors RRULE can express schedules the rest
 * of the app (summary, decompile, series split) cannot read back.
 *
 * `weekly` deliberately serves two product cases: with `interval: 1` it is "по
 * дням недели", with `interval: n` it is "раз в N недель". Same for
 * `monthly_day` / "раз в N месяцев".
 */

const KIND_OPTIONS: readonly SegmentOption<ScheduleKind>[] = [
  { value: 'once', label: TASKS_RU.recurrence.once },
  { value: 'daily', label: TASKS_RU.recurrence.daily },
  { value: 'weekly', label: TASKS_RU.recurrence.weekly },
  { value: 'monthly_day', label: TASKS_RU.recurrence.monthlyDay },
  { value: 'monthly_last_day', label: TASKS_RU.recurrence.monthlyLastDay },
];

type EndKind = RecurrenceEnd['type'];

const END_OPTIONS: readonly SegmentOption<EndKind>[] = [
  { value: 'never', label: TASKS_RU.recurrence.endsNever },
  { value: 'after', label: TASKS_RU.recurrence.endsAfter },
  { value: 'until', label: TASKS_RU.recurrence.endsUntil },
];

function NumberField(props: {
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-11 flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>{props.label}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={props.min}
        max={props.max}
        value={String(props.value)}
        disabled={props.disabled}
        onChange={(event) => {
          props.onChange(Number(event.target.value));
        }}
        // 16px minimum, or iOS zooms the viewport on focus and never zooms back.
        className="h-11 w-20 text-base"
      />
      <span>{props.suffix}</span>
    </label>
  );
}

export function RecurrenceBuilder(props: {
  value: ScheduleValue;
  onChange: (value: ScheduleValue) => void;
  /** Floating local anchor — seeds the weekday / day-of-month defaults. */
  dtstartLocal: string;
  disabled?: boolean;
}) {
  const { value, onChange, dtstartLocal, disabled } = props;
  const kind = kindOf(value);

  const setEnds = (ends: RecurrenceEnd) => {
    if (value.mode !== 'preset') return;
    onChange({ ...value, ends });
  };

  const setInterval = (interval: number) => {
    if (value.mode !== 'preset') return;
    onChange({ ...value, preset: { ...value.preset, interval: clampInterval(interval) } });
  };

  return (
    <div className="space-y-4">
      <SegmentedControl
        label={TASKS_RU.recurrence.legend}
        value={kind}
        options={KIND_OPTIONS}
        disabled={disabled}
        onChange={(next) => {
          onChange(scheduleForKind(next, dtstartLocal, value));
        }}
      />

      {value.mode === 'preset' ? (
        <div className="space-y-4 rounded-xl border border-border bg-muted/40 p-3">
          {value.preset.kind === 'daily' ? (
            <NumberField
              label={TASKS_RU.recurrence.everyNDays}
              suffix={TASKS_RU.recurrence.days}
              value={value.preset.interval}
              min={1}
              max={99}
              disabled={disabled}
              onChange={setInterval}
            />
          ) : null}

          {value.preset.kind === 'weekly' ? (
            <div className="space-y-3">
              <NumberField
                label={TASKS_RU.recurrence.everyNWeeks}
                suffix={TASKS_RU.recurrence.weeks}
                value={value.preset.interval}
                min={1}
                max={99}
                disabled={disabled}
                onChange={setInterval}
              />
              <div>
                <div className="mb-2 text-sm font-medium text-foreground">
                  {TASKS_RU.recurrence.weekdays}
                </div>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAY_OPTIONS_RU.map((option) => {
                    const weekdays: readonly Weekday[] =
                      value.preset.kind === 'weekly' ? value.preset.weekdays : [];
                    return (
                      <ToggleChip
                        key={option.value}
                        label={option.short}
                        ariaLabel={option.long}
                        pressed={weekdays.includes(option.value)}
                        disabled={disabled}
                        onClick={() => {
                          if (value.mode !== 'preset' || value.preset.kind !== 'weekly') return;
                          onChange({
                            ...value,
                            preset: {
                              ...value.preset,
                              weekdays: toggleWeekday(value.preset.weekdays, option.value),
                            },
                          });
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}

          {value.preset.kind === 'monthly_day' ? (
            <div className="space-y-2">
              <NumberField
                label={TASKS_RU.recurrence.everyNMonths}
                suffix={TASKS_RU.recurrence.months}
                value={value.preset.interval}
                min={1}
                max={99}
                disabled={disabled}
                onChange={setInterval}
              />
              <NumberField
                label={TASKS_RU.recurrence.dayOfMonth}
                suffix=""
                value={value.preset.dayOfMonth}
                min={1}
                max={31}
                disabled={disabled}
                onChange={(next) => {
                  if (value.mode !== 'preset' || value.preset.kind !== 'monthly_day') return;
                  onChange({
                    ...value,
                    preset: { ...value.preset, dayOfMonth: clampDayOfMonth(next) },
                  });
                }}
              />
              <p className="text-xs text-muted-foreground">{TASKS_RU.recurrence.dayOfMonthHint}</p>
            </div>
          ) : null}

          {value.preset.kind === 'monthly_last_day' ? (
            <div className="space-y-2">
              <NumberField
                label={TASKS_RU.recurrence.everyNMonths}
                suffix={TASKS_RU.recurrence.months}
                value={value.preset.interval}
                min={1}
                max={99}
                disabled={disabled}
                onChange={setInterval}
              />
              <p className="text-xs text-muted-foreground">{TASKS_RU.recurrence.lastDayHint}</p>
            </div>
          ) : null}

          <SegmentedControl
            label={TASKS_RU.recurrence.ends}
            value={value.ends.type}
            options={END_OPTIONS}
            disabled={disabled}
            onChange={(next) => {
              if (next === 'never') setEnds({ type: 'never' });
              else if (next === 'after') setEnds({ type: 'after', count: 10 });
              else
                setEnds({
                  type: 'until',
                  untilLocal: `${splitFloating(dtstartLocal).date}T23:59:00`,
                });
            }}
          />

          {value.ends.type === 'after' ? (
            <NumberField
              label={TASKS_RU.recurrence.endsAfter}
              suffix={TASKS_RU.recurrence.endsAfterUnit}
              value={value.ends.count}
              min={1}
              max={1000}
              disabled={disabled}
              onChange={(next) => {
                setEnds({ type: 'after', count: clampCount(next) });
              }}
            />
          ) : null}

          {value.ends.type === 'until' ? (
            <div className="flex min-h-11 flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{TASKS_RU.recurrence.endsUntil}</span>
              <DateField
                label={TASKS_RU.recurrence.endsUntil}
                value={splitFloating(value.ends.untilLocal).date}
                disabled={disabled}
                className="w-full sm:w-56"
                onChange={(next) => {
                  if (next === '') return;
                  // 23:59 keeps the last occurrence of the final day inside the
                  // window; the time half of this value is never shown.
                  setEnds({ type: 'until', untilLocal: `${next}T23:59:00` });
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="text-sm text-muted-foreground" data-testid="schedule-summary">
        {describeSchedule(value, dtstartLocal)}
      </p>
    </div>
  );
}
