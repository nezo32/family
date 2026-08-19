import { useMemo, useRef, useState } from 'react';
import { useForm, type FieldError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { taskSeriesCreateSchema, type PublicUser, type TaskSeriesResponse } from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import { getFamilyTimeZone } from '@/shared/lib/format';
import { COMMON } from '@/shared/lib/i18n';
import { TASKS_RU } from '../locale';
import { ONCE, scheduleFromView, todayKey, type ScheduleValue } from '../recurrence';
import { ScheduleField } from './ScheduleField';
import { SegmentedControl } from './SegmentedControl';

/**
 * Create / edit form.
 *
 * Validation is `zodResolver` against the **shared** contract minus the
 * recurrence branch: `recurrenceSpecSchema` is a discriminated union that the
 * restricted builder owns end to end, and threading a union through RHF's field
 * paths buys nothing except a class of "which arm is registered" bug.
 */

const taskFieldsSchema = taskSeriesCreateSchema.omit({ recurrence: true });
type TaskFieldsInput = z.input<typeof taskFieldsSchema>;
type TaskFieldsOutput = z.output<typeof taskFieldsSchema>;

export interface TaskFormSubmit {
  fields: TaskFieldsOutput;
  dtstartLocal: string;
  schedule: ScheduleValue;
  /** `false` lets the caller omit `recurrence` and leave the schedule alone. */
  scheduleChanged: boolean;
}

/** Русские сообщения для generic-ошибок zod (see `TASKS_RU.validation`). */
function messageFor(error: FieldError | undefined): string | null {
  if (!error) return null;
  // Schemas that care about their wording already write Russian; keep it.
  if (error.message && /[А-Яа-яЁё]/.test(error.message)) return error.message;
  switch (error.type) {
    case 'too_small':
      return TASKS_RU.validation.tooShort;
    case 'too_big':
      return TASKS_RU.validation.tooLong;
    case 'invalid_type':
      return TASKS_RU.validation.required;
    default:
      return TASKS_RU.validation.invalid;
  }
}

function FieldMessage(props: { error: FieldError | undefined }) {
  const text = messageFor(props.error);
  if (!text) return null;
  return <p className="text-sm text-destructive">{text}</p>;
}

const DUE_OPTIONS = [
  { value: '0', label: TASKS_RU.form.dueOptions.atStart },
  { value: '60', label: TASKS_RU.form.dueOptions.hour },
  { value: '1440', label: TASKS_RU.form.dueOptions.nextDay },
  { value: '10080', label: TASKS_RU.form.dueOptions.week },
] as const;

function defaultDtstart(): string {
  return `${todayKey(getFamilyTimeZone())}T09:00:00`;
}

export function TaskForm(props: {
  series?: TaskSeriesResponse | null;
  members: readonly PublicUser[];
  /** `scope: 'this'` — the contract forbids a schedule change in that scope. */
  scheduleLocked?: boolean;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (result: TaskFormSubmit) => void;
  onCancel: () => void;
}) {
  const { can } = useCan();
  const series = props.series ?? null;

  const [dtstartLocal, setDtstartLocal] = useState<string>(
    series?.recurrence.dtstartLocal ?? defaultDtstart(),
  );
  const [schedule, setSchedule] = useState<ScheduleValue>(() => {
    if (!series) return ONCE;
    return scheduleFromView(series.recurrence) ?? ONCE;
  });

  // Snapshot of what was loaded, so an untouched schedule is not resent (and a
  // resend would re-materialize every future occurrence for nothing).
  const initial = useRef(
    JSON.stringify({
      dtstartLocal: series?.recurrence.dtstartLocal ?? defaultDtstart(),
      schedule: series ? (scheduleFromView(series.recurrence) ?? ONCE) : ONCE,
    }),
  );

  const defaultValues = useMemo<TaskFieldsInput>(
    () => ({
      title: series?.title ?? '',
      notes: series?.notes ?? null,
      visibility: series?.visibility ?? 'household',
      dueOffsetMinutes: series?.dueOffsetMinutes ?? 0,
      graceMinutes: series?.graceMinutes ?? 0,
      rotationId: series?.rotationId ?? null,
      defaultAssigneeId: series?.defaultAssigneeId ?? null,
      points: series?.points ?? 0,
      category: series?.category ?? null,
      autoCancelAfterDays: series?.autoCancelAfterDays ?? null,
    }),
    [series],
  );

  const form = useForm<TaskFieldsInput, unknown, TaskFieldsOutput>({
    resolver: zodResolver(taskFieldsSchema),
    defaultValues,
  });

  const errors = form.formState.errors;
  const assigneeId = form.watch('defaultAssigneeId');
  const dueOffset = form.watch('dueOffsetMinutes');

  const submit = form.handleSubmit((fields) => {
    const scheduleChanged =
      !props.scheduleLocked && JSON.stringify({ dtstartLocal, schedule }) !== initial.current;
    props.onSubmit({ fields, dtstartLocal, schedule, scheduleChanged });
  });

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        void submit(event);
      }}
      noValidate
    >
      <div className="space-y-1.5">
        <Label htmlFor="task-title">{TASKS_RU.form.name}</Label>
        <Input
          id="task-title"
          placeholder={TASKS_RU.form.namePlaceholder}
          autoComplete="off"
          className="h-11 text-base"
          aria-invalid={errors.title ? true : undefined}
          {...form.register('title')}
        />
        <FieldMessage error={errors.title} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="task-notes">
          {TASKS_RU.form.notes}{' '}
          <span className="text-xs font-normal text-muted-foreground">({COMMON.optional})</span>
        </Label>
        <Textarea
          id="task-notes"
          placeholder={TASKS_RU.form.notesPlaceholder}
          className="min-h-20 text-base"
          {...form.register('notes', {
            setValueAs: (value: string) => (value === '' ? null : value),
          })}
        />
        <FieldMessage error={errors.notes} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="task-category">{TASKS_RU.form.category}</Label>
          <Input
            id="task-category"
            placeholder={TASKS_RU.form.categoryPlaceholder}
            autoComplete="off"
            className="h-11 text-base"
            {...form.register('category', {
              setValueAs: (value: string) => (value === '' ? null : value),
            })}
          />
          <FieldMessage error={errors.category} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="task-points">{TASKS_RU.form.points}</Label>
          <Input
            id="task-points"
            type="number"
            inputMode="numeric"
            min={0}
            max={1000}
            className="h-11 text-base"
            {...form.register('points', {
              setValueAs: (value: string) => (value === '' ? 0 : Number(value)),
            })}
          />
          <p className="text-xs text-muted-foreground">{TASKS_RU.form.pointsHint}</p>
          <FieldMessage error={errors.points} />
        </div>
      </div>

      {can('task:assign') ? (
        <SegmentedControl
          label={TASKS_RU.form.assignee}
          value={assigneeId ?? 'nobody'}
          options={[
            { value: 'nobody', label: TASKS_RU.form.assigneeNobody },
            ...props.members.map((member) => ({ value: member.id, label: member.displayName })),
          ]}
          onChange={(value) => {
            form.setValue('defaultAssigneeId', value === 'nobody' ? null : value, {
              shouldDirty: true,
            });
          }}
        />
      ) : null}

      <SegmentedControl
        label={TASKS_RU.form.due}
        value={String(dueOffset ?? 0)}
        options={DUE_OPTIONS}
        onChange={(value) => {
          form.setValue('dueOffsetMinutes', Number(value), { shouldDirty: true });
        }}
      />

      <ScheduleField
        dtstartLocal={dtstartLocal}
        onDtstartChange={setDtstartLocal}
        value={schedule}
        onChange={setSchedule}
        view={series?.recurrence ?? null}
        {...(props.scheduleLocked === undefined ? {} : { locked: props.scheduleLocked })}
      />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          onClick={props.onCancel}
          disabled={props.submitting}
        >
          {COMMON.cancel}
        </Button>
        <Button type="submit" className="min-h-11" disabled={props.submitting}>
          {props.submitting ? COMMON.saving : props.submitLabel}
        </Button>
      </div>
    </form>
  );
}
