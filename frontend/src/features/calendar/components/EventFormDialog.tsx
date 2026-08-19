import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import { Switch } from '@/shared/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
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
import { EditScopeDialog } from './EditScopeDialog';
import { RecurrenceBuilder } from './RecurrenceBuilder';

/**
 * Create / edit an event.
 *
 * Validation is `zodResolver` against the shared contract. `recurrence` is the
 * one field held outside the form: it is a discriminated union produced by the
 * restricted builder (`buildRecurrenceSpec`), which can only emit shapes the
 * contract accepts, and folding a union into RHF field paths buys nothing but
 * type noise. Everything else is the contract verbatim.
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

export function EventFormDialog(props: EventFormDialogProps) {
  const timezone = useFamilyTimeZone();
  const seriesQuery = useEventSeries(props.open ? props.seriesId : undefined);
  const series = props.seriesId ? seriesQuery.data : undefined;
  const isEdit = Boolean(props.seriesId);

  const create = useCreateEvent();
  const update = useUpdateEvent(series?.id ?? '');

  const anchorDateKey =
    props.occurrence?.localDate ??
    props.initialDateKey ??
    (series ? dateKeyOfFloating(series.recurrence.dtstartLocal) : todayKey(timezone));
  const anchorTime = series ? timeOfFloating(series.recurrence.dtstartLocal) : defaultStartTime();

  const [dateKey, setDateKey] = useState(anchorDateKey);
  const [time, setTime] = useState(anchorTime);
  const [recurrenceState, setRecurrenceState] = useState<RecurrenceBuilderState>(() =>
    initialRecurrenceState(series, anchorDateKey),
  );
  const [scopeOpen, setScopeOpen] = useState(false);
  const [pendingValues, setPendingValues] = useState<EventFormValues | null>(null);

  const form = useForm<EventFormInput, unknown, EventFormValues>({
    resolver: zodResolver(eventFormSchema),
    defaultValues: toDefaults(series, props.occurrence),
  });

  // Re-seed on open: the dialog is kept mounted, so stale values from the last
  // event would otherwise leak into the next one.
  useEffect(() => {
    if (!props.open) return;
    setDateKey(anchorDateKey);
    setTime(anchorTime);
    setRecurrenceState(initialRecurrenceState(series, anchorDateKey));
    setPendingValues(null);
    form.reset(toDefaults(series, props.occurrence));
    // `form` is stable; the rest is the identity of the thing being edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, series?.id, props.occurrence?.id, anchorDateKey, anchorTime]);

  const isAllDay = form.watch('isAllDay') ?? false;
  const recurringSeries = isRecurring(series?.recurrence);
  const scheduleLocked = Boolean(series?.isReadOnly);
  /** A rule the backend could not decompile: show it, never silently rewrite it. */
  const scheduleUnparsed = Boolean(series && recurrenceStateFrom(series.recurrence) === null);

  const activeMembers = useMemo(
    () => props.members.filter((member) => member.status === 'active'),
    [props.members],
  );

  const rsvpByUser = useMemo(
    () => new Map((props.occurrence?.attendees ?? []).map((a) => [a.userId, a.rsvp])),
    [props.occurrence],
  );

  const dtstartLocal = toFloatingLocal(dateKey, isAllDay ? '00:00' : time);

  const submit = (values: EventFormValues, scope: EditScope | null): void => {
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

    const effectiveScope: EditScope = scope ?? 'all';
    const body: EventSeriesUpdate = {
      scope: effectiveScope,
      ...(effectiveScope === 'all' ? {} : { occurrenceId: props.occurrence?.id }),
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
      ...(effectiveScope === 'this' || scheduleUnparsed ? {} : { recurrence }),
    };
    update.mutate(body, {
      onSuccess: () => {
        setScopeOpen(false);
        props.onOpenChange(false);
        props.onSaved?.();
      },
    });
  };

  const onSubmit = form.handleSubmit((values) => {
    if (series && recurringSeries) {
      // No default scope: guessing here is how a calendar loses data (D2 §3).
      setPendingValues(values);
      setScopeOpen(true);
      return;
    }
    submit(values, series ? 'all' : null);
  });

  const isPending = create.isPending || update.isPending;

  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent
          className="max-h-[92dvh] overflow-y-auto p-4 sm:max-w-2xl sm:p-6"
          data-scroll-pane
          data-testid="event-form"
        >
          <DialogHeader>
            <DialogTitle>
              {isEdit ? CALENDAR_RU.formEditTitle : CALENDAR_RU.formCreateTitle}
            </DialogTitle>
            <DialogDescription>
              {isEdit ? CALENDAR_RU.formEditDescription : CALENDAR_RU.formCreateDescription}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={(event) => void onSubmit(event)} className="space-y-5" noValidate>
            {/* ---- what -------------------------------------------------- */}
            <div className="space-y-1.5">
              <Label htmlFor="event-title">{CALENDAR_RU.fieldTitle}</Label>
              <Input
                id="event-title"
                className="h-11"
                placeholder={CALENDAR_RU.fieldTitlePlaceholder}
                autoComplete="off"
                {...form.register('title')}
              />
              {form.formState.errors.title ? (
                <p className="text-sm text-destructive">{form.formState.errors.title.message}</p>
              ) : null}
            </div>

            {/* ---- when -------------------------------------------------- */}
            <div className="space-y-3 rounded-xl border border-border p-3">
              <div className="flex min-h-11 items-center justify-between gap-3">
                <Label htmlFor="event-all-day" className="text-sm">
                  {CALENDAR_RU.fieldAllDay}
                </Label>
                <Controller
                  control={form.control}
                  name="isAllDay"
                  render={({ field }) => (
                    <Switch
                      id="event-all-day"
                      checked={Boolean(field.value)}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="event-date">{CALENDAR_RU.fieldDate}</Label>
                  <Input
                    id="event-date"
                    type="date"
                    className="h-11"
                    value={dateKey}
                    onChange={(event) => {
                      setDateKey(event.target.value || dateKey);
                    }}
                  />
                </div>

                {!isAllDay ? (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="event-time">{CALENDAR_RU.fieldTime}</Label>
                      <Input
                        id="event-time"
                        type="time"
                        className="h-11"
                        value={time}
                        onChange={(event) => {
                          setTime(event.target.value || time);
                        }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="event-duration">{CALENDAR_RU.fieldDuration}</Label>
                      <Controller
                        control={form.control}
                        name="durationMinutes"
                        render={({ field }) => (
                          <Select
                            value={String(field.value ?? 60)}
                            onValueChange={(next) => {
                              field.onChange(Number(next));
                            }}
                          >
                            <SelectTrigger id="event-duration" className="h-11 w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {CALENDAR_RU.durations.map((option) => (
                                <SelectItem key={option.minutes} value={String(option.minutes)}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            </div>

            {/* ---- recurrence -------------------------------------------- */}
            {scheduleUnparsed ? (
              <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
                {CALENDAR_RU.scheduleNotEditable}
                <span className="mt-1 block text-foreground">
                  {series?.recurrence.summary}
                </span>
              </p>
            ) : (
              <RecurrenceBuilder
                value={recurrenceState}
                onChange={setRecurrenceState}
                disabled={scheduleLocked}
              />
            )}

            {/* ---- where & what about ------------------------------------ */}
            <div className="space-y-1.5">
              <Label htmlFor="event-location">{CALENDAR_RU.fieldLocation}</Label>
              <Input
                id="event-location"
                className="h-11"
                placeholder={CALENDAR_RU.fieldLocationPlaceholder}
                {...form.register('location')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="event-description">{CALENDAR_RU.fieldDescription}</Label>
              <Textarea
                id="event-description"
                rows={3}
                placeholder={CALENDAR_RU.fieldDescriptionPlaceholder}
                {...form.register('description')}
              />
            </div>

            {/* ---- attendees --------------------------------------------- */}
            <div className="space-y-2">
              <span className="text-sm font-medium">{CALENDAR_RU.fieldAttendees}</span>
              <Controller
                control={form.control}
                name="attendeeIds"
                render={({ field }) => {
                  const selected = new Set(field.value ?? []);
                  return (
                    <div className="flex flex-wrap gap-2">
                      {activeMembers.map((member) => {
                        const active = selected.has(member.id);
                        const rsvp = rsvpByUser.get(member.id);
                        return (
                          <button
                            key={member.id}
                            type="button"
                            aria-pressed={active}
                            onClick={() => {
                              const next = active
                                ? (field.value ?? []).filter((id: string) => id !== member.id)
                                : [...(field.value ?? []), member.id];
                              field.onChange(next);
                            }}
                            className={cn(
                              'flex min-h-11 items-center gap-2 rounded-full border border-border py-1 pr-3 pl-1 text-sm transition-colors',
                              'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                              active
                                ? 'border-primary bg-primary/10 text-foreground'
                                : 'bg-background text-muted-foreground hover:bg-accent/40',
                            )}
                          >
                            <UserAvatar
                              user={{
                                id: member.id,
                                displayName: member.displayName,
                                avatarUrl: member.avatarUrl,
                              }}
                              size="sm"
                            />
                            <span className="truncate">{member.displayName}</span>
                            {active && rsvp ? (
                              <span className="text-xs text-muted-foreground">
                                {RSVP_LABELS[rsvp]}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  );
                }}
              />
            </div>

            {/* ---- reminders --------------------------------------------- */}
            <div className="space-y-2">
              <span className="text-sm font-medium">{CALENDAR_RU.fieldReminders}</span>
              <Controller
                control={form.control}
                name="reminderOffsets"
                render={({ field }) => {
                  const current: number[] = field.value ?? [];
                  return (
                    <div className="flex flex-wrap gap-2">
                      {CALENDAR_RU.reminderOptions.map((option) => {
                        const active = current.includes(option.minutes);
                        const atLimit = current.length >= 5 && !active;
                        return (
                          <button
                            key={option.minutes}
                            type="button"
                            aria-pressed={active}
                            disabled={atLimit}
                            onClick={() => {
                              field.onChange(
                                active
                                  ? current.filter((value) => value !== option.minutes)
                                  : [...current, option.minutes],
                              );
                            }}
                            className={cn(
                              'min-h-11 rounded-full border border-border px-3 text-sm transition-colors',
                              'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-40',
                              active
                                ? 'border-primary bg-primary/10 text-foreground'
                                : 'bg-background text-muted-foreground hover:bg-accent/40',
                            )}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  );
                }}
              />
              <p className="text-xs text-muted-foreground">{CALENDAR_RU.remindersHint}</p>
            </div>

            {/* ---- appearance & visibility -------------------------------- */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <span className="text-sm font-medium">{CALENDAR_RU.fieldColor}</span>
                <Controller
                  control={form.control}
                  name="color"
                  render={({ field }) => (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        aria-pressed={!field.value}
                        onClick={() => {
                          field.onChange(null);
                        }}
                        className={cn(
                          'min-h-11 rounded-full border border-border px-3 text-sm',
                          !field.value
                            ? 'border-primary bg-primary/10'
                            : 'bg-background text-muted-foreground',
                        )}
                      >
                        {CALENDAR_RU.fieldColorAuto}
                      </button>
                      {CALENDAR_RU.colors.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          aria-label={option.label}
                          aria-pressed={field.value === option.value}
                          onClick={() => {
                            field.onChange(option.value);
                          }}
                          className={cn(
                            'size-11 rounded-full border-2 transition-transform',
                            field.value === option.value
                              ? 'border-foreground scale-105'
                              : 'border-transparent',
                          )}
                          style={{ backgroundColor: option.value }}
                        />
                      ))}
                    </div>
                  )}
                />
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="event-category">{CALENDAR_RU.fieldCategory}</Label>
                  <Input
                    id="event-category"
                    className="h-11"
                    placeholder={CALENDAR_RU.fieldCategoryPlaceholder}
                    {...form.register('category')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="event-visibility">{CALENDAR_RU.fieldVisibility}</Label>
                  <Controller
                    control={form.control}
                    name="visibility"
                    render={({ field }) => (
                      <Select
                        value={(field.value as Visibility | undefined) ?? 'household'}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger id="event-visibility" className="h-11 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="household">
                            {CALENDAR_RU.visibility.household}
                          </SelectItem>
                          <SelectItem value="restricted">
                            {CALENDAR_RU.visibility.restricted}
                          </SelectItem>
                          <SelectItem value="private">
                            {CALENDAR_RU.visibility.private}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => {
                  props.onOpenChange(false);
                }}
                disabled={isPending}
              >
                {COMMON.cancel}
              </Button>
              <Button type="submit" className="h-11" disabled={isPending}>
                {isPending ? <InlineSpinner className="mr-2" /> : null}
                {isEdit ? CALENDAR_RU.saveEdit : CALENDAR_RU.saveCreate}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <EditScopeDialog
        open={scopeOpen}
        onOpenChange={setScopeOpen}
        mode="edit"
        isPending={update.isPending}
        onConfirm={(scope) => {
          if (pendingValues) submit(pendingValues, scope);
        }}
      />
    </>
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

/** The next full hour — nobody schedules dinner for 19:37. */
function defaultStartTime(): string {
  const now = new Date();
  const hour = Math.min(23, now.getHours() + 1);
  return `${String(hour).padStart(2, '0')}:00`;
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
    reminderOffsets: series?.reminderOffsets ?? [],
    color: series?.color ?? null,
    category: series?.category ?? '',
    attendeeIds: (occurrence?.attendees ?? []).map((attendee) => attendee.userId),
  };
}
