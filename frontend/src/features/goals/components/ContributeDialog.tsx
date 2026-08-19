import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowDownLeft, ArrowUpRight, PartyPopper, TriangleAlert } from 'lucide-react';
import {
  createContributionSchema,
  createWithdrawalSchema,
  type GoalResponse,
} from '@family/shared';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { formatMoney } from '@/shared/lib/format';
import { COMMON } from '@/shared/lib/i18n';
import { cn } from '@/shared/lib/utils';
import { GOALS_RU, MONEY_ERROR_RU } from '../locale';
import { goalProgressPercent, parsePositiveAmount, ringPercent } from '../money';
import { useContribute, useWithdraw } from '../hooks';
import { MoneyInput } from './MoneyInput';

/**
 * Contribute / withdraw.
 *
 * Both directions take a **positive** amount and the server applies the sign
 * (household.md §2.4) — the client never sends a negative number here, so a bug
 * in this file cannot silently credit a goal.
 *
 * The preview is the point of the dialog: before committing, the user sees the
 * exact resulting balance and the exact resulting percentage, computed in
 * integer минорные units. After the request, the balance on screen comes from
 * the server's recomputed `SUM(delta)`, never from this arithmetic.
 */

export type LedgerMode = 'contribute' | 'withdraw';

const QUICK_AMOUNTS = [50000, 100000, 500000];

interface LedgerFormValues {
  amount: string;
  note: string;
}

/** String field → validated positive minor units, checked against the contract. */
const ledgerFormSchema = z.object({
  amount: z.string().superRefine((value, ctx) => {
    const parsed = parsePositiveAmount(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MONEY_ERROR_RU[parsed.error] });
      return;
    }
    // The shared contract is the authority on what the API accepts.
    const contractCheck = createContributionSchema.shape.amount.safeParse(parsed.minorUnits);
    if (!contractCheck.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: GOALS_RU.errorAmountInvalid });
    }
  }),
  note: z.string().trim().max(500),
});

export function ContributeDialog(props: {
  goal: GoalResponse;
  mode: LedgerMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isContribution = props.mode === 'contribute';
  const contribute = useContribute(props.goal.id);
  const withdraw = useWithdraw(props.goal.id);
  const isPending = contribute.isPending || withdraw.isPending;

  const form = useForm<LedgerFormValues>({
    resolver: zodResolver(ledgerFormSchema),
    defaultValues: { amount: '', note: '' },
    mode: 'onSubmit',
  });

  // A reopened dialog must not remember the last amount: a stale "5 000" one
  // tap away from being committed again is exactly the kind of money bug the
  // append-only ledger cannot undo.
  useEffect(() => {
    if (props.open) form.reset({ amount: '', note: '' });
  }, [props.open, form]);

  const amountInput = form.watch('amount');
  const parsed = parsePositiveAmount(amountInput);
  const amount = parsed.ok ? parsed.minorUnits : 0;
  const delta = isContribution ? amount : -amount;
  const nextBalance = props.goal.currentAmount + delta;
  const nextPercent = goalProgressPercent(nextBalance, props.goal.targetAmount);
  const reachesTarget =
    isContribution &&
    props.goal.currentAmount < props.goal.targetAmount &&
    nextBalance >= props.goal.targetAmount;
  const overdraft = !isContribution && nextBalance < 0;

  const onSubmit = form.handleSubmit((values) => {
    const positive = parsePositiveAmount(values.amount);
    if (!positive.ok) return;
    const note = values.note.trim();
    // Validated against the shared contract one last time before it leaves.
    const input = { amount: positive.minorUnits, ...(note.length > 0 ? { note } : {}) };
    const close = {
      onSuccess: () => {
        props.onOpenChange(false);
      },
    };

    if (isContribution) {
      contribute.mutate(createContributionSchema.parse(input), close);
    } else {
      withdraw.mutate(createWithdrawalSchema.parse(input), close);
    }
  });

  const Icon = isContribution ? ArrowUpRight : ArrowDownLeft;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="size-5 text-primary" aria-hidden />
            {isContribution ? GOALS_RU.contributeTitle : GOALS_RU.withdrawTitle}
          </DialogTitle>
          <DialogDescription>
            {isContribution ? GOALS_RU.contributeDescription : GOALS_RU.withdrawDescription}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="goal-amount">{GOALS_RU.amount}</Label>
            <MoneyInput
              id="goal-amount"
              value={amountInput}
              onChange={(value) => {
                form.setValue('amount', value, { shouldValidate: form.formState.isSubmitted });
              }}
              invalid={Boolean(form.formState.errors.amount)}
              quickAmounts={isContribution ? QUICK_AMOUNTS : undefined}
              aria-describedby="goal-amount-hint"
            />
            <p id="goal-amount-hint" className="text-xs text-muted-foreground">
              {GOALS_RU.amountHint}
            </p>
            {form.formState.errors.amount ? (
              <p className="text-xs font-medium text-destructive" role="alert">
                {form.formState.errors.amount.message}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal-note">{GOALS_RU.note}</Label>
            <Textarea
              id="goal-note"
              rows={2}
              className="text-base md:text-sm"
              placeholder={GOALS_RU.notePlaceholder}
              {...form.register('note')}
            />
          </div>

          {/* ---- live preview ------------------------------------------- */}
          <div className="space-y-3 rounded-xl border bg-muted/40 p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">{GOALS_RU.previewBalance}</span>
              <span
                className="text-lg font-semibold tabular-nums"
                data-testid="contribute-preview-balance"
              >
                {formatMoney(nextBalance)}
              </span>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                <span>{GOALS_RU.previewProgress}</span>
                <span className="tabular-nums" data-testid="contribute-preview-percent">
                  {nextPercent} %
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-background">
                <div
                  className={cn(
                    'h-full rounded-full transition-[width] duration-300',
                    overdraft ? 'bg-destructive' : 'bg-primary',
                  )}
                  style={{ width: `${String(ringPercent(nextPercent))}%` }}
                />
              </div>
            </div>

            {reachesTarget ? (
              <p className="flex items-center gap-2 text-sm font-medium text-success">
                <PartyPopper className="size-4" aria-hidden />
                {GOALS_RU.previewReaches}
              </p>
            ) : null}
            {overdraft ? (
              <p
                className="flex items-center gap-2 text-sm font-medium text-destructive"
                role="alert"
              >
                <TriangleAlert className="size-4" aria-hidden />
                {GOALS_RU.previewOverdraft}
              </p>
            ) : null}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11 min-w-24"
              onClick={() => {
                props.onOpenChange(false);
              }}
              disabled={isPending}
            >
              {COMMON.cancel}
            </Button>
            <Button type="submit" className="h-11 min-w-32" disabled={isPending}>
              {isPending ? <InlineSpinner className="mr-2" /> : null}
              {isContribution ? GOALS_RU.contribute : GOALS_RU.withdraw}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
