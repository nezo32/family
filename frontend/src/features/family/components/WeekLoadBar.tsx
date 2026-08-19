import type { FairnessMember } from '@family/shared';
import { cn } from '@/shared/lib/utils';
import { FAMILY_RU, choreCount, pointCount } from '../locale';

/**
 * «Нагрузка за неделю» — the neutral load bar from **D5**.
 *
 * What this component deliberately is **not**: a ranking. It never receives the
 * other members' numbers, never sorts anything, and shows no position, medal or
 * comparison. Each member is measured against *their own* fair share — the tick
 * mark on the track — which is derived from their rotation weight. Two children
 * with different weights can both sit exactly on their mark, and that is the
 * point: the honest question is "am I carrying my share", not "did I beat my
 * brother". A sibling leaderboard produces arguments, not clean rooms.
 *
 * The bar is `role="img"` with a full sentence in `aria-label`: a screen reader
 * would otherwise read out nothing at all, and the numbers underneath are the
 * whole content.
 */
export function WeekLoadBar(props: {
  load: FairnessMember | undefined;
  className?: string;
}) {
  const { load } = props;

  if (!load) {
    return (
      <p className={cn('text-xs text-muted-foreground', props.className)}>
        {FAMILY_RU.loadUnavailable}
      </p>
    );
  }

  const total = load.completed + load.committed;
  if (total === 0) {
    return (
      <p className={cn('text-xs text-muted-foreground', props.className)}>{FAMILY_RU.loadEmpty}</p>
    );
  }

  // Both shares are 0..1 fractions of the family's week. The track is scaled so
  // a member sitting exactly on their fair share fills two thirds of it — a
  // full bar would read as "maxed out" and a half-empty one as "slacking", and
  // neither is a judgement this screen is entitled to make.
  const fairShare = load.fairShare > 0 ? load.fairShare : 0.5;
  const scale = Math.max(fairShare * 1.5, load.actualShare, 0.01);
  const filled = clampPercent((load.actualShare / scale) * 100);
  const mark = clampPercent((fairShare / scale) * 100);

  const label = `${FAMILY_RU.loadBarLabel}: ${percentText(load.actualShare)}, ${FAMILY_RU.loadShareLabel} ${percentText(fairShare)}`;

  return (
    <div className={cn('space-y-1.5', props.className)}>
      <div
        role="img"
        aria-label={label}
        className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary/70 transition-[width]"
          style={{ width: `${String(filled)}%` }}
        />
        <span
          aria-hidden
          className="absolute inset-y-0 w-0.5 rounded-full bg-foreground/40"
          style={{ left: `${String(mark)}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {choreCount(load.completed)} {FAMILY_RU.loadDone} · {String(load.committed)}{' '}
        {FAMILY_RU.loadPlanned} · {pointCount(load.earned)}
      </p>
    </div>
  );
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function percentText(share: number): string {
  return `${String(Math.round(share * 100))}%`;
}
