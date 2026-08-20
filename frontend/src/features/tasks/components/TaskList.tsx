import type { PublicUser } from '@family/shared';
import { Section, SectionStack } from '@/shared/ui/section';
import { GROUP_ORDER, type GroupId, type TaskGroups } from '../grouping';
import { TASKS_RU } from '../locale';
import { TaskCard } from './TaskCard';

/**
 * The list, grouped by what the user has to decide about each row rather than
 * by date: «просрочено» is a different kind of thing from «на неделе» even when
 * both are Tuesday.
 *
 * Each group is a `Section` — a quiet uppercase label with the count beside it,
 * outside a single surface of hairline-separated rows. The per-group hint
 * paragraph that used to sit under every heading («Ближайшие семь дней.»,
 * «Дела на сегодня.») is gone: six groups × one explanatory line is ~120px
 * telling the reader what the word above it already said, and §A3's rule is
 * that chrome must not repeat.
 *
 * «Выполнено» and «Пропущено» get the calm sage ground — a finished group is
 * visibly finished, and it stops the eye before it wastes a scan on history.
 */
export function TaskList(props: { groups: TaskGroups; members: readonly PublicUser[] }) {
  const visible = GROUP_ORDER.filter((group) => props.groups[group].length > 0);

  return (
    <SectionStack>
      {visible.map((group) => (
        <Section
          key={group}
          label={TASKS_RU.groups[group]}
          count={props.groups[group].length}
          surface={isClosedGroup(group) ? 'calm' : 'card'}
        >
          {props.groups[group].map((occurrence) => (
            <TaskCard key={occurrence.id} occurrence={occurrence} members={props.members} />
          ))}
        </Section>
      ))}
    </SectionStack>
  );
}

function isClosedGroup(group: GroupId): boolean {
  return group === 'done' || group === 'skipped';
}
