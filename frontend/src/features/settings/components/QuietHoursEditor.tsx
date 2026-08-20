import { useState } from 'react';
import { Moon, Plus, Trash2 } from 'lucide-react';
import {
  QUIET_MODES,
  QUIET_MODE_LABELS_RU,
  type QuietHours,
  type QuietHoursInput,
  type QuietMode,
} from '@family/shared';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { Label } from '@/shared/ui/label';
import { TimeField } from '@/shared/ui/time-field';
import { notify } from '@/shared/lib/toast';
import { SETTINGS_RU } from '../locale';
import { useSaveQuietHours } from '../hooks';

const T = SETTINGS_RU.notifications;

/**
 * Тихие часы.
 *
 * D10: quiet hours **defer**, they never drop. That promise is the reason the
 * default mode is `defer` and the reason the description says so out loud — a
 * family member who believes "тихие часы" means "потеряю напоминание" will never
 * turn them on, and then one 03:00 push later they turn off notifications
 * entirely, which is the failure mode that kills these apps.
 *
 * A window whose `endsAt <= startsAt` wraps past midnight (22:00 → 07:00) and is
 * the common case, so it is called out rather than rejected. The one thing the
 * contract forbids is `startsAt === endsAt`, which would mean either "always" or
 * "never" depending on how you read it.
 *
 * `PUT /api/notifications/quiet-hours` replaces the whole set, so the editor
 * keeps the entire list in local state and sends it as one array.
 */
export function QuietHoursEditor(props: { windows: readonly QuietHours[] }) {
  const save = useSaveQuietHours();
  const [draft, setDraft] = useState<QuietHoursInput[] | null>(null);

  const windows: QuietHoursInput[] =
    draft ??
    props.windows.map((window) => ({
      dayOfWeek: window.dayOfWeek,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      mode: window.mode,
    }));

  const update = (index: number, change: Partial<QuietHoursInput>) => {
    setDraft(windows.map((window, i) => (i === index ? { ...window, ...change } : window)));
  };

  const add = () => {
    setDraft([...windows, { dayOfWeek: null, startsAt: '22:00', endsAt: '07:00', mode: 'defer' }]);
  };

  const remove = (index: number) => {
    setDraft(windows.filter((_, i) => i !== index));
  };

  const invalid = windows.some((window) => window.startsAt === window.endsAt);
  const dirty = draft !== null;

  const submit = () => {
    if (invalid) return;
    save.mutate(windows, {
      onSuccess: () => {
        setDraft(null);
        notify.success(T.quietSaved);
      },
      onError: (error) => {
        notify.error(error);
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Moon className="size-4" aria-hidden />
          {T.quietTitle}
        </CardTitle>
        <CardDescription>{T.quietDescription}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {windows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{T.quietEmpty}</p>
        ) : (
          windows.map((window, index) => {
            const overnight = window.endsAt <= window.startsAt;
            const same = window.startsAt === window.endsAt;
            return (
              <div
                key={`${String(window.dayOfWeek)}-${String(index)}`}
                className="space-y-3 rounded-lg border border-border p-3"
              >
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label htmlFor={`quiet-from-${String(index)}`}>{T.quietFrom}</Label>
                    <TimeField
                      id={`quiet-from-${String(index)}`}
                      label={T.quietFrom}
                      className="w-40"
                      value={window.startsAt}
                      onChange={(next) => {
                        update(index, { startsAt: next });
                      }}
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor={`quiet-to-${String(index)}`}>{T.quietTo}</Label>
                    <TimeField
                      id={`quiet-to-${String(index)}`}
                      label={T.quietTo}
                      className="w-40"
                      value={window.endsAt}
                      onChange={(next) => {
                        update(index, { endsAt: next });
                      }}
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor={`quiet-day-${String(index)}`}>{T.quietDay}</Label>
                    {/*
                      A native <select> here on purpose: it is the accessible,
                      zero-JS control on a phone, and iOS renders it as a wheel
                      picker that beats any custom listbox with a thumb.
                    */}
                    <select
                      id={`quiet-day-${String(index)}`}
                      className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                      value={window.dayOfWeek === null ? 'all' : String(window.dayOfWeek)}
                      onChange={(event) => {
                        update(index, {
                          dayOfWeek:
                            event.target.value === 'all' ? null : Number(event.target.value),
                        });
                      }}
                    >
                      <option value="all">{T.quietEveryDay}</option>
                      {T.quietWeekdays.map((label, day) => (
                        <option key={label} value={String(day)}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor={`quiet-mode-${String(index)}`}>{T.quietMode}</Label>
                    <select
                      id={`quiet-mode-${String(index)}`}
                      className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                      value={window.mode}
                      onChange={(event) => {
                        update(index, { mode: event.target.value as QuietMode });
                      }}
                    >
                      {QUIET_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {QUIET_MODE_LABELS_RU[mode]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={T.quietRemove}
                    onClick={() => {
                      remove(index);
                    }}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>

                {same ? (
                  <p className="text-xs text-destructive">{T.quietSameTimeError}</p>
                ) : overnight ? (
                  <p className="text-xs text-muted-foreground">{T.quietOvernightHint}</p>
                ) : null}
              </div>
            );
          })
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={add}>
            <Plus aria-hidden />
            {T.quietAdd}
          </Button>
          <Button type="button" disabled={!dirty || invalid || save.isPending} onClick={submit}>
            {save.isPending ? T.saving : T.save}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
