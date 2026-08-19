import { forwardRef } from 'react';
import { formatMoney } from '@/shared/lib/format';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { cn } from '@/shared/lib/utils';
import { GOALS_RU } from '../locale';
import { formatMinorUnitsForInput, parseAmount } from '../money';

/**
 * Amount field.
 *
 * Text, never `type="number"`: a numeric input rejects the comma most Russian
 * keyboards produce, hides the typed value from us on invalid states and adds
 * spinners nobody wants on a phone. `inputMode="decimal"` still brings up the
 * numeric keypad on iOS, and `text-base` keeps the font at 16 px so iOS does
 * not zoom the viewport on focus.
 *
 * The value stays a **string** all the way to submit; `parseAmount` turns it
 * into integer minor units at exactly one place per form (D6).
 */
export const MoneyInput = forwardRef<
  HTMLInputElement,
  {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    onBlur?: () => void;
    placeholder?: string;
    disabled?: boolean;
    invalid?: boolean;
    /** Chips like «+1 000», in minor units. */
    quickAmounts?: number[];
    className?: string;
    'aria-describedby'?: string;
  }
>(function MoneyInput(props, ref) {
  const parsed = parseAmount(props.value);
  const preview = parsed.ok && parsed.minorUnits !== 0 ? formatMoney(parsed.minorUnits) : null;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Input
          id={props.id}
          ref={ref}
          type="text"
          // Numeric keypad with a decimal separator, no spinners, no locale fight.
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          value={props.value}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
          {...(props.onBlur ? { onBlur: props.onBlur } : {})}
          placeholder={props.placeholder ?? GOALS_RU.amountPlaceholder}
          disabled={props.disabled ?? false}
          aria-invalid={props.invalid ?? false}
          {...(props['aria-describedby'] ? { 'aria-describedby': props['aria-describedby'] } : {})}
          className={cn('h-12 pr-10 text-base tabular-nums md:text-base', props.className)}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground"
        >
          ₽
        </span>
      </div>

      {props.quickAmounts && props.quickAmounts.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {props.quickAmounts.map((amount) => (
            <Button
              key={amount}
              type="button"
              variant="secondary"
              size="sm"
              className="h-11 min-w-11 rounded-full px-4 text-sm"
              disabled={props.disabled ?? false}
              onClick={() => {
                const current = parseAmount(props.value);
                const base = current.ok ? current.minorUnits : 0;
                props.onChange(formatMinorUnitsForInput(base + amount));
              }}
            >
              +{formatMoney(amount, { withoutCurrency: true })}
            </Button>
          ))}
        </div>
      ) : null}

      {preview ? (
        <p className="text-xs text-muted-foreground" data-testid="money-input-preview">
          {preview}
        </p>
      ) : null}
    </div>
  );
});
