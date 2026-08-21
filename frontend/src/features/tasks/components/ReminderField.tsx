import { Bell, Check } from 'lucide-react';

import { cn } from '@/shared/lib/utils';
import { OptionList, PickerSheet } from '@/shared/ui/option-sheet';
import { ValueRow } from '@/shared/ui/value-row';
import { TASKS_RU } from '../locale';

/**
 * «Напоминание» — the row, and the sheet it opens (design §F5).
 *
 * ## What the owner asked for, and what this is
 *
 * «нужно добавить напоминания о предстоящем деле опциональные за час (или
 * несколько часов), за день (или несколько дней) и обязательное оповещение
 * прям во время начала дела».
 *
 * Three things, but only two of them are choices. The lead times are a
 * multi-select; the at-start notification is **not in the picker at all**. It
 * is the first row of the sheet, stated as a fact with no control next to it,
 * because a checkbox that cannot be unchecked is worse than no checkbox — it
 * invites a tap and then refuses it. Storing it as a `0` in the offsets array
 * would have been worse still: anything in that array is something an edit can
 * drop, and the whole point is that this one cannot be dropped.
 *
 * Where "mandatory" stops is written on the row itself:
 * «Выключить можно только в настройках уведомлений.» That door has to exist —
 * D10's entire premise is that a family which cannot turn a notification off
 * turns *all* of them off — but it is a deliberate, global, one-time decision
 * in Настройки, not something you can forget while composing a chore.
 *
 * ## Why this does not undo §D-forms
 *
 * The create sheet was cut to six visible controls with everything else behind
 * «Ещё», and the target is «ужин у бабушки» in two taps and one typed line.
 * This adds **one** row, in the «ПОДРОБНЕЕ» section, and that row states its
 * own value — «В момент начала», «За день и за час» — so nothing is hidden by
 * being one tap away. The fast path is untouched: a family that wants the
 * default never opens it.
 */

/** Contract cap. Mirrors `taskSeriesCreateSchema.reminderOffsets.max(5)`. */
const MAX_REMINDERS = 5;

/**
 * The row's value, in words.
 *
 * One lead reads as itself, two as «За день и за час» — the server stores the
 * array furthest-first precisely so this reads in the order a person says it.
 * Three or more stop being a sentence and become a count; «За неделю, за 2 дня,
 * за день и за час» in a 56px row is a wall, not an answer.
 */
export function reminderSummary(offsets: readonly number[]): string {
  if (offsets.length === 0) return TASKS_RU.form.remindersNone;
  if (offsets.length > 2) return TASKS_RU.form.remindersManyValue(offsets.length);

  const labelFor = (minutes: number): string =>
    TASKS_RU.form.remindersOptions.find((option) => option.minutes === minutes)?.label ??
    `За ${String(minutes)} мин`;

  const [first, second] = offsets;
  if (second === undefined) return labelFor(first ?? 0);
  // The second half is lowercased so the two read as one phrase rather than as
  // two headings joined by «и».
  return `${labelFor(first ?? 0)}${TASKS_RU.form.remindersJoin}${labelFor(second).toLowerCase()}`;
}

/** Furthest-first, de-duplicated — the same order the server normalizes to. */
function normalize(offsets: readonly number[]): number[] {
  return [...new Set(offsets)].sort((a, b) => b - a);
}

export function ReminderRow(props: { value: readonly number[]; onClick: () => void }) {
  return (
    <ValueRow
      icon={<Bell />}
      label={TASKS_RU.form.reminders}
      value={reminderSummary(props.value)}
      onClick={props.onClick}
    />
  );
}

export function ReminderSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: readonly number[];
  onChange: (next: number[]) => void;
}) {
  const selected = new Set(props.value);
  const atCap = selected.size >= MAX_REMINDERS;

  const toggle = (minutes: number): void => {
    const next = new Set(selected);
    if (next.has(minutes)) next.delete(minutes);
    else if (!atCap) next.add(minutes);
    props.onChange(normalize([...next]));
  };

  return (
    <PickerSheet
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={TASKS_RU.form.remindersSheetTitle}
      size="tall"
      bodyClassName="flex flex-col gap-4"
    >
      {/* The unremovable one. A row, not a control: there is nothing to decide. */}
      <OptionList role="group">
        <div className="flex min-h-14 w-full items-center gap-3 px-4 py-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[17px] leading-6 font-medium">
              {TASKS_RU.form.remindersAlwaysLabel}
            </span>
            <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
              {TASKS_RU.form.remindersAlwaysHint}
            </span>
          </span>
          <span className="shrink-0 text-[15px] leading-[22px] text-muted-foreground">
            {TASKS_RU.form.remindersAlwaysValue}
          </span>
        </div>
      </OptionList>

      {/*
        `role="group"` with `role="checkbox"` rows, not the `radiogroup` /
        `radio` pairing `OptionRow` hard-codes: these are independent toggles,
        and announcing them as a radio group would tell a screen reader that
        picking «за день» drops «за час».
      */}
      <OptionList role="group" label={TASKS_RU.form.remindersAheadLabel}>
        {TASKS_RU.form.remindersOptions.map((option) => {
          const on = selected.has(option.minutes);
          return (
            <button
              key={option.minutes}
              type="button"
              role="checkbox"
              aria-checked={on}
              // At the cap the unchosen rows go inert rather than disappearing,
              // so the list does not reflow under the thumb that just filled it.
              disabled={!on && atCap}
              onClick={() => {
                toggle(option.minutes);
              }}
              className={cn(
                'flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors',
                'touch-manipulation no-callout',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                'disabled:pointer-events-none disabled:opacity-50',
                'hover:bg-muted/40 active:bg-muted/60',
              )}
            >
              <span
                className={cn('flex-1 text-[17px] leading-6', on && 'font-medium text-foreground')}
              >
                {option.label}
              </span>
              {/* A tick, not a filled pill: colour is never the only signal (§B4). */}
              <Check
                aria-hidden
                className={cn(
                  'size-5 shrink-0 text-primary transition-opacity',
                  on ? 'opacity-100' : 'opacity-0',
                )}
              />
            </button>
          );
        })}
      </OptionList>

      {atCap ? (
        <p className="px-1 text-[13px] leading-[18px] text-muted-foreground">
          {TASKS_RU.form.remindersLimitHint}
        </p>
      ) : null}
    </PickerSheet>
  );
}
