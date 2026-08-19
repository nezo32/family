import { useEffect, useState } from 'react';
import type { EditScope } from '@family/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Button } from '@/shared/ui/button';
import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { CALENDAR_RU } from '../locale';

/**
 * The edit-scope prompt for a recurring event (D2 §3).
 *
 * There is no default and there must not be one: guessing whether "изменить"
 * means this Tuesday or every Tuesday is how calendars lose data. Shown **only**
 * for recurring series — a one-off is edited with `scope: 'all'` silently,
 * because for one occurrence all three answers are the same answer.
 */
export function EditScopeDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'edit' | 'delete';
  isPending?: boolean;
  onConfirm: (scope: EditScope) => void;
}) {
  const [scope, setScope] = useState<EditScope>('this');

  useEffect(() => {
    if (props.open) setScope('this');
  }, [props.open]);

  const options: { value: EditScope; label: string; hint: string }[] = [
    { value: 'this', label: CALENDAR_RU.scope.this, hint: CALENDAR_RU.scope.thisHint },
    {
      value: 'this_and_future',
      label: CALENDAR_RU.scope.thisAndFuture,
      hint: CALENDAR_RU.scope.thisAndFutureHint,
    },
    { value: 'all', label: CALENDAR_RU.scope.all, hint: CALENDAR_RU.scope.allHint },
  ];

  const isDelete = props.mode === 'delete';

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md" data-testid="edit-scope-dialog">
        <DialogHeader>
          <DialogTitle>
            {isDelete ? CALENDAR_RU.scope.deleteTitle : CALENDAR_RU.scope.editTitle}
          </DialogTitle>
          <DialogDescription>
            {isDelete ? CALENDAR_RU.scope.deleteDescription : CALENDAR_RU.scope.editDescription}
          </DialogDescription>
        </DialogHeader>

        <div role="radiogroup" className="flex flex-col gap-2">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={scope === option.value}
              onClick={() => {
                setScope(option.value);
              }}
              className={cn(
                'flex min-h-11 flex-col items-start gap-0.5 rounded-xl border border-border px-3 py-2.5 text-left transition-colors',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                scope === option.value
                  ? 'border-primary bg-primary/10'
                  : 'bg-background hover:bg-accent/40',
              )}
            >
              <span className="text-sm font-medium text-foreground">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.hint}</span>
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              props.onOpenChange(false);
            }}
            disabled={props.isPending}
          >
            {COMMON.cancel}
          </Button>
          <Button
            variant={isDelete ? 'destructive' : 'default'}
            disabled={props.isPending}
            onClick={() => {
              props.onConfirm(scope);
            }}
          >
            {isDelete ? CALENDAR_RU.scope.deleteApply : CALENDAR_RU.scope.apply}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
