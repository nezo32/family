import { cn } from '@/shared/lib/utils';

/**
 * Single-choice picker built from real buttons rather than a `<select>`.
 *
 * Native selects and Radix popovers both put the choice behind an extra tap and
 * a floating layer; on a phone, five 44 px targets that are always visible are
 * faster and survive being used one-handed on a moving bus. Rendered as a
 * `radiogroup` so screen readers announce it as one choice, not five buttons.
 */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Second line, for choices whose consequences need spelling out. */
  hint?: string;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>(props: {
  label?: string;
  value: T | null;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  /** Stack vertically — use when the options carry hints. */
  stacked?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={props.className}>
      {props.label ? (
        <div className="mb-2 text-sm font-medium text-foreground">{props.label}</div>
      ) : null}
      <div
        role="radiogroup"
        aria-label={props.label}
        className={cn(
          'gap-2',
          props.stacked ? 'flex flex-col' : 'grid grid-cols-2 sm:grid-cols-3',
        )}
      >
        {props.options.map((option) => {
          const selected = option.value === props.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={props.disabled ?? option.disabled}
              onClick={() => {
                props.onChange(option.value);
              }}
              className={cn(
                'flex min-h-11 flex-col justify-center rounded-xl border px-3 py-2 text-left text-sm transition-colors',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                'disabled:pointer-events-none disabled:opacity-50',
                selected
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <span className={cn('font-medium', selected && 'text-foreground')}>
                {option.label}
              </span>
              {option.hint ? (
                <span className="mt-0.5 text-xs text-pretty text-muted-foreground">
                  {option.hint}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Multi-select chip, e.g. the weekday row of the weekly recurrence arm. */
export function ToggleChip(props: {
  pressed: boolean;
  label: string;
  ariaLabel?: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      aria-label={props.ariaLabel ?? props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        'inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border px-3 text-sm font-medium transition-colors',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-50',
        props.pressed
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        props.className,
      )}
    >
      {props.label}
    </button>
  );
}
