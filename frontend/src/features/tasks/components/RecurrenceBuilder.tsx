import type { RecurrenceEnd, Weekday } from '@family/shared';
import { DateField } from '@/shared/ui/date-field';
import { Input } from '@/shared/ui/input';
import { OptionList, OptionRow } from '@/shared/ui/option-sheet';
import { SegmentedControl } from '@/shared/ui/segmented-control';
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
import { ToggleChip } from './SegmentedControl';

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
 *
 * ## Why it is a single-column list now, and why it lives in a sheet
 *
 * It used to be a `grid-cols-2` of chips sitting in the middle of the create
 * form. Five ragged options in two columns — «Последний день месяца» wraps to
 * two lines next to a one-line «Ежедневно» — is roughly 190px of form that
 * almost every family member scrolls past without touching, because a chore
 * repeats the way it always has.
 *
 * One column of 56px radio rows reads in a single downward sweep, its rows are
 * all the same height whatever the label says, and the parameters of the arm
 * you chose appear **under that arm** instead of in a second bordered box
 * further down. The form itself no longer carries any of it: `ScheduleRepeatRow`
 * states the current rule in words and opens this in a sheet (§F5).
 */

const KIND_ORDER: readonly { kind: ScheduleKind; label: string }[] = [
  { kind: 'once', label: TASKS_RU.recurrence.once },
  { kind: 'daily', label: TASKS_RU.recurrence.daily },
  { kind: 'weekly', label: TASKS_RU.recurrence.weekly },
  { kind: 'monthly_day', label: TASKS_RU.recurrence.monthlyDay },
  { kind: 'monthly_last_day', label: TASKS_RU.recurrence.monthlyLastDay },
];

/** The words the `ValueRow` shows without opening anything. */
export function scheduleLabel(value: ScheduleValue): string {
  const kind = kindOf(value);
  return KIND_ORDER.find((option) => option.kind === kind)?.label ?? TASKS_RU.recurrence.once;
}

type EndKind = RecurrenceEnd['type'];

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
    <label className="flex min-h-11 flex-wrap items-center gap-2 text-[15px] text-muted-foreground">
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
        className="h-11 w-20 text-base md:text-base"
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

  const setEnds = (ends: RecurrenceEnd): void => {
    if (value.mode !== 'preset') return;
    onChange({ ...value, ends });
  };

  const setInterval = (interval: number): void => {
    if (value.mode !== 'preset') return;
    onChange({ ...value, preset: { ...value.preset, interval: clampInterval(interval) } });
  };

  const weekdays: readonly Weekday[] =
    value.mode === 'preset' && value.preset.kind === 'weekly' ? value.preset.weekdays : [];

  return (
    <div className="flex max-w-row-measure flex-col gap-4">
      {/* No list label: the sheet header already says «Повторение». */}
      <OptionList>
        {KIND_ORDER.map((option) => (
          <OptionRow
            key={option.kind}
            label={option.label}
            selected={kind === option.kind}
            disabled={disabled}
            onSelect={() => {
              onChange(scheduleForKind(option.kind, dtstartLocal, value));
            }}
          >
            {option.kind === 'daily' ? (
              <NumberField
                label={TASKS_RU.recurrence.everyNDays}
                suffix={TASKS_RU.recurrence.days}
                value={value.mode === 'preset' ? value.preset.interval : 1}
                min={1}
                max={99}
                disabled={disabled}
                onChange={setInterval}
              />
            ) : null}

            {option.kind === 'weekly' ? (
              <div className="flex flex-col gap-3">
                <NumberField
                  label={TASKS_RU.recurrence.everyNWeeks}
                  suffix={TASKS_RU.recurrence.weeks}
                  value={value.mode === 'preset' ? value.preset.interval : 1}
                  min={1}
                  max={99}
                  disabled={disabled}
                  onChange={setInterval}
                />
                <div className="flex flex-col gap-2">
                  <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                    {TASKS_RU.recurrence.weekdays}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAY_OPTIONS_RU.map((weekday) => (
                      <ToggleChip
                        key={weekday.value}
                        label={weekday.short}
                        ariaLabel={weekday.long}
                        pressed={weekdays.includes(weekday.value)}
                        disabled={disabled}
                        onClick={() => {
                          if (value.mode !== 'preset' || value.preset.kind !== 'weekly') return;
                          onChange({
                            ...value,
                            preset: {
                              ...value.preset,
                              weekdays: toggleWeekday(value.preset.weekdays, weekday.value),
                            },
                          });
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {option.kind === 'monthly_day' ? (
              <div className="flex flex-col gap-2">
                <NumberField
                  label={TASKS_RU.recurrence.everyNMonths}
                  suffix={TASKS_RU.recurrence.months}
                  value={value.mode === 'preset' ? value.preset.interval : 1}
                  min={1}
                  max={99}
                  disabled={disabled}
                  onChange={setInterval}
                />
                <NumberField
                  label={TASKS_RU.recurrence.dayOfMonth}
                  suffix=""
                  value={
                    value.mode === 'preset' && value.preset.kind === 'monthly_day'
                      ? value.preset.dayOfMonth
                      : 1
                  }
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
                <p className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                  {TASKS_RU.recurrence.dayOfMonthHint}
                </p>
              </div>
            ) : null}

            {option.kind === 'monthly_last_day' ? (
              <div className="flex flex-col gap-2">
                <NumberField
                  label={TASKS_RU.recurrence.everyNMonths}
                  suffix={TASKS_RU.recurrence.months}
                  value={value.mode === 'preset' ? value.preset.interval : 1}
                  min={1}
                  max={99}
                  disabled={disabled}
                  onChange={setInterval}
                />
                <p className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                  {TASKS_RU.recurrence.lastDayHint}
                </p>
              </div>
            ) : null}
          </OptionRow>
        ))}
      </OptionList>

      {/* «Заканчивается» only exists once something repeats. Three options, so
          it is a segmented row rather than a fourth list (§F5). */}
      {value.mode === 'preset' ? (
        <div className="flex flex-col gap-2">
          <SegmentedControl<EndKind>
            label={TASKS_RU.recurrence.ends}
            showLabel
            value={value.ends.type}
            disabled={disabled}
            options={[
              { value: 'never', label: TASKS_RU.recurrence.endsNever },
              { value: 'after', label: TASKS_RU.recurrence.endsAfter },
              { value: 'until', label: TASKS_RU.recurrence.endsUntil },
            ]}
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
            <DateField
              label={TASKS_RU.recurrence.endsUntil}
              value={splitFloating(value.ends.untilLocal).date}
              disabled={disabled}
              onChange={(next) => {
                if (next === '') return;
                // 23:59 keeps the last occurrence of the final day inside the
                // window; the time half of this value is never shown.
                setEnds({ type: 'until', untilLocal: `${next}T23:59:00` });
              }}
            />
          ) : null}
        </div>
      ) : null}

      <p className="text-[13px] leading-[18px] text-muted-foreground" data-testid="schedule-summary">
        {describeSchedule(value, dtstartLocal)}
      </p>
    </div>
  );
}
