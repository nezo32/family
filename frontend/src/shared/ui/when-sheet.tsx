import { useEffect, useState } from 'react';
import { format as formatDate } from 'date-fns';
import { ru } from 'date-fns/locale';

import { dateKeyToDate, dateToDateKey, isTimeValue } from '@/shared/lib/datetime';
import { formatDuration } from '@/shared/lib/format';
import type { DayPickerWeekStart } from '@/shared/auth/week-start';
import { Button } from '@/shared/ui/button';
import { Calendar } from '@/shared/ui/calendar';
import { OptionList, OptionRow, PickerSheet } from '@/shared/ui/option-sheet';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { Switch } from '@/shared/ui/switch';
import { TimeField } from '@/shared/ui/time-field';

/**
 * The «когда» sheet, and the sentence the row that opens it says (design §F4).
 *
 * ## The single highest-value change in the forms rebuild
 *
 * «Весь день» + «Дата» + «Начало» + «Длительность» used to be four labelled
 * controls stacked inside a nested bordered box in the middle of the create
 * form — a box in a box, four decisions where the family makes one, and about
 * 280px of the 1640px «Новое событие» sheet.
 *
 * They collapse into one row that **states the plan in words** — «Сегодня,
 * 19:00 · 1 час ›» — and a sheet that asks the four questions in the order a
 * person actually answers them. The common case («сегодня, в семь») is now
 * already correct when the sheet opens, so nobody has to visit it at all.
 *
 * ## Why the calendar is inline here and not a `DateField`
 *
 * `DateField` is the right control everywhere else, but its `PickerSurface`
 * opens a sheet of its own on a coarse pointer — and a sheet that opens a
 * second sheet to answer a sub-question of the first is exactly where a user
 * loses track of what they were answering. «Выбрать…» reveals the month grid
 * *in place*, under the chips. Same `Calendar`, same date-key value, one
 * surface.
 *
 * Nothing here builds a `Date` from `new Date(dateKey)`; see
 * `shared/lib/datetime.ts` for why that is a day-shifting bug (D2).
 */

const TEXT = {
  title: 'Когда',
  description: 'Дата, время и длительность.',
  today: 'Сегодня',
  tomorrow: 'Завтра',
  yesterday: 'Вчера',
  pick: 'Выбрать…',
  dateGroup: 'Дата',
  allDay: 'Весь день',
  start: 'Начало',
  startField: 'Время начала',
  duration: 'Сколько',
  otherDuration: 'Другое',
  allDayValue: 'весь день',
} as const;

export interface WhenValue {
  /** `YYYY-MM-DD` — a calendar day, never an instant (D2). */
  dateKey: string;
  /** `HH:mm` wall clock. Meaningless while `allDay` is on, but preserved. */
  time: string;
  allDay: boolean;
  /** Minutes. Ignored by anything that has no duration (a chore). */
  durationMinutes: number;
}

export interface DurationOption {
  minutes: number;
  label: string;
}

/* -------------------------------------------------------------------------
 * Date-key arithmetic. UTC-anchored, so a DST transition cannot shift a day.
 * ---------------------------------------------------------------------- */

function addDays(key: string, days: number): string {
  const time = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(time)) return key;
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

/** «Сегодня» / «Завтра» / «Вчера» / «20 августа» / «20 августа 2027». */
export function relativeDateLabel(key: string, todayKey: string): string {
  if (key === todayKey) return TEXT.today;
  if (key === addDays(todayKey, 1)) return TEXT.tomorrow;
  if (key === addDays(todayKey, -1)) return TEXT.yesterday;
  const date = dateKeyToDate(key);
  if (!date) return key;
  const sameYear = key.slice(0, 4) === todayKey.slice(0, 4);
  return formatDate(date, sameYear ? 'd MMMM' : 'd MMMM yyyy', { locale: ru });
}

function durationLabel(minutes: number, options: readonly DurationOption[]): string {
  return options.find((option) => option.minutes === minutes)?.label ?? formatDuration(minutes);
}

/**
 * The words on the row: «Сегодня, 19:00 · 1 час», «Завтра, весь день»,
 * «20 августа, 21:00».
 */
export function describeWhen(
  value: WhenValue,
  options: {
    todayKey: string;
    /** Off for a chore: a task has a moment, not a span. */
    withDuration?: boolean;
    durationOptions?: readonly DurationOption[];
  },
): string {
  const day = relativeDateLabel(value.dateKey, options.todayKey);
  if (value.allDay) return `${day}, ${TEXT.allDayValue}`;
  const time = isTimeValue(value.time) ? value.time : '00:00';
  if (!options.withDuration) return `${day}, ${time}`;
  return `${day}, ${time} · ${durationLabel(value.durationMinutes, options.durationOptions ?? [])}`;
}

/* -------------------------------------------------------------------------
 * The sheet
 * ---------------------------------------------------------------------- */

type DayMode = 'today' | 'tomorrow' | 'pick';

/** Три chips maximum in a row, and the row never wraps (§F4). */
const QUICK_DURATIONS = [30, 60, 120] as const;

/** ±1 час around the current value: one tap moves dinner an hour either way. */
function nearbyTimes(time: string): readonly string[] {
  const [hourPart = '19', minutePart = '00'] = time.split(':');
  const hour = Number(hourPart);
  const safe = Number.isFinite(hour) ? hour : 19;
  return [safe - 1, safe, safe + 1]
    .filter((candidate) => candidate >= 0 && candidate <= 23)
    .map((candidate) => `${String(candidate).padStart(2, '0')}:${minutePart}`);
}

export function WhenSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: WhenValue;
  onChange: (value: WhenValue) => void;
  /** Today in the **family** timezone — never the device one (D2). */
  todayKey: string;
  /** A chore is never «весь день»; an event is. */
  withAllDay?: boolean;
  withDuration?: boolean;
  durationOptions?: readonly DurationOption[];
  title?: string;
  /** Earliest selectable day, as a date key. */
  min?: string;
  /** react-day-picker's 0-based axis. See `shared/auth/week-start.ts`. */
  weekStartsOn?: DayPickerWeekStart;
}) {
  const { value, onChange, todayKey } = props;
  const withAllDay = props.withAllDay ?? false;
  const withDuration = props.withDuration ?? false;
  const durationOptions = props.durationOptions ?? [];

  const tomorrowKey = addDays(todayKey, 1);
  const mode: DayMode =
    value.dateKey === todayKey ? 'today' : value.dateKey === tomorrowKey ? 'tomorrow' : 'pick';

  // «Выбрать…» has to stay open when the user then picks today from the grid,
  // otherwise the calendar vanishes under their finger.
  const [showCalendar, setShowCalendar] = useState(mode === 'pick');
  const [showAllDurations, setShowAllDurations] = useState(false);

  useEffect(() => {
    if (props.open) return;
    setShowCalendar(false);
    setShowAllDurations(false);
  }, [props.open]);

  const quickDuration = QUICK_DURATIONS.find((minutes) => minutes === value.durationMinutes);
  const durationMode = showAllDurations || !quickDuration ? 'other' : String(value.durationMinutes);
  const selectedDay = dateKeyToDate(value.dateKey) ?? undefined;
  const min = props.min === undefined ? undefined : (dateKeyToDate(props.min) ?? undefined);

  return (
    <PickerSheet
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title ?? TEXT.title}
      description={TEXT.description}
      size="auto"
    >
      <div className="flex max-w-row-measure flex-col gap-4">
        <SegmentedControl<DayMode>
          label={TEXT.dateGroup}
          value={mode === 'pick' || showCalendar ? 'pick' : mode}
          options={[
            { value: 'today', label: TEXT.today },
            { value: 'tomorrow', label: TEXT.tomorrow },
            { value: 'pick', label: TEXT.pick },
          ]}
          onChange={(next) => {
            if (next === 'pick') {
              setShowCalendar(true);
              return;
            }
            setShowCalendar(false);
            onChange({ ...value, dateKey: next === 'today' ? todayKey : tomorrowKey });
          }}
        />

        {mode === 'pick' || showCalendar ? (
          <div className="rounded-xl border border-border bg-card">
            <Calendar
              mode="single"
              className="mx-auto w-fit p-3"
              {...(props.weekStartsOn === undefined ? {} : { weekStartsOn: props.weekStartsOn })}
              selected={selectedDay}
              defaultMonth={selectedDay ?? new Date()}
              {...(min ? { startMonth: min, disabled: { before: min } } : {})}
              onSelect={(day) => {
                if (!day) return;
                onChange({ ...value, dateKey: dateToDateKey(day) });
              }}
            />
          </div>
        ) : null}

        {withAllDay ? (
          <label className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <span className="text-[17px] leading-6">{TEXT.allDay}</span>
            <Switch
              aria-label={TEXT.allDay}
              checked={value.allDay}
              onCheckedChange={(checked) => {
                onChange({ ...value, allDay: checked });
              }}
            />
          </label>
        ) : null}

        {/* «Весь день» **hides** the clock rather than disabling it (§F4): a
            greyed-out control still asks to be read. */}
        {value.allDay ? null : (
          <>
            <div className="flex flex-col gap-2">
              <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                {TEXT.start}
              </span>
              <TimeField
                label={TEXT.startField}
                value={value.time}
                onChange={(next) => {
                  onChange({ ...value, time: next || value.time });
                }}
              />
              <SegmentedControl
                label={TEXT.start}
                value={value.time}
                options={nearbyTimes(value.time).map((time) => ({ value: time, label: time }))}
                onChange={(next) => {
                  onChange({ ...value, time: next });
                }}
              />
            </div>

            {withDuration ? (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                  {TEXT.duration}
                </span>
                <SegmentedControl
                  label={TEXT.duration}
                  value={durationMode}
                  options={[
                    ...QUICK_DURATIONS.map((minutes) => ({
                      value: String(minutes),
                      label: durationLabel(minutes, durationOptions),
                    })),
                    { value: 'other', label: TEXT.otherDuration },
                  ]}
                  onChange={(next) => {
                    if (next === 'other') {
                      setShowAllDurations(true);
                      return;
                    }
                    setShowAllDurations(false);
                    onChange({ ...value, durationMinutes: Number(next) });
                  }}
                />
                {durationMode === 'other' ? (
                  <OptionList>
                    {durationOptions.map((option) => (
                      <OptionRow
                        key={option.minutes}
                        label={option.label}
                        selected={option.minutes === value.durationMinutes}
                        onSelect={() => {
                          onChange({ ...value, durationMinutes: option.minutes });
                        }}
                      />
                    ))}
                  </OptionList>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </PickerSheet>
  );
}

/**
 * A day on its own — a goal's deadline, a rule's last date. Same inline
 * calendar, no clock, and an explicit way to say "no date" when the field is
 * genuinely optional.
 */
export function DateSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** `YYYY-MM-DD`, or `''` for "not set". */
  value: string;
  onChange: (value: string) => void;
  /** Renders «Без срока» / «Убрать дату» under the grid. */
  clearLabel?: string;
  min?: string;
  weekStartsOn?: DayPickerWeekStart;
}) {
  const selected = dateKeyToDate(props.value) ?? undefined;
  const min = props.min === undefined ? undefined : (dateKeyToDate(props.min) ?? undefined);

  return (
    <PickerSheet open={props.open} onOpenChange={props.onOpenChange} title={props.title}>
      <div className="flex max-w-row-measure flex-col gap-3">
        <div className="rounded-xl border border-border bg-card">
          <Calendar
            mode="single"
            className="mx-auto w-fit p-3"
            {...(props.weekStartsOn === undefined ? {} : { weekStartsOn: props.weekStartsOn })}
            selected={selected}
            defaultMonth={selected ?? new Date()}
            {...(min ? { startMonth: min, disabled: { before: min } } : {})}
            onSelect={(day) => {
              if (!day) return;
              props.onChange(dateToDateKey(day));
              props.onOpenChange(false);
            }}
          />
        </div>
        {props.clearLabel && props.value !== '' ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 self-start px-3 text-muted-foreground"
            onClick={() => {
              props.onChange('');
              props.onOpenChange(false);
            }}
          >
            {props.clearLabel}
          </Button>
        ) : null}
      </div>
    </PickerSheet>
  );
}

/** Shared by both create forms so «через полчаса» means the same thing twice. */
export function nextRoundTime(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const minutes = pick('hour') * 60 + pick('minute') + 30;
  const rounded = Math.ceil(minutes / 30) * 30;
  // Past 23:30 the next slot is tomorrow's; the caller owns the day, so the
  // clock simply stops at the last slot of this one.
  const capped = Math.min(rounded, 23 * 60 + 30);
  return `${String(Math.floor(capped / 60)).padStart(2, '0')}:${String(capped % 60).padStart(2, '0')}`;
}

/** Exported for the forms that need one of these words in a row label. */
export const WHEN_SHEET_TEXT = TEXT;
