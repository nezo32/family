import { useEffect, useId, useState } from 'react';
import type { ClearInboxScope } from '@family/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog';
import { RadioGroup, RadioGroupItem } from '@/shared/ui/radio-group';
import { Skeleton } from '@/shared/ui/skeleton';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { COMMON } from '@/shared/lib/i18n';
import { errorMessageRu } from '@/shared/api/errors-ru';
import { useClearableInbox } from '../hooks';
import { NOTIFICATIONS_RU } from '../locale';

/**
 * «Очистить» — the confirmation in front of the most destructive thing the
 * inbox can do.
 *
 * ## Why a dialog of its own and not `ConfirmDialog`
 *
 * Because there are two answers, not one, and the difference between them is
 * the entire safety argument. `ConfirmDialog` offers a single button, which
 * would force either two entry points («Очистить прочитанные», «Очистить всё»)
 * competing in one small header, or one entry point that silently picks a
 * meaning. A radio group with «Прочитанные» preselected states both options
 * side by side and makes the destructive one exactly one deliberate tap
 * further — which is the shape the brief asked for and the shape a family
 * member can actually reason about.
 *
 * ## It states the count before it destroys anything
 *
 * The precedent is shopping's `clear-bought`, whose dialog says «В списке 3
 * позиции…» first. So this one opens by asking the server
 * `GET /notifications/clearable`, and each option carries its own live number;
 * the confirm button is disabled while that is unknown or zero. A destructive
 * action that cannot say what it will destroy is a trap however many
 * confirmations sit in front of it.
 *
 * ## Two things the copy has to say, because they are true and non-obvious
 *
 * 1. **Delivery receipts survive.** The server writes `cleared_at` and nothing
 *    else; «дошло ли до Ани» is still answerable about a notification that has
 *    been tidied away (D11). Saying so is what makes «Все» a defensible option
 *    rather than a shredder.
 * 2. **Some rows will not go, and why.** A `high`/`critical` delivery nobody
 *    has confirmed receipt of is refused by every scope — «Подтвердить
 *    получение» lives on that row, and for a `critical` intent it is the only
 *    signal that stops the reminder walking on to another family member.
 *    Clearing everything and still seeing two rows reads as a bug unless the
 *    dialog has already said it will happen.
 *
 * Built on `AlertDialog`, like every other destructive confirmation here: modal,
 * focus-trapped, announced as an alert, and Escape cancels rather than confirms.
 */
export function ClearInboxDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  onConfirm: (scope: ClearInboxScope) => void;
}) {
  const [scope, setScope] = useState<ClearInboxScope>('read');
  const counts = useClearableInbox(props.open);
  const groupId = useId();

  // Every open starts from the safe answer. A dialog that remembers «Все» from
  // last time is a dialog whose destructive option is one tap away again.
  useEffect(() => {
    if (props.open) setScope('read');
  }, [props.open]);

  const matched = counts.data ? (scope === 'read' ? counts.data.read : counts.data.all) : undefined;
  const keptNeedsAck = counts.data?.keptNeedsAck ?? 0;
  const nothingToDo = matched === 0;

  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{NOTIFICATIONS_RU.clearTitle}</AlertDialogTitle>
          <AlertDialogDescription>{NOTIFICATIONS_RU.clearReceiptsNote}</AlertDialogDescription>
        </AlertDialogHeader>

        {counts.isPending ? (
          <div className="space-y-3" aria-busy>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : counts.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessageRu(counts.error)}
          </p>
        ) : (
          <RadioGroup
            value={scope}
            onValueChange={(next) => {
              setScope(next as ClearInboxScope);
            }}
            aria-label={NOTIFICATIONS_RU.clearTitle}
          >
            <ScopeOption
              id={`${groupId}-read`}
              value="read"
              label={NOTIFICATIONS_RU.clearScopeRead}
              count={counts.data.read}
            />
            <ScopeOption
              id={`${groupId}-all`}
              value="all"
              label={NOTIFICATIONS_RU.clearScopeAll}
              count={counts.data.all}
              /*
                The one line that makes this the deliberate choice rather than
                the convenient one: what leaves is not only what you have seen.
              */
              warning={NOTIFICATIONS_RU.clearScopeAllWarning}
            />
          </RadioGroup>
        )}

        {keptNeedsAck > 0 ? (
          <p className="text-[13px] leading-[18px] text-muted-foreground">
            {NOTIFICATIONS_RU.clearKeptNeedsAck(keptNeedsAck)}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.isPending}>{COMMON.cancel}</AlertDialogCancel>
          <AlertDialogAction
            /*
              The `variant` prop, not a `buttonVariants()` class: `AlertDialogAction`
              renders a `Button asChild` and passes `variant` to it, so a class
              handed through `className` lands on the inner primitive and loses
              to the button's own. This control destroys something and has to
              look like it.
            */
            variant="destructive"
            disabled={props.isPending || matched === undefined || nothingToDo}
            onClick={(event) => {
              // Radix would close on click; the spinner has to stay visible
              // until the server has answered, because this write is not
              // optimistic and the panel behind is still showing the old list.
              event.preventDefault();
              props.onConfirm(scope);
            }}
          >
            {props.isPending ? <InlineSpinner className="mr-2" /> : null}
            {nothingToDo ? NOTIFICATIONS_RU.clearNothing : NOTIFICATIONS_RU.clearConfirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * One scope, with its own count.
 *
 * ## The whole row is the target
 *
 * A `<label>` around the sentence, so the 44px target is the words rather than
 * the 16px circle beside them (§C5).
 *
 * ## …and the whole sentence is the accessible name
 *
 * `aria-labelledby` on the radio, pointing at the label **and** the count, so a
 * screen reader hears «Все уведомления, исчезнут 5 уведомлений» — the same two
 * facts the sighted reader is choosing between. A bare `<label for>` around a
 * Radix radio (which is a `button`, not an `input`) does not reliably produce
 * that name, and a radio announced as nothing at all is the one control on this
 * dialog where guessing is expensive.
 *
 * The warning is a **description**, not part of the name: it is the reason the
 * option is the deliberate one, and it belongs after the choice rather than
 * inside it.
 */
function ScopeOption(props: {
  id: string;
  value: ClearInboxScope;
  label: string;
  count: number;
  warning?: string;
}) {
  const labelId = `${props.id}-label`;
  const countId = `${props.id}-count`;
  const warningId = `${props.id}-warning`;

  return (
    <label
      htmlFor={props.id}
      className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[[data-state=checked]]:border-primary"
    >
      <RadioGroupItem
        id={props.id}
        value={props.value}
        className="mt-1"
        aria-labelledby={`${labelId} ${countId}`}
        {...(props.warning ? { 'aria-describedby': warningId } : {})}
      />
      <span className="flex-1">
        <span id={labelId} className="block text-sm font-medium">
          {props.label}
        </span>
        <span
          id={countId}
          className="block text-[13px] leading-[18px] text-muted-foreground tabular-nums"
        >
          {NOTIFICATIONS_RU.clearCount(props.count)}
        </span>
        {props.warning ? (
          <span
            id={warningId}
            className="mt-1 block text-[13px] leading-[18px] text-muted-foreground"
          >
            {props.warning}
          </span>
        ) : null}
      </span>
    </label>
  );
}
