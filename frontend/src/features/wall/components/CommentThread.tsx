import { useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { CommentResponse, EntityRef } from '@family/shared';
import { Can } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/textarea';
import { InlineSpinner } from '@/shared/components';
import { ConfirmDialog } from '@/shared/components';
import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { flattenComments, isOptimistic, useAddComment, useComments, useDeleteComment, useRoster } from '../hooks';
import { WALL_RU } from '../locale';
import { AuthorLine } from './AuthorLine';

/**
 * The discussion under any entity — a post, a task, an event, a goal, a poll.
 *
 * Comments are fetched only once the thread is open: a feed page of twenty
 * cards must not fire twenty requests for threads nobody looked at.
 *
 * This is deliberately **not** a chat. There is no typing indicator, no read
 * receipt and no live socket; we do not compete with the family's messenger.
 */
export function CommentThread(props: { target: EntityRef; commentCount: number }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="w-full">
      <Button
        type="button"
        variant="ghost"
        className="min-h-9 px-2 text-sm text-muted-foreground"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        {props.commentCount > 0 ? WALL_RU.comments.count(props.commentCount) : WALL_RU.comments.toggle}
      </Button>
      {open ? <CommentList target={props.target} /> : null}
    </div>
  );
}

function CommentList(props: { target: EntityRef }) {
  const roster = useRoster();
  const query = useComments(props.target, true);
  const add = useAddComment(props.target);
  const remove = useDeleteComment(props.target);
  const [draft, setDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const comments = flattenComments(query.data);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const body = draft.trim();
    if (body.length === 0) return;
    setDraft('');
    add.mutate(body);
  };

  return (
    <div className="mt-2 space-y-3 border-l-2 border-border/70 pl-3">
      {query.isPending ? (
        <p className="text-sm text-muted-foreground">{COMMON.loading}</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{WALL_RU.comments.empty}</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              roster={roster}
              onDelete={() => {
                setPendingDelete(comment.id);
              }}
            />
          ))}
        </ul>
      )}

      {query.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          className="min-h-9 px-2 text-sm"
          disabled={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        >
          {WALL_RU.comments.loadOlder}
        </Button>
      ) : null}

      <Can perm="comment:create">
        <form onSubmit={submit} className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            rows={2}
            maxLength={4000}
            placeholder={WALL_RU.comments.placeholder}
            aria-label={WALL_RU.comments.placeholder}
            className="text-base"
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" className="min-h-11 px-4" disabled={draft.trim().length === 0}>
              {add.isPending ? <InlineSpinner className="mr-2" /> : null}
              {add.isPending ? WALL_RU.comments.sending : WALL_RU.comments.send}
            </Button>
          </div>
        </form>
      </Can>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title={WALL_RU.comments.deleteConfirmTitle}
        description={WALL_RU.comments.deleteConfirmDescription}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

function CommentRow(props: {
  comment: CommentResponse;
  roster: ReturnType<typeof useRoster>;
  onDelete: () => void;
}) {
  const { comment } = props;
  const pending = isOptimistic(comment.id);

  return (
    <li className={cn('space-y-1.5', pending && 'opacity-60')}>
      <AuthorLine
        roster={props.roster}
        authorId={comment.authorId}
        createdAt={comment.createdAt}
        size="xs"
        trailing={
          pending ? null : (
            <Can perm="comment:delete" resource={comment}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 text-muted-foreground"
                aria-label={COMMON.delete}
                onClick={props.onDelete}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </Can>
          )
        }
      />
      {/*
        No reaction bar on a comment: `COMMENTABLE_ENTITY_TYPES` has no `comment`
        member, so there is no route to react to one and the service always
        answers with an empty summary. The field exists for a future enum entry.
      */}
      <p className="text-sm wrap-break-word whitespace-pre-wrap text-foreground">{comment.body}</p>
    </li>
  );
}
