import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Button } from '@/shared/ui/button';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { COMMON } from '@/shared/lib/i18n';
import { ADMIN_RU } from '../locale';

/**
 * Rejection, with an optional reason.
 *
 * The reason is optional on purpose: forcing an admin to justify declining an
 * unknown signup would make the safe action the slow one. When it is given it
 * reaches the applicant's rejection screen, so the placeholder nudges towards
 * something a human can read.
 *
 * `text-base` on the textarea is not decoration — iOS zooms the viewport on
 * focus for anything under 16px and never zooms back out (D7).
 */
export function RejectDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memberName: string;
  isPending: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');

  // A reason typed for one applicant must never survive into the next one.
  useEffect(() => {
    if (props.open) setReason('');
  }, [props.open]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>{ADMIN_RU.rejectDialogTitle}</DialogTitle>
          <DialogDescription>{ADMIN_RU.rejectDialogDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="reject-reason">
            {ADMIN_RU.rejectReasonLabel}
            <span className="ml-1 font-normal text-muted-foreground">({COMMON.optional})</span>
          </Label>
          <Textarea
            id="reject-reason"
            value={reason}
            maxLength={500}
            rows={3}
            placeholder={ADMIN_RU.rejectReasonPlaceholder}
            className="text-base"
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">{props.memberName}</p>
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
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
            variant="destructive"
            className="min-h-11"
            disabled={props.isPending}
            onClick={() => {
              props.onConfirm(reason);
            }}
          >
            {props.isPending ? <InlineSpinner className="mr-2" /> : null}
            {ADMIN_RU.rejectConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
