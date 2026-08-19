import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  createGoalSchema,
  updateGoalSchema,
  type CreateGoal,
  type GoalResponse,
  type UpdateGoal,
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
import { RadioGroup, RadioGroupItem } from '@/shared/ui/radio-group';
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { useMe } from '@/shared/auth/use-me';
import { COMMON } from '@/shared/lib/i18n';
import { displayEmoji } from '@/shared/lib/emoji';
import { cn } from '@/shared/lib/utils';
import { GOALS_RU, MONEY_ERROR_RU } from '../locale';
import { formatMinorUnitsForInput, parsePositiveAmount } from '../money';
import { useCreateGoal, useUpdateGoal } from '../hooks';
import { MoneyInput } from './MoneyInput';

/**
 * Create / edit a goal.
 *
 * The form is validated by `zodResolver` against a schema whose field rules are
 * taken **from the shared contract** (`createGoalSchema.shape.*`), and the
 * assembled payload is parsed by the contract itself before it is sent — so the
 * client cannot drift from the API even if this file is edited carelessly.
 *
 * The amount field is a string throughout and becomes integer minor units in
 * exactly one place, at submit (D6).
 */

/**
 * Contract wants `#RRGGBB`, so the theme's OKLCH tokens are inlined as literal
 * hex here — a goal's colour is stored data, not a CSS variable.
 *
 * The first five **are** `--chart-1…5` from `src/index.css` (clay, sage, honey,
 * plum, sky); the last three extend the same ramp — same lightness band, same
 * chroma band, three unused hues. The ramp existed and nothing used it, so goals
 * picked from an unrelated set and a seeded sky-blue sat next to a themed
 * terracotta looking like two different products.
 */
export const GOAL_COLORS = [
  '#DA6635', // --chart-1  clay
  '#43996C', // --chart-2  sage
  '#E3AD3E', // --chart-3  honey
  '#9F599D', // --chart-4  plum
  '#3B9AC5', // --chart-5  sky
  '#C1555D', // brick
  '#6179BD', // indigo
  '#259B9C', // teal
] as const;

const GOAL_ICONS = [
  '🏖️',
  '🚲',
  '🏠',
  '💻',
  '🎓',
  '🎁',
  '🚗',
  '🎮',
  '✈️',
  '🛋️',
  '🐶',
  '💍',
] as const;

interface GoalFormValues {
  title: string;
  description: string;
  targetAmount: string;
  deadline: string;
  color: string;
  icon: string;
  ownership: 'shared' | 'personal';
  isPrivate: boolean;
}

const goalFormSchema = z.object({
  // Straight from the contract: one source of truth for length limits.
  title: createGoalSchema.shape.title,
  description: z.string().trim().max(2000),
  targetAmount: z.string().superRefine((value, ctx) => {
    const parsed = parsePositiveAmount(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MONEY_ERROR_RU[parsed.error] });
      return;
    }
    if (!createGoalSchema.shape.targetAmount.safeParse(parsed.minorUnits).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: GOALS_RU.errorAmountInvalid });
    }
  }),
  deadline: z
    .string()
    .refine(
      (value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value),
      GOALS_RU.errorDeadlineInvalid,
    ),
  color: z.string().refine((value) => /^#[0-9a-fA-F]{6}$/.test(value), GOALS_RU.errorColorInvalid),
  icon: z.string().max(64),
  ownership: z.enum(['shared', 'personal']),
  isPrivate: z.boolean(),
});

function toDefaults(goal: GoalResponse | undefined): GoalFormValues {
  return {
    title: goal?.title ?? '',
    description: goal?.description ?? '',
    targetAmount: goal ? formatMinorUnitsForInput(goal.targetAmount) : '',
    deadline: goal?.deadline ?? '',
    color: goal?.color ?? GOAL_COLORS[0],
    // Drop an icon we cannot draw rather than round-tripping it: this picker
    // writes emoji, so opening an older goal is the moment its stored lucide
    // name stops being carried forward.
    icon: displayEmoji(goal?.icon) ?? '',
    ownership: goal && goal.ownerId !== null ? 'personal' : 'shared',
    isPrivate: goal?.visibility === 'private',
  };
}

export function GoalFormDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit mode. */
  goal?: GoalResponse;
}) {
  const { data: me } = useMe();
  const create = useCreateGoal();
  const update = useUpdateGoal(props.goal?.id ?? '');
  const isPending = create.isPending || update.isPending;
  const isEdit = props.goal !== undefined;

  const form = useForm<GoalFormValues>({
    resolver: zodResolver(goalFormSchema),
    defaultValues: toDefaults(props.goal),
  });

  useEffect(() => {
    if (props.open) form.reset(toDefaults(props.goal));
  }, [props.open, props.goal, form]);

  const ownership = form.watch('ownership');
  const color = form.watch('color');
  const icon = form.watch('icon');
  const amountInput = form.watch('targetAmount');

  const onSubmit = form.handleSubmit((values) => {
    const parsed = parsePositiveAmount(values.targetAmount);
    if (!parsed.ok) return;

    const description = values.description.trim();
    const personal = values.ownership === 'personal';
    const base = {
      title: values.title.trim(),
      description: description.length > 0 ? description : null,
      targetAmount: parsed.minorUnits,
      currency: me?.family.currency ?? 'RUB',
      deadline: values.deadline === '' ? null : values.deadline,
      color: values.color,
      icon: values.icon === '' ? null : values.icon,
      visibility: personal && values.isPrivate ? ('private' as const) : ('household' as const),
      // `null` means a shared family goal; a personal one belongs to its author.
      ownerId: personal ? (props.goal?.ownerId ?? me?.user.id ?? null) : null,
    };

    const close = {
      onSuccess: () => {
        props.onOpenChange(false);
      },
    };

    if (props.goal) {
      const body: UpdateGoal = updateGoalSchema.parse(base);
      update.mutate(body, close);
    } else {
      const body: CreateGoal = createGoalSchema.parse(base);
      create.mutate(body, close);
    }
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? GOALS_RU.editGoalTitle : GOALS_RU.newGoalTitle}</DialogTitle>
          <DialogDescription>{GOALS_RU.subtitle}</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="goal-title">{GOALS_RU.formName}</Label>
            <Input
              id="goal-title"
              className="h-12 text-base md:text-sm"
              placeholder={GOALS_RU.formNamePlaceholder}
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
            <Label htmlFor="goal-target">{GOALS_RU.formTarget}</Label>
            <MoneyInput
              id="goal-target"
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

          <div className="space-y-2">
            <Label htmlFor="goal-description">{GOALS_RU.formDescription}</Label>
            <Textarea
              id="goal-description"
              rows={3}
              className="text-base md:text-sm"
              placeholder={GOALS_RU.formDescriptionPlaceholder}
              {...form.register('description')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal-deadline">{GOALS_RU.formDeadline}</Label>
            <Input
              id="goal-deadline"
              type="date"
              className="h-12 text-base md:text-sm"
              aria-invalid={Boolean(form.formState.errors.deadline)}
              {...form.register('deadline')}
            />
            <p className="text-xs text-muted-foreground">{GOALS_RU.formDeadlineHint}</p>
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{GOALS_RU.formColor}</legend>
            <div className="flex flex-wrap gap-2">
              {GOAL_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={swatch}
                  aria-pressed={color === swatch}
                  onClick={() => {
                    form.setValue('color', swatch, { shouldDirty: true });
                  }}
                  className={cn(
                    'size-11 rounded-full border-2 transition-transform',
                    color === swatch
                      ? 'scale-110 border-foreground'
                      : 'border-transparent hover:scale-105',
                  )}
                  style={{ backgroundColor: swatch }}
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{GOALS_RU.formIcon}</legend>
            <div className="flex flex-wrap gap-2">
              {GOAL_ICONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  aria-pressed={icon === emoji}
                  onClick={() => {
                    form.setValue('icon', icon === emoji ? '' : emoji, { shouldDirty: true });
                  }}
                  className={cn(
                    'flex size-11 items-center justify-center rounded-xl border text-xl transition-colors',
                    icon === emoji ? 'border-primary bg-primary/10' : 'hover:bg-accent',
                  )}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">{GOALS_RU.formKind}</legend>
            <RadioGroup
              value={ownership}
              onValueChange={(value) => {
                form.setValue('ownership', value === 'personal' ? 'personal' : 'shared', {
                  shouldDirty: true,
                });
              }}
              className="gap-2"
            >
              <Label
                htmlFor="goal-kind-shared"
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem value="shared" id="goal-kind-shared" />
                {GOALS_RU.formKindShared}
              </Label>
              <Label
                htmlFor="goal-kind-personal"
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem value="personal" id="goal-kind-personal" />
                {GOALS_RU.formKindPersonal}
              </Label>
            </RadioGroup>

            {ownership === 'personal' ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
                <Label htmlFor="goal-private" className="font-normal">
                  {GOALS_RU.formPrivate}
                  <span className="block text-xs text-muted-foreground">
                    {GOALS_RU.formPrivateHint}
                  </span>
                </Label>
                <Switch
                  id="goal-private"
                  checked={form.watch('isPrivate')}
                  onCheckedChange={(checked) => {
                    form.setValue('isPrivate', checked, { shouldDirty: true });
                  }}
                />
              </div>
            ) : null}
          </fieldset>

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
              {isEdit ? COMMON.save : COMMON.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
