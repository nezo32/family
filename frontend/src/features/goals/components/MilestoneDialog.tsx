import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  createMilestoneSchema,
  updateMilestoneSchema,
  type MilestoneResponse,
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
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { COMMON } from '@/shared/lib/i18n';
import { GOALS_RU, MONEY_ERROR_RU } from '../locale';
import { formatMinorUnitsForInput, parsePositiveAmount } from '../money';
import { useCreateMilestone, useUpdateMilestone } from '../hooks';
import { MoneyInput } from './MoneyInput';

/**
 * Milestone create / edit.
 *
 * `targetAmount` is an **absolute threshold** in minor units, not a delta and
 * not a percentage (see `contracts/goals.ts`) — the copy says "сумма этапа" for
 * that reason.
 */

interface MilestoneFormValues {
  title: string;
  targetAmount: string;
}

const milestoneFormSchema = z.object({
  title: createMilestoneSchema.shape.title,
  targetAmount: z.string().superRefine((value, ctx) => {
    const parsed = parsePositiveAmount(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MONEY_ERROR_RU[parsed.error] });
      return;
    }
    if (!createMilestoneSchema.shape.targetAmount.safeParse(parsed.minorUnits).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: GOALS_RU.errorAmountInvalid });
    }
  }),
});

export function MilestoneDialog(props: {
  goalId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit mode. */
  milestone?: MilestoneResponse | undefined;
}) {
  const create = useCreateMilestone(props.goalId);
  const update = useUpdateMilestone(props.goalId);
  const isPending = create.isPending || update.isPending;

  const form = useForm<MilestoneFormValues>({
    resolver: zodResolver(milestoneFormSchema),
    defaultValues: {
      title: props.milestone?.title ?? '',
      targetAmount: props.milestone ? formatMinorUnitsForInput(props.milestone.targetAmount) : '',
    },
  });

  useEffect(() => {
    if (props.open) {
      form.reset({
        title: props.milestone?.title ?? '',
        targetAmount: props.milestone ? formatMinorUnitsForInput(props.milestone.targetAmount) : '',
      });
    }
  }, [props.open, props.milestone, form]);

  const amountInput = form.watch('targetAmount');

  const onSubmit = form.handleSubmit((values) => {
    const parsed = parsePositiveAmount(values.targetAmount);
    if (!parsed.ok) return;
    const base = { title: values.title.trim(), targetAmount: parsed.minorUnits };
    const close = {
      onSuccess: () => {
        props.onOpenChange(false);
      },
    };

    if (props.milestone) {
      update.mutate(
        { milestoneId: props.milestone.id, body: updateMilestoneSchema.parse(base) },
        close,
      );
    } else {
      create.mutate(createMilestoneSchema.parse(base), close);
    }
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {props.milestone ? GOALS_RU.editMilestone : GOALS_RU.addMilestone}
          </DialogTitle>
          <DialogDescription>{GOALS_RU.milestonesDescription}</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="milestone-title">{GOALS_RU.milestoneTitle}</Label>
            <Input
              id="milestone-title"
              className="h-12 text-base md:text-sm"
              placeholder={GOALS_RU.milestoneTitlePlaceholder}
              aria-invalid={Boolean(form.formState.errors.title)}
              {...form.register('title')}
            />
            {form.formState.errors.title ? (
              <p className="text-xs font-medium text-destructive" role="alert">
                {GOALS_RU.errorTitleRequired}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="milestone-amount">{GOALS_RU.milestoneAmount}</Label>
            <MoneyInput
              id="milestone-amount"
              value={amountInput}
              onChange={(value) => {
                form.setValue('targetAmount', value, {
                  shouldValidate: form.formState.isSubmitted,
                });
              }}
              invalid={Boolean(form.formState.errors.targetAmount)}
            />
            {form.formState.errors.targetAmount ? (
              <p className="text-xs font-medium text-destructive" role="alert">
                {form.formState.errors.targetAmount.message}
              </p>
            ) : null}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11 min-w-24"
              disabled={isPending}
              onClick={() => {
                props.onOpenChange(false);
              }}
            >
              {COMMON.cancel}
            </Button>
            <Button type="submit" className="h-11 min-w-32" disabled={isPending}>
              {isPending ? <InlineSpinner className="mr-2" /> : null}
              {COMMON.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
