import type { ReactNode } from 'react';
import { UserAvatar, type AvatarSize } from '@/shared/components';
import { cn } from '@/shared/lib/utils';
import { relativeTime } from '@/shared/lib/i18n';
import type { Roster } from '../hooks';

/**
 * Avatar + name + "3 минуты назад" for anything with an author.
 *
 * A `null` author means the app itself wrote the row (goal reached, birthday,
 * weekly digest), which reads as «Семейный бот» rather than as a missing name.
 */
export function AuthorLine(props: {
  roster: Roster;
  authorId: string | null;
  createdAt: string;
  size?: AvatarSize;
  /** Right-hand slot: badges, the overflow menu. */
  trailing?: ReactNode;
  className?: string;
}) {
  const name = props.roster.nameOf(props.authorId);
  const member = props.authorId ? props.roster.byId.get(props.authorId) : undefined;

  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', props.className)}>
      <UserAvatar
        user={{
          ...(props.authorId ? { id: props.authorId } : {}),
          displayName: name,
          avatarUrl: member?.avatarUrl ?? null,
        }}
        size={props.size ?? 'sm'}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{name}</div>
        <time
          dateTime={props.createdAt}
          className="block truncate text-xs text-muted-foreground"
          title={props.createdAt}
        >
          {relativeTime(props.createdAt)}
        </time>
      </div>
      {props.trailing ? <div className="flex shrink-0 items-center gap-1">{props.trailing}</div> : null}
    </div>
  );
}
