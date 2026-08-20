import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CalendarDays, EyeOff, FileText, Palette, Smile, Users } from 'lucide-react';
import {
  createGoalSchema,
  updateGoalSchema,
  type CreateGoal,
  type GoalResponse,
  type UpdateGoal,
} from '@family/shared';
import { FormSheet } from '@/shared/ui/form-sheet';
import { OptionList, OptionRow, PickerSheet, TextSheet } from '@/shared/ui/option-sheet';
import { Section, SectionStack } from '@/shared/ui/section';
import { ValueRow } from '@/shared/ui/value-row';
import { ColorField, PALETTE_COLORS } from '@/shared/ui/color-field';
import { DateSheet, relativeDateLabel } from '@/shared/ui/when-sheet';
import { Switch } from '@/shared/ui/switch';
import { useMe } from '@/shared/auth/use-me';
import { todayDateKey } from '@/shared/lib/datetime';
import { displayEmoji } from '@/shared/lib/emoji';
import { cn } from '@/shared/lib/utils';
import { GOALS_RU, MONEY_ERROR_RU } from '../locale';
import { formatMinorUnitsForInput, parsePositiveAmount } from '../money';
import { useCreateGoal, useUpdateGoal } from '../hooks';
import { MoneyInput } from './MoneyInput';

/**
 * «Новая копилка» / «Изменить копилку» (design §F3–F5).
 *
 * ## What it was
 *
 * 358 × **1034** px on an 844px phone with «Создать» at y≈958 — below the fold,
 * like the other two. Eight labelled blocks of equal weight, of which exactly
 * two are load-bearing: what you are saving for, and how much.
 *
 * ## What it is
 *
 * Title and amount sit alone at the top, because a copilka without either is
 * not a copilka. Everything else — срок, цвет, значок, кому принадлежит,
 * описание — is a `ValueRow` under «Подробнее» that states its own value and
 * opens a sheet. «Создать» never leaves the header.
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
 * The palette moved to `shared/ui/color-field.tsx` when the profile screen
 * stopped using an OS colour wheel: goals and members now pick from the same
 * eight colours, which is the only way a member's chip and a goal's ring can be
 * guaranteed to belong to one product. The name stays so no call site moved.
 */
export const GOAL_COLORS = PALETTE_COLORS;

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

type SheetKey = 'deadline' | 'color' | 'icon' | 'ownership' | 'description';

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
  const formId = useId();

  const [openSheet, setOpenSheet] = useState<SheetKey | null>(null);

  const form = useForm<GoalFormValues>({
    resolver: zodResolver(goalFormSchema),
    defaultValues: toDefaults(props.goal),
  });

  /**
   * Re-seed on open — and **only** on open.
   *
   * ## Why the dependency is `props.goal?.id` and not `props.goal`
   *
   * `goal` is a TanStack query result. Structural sharing keeps its identity
   * stable while the server data is unchanged, so an idle refetch is invisible
   * here — which is exactly what makes the object-identity dependency look
   * safe. It is not. The moment another family member actually changes the
   * goal (a contribution lands, someone renames it), the refetch hands back a
   * **new object**, this effect fires mid-edit, and `form.reset` silently
   * discards the title being typed and the icon just chosen. Reproduced by
   * bumping `currentAmount` on the next `GET /api/goals/:id`: the typed title
   * reverted to «Отпуск на море» and the pressed icon un-pressed.
   *
   * A family app hits concurrent edits by construction. So the dependency is
   * the *identity of the thing being edited* — its id — and the object is read
   * through a ref, which cannot go stale because it is written on every render.
   * The same bug was fixed once already in the shopping dialogs; the test in
   * `goals.test.tsx` exists so there is no third time.
   *
   * ## Why the draft ref
   *
   * `FormSheet` is a *child*, so its draft-restore effect runs before this one
   * on the same commit (React flushes effects bottom-up). Without the guard, a
   * draft that survived an iOS background kill would be read, applied, and
   * overwritten by these defaults inside one render.
   */
  const goalRef = useRef(props.goal);
  goalRef.current = props.goal;
  const restoredDraft = useRef(false);
  useEffect(() => {
    if (!props.open) {
      restoredDraft.current = false;
      setOpenSheet(null);
      return;
    }
    if (restoredDraft.current) return;
    form.reset(toDefaults(goalRef.current));
    // `form` is stable; the goal is read through a ref, deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.goal?.id]);

  const title = form.watch('title');
  const ownership = form.watch('ownership');
  const color = form.watch('color');
  const icon = form.watch('icon');
  const amountInput = form.watch('targetAmount');
  const deadline = form.watch('deadline');
  const description = form.watch('description');
  const isPrivate = form.watch('isPrivate');

  const onSubmit = form.handleSubmit((values) => {
    const parsed = parsePositiveAmount(values.targetAmount);
    if (!parsed.ok) return;

    const trimmedDescription = values.description.trim();
    const personal = values.ownership === 'personal';
    const base = {
      title: values.title.trim(),
      description: trimmedDescription.length > 0 ? trimmedDescription : null,
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
    <FormSheet<GoalFormValues>
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={isEdit ? GOALS_RU.editGoalTitle : GOALS_RU.newGoalTitle}
      description={GOALS_RU.subtitle}
      submitLabel={isEdit ? GOALS_RU.formSubmitEdit : GOALS_RU.formSubmitCreate}
      formId={formId}
      submitDisabled={title.trim().length === 0}
      submitting={isPending}
      dirty={form.formState.isDirty}
      draft={{
        key: `family:goal-draft:${props.goal?.id ?? 'new'}`,
        read: () => form.getValues(),
        restore: (value) => {
          restoredDraft.current = true;
          form.reset(value, { keepDefaultValues: true });
        },
        enabled: !isPending,
      }}
    >
      <form id={formId} onSubmit={onSubmit} noValidate>
        <SectionStack className="gap-6 pt-2">
          <Section surface="card">
            {/* Название first, autofocused: the keyboard is up when the sheet
                lands and one typed line is the whole common case. */}
            <div className="w-full max-w-row-measure px-4">
              <input
                autoFocus
                type="text"
                aria-label={GOALS_RU.formName}
                aria-invalid={Boolean(form.formState.errors.title)}
                autoComplete="off"
                placeholder={GOALS_RU.formNamePlaceholder}
                className={cn(
                  'h-14 w-full bg-transparent text-[17px] leading-6 outline-none',
                  'placeholder:text-muted-foreground',
                )}
                {...form.register('title')}
              />
            </div>

            {/* The amount stays inline: a copilka without a target is not a
                copilka, so it is the one optional-looking control that is not
                optional. */}
            <div className="flex w-full max-w-row-measure flex-col gap-2 px-4 py-3">
              <label
                htmlFor="goal-target"
                className="text-[13px] leading-[18px] font-medium text-muted-foreground"
              >
                {GOALS_RU.formTarget}
              </label>
              <MoneyInput
                id="goal-target"
                value={amountInput}
                onChange={(value) => {
                  form.setValue('targetAmount', value, {
                    shouldDirty: true,
                    shouldValidate: form.formState.isSubmitted,
                  });
                }}
                invalid={Boolean(form.formState.errors.targetAmount)}
              />
              {form.formState.errors.targetAmount ? (
                <p className="text-[13px] leading-[18px] font-medium text-destructive" role="alert">
                  {form.formState.errors.targetAmount.message}
                </p>
              ) : null}
            </div>
          </Section>

          {form.formState.errors.title ? (
            <p className="-mt-4 px-4 text-[13px] leading-[18px] text-destructive" role="alert">
              {GOALS_RU.errorTitleRequired}
            </p>
          ) : null}

          <Section label={GOALS_RU.formDetails} surface="card">
            <ValueRow
              icon={<CalendarDays />}
              label={GOALS_RU.formDeadline}
              value={
                deadline === ''
                  ? GOALS_RU.noDeadline
                  : relativeDateLabel(deadline, todayDateKey())
              }
              onClick={() => {
                setOpenSheet('deadline');
              }}
            />
            <ValueRow
              icon={<Palette />}
              label={GOALS_RU.formColor}
              value={
                <span
                  aria-hidden
                  className="block size-5 rounded-full border border-border"
                  style={{ backgroundColor: color }}
                />
              }
              onClick={() => {
                setOpenSheet('color');
              }}
            />
            <ValueRow
              icon={<Smile />}
              label={GOALS_RU.formIcon}
              value={icon === '' ? '' : <span className="text-[20px]">{icon}</span>}
              onClick={() => {
                setOpenSheet('icon');
              }}
            />
            <ValueRow
              icon={<Users />}
              label={GOALS_RU.formKind}
              value={ownership === 'personal' ? GOALS_RU.personalGoal : GOALS_RU.sharedGoal}
              onClick={() => {
                setOpenSheet('ownership');
              }}
            />
            {ownership === 'personal' ? (
              <ValueRow
                icon={<EyeOff />}
                label={GOALS_RU.formPrivate}
                hint={GOALS_RU.formPrivateHint}
                trailing={
                  <Switch
                    aria-label={GOALS_RU.formPrivate}
                    checked={isPrivate}
                    onCheckedChange={(checked) => {
                      form.setValue('isPrivate', checked, { shouldDirty: true });
                    }}
                  />
                }
              />
            ) : null}
            <ValueRow
              icon={<FileText />}
              label={GOALS_RU.formDescription}
              value={description}
              onClick={() => {
                setOpenSheet('description');
              }}
            />
          </Section>
        </SectionStack>
      </form>

      {/* ---- the sheets the rows open ------------------------------------ */}

      <DateSheet
        open={openSheet === 'deadline'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'deadline' : null);
        }}
        title={GOALS_RU.formDeadline}
        value={deadline}
        clearLabel={GOALS_RU.formDeadlineClear}
        onChange={(next) => {
          form.setValue('deadline', next, { shouldDirty: true });
        }}
      />

      <PickerSheet
        open={openSheet === 'color'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'color' : null);
        }}
        title={GOALS_RU.formColor}
      >
        <ColorField
          label={GOALS_RU.formColor}
          value={color}
          onChange={(next) => {
            form.setValue('color', next, { shouldDirty: true });
          }}
        />
      </PickerSheet>

      <PickerSheet
        open={openSheet === 'icon'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'icon' : null);
        }}
        title={GOALS_RU.formIcon}
      >
        <div role="group" aria-label={GOALS_RU.formIcon} className="flex flex-wrap gap-2">
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
                'flex size-12 items-center justify-center rounded-xl border text-xl transition-colors',
                icon === emoji ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
      </PickerSheet>

      <PickerSheet
        open={openSheet === 'ownership'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'ownership' : null);
        }}
        title={GOALS_RU.formKind}
      >
        <OptionList>
          <OptionRow
            label={GOALS_RU.sharedGoal}
            hint={GOALS_RU.formKindShared}
            selected={ownership === 'shared'}
            onSelect={() => {
              form.setValue('ownership', 'shared', { shouldDirty: true });
              setOpenSheet(null);
            }}
          />
          <OptionRow
            label={GOALS_RU.personalGoal}
            hint={GOALS_RU.formKindPersonal}
            selected={ownership === 'personal'}
            onSelect={() => {
              form.setValue('ownership', 'personal', { shouldDirty: true });
              setOpenSheet(null);
            }}
          />
        </OptionList>
      </PickerSheet>

      <TextSheet
        open={openSheet === 'description'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'description' : null);
        }}
        title={GOALS_RU.formDescription}
        placeholder={GOALS_RU.formDescriptionPlaceholder}
        maxLength={2000}
        multiline
        value={description}
        onChange={(next) => {
          form.setValue('description', next, { shouldDirty: true });
        }}
      />
    </FormSheet>
  );
}
