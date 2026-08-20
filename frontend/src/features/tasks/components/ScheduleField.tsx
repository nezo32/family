import { useState } from 'react';
import { CalendarClock, Clock, Lock, Repeat } from 'lucide-react';
import type { RecurrenceView } from '@family/shared';
import { Button } from '@/shared/ui/button';
import { PickerSheet } from '@/shared/ui/option-sheet';
import { ValueRow } from '@/shared/ui/value-row';
import { describeWhen, WhenSheet, type WhenValue } from '@/shared/ui/when-sheet';
import { joinFloating, splitFloating } from '@/shared/lib/datetime';
import { TASKS_RU } from '../locale';
import { ONCE, scheduleFromView, type ScheduleValue } from '../recurrence';
import { RecurrenceBuilder, scheduleLabel } from './RecurrenceBuilder';

/**
 * The two rows a chore's schedule became (design §F3–F5).
 *
 * Before: a `DateTimeField` pair plus a five-option chip grid plus a bordered
 * parameter box plus an «Заканчивается» chip row — about 320px of the 1326px
 * «Новое дело» dialog, all of it above «Создать» and none of it touched by the
 * family member who is adding «вынести мусор» before dinner.
 *
 * After: `🕘 Сегодня, 21:00 ›` and `🔁 Повторение · не повторяется ›`. Both
 * state their answer in words, both open a sheet, and the sheet is where the
 * height goes — not the form.
 *
 * The two rows sit in different places on the form (когда is a primary control,
 * повторение lives under «Подробнее»), which is why this file exports two
 * components instead of one block. The state they share — whether the schedule
 * is editable at all — is owned by the form above them.
 *
 * The interesting case is a series whose stored rule does **not** decompile
 * into the restricted grammar (`recurrence.preset === null`, i.e. an ICS
 * import). Rendering the builder for it would silently rewrite a schedule
 * nobody asked us to touch, so it stays inline, read-only, with the server's
 * Russian summary — the one thing here that is *not* hidden behind a row,
 * because it is the one thing the user cannot be assumed to already know.
 */

/** Does this view carry a rule the builder cannot express? */
export function isCustomSchedule(view: RecurrenceView | null | undefined): boolean {
  return view != null && scheduleFromView(view) === null;
}

/* -------------------------------------------------------------------------
 * «Когда» — the anchor of the series
 * ---------------------------------------------------------------------- */

export function ScheduleWhenRow(props: {
  /** Floating local datetime, `YYYY-MM-DDTHH:mm:ss` (D2). */
  dtstartLocal: string;
  onChange: (value: string) => void;
  /** Today in the family timezone. */
  todayKey: string;
  /** `scope: 'this'` and imported rules forbid a schedule change. */
  locked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { date, time } = splitFloating(props.dtstartLocal);
  const value: WhenValue = { dateKey: date, time, allDay: false, durationMinutes: 0 };
  const sentence = describeWhen(value, { todayKey: props.todayKey });

  return (
    <>
      <ValueRow
        icon={<Clock />}
        label={sentence}
        disabled={props.locked}
        {...(props.locked
          ? {}
          : {
              onClick: () => {
                setOpen(true);
              },
            })}
      />
      <WhenSheet
        open={open}
        onOpenChange={setOpen}
        value={value}
        todayKey={props.todayKey}
        onChange={(next) => {
          props.onChange(joinFloating(next.dateKey, next.time));
        }}
      />
    </>
  );
}

/* -------------------------------------------------------------------------
 * «Повторение» — the rule
 * ---------------------------------------------------------------------- */

export function ScheduleRepeatRow(props: {
  value: ScheduleValue;
  onChange: (value: ScheduleValue) => void;
  dtstartLocal: string;
  /** The saved series' recurrence, when editing. */
  view?: RecurrenceView | null;
  /** `scope: 'this'` forbids a schedule change (taskSeriesUpdateSchema). */
  locked?: boolean;
  /** Told when an imported rule is replaced, so the form can unlock «Когда». */
  onReplaceCustom?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const custom = isCustomSchedule(props.view);

  if (props.locked) {
    return (
      <ValueRow
        icon={<Lock />}
        label={TASKS_RU.recurrence.summaryLabel}
        hint={props.view?.summary ?? TASKS_RU.detail.seriesOnce}
        disabled
      />
    );
  }

  if (custom && !replacing) {
    return (
      <div className="flex max-w-row-measure flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-2 text-[15px] font-medium text-foreground">
          <CalendarClock className="size-4" aria-hidden />
          {TASKS_RU.recurrence.customTitle}
        </div>
        <p className="text-[15px] text-foreground">{props.view?.summary}</p>
        <p className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
          {TASKS_RU.recurrence.customDescription}
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full sm:w-auto"
          onClick={() => {
            setReplacing(true);
            props.onChange(ONCE);
            props.onReplaceCustom?.();
          }}
        >
          {TASKS_RU.recurrence.replace}
        </Button>
      </div>
    );
  }

  return (
    <>
      <ValueRow
        icon={<Repeat />}
        label={TASKS_RU.recurrence.legend}
        value={scheduleLabel(props.value)}
        onClick={() => {
          setOpen(true);
        }}
      />
      <PickerSheet
        open={open}
        onOpenChange={setOpen}
        title={TASKS_RU.recurrence.legend}
        size="tall"
      >
        <RecurrenceBuilder
          value={props.value}
          onChange={props.onChange}
          dtstartLocal={props.dtstartLocal}
        />
      </PickerSheet>
    </>
  );
}
