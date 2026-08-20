import type { PublicUser } from '@family/shared';
import { PLURALS, pluralize } from '@/shared/lib/i18n';
import { GROUP_ORDER, type GroupId, type TaskGroups } from '../grouping';
import { TASKS_RU } from '../locale';
import { TaskCard } from './TaskCard';

/**
 * The list, grouped by what the user has to decide about each row rather than
 * by date: "просрочено" is a different kind of thing from "на неделе" even when
 * both are Tuesday.
 */
export function TaskList(props: { groups: TaskGroups; members: readonly PublicUser[] }) {
  const visible = GROUP_ORDER.filter((group) => props.groups[group].length > 0);

  return (
    <div className="space-y-7">
      {visible.map((group) => (
        <TaskGroupSection
          key={group}
          group={group}
          occurrences={props.groups[group]}
          members={props.members}
        />
      ))}
    </div>
  );
}

function TaskGroupSection(props: {
  group: GroupId;
  occurrences: TaskGroups[GroupId];
  members: readonly PublicUser[];
}) {
  const headingId = `task-group-${props.group}`;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold tracking-wide text-foreground">
          {TASKS_RU.groups[props.group]}
        </h2>
        <span className="text-xs text-muted-foreground">
          {pluralize(props.occurrences.length, PLURALS.chore)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{TASKS_RU.groupHint[props.group]}</p>
      <ul className="grid gap-2">
        {props.occurrences.map((occurrence) => (
          <TaskCard key={occurrence.id} occurrence={occurrence} members={props.members} />
        ))}
      </ul>
    </section>
  );
}
