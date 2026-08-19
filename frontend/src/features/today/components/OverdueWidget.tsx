import { AlarmClock } from 'lucide-react';
import type { TaskOccurrenceResponse } from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { ROUTES } from '@/shared/lib/routes';
import { TODAY_RU, taskCount } from '../locale';
import { TaskRow } from './TaskRow';
import { WidgetCard } from './WidgetCard';

/** How many overdue rows fit before the card stops being glanceable. */
const VISIBLE = 4;

/**
 * Anything past its due time, first on the screen.
 *
 * Urgent, never shaming (D5's framing rule applied to copy): the card says
 * «Требует внимания» and offers the tick, it does not count failures and it
 * does not name who dropped the ball.
 */
export function OverdueWidget(props: {
  items: TaskOccurrenceResponse[];
  onComplete: (occurrenceId: string) => void;
}) {
  const { can } = useCan();
  if (props.items.length === 0) return null;

  const shown = props.items.slice(0, VISIBLE);
  const rest = props.items.length - shown.length;

  return (
    <WidgetCard
      title={TODAY_RU.overdueTitle}
      icon={AlarmClock}
      tone="urgent"
      meta={taskCount(props.items.length)}
      linkTo={ROUTES.tasks}
      linkLabel={TODAY_RU.tasksAll}
    >
      <p className="pb-2 text-xs text-muted-foreground">{TODAY_RU.overdueHint}</p>
      <ul className="divide-y divide-border/60">
        {shown.map((occurrence) => (
          <TaskRow
            key={occurrence.id}
            occurrence={occurrence}
            overdue
            canComplete={can('task:complete', occurrence)}
            onComplete={props.onComplete}
          />
        ))}
      </ul>
      {rest > 0 ? (
        <p className="pt-2 text-xs text-muted-foreground">+ {taskCount(rest)}</p>
      ) : null}
    </WidgetCard>
  );
}
