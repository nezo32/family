import { cn } from '@/shared/lib/utils';
import { ringPercent } from '../money';

/**
 * The progress ring — the reason this section exists.
 *
 * A savings goal is a motivational object, not a row in a report: the ring is
 * big, it fills clockwise from twelve o'clock, and it animates towards its
 * value so a fresh contribution is visibly *earned*. An over-funded goal keeps
 * its full ring and shows the real percentage (`112 %`) rather than lying about
 * being exactly full.
 *
 * `percent` is the uncapped server value; the fill is clamped separately.
 */
export function ProgressRing(props: {
  percent: number;
  /** Outer diameter in px. */
  size?: number;
  thickness?: number;
  /** `#RRGGBB` from the goal; falls back to the app's clay primary. */
  color?: string | null;
  /** Big number in the middle. Defaults to `NN %`. */
  label?: string;
  /** Small line under the number. */
  caption?: string;
  /** Dimmed ring for archived / cancelled goals. */
  muted?: boolean;
  className?: string;
}) {
  const size = props.size ?? 96;
  const thickness = props.thickness ?? 9;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = ringPercent(props.percent);
  const dash = (circumference * filled) / 100;
  const stroke = props.color ?? 'var(--primary)';
  const complete = props.percent >= 100;

  return (
    <div
      className={cn('relative shrink-0', props.className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${props.label ?? `${String(Math.round(props.percent))} %`}${
        props.caption ? `, ${props.caption}` : ''
      }`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${String(size)} ${String(size)}`} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          className={cn('stroke-muted', props.muted && 'opacity-60')}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          stroke={props.muted ? 'var(--muted-foreground)' : stroke}
          strokeDasharray={`${String(dash)} ${String(circumference - dash)}`}
          // Start at 12 o'clock instead of 3.
          transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}
          style={{ transition: 'stroke-dasharray 600ms cubic-bezier(0.22, 1, 0.36, 1)' }}
          opacity={filled === 0 ? 0 : 1}
        />
        {complete && !props.muted ? (
          // A second, softer ring just outside the track: the "you did it" halo.
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius + thickness / 2 + 2}
            fill="none"
            strokeWidth={2}
            stroke={stroke}
            opacity={0.35}
          />
        ) : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-center">
        <span
          className={cn(
            'font-semibold tabular-nums text-foreground',
            size >= 120 ? 'text-2xl' : 'text-base',
          )}
        >
          {props.label ?? `${String(Math.round(props.percent))} %`}
        </span>
        {props.caption ? (
          <span className="max-w-[80%] truncate text-[10px] leading-tight text-muted-foreground">
            {props.caption}
          </span>
        ) : null}
      </div>
    </div>
  );
}
