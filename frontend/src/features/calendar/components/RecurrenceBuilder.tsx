import type { RecurrenceEnd, Weekday } from '@family/shared';
import { DateField } from '@/shared/ui/date-field';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { OptionList, OptionRow } from '@/shared/ui/option-sheet';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { cn } from '@/shared/lib/utils';
import {
  toFloatingLocal,
  type RecurrenceArm,
  type RecurrenceBuilderState,
} from '../calendar-model';
import { CALENDAR_RU } from '../locale';

/**
 * The **restricted** recurrence builder — the same grammar tasks use
 * (`docs/architecture/scheduling.md` §7).
 *
 * There is no free-text RRULE editor and there must not be one: the client
 * never authors RRULE text, it picks one of six shapes and the backend compiles
 * it. "По дням недели" and "Раз в N недель" are both `FREQ=WEEKLY` under the
 * hood, but they are two different questions to a human, so they get two arms.
 *
 * ## Why one column, and why it is not on the form any more
 *
 * Six arms in a `grid-cols-2` was the single tallest block of «Новое событие»:
 * «Последний день месяца» wraps to two lines beside a one-line «Ежедневно», so
 * three rows of ragged pills became ~200px of a 1640px sheet — above «Создать»,
 * and untouched by the overwhelming majority of events, which happen once.
 *
 * Now the form carries one row — «🔁 Повторение · не повторяется ›» — and this
 * opens in a sheet. Inside, one column of equal-height radio rows, and the
 * parameters of the chosen arm appear directly under it rather than in a second
 * bordered box below the whole list (§F5).
 */

const ARM_LABELS: Record<RecurrenceArm, string> = {
  once: CALENDAR_RU.recurrence.once,
  daily: CALENDAR_RU.recurrence.daily,
  weekly: CALENDAR_RU.recurrence.weekly,
  weekly_interval: CALENDAR_RU.recurrence.weeklyInterval,
  monthly_day: CALENDAR_RU.recurrence.monthlyDay,
  monthly_last_day: CALENDAR_RU.recurrence.monthlyLastDay,
};

const ARMS: readonly RecurrenceArm[] = [
  'once',
  'daily',
  'weekly',
  'weekly_interval',
  'monthly_day',
  'monthly_last_day',
];

/** The words the `ValueRow` shows without opening anything. */
export function recurrenceLabel(state: RecurrenceBuilderState): string {
  return ARM_LABELS[state.arm];
}

export function RecurrenceBuilder(props: {
  value: RecurrenceBuilderState;
  onChange: (next: RecurrenceBuilderState) => void;
  /** Disabled for generated series (birthdays) and imported rules. */
  disabled?: boolean;
}) {
  const { value, onChange } = props;

  const patch = (partial: Partial<RecurrenceBuilderState>): void => {
    onChange({ ...value, ...partial });
  };

  const intervalUnit = (arm: RecurrenceArm): string =>
    arm === 'daily'
      ? CALENDAR_RU.recurrence.days
      : arm === 'weekly_interval'
        ? CALENDAR_RU.recurrence.weeks
        : CALENDAR_RU.recurrence.months;

  const intervalField = (arm: RecurrenceArm) => (
    <div className="flex min-h-11 items-center gap-2">
      <Label htmlFor="recurrence-interval" className="text-[15px] text-muted-foreground">
        {CALENDAR_RU.recurrence.everyN}
      </Label>
      <Input
        id="recurrence-interval"
        type="number"
        inputMode="numeric"
        min={1}
        max={99}
        className="h-11 w-20 text-base md:text-base"
        value={String(value.interval)}
        disabled={props.disabled}
        onChange={(event) => {
          patch({ interval: Number(event.target.value) || 1 });
        }}
      />
      <span className="text-[15px] text-muted-foreground">{intervalUnit(arm)}</span>
    </div>
  );

  const weekdayField = (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
        {CALENDAR_RU.recurrence.weekdays}
      </span>
      <div className="flex flex-wrap gap-2">
        {CALENDAR_RU.weekdayCodes.map((day) => {
          const code = day.code as Weekday;
          const active = value.weekdays.includes(code);
          return (
            <button
              key={code}
              type="button"
              aria-pressed={active}
              aria-label={day.label}
              disabled={props.disabled}
              onClick={() => {
                const next = active
                  ? value.weekdays.filter((item) => item !== code)
                  : [...value.weekdays, code];
                patch({ weekdays: next.length > 0 ? next : [code] });
              }}
              className={cn(
                'size-11 rounded-full border text-[15px] transition-colors',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-accent/40',
              )}
            >
              {day.short}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="flex max-w-row-measure flex-col gap-4">
      {/* No list label: the sheet header already says «Повторение». */}
      <OptionList>
        {ARMS.map((arm) => (
          <OptionRow
            key={arm}
            label={ARM_LABELS[arm]}
            selected={value.arm === arm}
            disabled={props.disabled}
            onSelect={() => {
              patch({ arm, interval: arm === 'weekly' ? 1 : Math.max(1, value.interval) });
            }}
          >
            {arm === 'daily' || arm === 'weekly_interval' || arm === 'monthly_last_day'
              ? intervalField(arm)
              : null}

            {arm === 'weekly' ? weekdayField : null}

            {arm === 'weekly_interval' ? <div className="mt-3">{weekdayField}</div> : null}

            {arm === 'monthly_day' ? (
              <div className="flex flex-col gap-2">
                {intervalField(arm)}
                <div className="flex min-h-11 items-center gap-2">
                  <Label
                    htmlFor="recurrence-day-of-month"
                    className="text-[15px] text-muted-foreground"
                  >
                    {CALENDAR_RU.recurrence.dayOfMonth}
                  </Label>
                  <Input
                    id="recurrence-day-of-month"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={31}
                    className="h-11 w-20 text-base md:text-base"
                    value={String(value.dayOfMonth)}
                    disabled={props.disabled}
                    onChange={(event) => {
                      patch({ dayOfMonth: Number(event.target.value) || 1 });
                    }}
                  />
                </div>
                {value.dayOfMonth > 28 ? (
                  <p className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
                    {CALENDAR_RU.recurrence.dayOfMonthHint}
                  </p>
                ) : null}
              </div>
            ) : null}
          </OptionRow>
        ))}
      </OptionList>

      {value.arm === 'once' ? null : (
        <RecurrenceEndsField
          value={value.ends}
          onChange={(ends) => {
            patch({ ends });
          }}
          {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        />
      )}
    </div>
  );
}

function RecurrenceEndsField(props: {
  value: RecurrenceEnd;
  onChange: (next: RecurrenceEnd) => void;
  disabled?: boolean;
}) {
  const select = (type: RecurrenceEnd['type']): void => {
    if (type === 'never') props.onChange({ type: 'never' });
    else if (type === 'after') props.onChange({ type: 'after', count: 10 });
    else
      props.onChange({ type: 'until', untilLocal: toFloatingLocal(defaultUntilDate(), '23:59') });
  };

  return (
    <div className="flex flex-col gap-2">
      <SegmentedControl<RecurrenceEnd['type']>
        label={CALENDAR_RU.recurrence.endsLegend}
        showLabel
        value={props.value.type}
        disabled={props.disabled}
        options={[
          { value: 'never', label: CALENDAR_RU.recurrence.endsNever },
          { value: 'after', label: CALENDAR_RU.recurrence.endsAfter },
          { value: 'until', label: CALENDAR_RU.recurrence.endsUntil },
        ]}
        onChange={select}
      />

      {props.value.type === 'after' ? (
        <div className="flex min-h-11 items-center gap-2">
          <Input
            aria-label={CALENDAR_RU.recurrence.endsAfter}
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            className="h-11 w-24 text-base md:text-base"
            value={String(props.value.count)}
            disabled={props.disabled}
            onChange={(event) => {
              props.onChange({ type: 'after', count: Number(event.target.value) || 1 });
            }}
          />
          <span className="text-[15px] text-muted-foreground">
            {CALENDAR_RU.recurrence.endsAfterUnit}
          </span>
        </div>
      ) : null}

      {props.value.type === 'until' ? (
        <DateField
          label={CALENDAR_RU.recurrence.endsUntilLabel}
          value={props.value.untilLocal.slice(0, 10)}
          disabled={props.disabled}
          onChange={(date) => {
            if (!date) return;
            props.onChange({ type: 'until', untilLocal: toFloatingLocal(date, '23:59') });
          }}
        />
      ) : null}
    </div>
  );
}

/** A year out — a sane default that is never "yesterday". */
function defaultUntilDate(): string {
  const now = new Date();
  return new Date(now.getFullYear() + 1, now.getMonth(), now.getDate(), 12)
    .toLocaleDateString('sv-SE')
    .slice(0, 10);
}
