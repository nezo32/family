import { cn } from '@/shared/lib/utils';

/**
 * One row, one decision — the inline picker for the handful of choices a family
 * makes every day (design §E, §F5).
 *
 * ## Why this replaces the 2-column chip grid
 *
 * The create forms shipped **five** `grid-cols-2` chip grids between them. A
 * two-column grid of variable-length Russian labels produces ragged rows:
 * «Никто — возьмёт любой» is two lines tall next to a one-line «Павел», and
 * «Последний день месяца» wraps while «Ежедневно» does not. Fifteen pills of
 * unequal height read as an undifferentiated field with no signal about which
 * of them the user actually has to answer.
 *
 * So the rule is deliberately narrow, and it is enforced by the type rather
 * than by a comment: **at most four options, always on one row, never
 * wrapping.** A set that does not fit that is not a segmented control — it is a
 * list of radio rows in a sheet (`OptionSheet`), reached from a `ValueRow`.
 *
 * ## Sizing
 *
 * 44px tall (§F1 tap target) inside a `--muted` track, the selected segment on
 * `--card` — the iOS/Android convention, and the only presentation where four
 * equal segments cannot be mistaken for four independent buttons. Labels
 * truncate rather than wrap: a clipped label in a row of four still tells you
 * where you are, a wrapped one silently makes the control 72px tall.
 */

export interface Segment<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>(props: {
  /** Accessible name of the group. Rendered visually only when `showLabel`. */
  label: string;
  showLabel?: boolean;
  value: T | null;
  /** Two to four. More than four does not fit 320px and belongs in a sheet. */
  options: readonly Segment<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2', props.className)}>
      {props.showLabel ? (
        <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
          {props.label}
        </span>
      ) : null}
      <div
        role="radiogroup"
        aria-label={props.label}
        data-slot="segmented-control"
        // `grid-flow-col auto-cols-fr` — equal columns that cannot wrap however
        // long a label is, which `flex-wrap` and `grid-cols-2` both fail at.
        className="grid h-11 w-full max-w-row-measure grid-flow-col auto-cols-fr gap-1 rounded-lg bg-muted p-1"
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
                'flex min-w-0 items-center justify-center rounded-md px-2 text-[15px] leading-[22px] transition-colors',
                'touch-manipulation no-callout',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                'disabled:pointer-events-none disabled:opacity-50',
                selected
                  ? 'bg-card font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0_/_0.08)]'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
