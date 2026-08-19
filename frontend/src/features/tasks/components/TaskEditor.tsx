import { useEffect, useState } from 'react';
import {
  taskSeriesCreateSchema,
  taskSeriesUpdateSchema,
  type EditScope,
  type PublicUser,
  type TaskOccurrenceResponse,
  type TaskSeriesResponse,
} from '@family/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/ui/dialog';
import { getFamilyTimeZone } from '@/shared/lib/format';
import { notify } from '@/shared/lib/toast';
import { TASKS_RU } from '../locale';
import { isRecurring, toRecurrenceSpec } from '../recurrence';
import { useCreateSeries, useUpdateSeries } from '../hooks';
import { EditScopeDialog } from '@/shared/components';
import { TaskForm, type TaskFormSubmit } from './TaskForm';

/**
 * Create / edit flow.
 *
 * The whole point of this component is the ordering: for a **recurring**
 * occurrence the scope question comes *before* the form, never after. Asking
 * afterwards ("save… now, which ones?") invites the user to answer whatever
 * dismisses the dialog, and «Все» silently rewrites the family's history.
 * A one-off has no such question — there is only one instance, so the prompt
 * would be noise.
 */
export function TaskEditor(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` / omitted → create a new series. */
  series?: TaskSeriesResponse | null;
  /** Anchor for `this` / `this_and_future`. */
  occurrence?: TaskOccurrenceResponse | null;
  members: readonly PublicUser[];
  onSaved?: () => void;
}) {
  const series = props.series ?? null;
  const occurrence = props.occurrence ?? null;
  const create = useCreateSeries();
  const update = useUpdateSeries();

  // A scope is only meaningful when there is a rule *and* an anchor occurrence.
  const needsScope = series !== null && occurrence !== null && isRecurring(series.recurrence);
  const [scope, setScope] = useState<EditScope | null>(null);

  useEffect(() => {
    if (!props.open) setScope(null);
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
        onSuccess: () => {
          props.onOpenChange(false);
          props.onSaved?.();
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
        onSuccess: () => {
          props.onOpenChange(false);
          props.onSaved?.();
        },
      },
    );
  };

  if (needsScope && scope === null) {
    return (
      <EditScopeDialog
        open={props.open}
        onOpenChange={props.onOpenChange}
        intent="edit"
        strings={TASKS_RU.scope}
        onConfirm={setScope}
      />
    );
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-[min(40rem,calc(100vw-2rem))] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {series === null ? TASKS_RU.form.createTitle : TASKS_RU.form.editTitle}
          </DialogTitle>
        </DialogHeader>
        <TaskForm
          series={series}
          members={props.members}
          scheduleLocked={effectiveScope === 'this'}
          submitting={create.isPending || update.isPending}
          submitLabel={series === null ? TASKS_RU.form.createSubmit : TASKS_RU.form.editSubmit}
          onSubmit={handleSubmit}
          onCancel={() => {
            props.onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
