import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Bell, Clock, Eye, FileText, MapPin, Palette, Repeat, Tag, Users } from 'lucide-react';
import {
  eventSeriesCreateSchema,
  type EditScope,
  type EventOccurrenceResponse,
  type EventSeriesCreate,
  type EventSeriesResponse,
  type EventSeriesUpdate,
  type PublicUser,
  type Visibility,
} from '@family/shared';
import { FormSheet } from '@/shared/ui/form-sheet';
import { OptionList, OptionRow, PickerSheet, TextSheet, ToggleRow } from '@/shared/ui/option-sheet';
import { ScopeChip } from '@/shared/ui/scope-chip';
import { Section, SectionStack } from '@/shared/ui/section';
import { ValueRow } from '@/shared/ui/value-row';
import { Button } from '@/shared/ui/button';
import {
  describeWhen,
  nextRoundTime,
  relativeDateLabel,
  WhenSheet,
  type WhenValue,
} from '@/shared/ui/when-sheet';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { cn } from '@/shared/lib/utils';
import {
  buildRecurrenceSpec,
  dateKeyOfFloating,
  defaultRecurrenceState,
  isRecurring,
  recurrenceStateFrom,
  timeOfFloating,
  toFloatingLocal,
  todayKey,
  type RecurrenceBuilderState,
} from '../calendar-model';
import { useCreateEvent, useEventSeries, useFamilyTimeZone, useUpdateEvent } from '../hooks';
import { CALENDAR_RU } from '../locale';
import { EditScopeDialog } from '@/shared/components';
import { RecurrenceBuilder, recurrenceLabel } from './RecurrenceBuilder';

/**
 * «Новое событие» / «Изменение события» — the worst offender, rebuilt (§F3–F6).
 *
 * ## What it was
 *
 * 358 × **1640** px on an 844px phone, starting **34px from the top** — under
 * an iPhone's status bar, which is why the owner photographed a clipped title.
 * «Создать» sat at y≈1567: off-screen on a phone, off-screen at 1440×900, and
 * off-screen at every width in between. Twelve fields, two chip grids, a nested
 * bordered box holding four separate controls for one decision, and a colour
 * swatch row that mattered to nobody creating «ужин у бабушки».
 *
 * ## What it is
 *
 * ```
 *   Отмена       Новое событие      Создать   ← fixed header, never scrolls
 *   ┌────────────────────────────────────────┐
 *   │ Например, ужин у бабушки               │  ← title first, autofocused
 *   │ 🕘  Сегодня, 19:00 · 1 час           › │  ← the when-row
 *   └────────────────────────────────────────┘
 *   ПОДРОБНЕЕ
 *   📍 Место                             —  ›
 *   🔁 Повторение           не повторяется  ›
 *   👥 Кто                       Вся семья  ›
 *   📝 Описание                          —  ›
 *   ⌄ Ещё                                      ← напоминания, цвет, категория,
 *                                                кто видит
 * ```
 *
 * Six visible controls, every one of them stating its own value. «Ужин у
 * бабушки, сегодня в семь» is now the default plus one typed line.
 *
 * ## The scope question moved
 *
 * Editing a recurring occurrence asks «Что изменить?» **before** the form
 * opens, and the answer then stays pinned under the header as a chip. Asking
 * afterwards — the old behaviour — put an unanswerable question on top of a
 * form the user had just fought, at the moment they most wanted it gone (§F6).
 *
 * Validation is `zodResolver` against the shared contract. `recurrence` is the
 * one field held outside the form: it is a discriminated union produced by the
 * restricted builder (`buildRecurrenceSpec`), which can only emit shapes the
 * contract accepts, and folding a union into RHF field paths buys nothing but
 * type noise.
 */
const eventFormSchema = eventSeriesCreateSchema.omit({ recurrence: true });
type EventFormInput = z.input<typeof eventFormSchema>;
type EventFormValues = z.output<typeof eventFormSchema>;

export interface EventFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: readonly PublicUser[];
  /** Editing an existing series; absent means "create". Fetched on demand. */
  seriesId?: string | undefined;
  /** The instance the edit was started from — the anchor of a scoped edit. */
  occurrence?: EventOccurrenceResponse | undefined;
  /** Pre-selected day when creating from the grid. */
  initialDateKey?: string | undefined;
  onSaved?: () => void;
}

type SheetKey =
  | 'when'
  | 'location'
  | 'repeat'
  | 'attendees'
  | 'description'
  | 'reminders'
  | 'color'
  | 'category'
  | 'visibility';

const VISIBILITY_OPTIONS = [
  { value: 'household', label: CALENDAR_RU.visibility.household },
  { value: 'restricted', label: CALENDAR_RU.visibility.restricted },
  { value: 'private', label: CALENDAR_RU.visibility.private },
] as const;

interface EventDraft {
  values: EventFormInput;
  dateKey: string;
  time: string;
  recurrence: RecurrenceBuilderState;
}

export function EventFormDialog(props: EventFormDialogProps) {
  const timezone = useFamilyTimeZone();
  const seriesQuery = useEventSeries(props.open ? props.seriesId : undefined);
  const series = props.seriesId ? seriesQuery.data : undefined;
  const isEdit = Boolean(props.seriesId);
  const formId = useId();

  const create = useCreateEvent();
  const update = useUpdateEvent(series?.id ?? '');

  const anchorDateKey =
    props.occurrence?.localDate ??
    props.initialDateKey ??
    (series ? dateKeyOfFloating(series.recurrence.dtstartLocal) : todayKey(timezone));
  const anchorTime = series
    ? timeOfFloating(series.recurrence.dtstartLocal)
    : nextRoundTime(new Date(), timezone);

  const [dateKey, setDateKey] = useState(anchorDateKey);
  const [time, setTime] = useState(anchorTime);
  const [recurrenceState, setRecurrenceState] = useState<RecurrenceBuilderState>(() =>
    initialRecurrenceState(series, anchorDateKey),
  );
  const [scope, setScope] = useState<EditScope | null>(null);
  const [changingScope, setChangingScope] = useState(false);
  const [openSheet, setOpenSheet] = useState<SheetKey | null>(null);
  const [showMore, setShowMore] = useState(false);

  const form = useForm<EventFormInput, unknown, EventFormValues>({
    resolver: zodResolver(eventFormSchema),
    defaultValues: toDefaults(series, props.occurrence),
  });

  /**
   * Re-seed on open: the dialog is kept mounted, so stale values from the last
   * event would otherwise leak into the next one.
   *
   * The guard is not decoration: `FormSheet` is a *child*, so its
   * draft-restore effect runs before this one on the same commit (React flushes
   * effects bottom-up). Without the ref, a draft that survived an iOS
   * background kill would be read, applied, and overwritten by these defaults
   * inside one render.
   */
  const restoredDraft = useRef(false);
  useEffect(() => {
    if (!props.open) {
      restoredDraft.current = false;
      setScope(null);
      setChangingScope(false);
      setOpenSheet(null);
      setShowMore(false);
      return;
    }
    if (restoredDraft.current) return;
    setDateKey(anchorDateKey);
    setTime(anchorTime);
    setRecurrenceState(initialRecurrenceState(series, anchorDateKey));
    form.reset(toDefaults(series, props.occurrence));
    // `form` is stable; the rest is the identity of the thing being edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, series?.id, props.occurrence?.id, anchorDateKey, anchorTime]);

  const title = form.watch('title') ?? '';
  const isAllDay = form.watch('isAllDay') ?? false;
  const durationMinutes = Number(form.watch('durationMinutes') ?? 60);
  const location = form.watch('location') ?? '';
  const description = form.watch('description') ?? '';
  const category = form.watch('category') ?? '';
  const color = form.watch('color') ?? null;
  const visibility = (form.watch('visibility') as Visibility | undefined) ?? 'household';
  const attendeeIds = form.watch('attendeeIds') ?? [];
  const reminderOffsets = form.watch('reminderOffsets') ?? [];

  const recurringSeries = isRecurring(series?.recurrence);
  const scheduleLocked = Boolean(series?.isReadOnly);
  /** A rule the backend could not decompile: show it, never silently rewrite it. */
  const scheduleUnparsed = Boolean(series && recurrenceStateFrom(series.recurrence) === null);

  const activeMembers = useMemo(
    () => props.members.filter((member) => member.status === 'active'),
    [props.members],
  );

  /** Who has already answered «вы придёте?», so the picker can say so. */
  const rsvpByUser = useMemo(
    () => new Map((props.occurrence?.attendees ?? []).map((a) => [a.userId, a.rsvp])),
    [props.occurrence],
  );

  const dtstartLocal = toFloatingLocal(dateKey, isAllDay ? '00:00' : time);
  const today = todayKey(timezone);
  const whenValue: WhenValue = {
    dateKey,
    time,
    allDay: Boolean(isAllDay),
    durationMinutes,
  };

  const submit = (values: EventFormValues, effectiveScope: EditScope | null): void => {
    const recurrence = buildRecurrenceSpec(recurrenceState, { dtstartLocal, timezone });
    const cleaned = {
      ...values,
      description: emptyToNull(values.description),
      location: emptyToNull(values.location),
      category: emptyToNull(values.category),
      durationMinutes: values.isAllDay ? 1440 : values.durationMinutes,
    };

    if (!series) {
      const body: EventSeriesCreate = { ...cleaned, recurrence };
      create.mutate(body, {
        onSuccess: () => {
          props.onOpenChange(false);
          props.onSaved?.();
        },
      });
      return;
    }

    const applied: EditScope = effectiveScope ?? 'all';
    const body: EventSeriesUpdate = {
      scope: applied,
      ...(applied === 'all' ? {} : { occurrenceId: props.occurrence?.id }),
      title: cleaned.title,
      description: cleaned.description,
      location: cleaned.location,
      visibility: cleaned.visibility,
      durationMinutes: cleaned.durationMinutes,
      isAllDay: cleaned.isAllDay,
      reminderOffsets: cleaned.reminderOffsets,
      color: cleaned.color ?? null,
      category: cleaned.category,
      attendeeIds: cleaned.attendeeIds,
      // The schedule of a single instance is not the schedule of the series
      // (contract refinement), and an unparsed rule must not be overwritten.
      ...(applied === 'this' || scheduleUnparsed ? {} : { recurrence }),
    };
    update.mutate(body, {
      onSuccess: () => {
        props.onOpenChange(false);
        props.onSaved?.();
      },
    });
  };

  const onSubmit = form.handleSubmit((values) => {
    submit(values, series ? scope : null);
  });

  const isPending = create.isPending || update.isPending;

  /* ---- the scope question, asked before the form (§F6) ------------------ */

  const needsScope = Boolean(series) && recurringSeries;
  const scopePromptOpen = props.open && needsScope && (scope === null || changingScope);

  // Whether a scope is needed at all is only knowable once the series has
  // arrived. Rendering the form in the meantime would flash a blank sheet and
  // then replace it with «Что изменить?» — the opposite of asking first.
  if (props.open && props.seriesId !== undefined && !series) return null;

  if (scopePromptOpen) {
    return (
      <EditScopeDialog
        open
        onOpenChange={(next) => {
          if (next) return;
          // Backing out of a *re-open* returns to the form with the old answer;
          // backing out of the first ask closes the whole thing, because there
          // is no form behind it yet.
          if (changingScope) setChangingScope(false);
          else props.onOpenChange(false);
        }}
        intent="edit"
        strings={CALENDAR_RU.scope}
        onConfirm={(next) => {
          setScope(next);
          setChangingScope(false);
        }}
      />
    );
  }

  const anchorLabel = props.occurrence
    ? relativeDateLabel(props.occurrence.localDate, today)
    : relativeDateLabel(dateKey, today);
  const scopeText =
    scope === 'this'
      ? CALENDAR_RU.scopeChip.this(anchorLabel)
      : scope === 'this_and_future'
        ? CALENDAR_RU.scopeChip.thisAndFuture(anchorLabel)
        : CALENDAR_RU.scopeChip.all;

  const attendeeSummary =
    attendeeIds.length === 0
      ? CALENDAR_RU.formAttendeesNobody
      : activeMembers
          .filter((member) => attendeeIds.includes(member.id))
          .map((member) => member.displayName)
          .join(', ');

  return (
    <FormSheet<EventDraft>
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={isEdit ? CALENDAR_RU.formEditTitle : CALENDAR_RU.formCreateTitle}
      description={isEdit ? CALENDAR_RU.formEditDescription : CALENDAR_RU.formCreateDescription}
      submitLabel={isEdit ? CALENDAR_RU.saveEdit : CALENDAR_RU.saveCreate}
      formId={formId}
      submitDisabled={title.trim().length === 0}
      submitting={isPending}
      dirty={form.formState.isDirty}
      {...(needsScope
        ? {
            banner: (
              <ScopeChip
                prefix={CALENDAR_RU.scopeChip.prefix}
                value={scopeText}
                changeLabel={CALENDAR_RU.scopeChip.change}
                onChange={() => {
                  setChangingScope(true);
                }}
              />
            ),
          }
        : {})}
      draft={{
        key: `family:event-draft:${series?.id ?? 'new'}`,
        read: () => ({ values: form.getValues(), dateKey, time, recurrence: recurrenceState }),
        restore: (value) => {
          restoredDraft.current = true;
          form.reset(value.values, { keepDefaultValues: true });
          setDateKey(value.dateKey);
          setTime(value.time);
          setRecurrenceState(value.recurrence);
        },
        enabled: !isPending,
      }}
    >
      <form
        id={formId}
        data-testid="event-form"
        onSubmit={(event) => {
          void onSubmit(event);
        }}
        noValidate
      >
        <SectionStack className="gap-6 pt-2">
          <Section surface="card">
            <div className="w-full max-w-row-measure px-4">
              <input
                autoFocus
                type="text"
                aria-label={CALENDAR_RU.fieldTitle}
                autoComplete="off"
                placeholder={CALENDAR_RU.fieldTitlePlaceholder}
                className={cn(
                  'h-14 w-full bg-transparent text-[17px] leading-6 outline-none',
                  'placeholder:text-muted-foreground',
                )}
                {...form.register('title')}
              />
            </div>

            <ValueRow
              icon={<Clock />}
              label={describeWhen(whenValue, {
                todayKey: today,
                withDuration: true,
                durationOptions: CALENDAR_RU.durations,
              })}
              disabled={scheduleLocked}
              {...(scheduleLocked
                ? {}
                : {
                    onClick: () => {
                      setOpenSheet('when');
                    },
                  })}
            />
          </Section>

          {form.formState.errors.title ? (
            <p className="-mt-4 px-4 text-[13px] leading-[18px] text-destructive" role="alert">
              {form.formState.errors.title.message}
            </p>
          ) : null}

          <Section label={CALENDAR_RU.formDetails} surface="card">
            <ValueRow
              icon={<MapPin />}
              label={CALENDAR_RU.fieldLocation}
              value={location}
              onClick={() => {
                setOpenSheet('location');
              }}
            />

            {scheduleUnparsed ? (
              <ValueRow
                icon={<Repeat />}
                label={CALENDAR_RU.repeats}
                hint={series?.recurrence.summary ?? CALENDAR_RU.scheduleNotEditable}
                disabled
              />
            ) : (
              <ValueRow
                icon={<Repeat />}
                label={CALENDAR_RU.repeats}
                value={recurrenceLabel(recurrenceState)}
                disabled={scheduleLocked}
                {...(scheduleLocked
                  ? {}
                  : {
                      onClick: () => {
                        setOpenSheet('repeat');
                      },
                    })}
              />
            )}

            <ValueRow
              icon={<Users />}
              label={CALENDAR_RU.fieldAttendees}
              value={attendeeSummary}
              onClick={() => {
                setOpenSheet('attendees');
              }}
            />

            <ValueRow
              icon={<FileText />}
              label={CALENDAR_RU.fieldDescription}
              value={description}
              onClick={() => {
                setOpenSheet('description');
              }}
            />
          </Section>

          {showMore ? (
            <Section label={CALENDAR_RU.formMore} surface="card">
              <ValueRow
                icon={<Bell />}
                label={CALENDAR_RU.fieldReminders}
                value={
                  reminderOffsets.length === 0
                    ? CALENDAR_RU.formRemindersNone
                    : CALENDAR_RU.reminderOptions
                        .filter((option) => reminderOffsets.includes(option.minutes))
                        .map((option) => option.label)
                        .join(', ')
                }
                onClick={() => {
                  setOpenSheet('reminders');
                }}
              />
              <ValueRow
                icon={<Palette />}
                label={CALENDAR_RU.fieldColor}
                value={
                  <span className="flex items-center gap-2">
                    {color ? (
                      <span
                        aria-hidden
                        className="size-4 rounded-full border border-border"
                        style={{ backgroundColor: color }}
                      />
                    ) : null}
                    {CALENDAR_RU.colors.find((option) => option.value === color)?.label ??
                      CALENDAR_RU.formColorAutoShort}
                  </span>
                }
                onClick={() => {
                  setOpenSheet('color');
                }}
              />
              <ValueRow
                icon={<Tag />}
                label={CALENDAR_RU.fieldCategory}
                value={category}
                onClick={() => {
                  setOpenSheet('category');
                }}
              />
              <ValueRow
                icon={<Eye />}
                label={CALENDAR_RU.fieldVisibility}
                value={
                  VISIBILITY_OPTIONS.find((option) => option.value === visibility)?.label ??
                  CALENDAR_RU.visibility.household
                }
                onClick={() => {
                  setOpenSheet('visibility');
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
              {CALENDAR_RU.formMore}
            </Button>
          )}
        </SectionStack>
      </form>

      {/* ---- the sheets the rows open ------------------------------------ */}

      <WhenSheet
        open={openSheet === 'when'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'when' : null);
        }}
        value={whenValue}
        todayKey={today}
        withAllDay
        withDuration
        durationOptions={CALENDAR_RU.durations}
        onChange={(next) => {
          setDateKey(next.dateKey);
          setTime(next.time);
          form.setValue('isAllDay', next.allDay, { shouldDirty: true });
          form.setValue('durationMinutes', next.durationMinutes, { shouldDirty: true });
        }}
      />

      <PickerSheet
        open={openSheet === 'repeat'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'repeat' : null);
        }}
        title={CALENDAR_RU.recurrence.legend}
        size="tall"
      >
        <RecurrenceBuilder value={recurrenceState} onChange={setRecurrenceState} />
      </PickerSheet>

      <PickerSheet
        open={openSheet === 'attendees'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'attendees' : null);
        }}
        title={CALENDAR_RU.fieldAttendees}
        size="tall"
      >
        <OptionList role="group" label={CALENDAR_RU.noAttendees}>
          {activeMembers.map((member) => (
            <ToggleRow
              key={member.id}
              label={member.displayName}
              leading={<UserAvatar user={member} size="sm" />}
              {...(rsvpByUser.get(member.id) === undefined
                ? {}
                : { hint: RSVP_LABELS[rsvpByUser.get(member.id) ?? 'pending'] })}
              checked={attendeeIds.includes(member.id)}
              onToggle={() => {
                const next = attendeeIds.includes(member.id)
                  ? attendeeIds.filter((id) => id !== member.id)
                  : [...attendeeIds, member.id];
                form.setValue('attendeeIds', next, { shouldDirty: true });
              }}
            />
          ))}
        </OptionList>
      </PickerSheet>

      <PickerSheet
        open={openSheet === 'reminders'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'reminders' : null);
        }}
        title={CALENDAR_RU.fieldReminders}
        size="tall"
      >
        <OptionList role="group" label={CALENDAR_RU.remindersHint}>
          {CALENDAR_RU.reminderOptions.map((option) => {
            const active = reminderOffsets.includes(option.minutes);
            return (
              <ToggleRow
                key={option.minutes}
                label={option.label}
                checked={active}
                disabled={!active && reminderOffsets.length >= 5}
                onToggle={() => {
                  form.setValue(
                    'reminderOffsets',
                    active
                      ? reminderOffsets.filter((value) => value !== option.minutes)
                      : [...reminderOffsets, option.minutes],
                    { shouldDirty: true },
                  );
                }}
              />
            );
          })}
        </OptionList>
      </PickerSheet>

      <PickerSheet
        open={openSheet === 'color'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'color' : null);
        }}
        title={CALENDAR_RU.fieldColor}
        size="tall"
      >
        <OptionList>
          <OptionRow
            label={CALENDAR_RU.fieldColorAuto}
            selected={!color}
            onSelect={() => {
              form.setValue('color', null, { shouldDirty: true });
              setOpenSheet(null);
            }}
          />
          {CALENDAR_RU.colors.map((option) => (
            <OptionRow
              key={option.value}
              label={option.label}
              selected={color === option.value}
              leading={
                <span
                  aria-hidden
                  className="size-6 rounded-full border border-border"
                  style={{ backgroundColor: option.value }}
                />
              }
              onSelect={() => {
                form.setValue('color', option.value, { shouldDirty: true });
                setOpenSheet(null);
              }}
            />
          ))}
        </OptionList>
      </PickerSheet>

      <PickerSheet
        open={openSheet === 'visibility'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'visibility' : null);
        }}
        title={CALENDAR_RU.fieldVisibility}
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
        open={openSheet === 'location'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'location' : null);
        }}
        title={CALENDAR_RU.fieldLocation}
        placeholder={CALENDAR_RU.fieldLocationPlaceholder}
        maxLength={200}
        value={location}
        onChange={(next) => {
          form.setValue('location', next, { shouldDirty: true });
        }}
      />

      <TextSheet
        open={openSheet === 'description'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'description' : null);
        }}
        title={CALENDAR_RU.fieldDescription}
        placeholder={CALENDAR_RU.fieldDescriptionPlaceholder}
        maxLength={2000}
        multiline
        value={description}
        onChange={(next) => {
          form.setValue('description', next, { shouldDirty: true });
        }}
      />

      <TextSheet
        open={openSheet === 'category'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'category' : null);
        }}
        title={CALENDAR_RU.fieldCategory}
        placeholder={CALENDAR_RU.fieldCategoryPlaceholder}
        maxLength={64}
        value={category}
        onChange={(next) => {
          form.setValue('category', next, { shouldDirty: true });
        }}
      />
    </FormSheet>
  );
}

const RSVP_LABELS: Record<string, string> = {
  yes: CALENDAR_RU.rsvpYes,
  no: CALENDAR_RU.rsvpNo,
  maybe: CALENDAR_RU.rsvpMaybe,
  pending: CALENDAR_RU.rsvpPending,
};

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function initialRecurrenceState(
  series: EventSeriesResponse | undefined,
  anchorDateKey: string,
): RecurrenceBuilderState {
  if (!series) return defaultRecurrenceState(`${anchorDateKey}T00:00:00`);
  return (
    recurrenceStateFrom(series.recurrence) ?? defaultRecurrenceState(series.recurrence.dtstartLocal)
  );
}

function toDefaults(
  series: EventSeriesResponse | undefined,
  occurrence: EventOccurrenceResponse | undefined,
): EventFormInput {
  return {
    title: occurrence?.title ?? series?.title ?? '',
    description: occurrence?.description ?? series?.description ?? '',
    location: occurrence?.location ?? series?.location ?? '',
    visibility: series?.visibility ?? 'household',
    durationMinutes: series?.durationMinutes ?? 60,
    isAllDay: series?.isAllDay ?? false,
    // «за 1 час» is the default a family means by "напомни" (§F2). It is only a
    // *default*: an edit keeps whatever the series already carries, including
    // an explicit "no reminders".
    reminderOffsets: series?.reminderOffsets ?? (series ? [] : [60]),
    color: series?.color ?? null,
    category: series?.category ?? '',
    attendeeIds: (occurrence?.attendees ?? []).map((attendee) => attendee.userId),
  };
}
