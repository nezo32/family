import { Minus, Plus } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { FAMILY_RU } from '../locale';
import { CHORE_WEIGHT_MAX, CHORE_WEIGHT_MIN, CHORE_WEIGHT_STEP, clampChoreWeight } from '../api';

/**
 * The rotation weight (D5): how big a share of the chores this member is
 * expected to carry. `0` means "temporarily excused" — exams, illness, a broken
 * arm — and is a first-class value, not a disabled state.
 *
 * Stepper rather than a number input on purpose: this is a phone-first screen,
 * a numeric keyboard for a value that only ever moves by 0.25 is friction, and
 * a free-text field invites `2,5` which the contract would reject.
 */
export function ChoreWeightControl(props: {
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
}) {
  const decrease = clampChoreWeight(props.value - CHORE_WEIGHT_STEP);
  const increase = clampChoreWeight(props.value + CHORE_WEIGHT_STEP);

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="icon-lg"
        className="size-11 shrink-0"
        aria-label={FAMILY_RU.sheetWeightDecrease}
        disabled={props.disabled || props.value <= CHORE_WEIGHT_MIN}
        onClick={() => {
          props.onChange(decrease);
        }}
      >
        <Minus />
      </Button>

      <output className="min-w-14 text-center text-base font-semibold tabular-nums text-foreground">
        {props.value.toFixed(2)}
      </output>

      <Button
        type="button"
        variant="outline"
        size="icon-lg"
        className="size-11 shrink-0"
        aria-label={FAMILY_RU.sheetWeightIncrease}
        disabled={props.disabled || props.value >= CHORE_WEIGHT_MAX}
        onClick={() => {
          props.onChange(increase);
        }}
      >
        <Plus />
      </Button>
    </div>
  );
}
