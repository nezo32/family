import { useState, type FormEvent, type ReactNode } from 'react';
import { MessageSquare, Trash2 } from 'lucide-react';
import type { CommentResponse, EntityRef } from '@family/shared';
import { Can } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/textarea';
import { InlineSpinner } from '@/shared/components';
import { ConfirmDialog } from '@/shared/components';
import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import {
  flattenComments,
  isOptimistic,
  useAddComment,
  useComments,
  useDeleteComment,
  useRoster,
} from '../hooks';
import { WALL_RU } from '../locale';
import { AuthorLine } from './AuthorLine';

/**
 * The discussion under one note — and the one place on Стена where a text field
 * is allowed to exist.
 *
 * ## Why the composer is *here* and nowhere else
 *
 * A message box pinned to the bottom of the screen is the single feature that
 * would turn this board into a chat, and the family already has Telegram. So
 * there is no page-level composer: writing happens either behind the app bar's
 * one door (a new note) or inside a thread that somebody deliberately opened.
 * Closed is the default, and closed is what the board looks like.
 *
 * It follows that there is no typing indicator, no read receipt, no live
 * socket and no threads-of-threads. Comments are fetched only once the thread
 * is open, which is also why a board page of twelve notes fires one request and
 * not twelve.
 *
 * ## The footer line
 *
 * Reactions and the thread toggle share one 44px row (`actions`), because two
 * stacked rows of chrome under every note is ~88px per note — on a phone that
 * is most of what the board would be made of.
 */
export function CommentThread(props: {
  target: EntityRef;
  commentCount: number;
  /** Rendered to the left of the toggle, on the same line. The reaction bar. */
  actions?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn('w-full', props.className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {props.actions}
        <Button
          type="button"
          variant="ghost"
          className="ms-auto min-h-11 px-2.5 text-[13px] leading-[18px] font-medium text-muted-foreground"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          <MessageSquare className="size-4" aria-hidden />
          {props.commentCount > 0
            ? WALL_RU.comments.count(props.commentCount)
            : WALL_RU.comments.toggle}
        </Button>
      </div>
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
    <div className="mt-1 space-y-3 border-s-2 border-hairline ps-3">
      {query.isPending ? (
        <p className="text-[13px] leading-[18px] font-medium text-muted-foreground">
          {COMMON.loading}
        </p>
      ) : comments.length === 0 ? (
        <p className="text-[13px] leading-[18px] font-medium text-muted-foreground">
          {WALL_RU.comments.empty}
        </p>
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
          className="min-h-11 px-2 text-[13px] font-medium"
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
            className="resize-none text-[17px] md:text-[17px]"
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              className="min-h-11 px-4"
              disabled={draft.trim().length === 0 || add.isPending}
            >
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
    <li className={cn('space-y-1', pending && 'opacity-60')}>
      <AuthorLine
        roster={props.roster}
        authorId={comment.authorId}
        createdAt={comment.createdAt}
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
      <p className="text-[15px] leading-[22px] wrap-break-word whitespace-pre-wrap select-text">
        {comment.body}
      </p>
    </li>
  );
}
