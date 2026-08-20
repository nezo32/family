import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, ClockIcon } from 'lucide-react';

import { cn } from '@/shared/lib/utils';
import { isTimeValue, parseTimeInput } from '@/shared/lib/datetime';
import { fieldShellClass, PickerSurface } from '@/shared/ui/field-shell';

export const TIME_FIELD_RU = {
  placeholder: '09:00',
  open: 'Выбрать из списка',
  sheetTitle: 'Выберите время',
  sheetDescription: 'Часы и минуты, шаг 5 минут.',
  hours: 'Часы',
  minutes: 'Минуты',
};

/** Minutes offered in the list. Typing is not restricted to them. */
const MINUTE_STEP = 5;

/**
 * A time field whose value stays a plain `HH:mm` — the same string
 * `<input type="time">` produced, so nothing downstream changes (D2).
 *
 * Two ways in, because a phone and a keyboard want different things:
 *
 * - **Type it.** `9`, `930`, `9:30`, `9.30` all become `09:30` on blur. An
 *   unparseable draft reverts to the committed value rather than being coerced
 *   into some nearby time nobody asked for.
 * - **Pick it.** Two short columns — hours and 5-minute steps — in a popover on
 *   a desktop and a bottom sheet on a phone. Five minutes is as fine as a
 *   family calendar ever needs, and it keeps the minute column to twelve rows
 *   instead of sixty.
 *
 * A value that is *not* on the 5-minute grid (an imported 09:07) is kept and
 * shown as selected; the grid is what the list offers, not what the field
 * permits.
 */
export function TimeField(props: {
  /** `HH:mm`. */
  value: string;
  onChange: (value: string) => void;
  /** Visible field label; folded into the accessible names. */
  label: string;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  'data-testid'?: string;
}) {
  const [open, setOpen] = useState(false);
  /** What the user is mid-typing. `null` means "show the committed value". */
  const [draft, setDraft] = useState<string | null>(null);

  const value = isTimeValue(props.value) ? props.value : '';
  const [hourPart = '', minutePart = ''] = value.split(':');

  const commit = (): void => {
    if (draft === null) return;
    const parsed = parseTimeInput(draft);
    setDraft(null);
    if (parsed !== null && parsed !== value) props.onChange(parsed);
  };

  const setHour = (hour: number): void => {
    props.onChange(`${String(hour).padStart(2, '0')}:${minutePart || '00'}`);
  };
  const setMinute = (minute: number): void => {
    props.onChange(`${hourPart || '00'}:${String(minute).padStart(2, '0')}`);
  };

  const hours = Array.from({ length: 24 }, (_, index) => index);
  const minutes = buildMinuteOptions(minutePart);

  const trigger = (
    <button
      type="button"
      disabled={props.disabled}
      aria-label={`${props.label}: ${value || TIME_FIELD_RU.placeholder}. ${TIME_FIELD_RU.open}`}
      // 44px, reaching into the shell's own padding: a 36px chevron is under
      // the tap-target minimum however tall the field around it is.
      className="-my-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <ChevronDownIcon className="size-4" aria-hidden />
    </button>
  );

  return (
    <div
      data-slot="time-field"
      className={cn(
        fieldShellClass,
        'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        props.disabled && 'pointer-events-none opacity-50',
        props.className,
      )}
      aria-invalid={props.invalid ?? undefined}
    >
      <ClockIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <input
        id={props.id}
        type="text"
        // `numeric` gives iOS the digit pad without the "Готово" bar of a
        // native time control, and `text` keeps the colon typeable.
        inputMode="numeric"
        autoComplete="off"
        aria-label={props.label}
        aria-describedby={props.describedBy}
        disabled={props.disabled}
        data-testid={props['data-testid']}
        placeholder={TIME_FIELD_RU.placeholder}
        value={draft ?? value}
        maxLength={5}
        className="h-full w-full min-w-0 flex-1 bg-transparent text-base tabular-nums outline-none placeholder:text-muted-foreground"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') setDraft(null);
        }}
      />
      <PickerSurface
        open={open}
        onOpenChange={setOpen}
        trigger={trigger}
        title={TIME_FIELD_RU.sheetTitle}
        description={TIME_FIELD_RU.sheetDescription}
      >
        <div className="flex gap-2 p-2 sm:p-3">
          <TimeColumn
            label={TIME_FIELD_RU.hours}
            open={open}
            options={hours}
            selected={hourPart === '' ? null : Number(hourPart)}
            onSelect={setHour}
          />
          <TimeColumn
            label={TIME_FIELD_RU.minutes}
            open={open}
            options={minutes}
            selected={minutePart === '' ? null : Number(minutePart)}
            onSelect={setMinute}
          />
        </div>
      </PickerSurface>
    </div>
  );
}

/** The 5-minute grid, plus the current minute when it is off-grid. */
function buildMinuteOptions(minutePart: string): readonly number[] {
  const grid: number[] = [];
  for (let minute = 0; minute < 60; minute += MINUTE_STEP) grid.push(minute);
  const current = minutePart === '' ? Number.NaN : Number(minutePart);
  if (Number.isInteger(current) && !grid.includes(current)) {
    grid.push(current);
    grid.sort((a, b) => a - b);
  }
  return grid;
}

function TimeColumn(props: {
  label: string;
  open: boolean;
  options: readonly number[];
  selected: number | null;
  onSelect: (value: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!props.open) return;
    selectedRef.current?.scrollIntoView({ block: 'center' });
  }, [props.open]);

  return (
    <div
      role="listbox"
      aria-label={props.label}
      className="max-h-[min(50vh,15rem)] flex-1 overflow-y-auto overscroll-contain rounded-md border border-border p-1"
    >
      {props.options.map((option) => {
        const isSelected = option === props.selected;
        return (
          <button
            key={option}
            ref={isSelected ? selectedRef : undefined}
            type="button"
            role="option"
            aria-selected={isSelected}
            className={cn(
              'flex h-11 w-full items-center justify-center rounded-md text-base tabular-nums transition-colors',
              isSelected
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-accent hover:text-accent-foreground',
            )}
            onClick={() => {
              props.onSelect(option);
            }}
          >
            {String(option).padStart(2, '0')}
          </button>
        );
      })}
    </div>
  );
}
