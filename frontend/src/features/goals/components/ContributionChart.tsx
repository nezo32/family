import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { GoalResponse, GoalTransactionResponse } from '@family/shared';
import { formatDateShort, formatMoney } from '@/shared/lib/format';
import { GOALS_RU } from '../locale';

/**
 * Contributions over time — the cumulative balance, not per-transaction bars.
 *
 * A savings goal is a story of a line going up; a bar per contribution hides
 * that behind noise. The target is drawn as a reference line so the gap between
 * "where we are" and "where we are going" is the most visible thing on the
 * chart.
 *
 * Every value on this chart is integer minor units; the division by 100 happens
 * only inside `formatMoney`, at render (D6).
 */
export function ContributionChart(props: {
  goal: GoalResponse;
  transactions: GoalTransactionResponse[];
}) {
  const data = useMemo(() => {
    const ascending = [...props.transactions].sort(
      (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
    );
    let running = 0;
    return ascending.map((transaction) => {
      running += transaction.delta;
      return { t: Date.parse(transaction.occurredAt), balance: running };
    });
  }, [props.transactions]);

  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">{GOALS_RU.chartEmpty}</p>;
  }

  const accent = props.goal.color ?? 'var(--chart-1)';
  const maxValue = Math.max(props.goal.targetAmount, ...data.map((point) => point.balance));

  return (
    <div className="h-48 w-full sm:h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="goal-balance-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity={0.35} />
              <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(value: number) => formatDateShort(value)}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            domain={[0, Math.ceil(maxValue * 1.05)]}
            tickFormatter={(value: number) =>
              formatMoney(Math.round(value), { withoutCurrency: true })
            }
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <Tooltip
            formatter={(value) => [formatMoney(Math.round(Number(value))), GOALS_RU.chartSaved]}
            labelFormatter={(label) => formatDateShort(Number(label))}
            contentStyle={{
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              fontSize: 12,
              color: 'var(--popover-foreground)',
            }}
          />
          <ReferenceLine
            y={props.goal.targetAmount}
            stroke="var(--muted-foreground)"
            strokeDasharray="4 4"
            label={{
              value: GOALS_RU.chartTarget,
              position: 'insideTopRight',
              fill: 'var(--muted-foreground)',
              fontSize: 11,
            }}
          />
          <Area
            type="monotone"
            dataKey="balance"
            stroke={accent}
            strokeWidth={2}
            fill="url(#goal-balance-fill)"
            dot={data.length < 20}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
