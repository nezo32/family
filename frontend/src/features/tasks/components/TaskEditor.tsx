import { useEffect, useState } from 'react';
import {
  taskSeriesCreateSchema,
  taskSeriesUpdateSchema,
  type EditScope,
  type PublicUser,
  type TaskOccurrenceResponse,
  type TaskSeriesResponse,
} from '@family/shared';
import { getFamilyTimeZone } from '@/shared/lib/format';
import { notify } from '@/shared/lib/toast';
import { ScopeChip } from '@/shared/ui/scope-chip';
import { relativeDateLabel } from '@/shared/ui/when-sheet';
import { TASKS_RU } from '../locale';
import { isRecurring, todayKey, toRecurrenceSpec } from '../recurrence';
import { useCreateSeries, useUpdateSeries } from '../hooks';
import { EditScopeDialog } from '@/shared/components';
import { TaskForm, type TaskFormSubmit } from './TaskForm';

/**
 * Create / edit flow.
 *
 * The whole point of this component is the ordering: for a **recurring**
 * occurrence the scope question comes *before* the form, never after. Asking
 * afterwards ("save… now, which ones?") puts an unanswerable question on top of
 * a form the user has just fought, and invites them to answer whatever
 * dismisses the dialog — «Все» silently rewrites the family's history. A one-off
 * has no such question: there is only one instance, so the prompt is noise.
 *
 * Once answered, the choice does not disappear. It stays as a chip pinned under
 * the sheet header — «Меняем: только 20 августа · сменить» — for the whole
 * editing session, and one tap re-opens the prompt (§F6).
 */
export function TaskEditor(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` / omitted → create a new series. */
  series?: TaskSeriesResponse | null;
  /** Anchor for `this` / `this_and_future`. */
  occurrence?: TaskOccurrenceResponse | null;
  members: readonly PublicUser[];
  /**
   * The series as it stands after the save. A `this_and_future` edit answers
   * with the **successor**, not the series that was passed in, so a caller that
   * is standing on one occurrence can find out where that date went.
   */
  onSaved?: (series: TaskSeriesResponse) => void;
}) {
  const series = props.series ?? null;
  const occurrence = props.occurrence ?? null;
  const create = useCreateSeries();
  const update = useUpdateSeries();

  // A scope is only meaningful when there is a rule *and* an anchor occurrence.
  const needsScope = series !== null && occurrence !== null && isRecurring(series.recurrence);
  const [scope, setScope] = useState<EditScope | null>(null);
  /** Re-opened from the chip: the form stays mounted underneath. */
  const [changingScope, setChangingScope] = useState(false);

  useEffect(() => {
    if (!props.open) {
      setScope(null);
      setChangingScope(false);
    }
  }, [props.open]);

  const effectiveScope: EditScope | null = series === null ? null : needsScope ? scope : 'all';

  const handleSubmit = (result: TaskFormSubmit) => {
    const timezone = getFamilyTimeZone();
    const recurrence = toRecurrenceSpec(result.schedule, result.dtstartLocal, timezone);

    if (series === null) {
      const parsed = taskSeriesCreateSchema.safeParse({ ...result.fields, recurrence });
      if (!parsed.success) {
        notify.error(parsed.error);
        return;
      }
      create.mutate(parsed.data, {
        onSuccess: (created) => {
          props.onOpenChange(false);
          props.onSaved?.(created);
        },
      });
      return;
    }

    if (effectiveScope === null) return;
    const sendsSchedule = result.scheduleChanged && effectiveScope !== 'this';
    const parsed = taskSeriesUpdateSchema.safeParse({
      scope: effectiveScope,
      ...(effectiveScope === 'all' ? {} : { occurrenceId: occurrence?.id }),
      ...result.fields,
      ...(sendsSchedule ? { recurrence } : {}),
    });
    if (!parsed.success) {
      notify.error(parsed.error);
      return;
    }
    update.mutate(
      { seriesId: series.id, body: parsed.data },
      {
        onSuccess: (saved) => {
          props.onOpenChange(false);
          props.onSaved?.(saved);
        },
      },
    );
  };

  const scopePromptOpen = props.open && needsScope && (scope === null || changingScope);

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
        strings={TASKS_RU.scope}
        onConfirm={(next) => {
          setScope(next);
          setChangingScope(false);
        }}
      />
    );
  }

  const anchorLabel = occurrence
    ? relativeDateLabel(occurrence.localDate, todayKey(getFamilyTimeZone()))
    : '';
  const scopeText =
    effectiveScope === 'this'
      ? TASKS_RU.scopeChip.this(anchorLabel)
      : effectiveScope === 'this_and_future'
        ? TASKS_RU.scopeChip.thisAndFuture(anchorLabel)
        : TASKS_RU.scopeChip.all;

  return (
    <TaskForm
      open={props.open}
      onOpenChange={props.onOpenChange}
      series={series}
      members={props.members}
      scheduleLocked={effectiveScope === 'this'}
      submitting={create.isPending || update.isPending}
      sheetTitle={series === null ? TASKS_RU.form.createTitle : TASKS_RU.form.editTitle}
      submitLabel={series === null ? TASKS_RU.form.createSubmit : TASKS_RU.form.editSubmit}
      {...(needsScope
        ? {
            banner: (
              <ScopeChip
                prefix={TASKS_RU.scopeChip.prefix}
                value={scopeText}
                changeLabel={TASKS_RU.scopeChip.change}
                onChange={() => {
                  setChangingScope(true);
                }}
              />
            ),
          }
        : {})}
      onSubmit={handleSubmit}
    />
  );
}
