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

/**
 * «Только это / Это и последующие / Все» — the prompt that must appear before
 * **every** edit or delete of a recurring occurrence (`editScopeSchema`).
 *
 * ## Why this is one component
 *
 * Tasks and the calendar each had their own, and the safety default was
 * **inverted between them**. Tasks pre-selected nothing and kept «Продолжить»
 * disabled until the user chose. The calendar defaulted to `'this'` with its
 * confirm button always enabled — so on that screen a double-tap (open the
 * dialog, land on the button underneath) silently committed a
 * single-occurrence edit, while the file's own header comment claimed «there is
 * no default and there must not be one». The two copies also read their titles
 * and descriptions from locale keys that were swapped relative to each other.
 *
 * The behaviour below is the tasks one, because "guessing whether «изменить»
 * means this Tuesday or every Tuesday is how calendars lose data" is right and
 * only one of the two implementations actually did it:
 *
 *  - **nothing is pre-selected** and confirm stays disabled until the user
 *    picks, so a mis-tap cannot rewrite a whole series;
 *  - the selection **resets when the dialog closes**, so re-opening it never
 *    inherits the previous answer;
 *  - each option carries a plain-Russian consequence, because "все" reads as
 *    "everything including the past" to most people and it does not mean that.
 *
 * From the calendar copy it keeps `isPending` (both buttons disable while the
 * mutation is in flight) and the destructive styling on a delete.
 *
 * ## Copy
 *
 * The strings stay with the feature (D7) — a task is «дело» and an event is
 * «событие» — so they arrive as {@link EditScopeStrings}. The shape is fixed
 * here so the two locale files cannot disagree about which key is the title
 * again.
 */

/**
 * The scope vocabulary a feature must supply.
 *
 * `*Title` is the **question** («Что изменить?») and `*Description` is the
 * sentence that gives it context («Это повторяющееся дело. …»), in that order,
 * on both screens.
 */
export interface EditScopeStrings {
  editTitle: string;
  editDescription: string;
  deleteTitle: string;
  deleteDescription: string;

  this: string;
  thisAndFuture: string;
  all: string;

  thisHint: string;
  thisAndFutureHint: string;
  allHint: string;

  /** Delete-specific consequences. Each falls back to its edit counterpart. */
  thisDeleteHint?: string;
  thisAndFutureDeleteHint?: string;
  allDeleteHint?: string;

  /** Confirm label. `deleteConfirm` falls back to `confirm`. */
  confirm: string;
  deleteConfirm?: string;
}

export function EditScopeDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  intent: 'edit' | 'delete';
  strings: EditScopeStrings;
  /** Disables both buttons while the mutation is in flight. */
  isPending?: boolean;
  onConfirm: (scope: EditScope) => void;
}) {
  const { strings } = props;
  const isDelete = props.intent === 'delete';

  // `null`, always, on open. The whole point of the dialog is that the answer
  // comes from the user and not from us.
  const [scope, setScope] = useState<EditScope | null>(null);
  useEffect(() => {
    if (props.open) setScope(null);
  }, [props.open]);

  const options: readonly { value: EditScope; label: string; hint: string }[] = [
    {
      value: 'this',
      label: strings.this,
      hint: (isDelete ? strings.thisDeleteHint : undefined) ?? strings.thisHint,
    },
    {
      value: 'this_and_future',
      label: strings.thisAndFuture,
      hint: (isDelete ? strings.thisAndFutureDeleteHint : undefined) ?? strings.thisAndFutureHint,
    },
    {
      value: 'all',
      label: strings.all,
      hint: (isDelete ? strings.allDeleteHint : undefined) ?? strings.allHint,
    },
  ];

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setScope(null);
        props.onOpenChange(open);
      }}
    >
      <DialogContent
        className="max-w-[min(32rem,calc(100vw-2rem))]"
        data-testid="edit-scope-dialog"
      >
        <DialogHeader>
          <DialogTitle>{isDelete ? strings.deleteTitle : strings.editTitle}</DialogTitle>
          <DialogDescription>
            {isDelete ? strings.deleteDescription : strings.editDescription}
          </DialogDescription>
        </DialogHeader>

        <div role="radiogroup" className="flex flex-col gap-2">
          {options.map((option) => {
            const selected = scope === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={props.isPending}
                onClick={() => {
                  setScope(option.value);
                }}
                className={cn(
                  'flex min-h-11 flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
                  'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                  'disabled:pointer-events-none disabled:opacity-50',
                  selected
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-background hover:bg-accent/40',
                )}
              >
                <span className="text-sm font-medium text-foreground">{option.label}</span>
                <span className="text-xs text-pretty text-muted-foreground">{option.hint}</span>
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={props.isPending}
            onClick={() => {
              props.onOpenChange(false);
            }}
          >
            {COMMON.cancel}
          </Button>
          <Button
            type="button"
            className="min-h-11"
            variant={isDelete ? 'destructive' : 'default'}
            // The safety default, and the reason this component exists once:
            // there is nothing to confirm until the user has actually chosen.
            disabled={scope === null || props.isPending}
            onClick={() => {
              if (scope) props.onConfirm(scope);
            }}
          >
            {(isDelete ? strings.deleteConfirm : undefined) ?? strings.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
