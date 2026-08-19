import type { RecurrenceEnd, Weekday } from '@family/shared';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { cn } from '@/shared/lib/utils';
import { toFloatingLocal, type RecurrenceArm, type RecurrenceBuilderState } from '../calendar-model';
import { CALENDAR_RU } from '../locale';

/**
 * The **restricted** recurrence builder — the same grammar tasks use
 * (`docs/architecture/scheduling.md` §7).
 *
 * There is no free-text RRULE editor and there must not be one: the client
 * never authors RRULE text, it picks one of six shapes and the backend
 * compiles it. "По дням недели" and "Раз в N недель" are both `FREQ=WEEKLY`
 * under the hood, but they are two different questions to a human, so they get
 * two arms.
 */

const ARM_LABELS: Record<RecurrenceArm, string> = {
  once: CALENDAR_RU.recurrence.once,
  daily: CALENDAR_RU.recurrence.daily,
  weekly: CALENDAR_RU.recurrence.weekly,
  weekly_interval: CALENDAR_RU.recurrence.weeklyInterval,
  monthly_day: CALENDAR_RU.recurrence.monthlyDay,
  monthly_last_day: CALENDAR_RU.recurrence.monthlyLastDay,
};

const ARMS: RecurrenceArm[] = [
  'once',
  'daily',
  'weekly',
  'weekly_interval',
  'monthly_day',
  'monthly_last_day',
];

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

  const showInterval =
    value.arm === 'daily' ||
    value.arm === 'weekly_interval' ||
    value.arm === 'monthly_day' ||
    value.arm === 'monthly_last_day';
  const showWeekdays = value.arm === 'weekly' || value.arm === 'weekly_interval';
  const showDayOfMonth = value.arm === 'monthly_day';
  const showEnds = value.arm !== 'once';

  const intervalUnit =
    value.arm === 'daily'
      ? CALENDAR_RU.recurrence.days
      : value.arm === 'weekly_interval'
        ? CALENDAR_RU.recurrence.weeks
        : CALENDAR_RU.recurrence.months;

  return (
    <fieldset className="space-y-3" disabled={props.disabled}>
      <legend className="mb-2 text-sm font-medium text-foreground">
        {CALENDAR_RU.recurrence.legend}
      </legend>

      <div role="radiogroup" aria-label={CALENDAR_RU.recurrence.legend} className="grid grid-cols-2 gap-2">
        {ARMS.map((arm) => (
          <button
            key={arm}
            type="button"
            role="radio"
            aria-checked={value.arm === arm}
            disabled={props.disabled}
            onClick={() => {
              patch({ arm, interval: arm === 'weekly' ? 1 : Math.max(1, value.interval) });
            }}
            className={cn(
              'flex min-h-11 items-center rounded-lg border border-border px-3 text-sm transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50',
              value.arm === arm
                ? 'border-primary bg-primary/10 font-medium text-foreground'
                : 'bg-background text-muted-foreground hover:bg-accent/40',
            )}
          >
            {ARM_LABELS[arm]}
          </button>
        ))}
      </div>

      {showInterval ? (
        <div className="flex items-center gap-2">
          <Label htmlFor="recurrence-interval" className="text-sm text-muted-foreground">
            {CALENDAR_RU.recurrence.everyN}
          </Label>
          <Input
            id="recurrence-interval"
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            className="h-11 w-20"
            value={String(value.interval)}
            onChange={(event) => {
              patch({ interval: Number(event.target.value) || 1 });
            }}
          />
          <span className="text-sm text-muted-foreground">{intervalUnit}</span>
        </div>
      ) : null}

      {showWeekdays ? (
        <div className="space-y-1.5">
          <span className="text-sm text-muted-foreground">{CALENDAR_RU.recurrence.weekdays}</span>
          <div className="flex flex-wrap gap-1.5">
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
                    'size-11 rounded-full border border-border text-sm transition-colors',
                    'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'bg-background text-muted-foreground hover:bg-accent/40',
                  )}
                >
                  {day.short}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {showDayOfMonth ? (
        <div className="space-y-1.5">
          <Label htmlFor="recurrence-day-of-month" className="text-sm text-muted-foreground">
            {CALENDAR_RU.recurrence.dayOfMonth}
          </Label>
          <Input
            id="recurrence-day-of-month"
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            className="h-11 w-20"
            value={String(value.dayOfMonth)}
            onChange={(event) => {
              patch({ dayOfMonth: Number(event.target.value) || 1 });
            }}
          />
          {value.dayOfMonth > 28 ? (
            <p className="text-xs text-muted-foreground">
              {CALENDAR_RU.recurrence.dayOfMonthHint}
            </p>
          ) : null}
        </div>
      ) : null}

      {showEnds ? <RecurrenceEndsField value={value.ends} onChange={(ends) => { patch({ ends }); }} disabled={props.disabled} /> : null}
    </fieldset>
  );
}

function RecurrenceEndsField(props: {
  value: RecurrenceEnd;
  onChange: (next: RecurrenceEnd) => void;
  disabled?: boolean;
}) {
  const options: { type: RecurrenceEnd['type']; label: string }[] = [
    { type: 'never', label: CALENDAR_RU.recurrence.endsNever },
    { type: 'after', label: CALENDAR_RU.recurrence.endsAfter },
    { type: 'until', label: CALENDAR_RU.recurrence.endsUntil },
  ];

  const select = (type: RecurrenceEnd['type']): void => {
    if (type === 'never') props.onChange({ type: 'never' });
    else if (type === 'after') props.onChange({ type: 'after', count: 10 });
    else props.onChange({ type: 'until', untilLocal: toFloatingLocal(defaultUntilDate(), '23:59') });
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <span className="text-sm font-medium text-foreground">
        {CALENDAR_RU.recurrence.endsLegend}
      </span>
      <div role="radiogroup" aria-label={CALENDAR_RU.recurrence.endsLegend} className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.type}
            type="button"
            role="radio"
            aria-checked={props.value.type === option.type}
            disabled={props.disabled}
            onClick={() => {
              select(option.type);
            }}
            className={cn(
              'min-h-11 rounded-lg border border-border px-3 text-sm transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50',
              props.value.type === option.type
                ? 'border-primary bg-primary/10 font-medium text-foreground'
                : 'bg-background text-muted-foreground hover:bg-accent/40',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {props.value.type === 'after' ? (
        <div className="flex items-center gap-2">
          <Input
            aria-label={CALENDAR_RU.recurrence.endsAfter}
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            className="h-11 w-24"
            value={String(props.value.count)}
            onChange={(event) => {
              props.onChange({ type: 'after', count: Number(event.target.value) || 1 });
            }}
          />
          <span className="text-sm text-muted-foreground">
            {CALENDAR_RU.recurrence.endsAfterUnit}
          </span>
        </div>
      ) : null}

      {props.value.type === 'until' ? (
        <Input
          aria-label={CALENDAR_RU.recurrence.endsUntilLabel}
          type="date"
          className="h-11 w-full sm:w-56"
          value={props.value.untilLocal.slice(0, 10)}
          onChange={(event) => {
            const date = event.target.value;
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
