import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useForm, type FieldError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Eye, FileText, Hourglass, Tag, Users } from 'lucide-react';
import { taskSeriesCreateSchema, type PublicUser, type TaskSeriesResponse } from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { FormSheet } from '@/shared/ui/form-sheet';
import { OptionList, OptionRow, PickerSheet, TextSheet } from '@/shared/ui/option-sheet';
import { Section, SectionStack } from '@/shared/ui/section';
import { ValueRow } from '@/shared/ui/value-row';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { Button } from '@/shared/ui/button';
import { getFamilyTimeZone } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { TASKS_RU } from '../locale';
import { ONCE, scheduleFromView, todayKey, type ScheduleValue } from '../recurrence';
import { isCustomSchedule, ScheduleRepeatRow, ScheduleWhenRow } from './ScheduleField';

/**
 * «Новое дело» / «Изменить дело» — the full-screen sheet (design §F3–F5).
 *
 * ## What this replaced
 *
 * A 358 × **1326** px dialog on an 844px phone whose «Создать» sat at y≈1169 —
 * off-screen, at every viewport measured, 1440×900 included. Twelve labelled
 * controls of equal weight, three of them 2-column chip grids, and no signal
 * anywhere that a title and a time are all a chore actually needs.
 *
 * ## The shape now
 *
 * ```
 *   Отмена        Новое дело        Создать     ← fixed header, never scrolls
 *   ┌───────────────────────────────────────┐
 *   │ Например: вынести мусор               │   ← title first, autofocused
 *   │ 🕘  Сегодня, 21:00                  › │   ← the when-row
 *   └───────────────────────────────────────┘
 *   ПОДРОБНЕЕ
 *   🔁 Повторение          не повторяется  ›
 *   👥 Кто                          Любой  ›
 *   📝 Заметка                          —  ›
 *   ⌄ Ещё                                     ← срок, категория, кто видит
 * ```
 *
 * Every row states its own value, so nothing is hidden by being moved behind a
 * tap — «Повторение · не повторяется» answers the question from the form. The
 * target is «вынести мусор, сегодня» in **two taps and one typed line**: open,
 * type, «Создать».
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

const DUE_OPTIONS = [
  { minutes: 0, label: TASKS_RU.form.dueOptions.atStart, hint: TASKS_RU.form.dueHints.atStart },
  { minutes: 60, label: TASKS_RU.form.dueOptions.hour, hint: TASKS_RU.form.dueHints.hour },
  { minutes: 1440, label: TASKS_RU.form.dueOptions.nextDay, hint: TASKS_RU.form.dueHints.nextDay },
  { minutes: 10080, label: TASKS_RU.form.dueOptions.week, hint: TASKS_RU.form.dueHints.week },
] as const;

const VISIBILITY_OPTIONS = [
  { value: 'household', label: TASKS_RU.visibility.household },
  { value: 'restricted', label: TASKS_RU.visibility.restricted },
  { value: 'private', label: TASKS_RU.visibility.private },
] as const;

/**
 * «До конца вечера» is what a family means by "today" (§F2). Created before
 * six, the chore is due tonight at nine; created after, tomorrow night — a
 * chore handed out at 22:30 that is already overdue is not a default, it is a
 * bug wearing one.
 */
function defaultDtstart(timeZone: string, now: Date = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', hour12: false }).format(now),
  );
  const today = todayKey(timeZone, now);
  if (Number.isFinite(hour) && hour >= 18) {
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    return `${tomorrow}T21:00:00`;
  }
  return `${today}T21:00:00`;
}

interface TaskDraft {
  fields: TaskFieldsInput;
  dtstartLocal: string;
  schedule: ScheduleValue;
}

export function TaskForm(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  series?: TaskSeriesResponse | null;
  members: readonly PublicUser[];
  /** `scope: 'this'` — the contract forbids a schedule change in that scope. */
  scheduleLocked?: boolean;
  submitting: boolean;
  sheetTitle: string;
  submitLabel: string;
  /** The recurrence-scope chip, fixed under the header (§F6). */
  banner?: ReactNode;
  onSubmit: (result: TaskFormSubmit) => void;
}) {
  const { can } = useCan();
  const series = props.series ?? null;
  const timeZone = getFamilyTimeZone();
  const today = todayKey(timeZone);
  const formId = useId();

  const initialDtstart = series?.recurrence.dtstartLocal ?? defaultDtstart(timeZone);
  const [dtstartLocal, setDtstartLocal] = useState<string>(initialDtstart);
  const [schedule, setSchedule] = useState<ScheduleValue>(() => {
    if (!series) return ONCE;
    return scheduleFromView(series.recurrence) ?? ONCE;
  });
  const [customReplaced, setCustomReplaced] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [openSheet, setOpenSheet] = useState<
    'who' | 'due' | 'category' | 'notes' | 'who-sees' | null
  >(null);

  // Snapshot of what was loaded, so an untouched schedule is not resent (and a
  // resend would re-materialize every future occurrence for nothing).
  const initial = useRef(
    JSON.stringify({
      dtstartLocal: initialDtstart,
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
      category: series?.category ?? null,
      autoCancelAfterDays: series?.autoCancelAfterDays ?? null,
    }),
    [series],
  );

  const form = useForm<TaskFieldsInput, unknown, TaskFieldsOutput>({
    resolver: zodResolver(taskFieldsSchema),
    defaultValues,
  });

  /**
   * Re-seed on open. The editor stays mounted between openings, so without this
   * the second «Новое дело» of the day arrives pre-filled with the first one.
   *
   * The guard is not decoration: `FormSheet` is a *child*, so its
   * draft-restore effect runs before this one on the same commit (React flushes
   * effects bottom-up). Without the ref, restoring a draft that survived an iOS
   * background kill would be immediately overwritten by these defaults — the
   * draft would be read, applied, and thrown away inside one render.
   */
  const restoredDraft = useRef(false);
  useEffect(() => {
    if (!props.open) {
      restoredDraft.current = false;
      return;
    }
    if (restoredDraft.current) return;
    const seeded = series?.recurrence.dtstartLocal ?? defaultDtstart(timeZone);
    const seededSchedule = series ? (scheduleFromView(series.recurrence) ?? ONCE) : ONCE;
    initial.current = JSON.stringify({ dtstartLocal: seeded, schedule: seededSchedule });
    setDtstartLocal(seeded);
    setSchedule(seededSchedule);
    setCustomReplaced(false);
    setShowMore(false);
    setOpenSheet(null);
    form.reset(defaultValues);
    // `form` is stable and `timeZone` is a module-level setting, not state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, series?.id, defaultValues]);

  const errors = form.formState.errors;
  const title = form.watch('title') ?? '';
  const assigneeId = form.watch('defaultAssigneeId') ?? null;
  const dueOffset = Number(form.watch('dueOffsetMinutes') ?? 0);
  const category = form.watch('category') ?? '';
  const notes = form.watch('notes') ?? '';
  const visibility = form.watch('visibility') ?? 'household';

  const scheduleChanged = JSON.stringify({ dtstartLocal, schedule }) !== initial.current;
  const assignee = props.members.find((member) => member.id === assigneeId) ?? null;
  const scheduleLocked = props.scheduleLocked === true;
  // An imported rule is left alone until the user explicitly replaces it —
  // moving its anchor would rewrite a schedule nobody asked us to touch.
  const anchorLocked = scheduleLocked || (isCustomSchedule(series?.recurrence) && !customReplaced);

  const submit = form.handleSubmit((fields) => {
    props.onSubmit({
      fields,
      dtstartLocal,
      schedule,
      scheduleChanged: !scheduleLocked && scheduleChanged,
    });
  });

  const titleError = messageFor(errors.title);

  return (
    <FormSheet<TaskDraft>
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.sheetTitle}
      submitLabel={props.submitLabel}
      formId={formId}
      submitDisabled={title.trim().length === 0}
      submitting={props.submitting}
      dirty={form.formState.isDirty || scheduleChanged}
      {...(props.banner === undefined ? {} : { banner: props.banner })}
      draft={{
        key: `family:task-draft:${series?.id ?? 'new'}`,
        read: () => ({ fields: form.getValues(), dtstartLocal, schedule }),
        restore: (value) => {
          restoredDraft.current = true;
          form.reset(value.fields, { keepDefaultValues: true });
          setDtstartLocal(value.dtstartLocal);
          setSchedule(value.schedule);
        },
        enabled: !props.submitting,
      }}
    >
      <form
        id={formId}
        onSubmit={(event) => {
          void submit(event);
        }}
        noValidate
      >
        <SectionStack className="gap-6 pt-2">
          <Section surface="card">
            {/* Title first, autofocused: the keyboard is already up when the
                sheet lands, and typing one line is the whole common case. The
                field is borderless because it is the *subject* of the screen,
                not one control among twelve. */}
            <div className="w-full max-w-row-measure px-4">
              <input
                autoFocus
                type="text"
                aria-label={TASKS_RU.form.name}
                aria-invalid={errors.title ? true : undefined}
                autoComplete="off"
                placeholder={TASKS_RU.form.namePlaceholder}
                className={cn(
                  'h-14 w-full bg-transparent text-[17px] leading-6 outline-none',
                  'placeholder:text-muted-foreground',
                )}
                {...form.register('title')}
              />
            </div>

            <ScheduleWhenRow
              dtstartLocal={dtstartLocal}
              onChange={setDtstartLocal}
              todayKey={today}
              locked={anchorLocked}
            />
          </Section>

          {titleError ? (
            <p className="-mt-4 px-4 text-[13px] leading-[18px] text-destructive" role="alert">
              {titleError}
            </p>
          ) : null}

          <Section label={TASKS_RU.form.details} surface="card">
            <ScheduleRepeatRow
              value={schedule}
              onChange={setSchedule}
              dtstartLocal={dtstartLocal}
              view={series?.recurrence ?? null}
              locked={scheduleLocked}
              onReplaceCustom={() => {
                setCustomReplaced(true);
              }}
            />

            {can('task:assign') ? (
              <ValueRow
                icon={<Users />}
                label={TASKS_RU.form.who}
                value={assignee?.displayName ?? TASKS_RU.form.whoAnyone}
                onClick={() => {
                  setOpenSheet('who');
                }}
              />
            ) : null}

            <ValueRow
              icon={<FileText />}
              label={TASKS_RU.form.notes}
              value={notes}
              onClick={() => {
                setOpenSheet('notes');
              }}
            />
          </Section>

          {showMore ? (
            <Section label={TASKS_RU.form.more} surface="card">
              <ValueRow
                icon={<Hourglass />}
                label={TASKS_RU.form.due}
                value={
                  DUE_OPTIONS.find((option) => option.minutes === dueOffset)?.label ??
                  TASKS_RU.form.dueOptions.atStart
                }
                onClick={() => {
                  setOpenSheet('due');
                }}
              />
              <ValueRow
                icon={<Tag />}
                label={TASKS_RU.form.category}
                value={category}
                onClick={() => {
                  setOpenSheet('category');
                }}
              />
              <ValueRow
                icon={<Eye />}
                label={TASKS_RU.form.visibility}
                value={
                  VISIBILITY_OPTIONS.find((option) => option.value === visibility)?.label ??
                  TASKS_RU.visibility.household
                }
                onClick={() => {
                  setOpenSheet('who-sees');
                }}
              />
            </Section>
          ) : (
            <Button
              type="button"
              variant="ghost"
              className="h-11 self-start px-4 text-muted-foreground"
              onClick={() => {
                setShowMore(true);
              }}
            >
              {TASKS_RU.form.more}
            </Button>
          )}
        </SectionStack>
      </form>

      {/* ---- the sheets the rows open ------------------------------------ */}

      <PickerSheet
        open={openSheet === 'who'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'who' : null);
        }}
        title={TASKS_RU.form.whoSheetTitle}
      >
        <OptionList>
          <OptionRow
            label={TASKS_RU.form.whoAnyone}
            hint={TASKS_RU.assign.nobody}
            selected={assigneeId === null}
            onSelect={() => {
              form.setValue('defaultAssigneeId', null, { shouldDirty: true });
              setOpenSheet(null);
            }}
          />
          {props.members.map((member) => (
            <OptionRow
              key={member.id}
              label={member.displayName}
              leading={<UserAvatar user={member} size="sm" />}
              selected={assigneeId === member.id}
              onSelect={() => {
                form.setValue('defaultAssigneeId', member.id, { shouldDirty: true });
                setOpenSheet(null);
              }}
            />
          ))}
        </OptionList>
      </PickerSheet>

      <PickerSheet
        open={openSheet === 'due'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'due' : null);
        }}
        title={TASKS_RU.form.dueSheetTitle}
      >
        <OptionList>
          {DUE_OPTIONS.map((option) => (
            <OptionRow
              key={option.minutes}
              label={option.label}
              hint={option.hint}
              selected={dueOffset === option.minutes}
              onSelect={() => {
                form.setValue('dueOffsetMinutes', option.minutes, { shouldDirty: true });
                setOpenSheet(null);
              }}
            />
          ))}
        </OptionList>
      </PickerSheet>

      <PickerSheet
        open={openSheet === 'who-sees'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'who-sees' : null);
        }}
        title={TASKS_RU.form.visibility}
      >
        <OptionList>
          {VISIBILITY_OPTIONS.map((option) => (
            <OptionRow
              key={option.value}
              label={option.label}
              selected={visibility === option.value}
              onSelect={() => {
                form.setValue('visibility', option.value, { shouldDirty: true });
                setOpenSheet(null);
              }}
            />
          ))}
        </OptionList>
      </PickerSheet>

      <TextSheet
        open={openSheet === 'category'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'category' : null);
        }}
        title={TASKS_RU.form.categorySheetTitle}
        placeholder={TASKS_RU.form.categoryPlaceholder}
        maxLength={64}
        value={category}
        onChange={(next) => {
          form.setValue('category', next === '' ? null : next, { shouldDirty: true });
        }}
      />

      <TextSheet
        open={openSheet === 'notes'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'notes' : null);
        }}
        title={TASKS_RU.form.notesSheetTitle}
        placeholder={TASKS_RU.form.notesPlaceholder}
        maxLength={4000}
        multiline
        value={notes}
        onChange={(next) => {
          form.setValue('notes', next === '' ? null : next, { shouldDirty: true });
        }}
      />
    </FormSheet>
  );
}
