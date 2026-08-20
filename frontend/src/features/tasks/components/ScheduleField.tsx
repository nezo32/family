import { useState } from 'react';
import { CalendarClock, Lock } from 'lucide-react';
import type { RecurrenceView } from '@family/shared';
import { Button } from '@/shared/ui/button';
import { DateTimeField } from '@/shared/ui/date-time-field';
import { TASKS_RU } from '../locale';
import { ONCE, scheduleFromView, type ScheduleValue } from '../recurrence';
import { RecurrenceBuilder } from './RecurrenceBuilder';

/**
 * Start anchor + repetition, together — they are one decision for the user even
 * though the contract splits them into `dtstartLocal` and `recurrence`.
 *
 * The interesting case is a series whose stored rule does **not** decompile into
 * the restricted grammar (`recurrence.preset === null`, i.e. an ICS import).
 * Rendering the builder for it would silently rewrite a schedule nobody asked us
 * to touch, so it is shown read-only with the server's Russian summary and the
 * only offer is to replace the whole thing.
 */
export function ScheduleField(props: {
  dtstartLocal: string;
  onDtstartChange: (value: string) => void;
  value: ScheduleValue;
  onChange: (value: ScheduleValue) => void;
  /** The saved series' recurrence, when editing. */
  view?: RecurrenceView | null;
  /** `scope: 'this'` forbids a schedule change (taskSeriesUpdateSchema). */
  locked?: boolean;
  disabled?: boolean;
}) {
  const custom = props.view != null && scheduleFromView(props.view) === null;
  const [replacing, setReplacing] = useState(false);

  if (props.locked) {
    return (
      <section className="space-y-2 rounded-xl border border-border bg-muted/40 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Lock className="size-4" aria-hidden />
          {TASKS_RU.recurrence.summaryLabel}
        </div>
        <p className="text-sm text-muted-foreground">
          {props.view?.summary ?? TASKS_RU.detail.seriesOnce}
        </p>
      </section>
    );
  }

  if (custom && !replacing) {
    return (
      <section className="space-y-3 rounded-xl border border-border bg-muted/40 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CalendarClock className="size-4" aria-hidden />
          {TASKS_RU.recurrence.customTitle}
        </div>
        <p className="text-sm text-foreground">{props.view?.summary}</p>
        <p className="text-xs text-pretty text-muted-foreground">
          {TASKS_RU.recurrence.customDescription}
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full sm:w-auto"
          onClick={() => {
            setReplacing(true);
            props.onChange(ONCE);
          }}
        >
          {TASKS_RU.recurrence.replace}
        </Button>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <DateTimeField
        idPrefix="task"
        dateLabel={TASKS_RU.form.date}
        timeLabel={TASKS_RU.form.time}
        value={props.dtstartLocal}
        disabled={props.disabled}
        onChange={props.onDtstartChange}
      />

      <RecurrenceBuilder
        value={props.value}
        onChange={props.onChange}
        dtstartLocal={props.dtstartLocal}
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      />
    </div>
  );
}
