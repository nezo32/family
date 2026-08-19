import type { ActivityItem } from '@family/shared';
import { UserAvatar } from '@/shared/components';
import { relativeTime } from '@/shared/lib/i18n';
import type { Roster } from '../hooks';

/**
 * One line of "who did what".
 *
 * `summary` is a **pre-rendered Russian sentence** frozen at write time
 * («Папа выполнил задачу „Вынести мусор"»). It is rendered verbatim: it has to
 * stay readable after the referenced task is renamed or deleted, and
 * re-composing it here would couple the wall to every other module's wording.
 * `entityType` / `entityId` are for the link, nothing else.
 *
 * Visually this is the quiet layer of the feed — no card, no border, muted
 * type — so an announcement never has to compete with it.
 */
export function ActivityRow(props: { activity: ActivityItem; roster: Roster }) {
  const { activity } = props;
  const actor = activity.actorId ? props.roster.byId.get(activity.actorId) : undefined;

  return (
    <div className="flex min-w-0 items-start gap-2.5 px-1 py-2">
      <UserAvatar
        user={{
          ...(activity.actorId ? { id: activity.actorId } : {}),
          displayName: props.roster.nameOf(activity.actorId),
          avatarUrl: actor?.avatarUrl ?? null,
        }}
        size="xs"
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="wrap-break-word text-sm text-muted-foreground">{activity.summary}</p>
        <time dateTime={activity.createdAt} className="text-xs text-muted-foreground/80">
          {relativeTime(activity.createdAt)}
        </time>
      </div>
    </div>
  );
}
