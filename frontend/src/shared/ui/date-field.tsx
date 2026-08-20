import { useState } from 'react';
import { CalendarIcon, XIcon } from 'lucide-react';

import { cn } from '@/shared/lib/utils';
import { dateKeyToDate, dateToDateKey } from '@/shared/lib/datetime';
import { formatDateKeyLong } from '@/shared/lib/format';
import { Button } from '@/shared/ui/button';
import { Calendar } from '@/shared/ui/calendar';
import { fieldShellClass, PickerSurface } from '@/shared/ui/field-shell';
import type { DayPickerWeekStart } from '@/shared/auth/week-start';

export const DATE_FIELD_RU = {
  placeholder: 'Выберите дату',
  sheetTitle: 'Выберите дату',
  sheetDescription: 'Календарь для выбора даты.',
  clear: 'Очистить дату',
  empty: 'не выбрана',
};

/**
 * A date field that keeps its value as a **date key** — `YYYY-MM-DD`, the exact
 * string `<input type="date">` produced and the exact string the contract still
 * expects (D2). Only the presentation changes: the trigger shows the date the
 * way the rest of the app writes dates («7 сентября 2026 г.») instead of
 * whatever iOS decides to render («20 авг. 2026 г.»), and the picker is the
 * app's own `Calendar` — Russian, Monday-first — rather than the OS wheel.
 *
 * Nothing here ever builds a `Date` from `new Date(key)`; see
 * `shared/lib/datetime.ts` for why that is a day-shifting bug rather than a
 * style preference.
 */
export function DateField(props: {
  /** `YYYY-MM-DD`, or `''` for empty. */
  value: string;
  onChange: (value: string) => void;
  /** Visible field label; folded into the trigger's accessible name. */
  label: string;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Earliest selectable day, as a date key. */
  min?: string;
  /** Latest selectable day, as a date key. */
  max?: string;
  /** `dropdown` gives month/year selects — worth it for a birthday. */
  captionLayout?: 'label' | 'dropdown';
  /** Offer an × to empty the field. Only for genuinely optional dates. */
  clearable?: boolean;
  invalid?: boolean;
  describedBy?: string;
  weekStartsOn?: DayPickerWeekStart;
  className?: string;
  'data-testid'?: string;
}) {
  const [open, setOpen] = useState(false);

  const selected = dateKeyToDate(props.value) ?? undefined;
  const formatted = formatDateKeyLong(props.value);
  const placeholder = props.placeholder ?? DATE_FIELD_RU.placeholder;
  const min = props.min === undefined ? undefined : (dateKeyToDate(props.min) ?? undefined);
  const max = props.max === undefined ? undefined : (dateKeyToDate(props.max) ?? undefined);

  const trigger = (
    <button
      type="button"
      id={props.id}
      disabled={props.disabled}
      // The whole point of a button-as-field: a screen reader must hear the
      // value, not just «кнопка». `Дата: 7 сентября 2026 г.`
      aria-label={`${props.label}: ${formatted || DATE_FIELD_RU.empty}`}
      aria-invalid={props.invalid ?? undefined}
      aria-describedby={props.describedBy}
      data-testid={props['data-testid']}
      data-slot="date-field-trigger"
      className={cn(fieldShellClass, props.clearable && props.value !== '' && 'pr-12')}
    >
      <CalendarIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span
        className={cn('min-w-0 flex-1 truncate', formatted === '' && 'text-muted-foreground')}
      >
        {formatted === '' ? placeholder : formatted}
      </span>
    </button>
  );

  const calendar = (
    <Calendar
      mode="single"
      autoFocus
      className="mx-auto w-fit p-3"
      captionLayout={props.captionLayout ?? 'label'}
      {...(props.weekStartsOn === undefined ? {} : { weekStartsOn: props.weekStartsOn })}
      selected={selected}
      defaultMonth={selected ?? max ?? new Date()}
      {...(min ? { startMonth: min } : {})}
      {...(max ? { endMonth: max } : {})}
      disabled={
        min && max ? { before: min, after: max } : min ? { before: min } : max ? { after: max } : []
      }
      onSelect={(day) => {
        if (!day) return;
        props.onChange(dateToDateKey(day));
        setOpen(false);
      }}
    />
  );

  return (
    <div className={cn('relative w-full min-w-0', props.className)}>
      <PickerSurface
        open={open}
        onOpenChange={setOpen}
        trigger={trigger}
        title={DATE_FIELD_RU.sheetTitle}
        description={DATE_FIELD_RU.sheetDescription}
      >
        {calendar}
      </PickerSurface>

      {props.clearable && props.value !== '' && !props.disabled ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={DATE_FIELD_RU.clear}
          className="absolute top-1/2 right-0 size-11 -translate-y-1/2 text-muted-foreground"
          onClick={() => {
            props.onChange('');
          }}
        >
          <XIcon className="size-4" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}
