import { Gauge } from 'lucide-react';
import { TODAY_RU, choreCount, pointWord } from '../locale';
import type { DashboardWeekResponse } from '../types';
import { WidgetCard } from './WidgetCard';

/**
 * "Ваша неделя" — the neutral load bar from D5.
 *
 * Deliberately absent: any other member's numbers, a rank, a streak badge, a
 * colour that says "too little". The bar compares me to **my own** fair share,
 * because the fix for an unfair week is a family conversation, not a
 * leaderboard between siblings.
 */
export function LoadWidget(props: { week: DashboardWeekResponse }) {
  const load = props.week.load;

  if (!load) {
    return (
      <WidgetCard title={TODAY_RU.loadTitle} icon={Gauge} tone="quiet">
        <p className="py-2 text-sm text-muted-foreground">{TODAY_RU.loadEmpty}</p>
      </WidgetCard>
    );
  }

  const total = load.completed + load.committed;
  const donePercent = total > 0 ? Math.round((load.completed / total) * 100) : 0;
  const fairPercent = Math.max(0, Math.min(100, Math.round(load.fairShare * 100)));
  const sharePercent = Math.max(0, Math.min(100, Math.round(load.actualShare * 100)));

  return (
    <WidgetCard title={TODAY_RU.loadTitle} icon={Gauge} tone="quiet">
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-secondary"
        role="img"
        aria-label={`${choreCount(load.completed)} ${TODAY_RU.loadDone}, ${choreCount(
          load.committed,
        )} ${TODAY_RU.loadPlanned}`}
      >
        <span className="bg-primary" style={{ width: `${String(donePercent)}%` }} />
        <span className="bg-primary/30" style={{ width: `${String(100 - donePercent)}%` }} />
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Stat value={String(load.completed)} label={TODAY_RU.loadDone} />
        <Stat value={String(load.committed)} label={TODAY_RU.loadPlanned} />
        <Stat value={String(load.earned)} label={pointWord(load.earned)} />
      </dl>

      {props.week.familyTotal > 0 ? (
        <p className="pt-3 text-xs text-muted-foreground">
          {TODAY_RU.loadFairShare} — {String(sharePercent)} %, {TODAY_RU.loadExpected}{' '}
          {String(fairPercent)} %
        </p>
      ) : null}
    </WidgetCard>
  );
}

function Stat(props: { value: string; label: string }) {
  return (
    <div className="rounded-lg bg-background/60 py-2">
      <dt className="sr-only">{props.label}</dt>
      <dd className="text-base font-semibold text-foreground tabular-nums">{props.value}</dd>
      <p className="text-[11px] leading-tight text-muted-foreground">{props.label}</p>
    </div>
  );
}
