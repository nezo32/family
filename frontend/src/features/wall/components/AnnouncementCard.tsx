import { useState } from 'react';
import { MoreHorizontal, Pin, PinOff, Sparkles, Trash2 } from 'lucide-react';
import type { PostResponse } from '@family/shared';
import { Can, useCan } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { ConfirmDialog } from '@/shared/components';
import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { formatDateTime } from '@/shared/lib/format';
import { useDeletePost, useSetPin, type Roster } from '../hooks';
import { WALL_RU } from '../locale';
import { AuthorLine } from './AuthorLine';
import { ReactionBar } from './ReactionBar';
import { CommentThread } from './CommentThread';

/**
 * An announcement.
 *
 * The visual hierarchy of the wall lives here and in `ActivityRow`: a pinned
 * announcement from a parent gets a card, a clay accent and a full-size title;
 * «Лиза полила цветы» gets a one-line muted row with no card at all. If those
 * two ever start looking alike, the wall stops working as a wall.
 */
export function AnnouncementCard(props: {
  post: PostResponse;
  roster: Roster;
  /** Rendered in the pinned rail above the stream. */
  emphasised?: boolean;
}) {
  const { post } = props;
  const setPin = useSetPin();
  const remove = useDeletePost();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isSystem = post.type === 'system';

  return (
    <article
      className={cn(
        'rounded-xl border p-4 shadow-xs',
        props.emphasised
          ? 'border-primary/35 bg-primary/[0.06]'
          : isSystem
            ? 'border-border/70 bg-muted/40'
            : 'border-border bg-card',
      )}
    >
      <AuthorLine
        roster={props.roster}
        authorId={post.authorId}
        createdAt={post.createdAt}
        size={props.emphasised ? 'md' : 'sm'}
        trailing={
          <>
            {post.isPinned ? (
              <Badge variant="secondary" className="gap-1">
                <Pin className="size-3" aria-hidden />
                {WALL_RU.post.pinned}
              </Badge>
            ) : null}
            {isSystem ? (
              <Sparkles className="size-4 text-muted-foreground" aria-hidden />
            ) : null}
            <PostMenu
              post={post}
              onPin={(pinnedUntil) => {
                setPin.mutate({ id: post.id, pinnedUntil });
              }}
              onDelete={() => {
                setConfirmingDelete(true);
              }}
            />
          </>
        }
      />

      <div className="mt-3 space-y-1.5">
        {post.title ? (
          <h3
            className={cn(
              'wrap-break-word font-semibold text-foreground',
              props.emphasised ? 'text-lg' : 'text-base',
            )}
          >
            {post.title}
          </h3>
        ) : null}
        <p className="wrap-break-word text-sm whitespace-pre-wrap text-foreground/90">{post.body}</p>
        {post.isPinned && post.pinnedUntil ? (
          <p className="text-xs text-muted-foreground">
            {WALL_RU.post.pinnedUntil(formatDateTime(post.pinnedUntil))}
          </p>
        ) : null}
      </div>

      <div className="mt-3 space-y-1">
        <ReactionBar
          target={{ entityType: 'post', entityId: post.id }}
          reactions={post.reactions}
        />
        <CommentThread
          target={{ entityType: 'post', entityId: post.id }}
          commentCount={post.commentCount}
        />
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={WALL_RU.post.deleteConfirmTitle}
        description={WALL_RU.post.deleteConfirmDescription}
        onConfirm={() => {
          remove.mutate(post.id);
        }}
      />
    </article>
  );
}

/**
 * Pin / delete overflow.
 *
 * Both entries are permission-gated, and the whole trigger disappears when
 * neither is available — an overflow button that opens an empty menu is worse
 * than no button. Gating goes through `useCan()`; nothing here looks at a role.
 */
function PostMenu(props: {
  post: PostResponse;
  onPin: (pinnedUntil: string | null) => void;
  onDelete: () => void;
}) {
  const { can } = useCan();
  const mayPin = can('post:pin');
  const mayDelete = can('post:delete', props.post);
  if (!mayPin && !mayDelete) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 text-muted-foreground"
          aria-label={COMMON.more}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {mayPin ? (
          props.post.isPinned ? (
            <DropdownMenuItem
              onSelect={() => {
                props.onPin(null);
              }}
            >
              <PinOff className="size-4" aria-hidden />
              {WALL_RU.post.unpin}
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuLabel>{WALL_RU.post.pinFor}</DropdownMenuLabel>
              {PIN_DURATIONS.map((duration) => (
                <DropdownMenuItem
                  key={duration.days}
                  onSelect={() => {
                    props.onPin(isoInDays(duration.days));
                  }}
                >
                  <Pin className="size-4" aria-hidden />
                  {duration.label}
                </DropdownMenuItem>
              ))}
            </>
          )
        ) : null}
        {mayPin && mayDelete ? <DropdownMenuSeparator /> : null}
        <Can perm="post:delete" resource={props.post}>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              props.onDelete();
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            {WALL_RU.post.delete}
          </DropdownMenuItem>
        </Can>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Pinning expires by design (D-contract): «закреплено до» self-clears. */
const PIN_DURATIONS = [
  { days: 1, label: WALL_RU.post.pinDay },
  { days: 3, label: WALL_RU.post.pinThreeDays },
  { days: 7, label: WALL_RU.post.pinWeek },
] as const;

export function isoInDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
