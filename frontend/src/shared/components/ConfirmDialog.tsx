import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { buttonVariants } from '../ui/button';
import { cn } from '../lib/utils';
import { COMMON } from '../lib/i18n';
import { InlineSpinner } from './LoadingScreen';

/**
 * Confirmation for destructive or irreversible actions.
 *
 * Built on `AlertDialog` (not `Dialog`) so it is modal, focus-trapped and
 * announced as an alert, and so Escape/outside-click do **not** silently
 * confirm.
 */
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button. Default `true` — most confirmations are deletions. */
  destructive?: boolean;
  /** May return a promise; the button shows a spinner until it settles. */
  onConfirm: () => void | Promise<void>;
  isPending?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const pending = props.isPending ?? busy;
  const destructive = props.destructive ?? true;

  const handleConfirm = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      // Keep the dialog open while the request is in flight; Radix would close
      // it on click otherwise and the user would lose the spinner.
      event.preventDefault();
      const result = props.onConfirm();
      if (result instanceof Promise) {
        setBusy(true);
        void result.finally(() => {
          setBusy(false);
          props.onOpenChange(false);
        });
      } else {
        props.onOpenChange(false);
      }
    },
    [props],
  );

  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title ?? COMMON.areYouSure}</AlertDialogTitle>
          <AlertDialogDescription>
            {props.description ?? COMMON.actionCannotBeUndone}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{props.cancelLabel ?? COMMON.cancel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={pending}
            className={cn(
              destructive &&
                buttonVariants({ variant: 'destructive' }),
            )}
          >
            {pending ? <InlineSpinner className="mr-2" /> : null}
            {props.confirmLabel ?? (destructive ? COMMON.delete : COMMON.confirm)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Hook form of the same thing, for list rows where wiring up local state for
 * every item is tedious.
 *
 * ```tsx
 * const confirm = useConfirm();
 * …
 * <Button onClick={() => confirm.ask({ title: 'Удалить задачу?', onConfirm: () => remove(id) })} />
 * {confirm.dialog}
 * ```
 */
export function useConfirm() {
  const [open, setOpen] = useState(false);
  const optionsRef = useRef<ConfirmOptions | null>(null);
  const [, force] = useState(0);

  const ask = useCallback((options: ConfirmOptions) => {
    optionsRef.current = options;
    force((n) => n + 1);
    setOpen(true);
  }, []);

  const options = optionsRef.current;

  const dialog = options ? (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      {...options}
      onConfirm={options.onConfirm}
    />
  ) : null;

  return { ask, dialog, isOpen: open };
}

export interface ConfirmOptions {
  title?: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}
