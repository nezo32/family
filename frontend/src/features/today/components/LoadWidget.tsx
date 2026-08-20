import { Gauge } from 'lucide-react';
import { TODAY_RU, choreCount, eventCount, taskCount } from '../locale';
import type { DashboardFairness, WeekResponse } from '../types';
import { WidgetCard } from './WidgetCard';

/**
 * «Ваша неделя» — my own share of the week, from D5.
 *
 * Deliberately absent: a rank, a medal, a score, another member's numbers next
 * to mine. The bar is my share of the family's week against the whole; the
 * server sends a neutral Russian `note` alongside it (the contract guarantees
 * it is never comparative), and that sentence is the only interpretation shown.
 *
 * There was a «баллы» tile in the middle of the row below until the score
 * system was removed — a number that follows a person around and grows when
 * they do chores is the sibling scoreboard D5 rules out, whatever it is
 * labelled.
 *
 * The second line is the week *ahead*, from `GET /dashboard/week` — it answers
 * "is tomorrow going to be busy" without leaving the home screen.
 */
export function LoadWidget(props: {
  fairness: DashboardFairness;
  week?: WeekResponse | undefined;
}) {
  const me = props.fairness.me;
  const share = Math.max(0, Math.min(100, me.sharePercent));
  const ahead = props.week?.totals;

  return (
    <WidgetCard title={TODAY_RU.loadTitle} icon={Gauge} tone="quiet">
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-secondary"
        role="img"
        aria-label={`${choreCount(me.doneCount)} ${TODAY_RU.loadDone}, ${String(share)} % ${TODAY_RU.loadShare}`}
      >
        <span className="bg-primary" style={{ width: `${String(share)}%` }} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-center">
        <Stat value={String(me.doneCount)} label={TODAY_RU.loadDone} />
        <Stat value={`${String(share)} %`} label={TODAY_RU.loadShare} />
      </dl>

      {props.fairness.note ? (
        // Family-specific copy composed server-side; the contract defines it as
        // a neutral Russian sentence, never a ranking.
        <p className="pt-3 text-xs text-muted-foreground">{props.fairness.note}</p>
      ) : null}

      {ahead && ahead.tasks + ahead.events > 0 ? (
        <p className="pt-2 text-xs text-muted-foreground">
          {TODAY_RU.weekAhead}: {taskCount(ahead.tasks)} · {eventCount(ahead.events)}
        </p>
      ) : null}
    </WidgetCard>
  );
}

function Stat(props: { value: string; label: string }) {
  return (
    <div className="rounded-lg bg-background/60 py-2">
      <dt className="sr-only">{props.label}</dt>
      <dd className="text-base font-semibold tabular-nums text-foreground">{props.value}</dd>
      <p className="text-[11px] leading-tight text-muted-foreground">{props.label}</p>
    </div>
  );
}
