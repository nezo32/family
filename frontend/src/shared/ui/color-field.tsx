import { useId } from 'react';
import { CheckIcon } from 'lucide-react';

import { cn } from '@/shared/lib/utils';

/**
 * The palette every colour choice in the app picks from.
 *
 * The contract stores `#RRGGBB`, so the theme's OKLCH tokens are inlined as
 * literal hex — a member's colour is stored data, not a CSS variable, and it has
 * to survive a theme edit unchanged.
 *
 * The first five **are** `--chart-1…5` from `src/index.css` (clay, sage, honey,
 * plum, sky); the last three extend the same ramp — same lightness band, same
 * chroma band, three unused hues. Goals already picked from this list; the
 * profile picked from the OS colour wheel, which is how a member ended up with
 * a `#2563eb` that belongs to no palette in this product.
 */
export const PALETTE_COLORS = [
  '#DA6635', // --chart-1  clay
  '#43996C', // --chart-2  sage
  '#E3AD3E', // --chart-3  honey
  '#9F599D', // --chart-4  plum
  '#3B9AC5', // --chart-5  sky
  '#C1555D', // brick
  '#6179BD', // indigo
  '#259B9C', // teal
] as const;

/** Screen-reader names — «#DA6635» is not something anybody can hear. */
const COLOR_NAMES_RU: Record<string, string> = {
  '#DA6635': 'терракотовый',
  '#43996C': 'зелёный',
  '#E3AD3E': 'медовый',
  '#9F599D': 'сливовый',
  '#3B9AC5': 'голубой',
  '#C1555D': 'кирпичный',
  '#6179BD': 'индиго',
  '#259B9C': 'бирюзовый',
};

export const COLOR_FIELD_RU = {
  current: 'текущий цвет',
};

/**
 * A swatch picker, replacing `<input type="color">`.
 *
 * The native control was never a fit: iOS renders it as a squat well that
 * clipped its own `#2563e` label, needed the hex repeated as text beside it to
 * be readable at all, and opened an OS colour wheel from which a family member
 * could pick a colour that clashes with every surface in the app. A fixed ramp
 * is both prettier and one less way to get an unreadable calendar chip.
 *
 * Built on real `<input type="radio">`s: arrow-key navigation, `Space` to
 * choose and correct group semantics all come from the platform, and each
 * swatch is a 44px tap target.
 */
export function ColorField(props: {
  /** `#RRGGBB`. A value outside the palette is kept and shown as an extra swatch. */
  value: string;
  onChange: (value: string) => void;
  /** Group label for assistive tech. */
  label: string;
  /** Radio group name; generated when omitted. */
  name?: string;
  disabled?: boolean;
  className?: string;
}) {
  const generatedName = useId();
  const name = props.name ?? generatedName;

  const normalized = props.value.toUpperCase();
  const swatches: readonly string[] = PALETTE_COLORS.some(
    (color) => color.toUpperCase() === normalized,
  )
    ? PALETTE_COLORS
    : [...PALETTE_COLORS, props.value];

  return (
    <div
      role="group"
      aria-label={props.label}
      data-slot="color-field"
      className={cn('flex flex-wrap gap-2', props.className)}
    >
      {swatches.map((swatch) => {
        const selected = swatch.toUpperCase() === normalized;
        const title = COLOR_NAMES_RU[swatch.toUpperCase()] ?? `${COLOR_FIELD_RU.current} ${swatch}`;
        return (
          <label key={swatch} className="cursor-pointer">
            <input
              type="radio"
              name={name}
              value={swatch}
              checked={selected}
              disabled={props.disabled}
              className="peer sr-only"
              onChange={() => {
                props.onChange(swatch);
              }}
            />
            <span className="sr-only">{title}</span>
            <span
              aria-hidden
              style={{ backgroundColor: swatch }}
              className={cn(
                'flex size-11 items-center justify-center rounded-full border-2 border-transparent',
                'ring-offset-2 ring-offset-background transition-transform',
                'peer-checked:scale-110 peer-checked:border-foreground',
                'peer-focus-visible:ring-2 peer-focus-visible:ring-ring',
                'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
              )}
            >
              {selected ? (
                <CheckIcon className="size-5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]" />
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
