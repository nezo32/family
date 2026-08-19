import { useState } from 'react';
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
import { COMMON } from '@/shared/lib/i18n';
import { TASKS_RU } from '../locale';
import { SegmentedControl, type SegmentOption } from './SegmentedControl';

/**
 * «Только это / Это и последующие / Все» — the prompt that must appear before
 * **every** edit or delete of a recurring occurrence (`editScopeSchema`; there
 * is no default scope on purpose).
 *
 * Two deliberate choices:
 *  - nothing is pre-selected, and «Продолжить» stays disabled until the user
 *    picks, so a mis-tap cannot rewrite the whole series;
 *  - each option carries a plain-Russian consequence, because "все" reads as
 *    "everything including the past" to most people, and it does not mean that.
 */
export function EditScopeDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  intent: 'edit' | 'delete';
  onConfirm: (scope: EditScope) => void;
}) {
  const [scope, setScope] = useState<EditScope | null>(null);
  const isDelete = props.intent === 'delete';

  const options: readonly SegmentOption<EditScope>[] = [
    {
      value: 'this',
      label: TASKS_RU.scope.this,
      hint: isDelete ? TASKS_RU.scope.thisDeleteHint : TASKS_RU.scope.thisHint,
    },
    {
      value: 'this_and_future',
      label: TASKS_RU.scope.thisAndFuture,
      hint: isDelete ? TASKS_RU.scope.thisAndFutureDeleteHint : TASKS_RU.scope.thisAndFutureHint,
    },
    {
      value: 'all',
      label: TASKS_RU.scope.all,
      hint: isDelete ? TASKS_RU.scope.allDeleteHint : TASKS_RU.scope.allHint,
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
      <DialogContent className="max-w-[min(32rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>
            {isDelete ? TASKS_RU.scope.deleteTitle : TASKS_RU.scope.editTitle}
          </DialogTitle>
          <DialogDescription>
            {isDelete ? TASKS_RU.scope.deleteDescription : TASKS_RU.scope.description}
          </DialogDescription>
        </DialogHeader>

        <SegmentedControl<EditScope> value={scope} options={options} onChange={setScope} stacked />

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            onClick={() => {
              props.onOpenChange(false);
            }}
          >
            {COMMON.cancel}
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={scope === null}
            onClick={() => {
              if (scope) props.onConfirm(scope);
            }}
          >
            {TASKS_RU.scope.continue}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
