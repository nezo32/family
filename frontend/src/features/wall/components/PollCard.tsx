import { useEffect, useMemo, useState } from 'react';
import { Check, Lock } from 'lucide-react';
import type { PollResponse } from '@family/shared';
import { useCan } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { ConfirmDialog, InlineSpinner } from '@/shared/components';
import { cn } from '@/shared/lib/utils';
import { formatDateTime } from '@/shared/lib/format';
import { useClosePoll, useVotePoll, type Roster } from '../hooks';
import { WALL_RU } from '../locale';
import { AuthorLine } from './AuthorLine';
import { CommentThread } from './CommentThread';

/**
 * One poll: the question, the options as proportional bars, and — while it is
 * open — a way to answer.
 *
 * **A closed poll renders the result, never a form.** Voting after the deadline
 * is refused server-side with a `409`; showing a dead radio button and then an
 * error toast would be a small betrayal every time. The card simply stops
 * offering the choice and shows what the family decided. If a vote does lose the
 * race with the deadline, `useVotePoll` swallows the conflict and re-renders the
 * closed card instead of raising an error.
 */
export function PollCard(props: { poll: PollResponse; roster: Roster }) {
  const { poll } = props;
  const { can, hasPermission, userId } = useCan();
  const vote = useVotePoll();
  const close = useClosePoll();
  const [confirmingClose, setConfirmingClose] = useState(false);

  const [selected, setSelected] = useState<readonly string[]>(poll.myOptionIds);
  const serverSelection = poll.myOptionIds.join('|');
  useEffect(() => {
    setSelected(serverSelection.length > 0 ? serverSelection.split('|') : []);
  }, [serverSelection]);

  const mayVote = can('poll:vote') && !poll.isClosed;
  const mayClose =
    !poll.isClosed &&
    can('poll:close') &&
    (poll.createdById === userId || hasPermission('post:delete:any'));

  const denominator = Math.max(1, poll.totalVoters);
  const shares = useMemo(
    () =>
      new Map(
        poll.options.map((option) => [
          option.id,
          Math.round((option.voteCount / denominator) * 100),
        ]),
      ),
    [poll.options, denominator],
  );

  const submit = (optionIds: readonly string[]): void => {
    if (optionIds.length === 0) return;
    vote.mutate({ pollId: poll.id, optionIds: [...optionIds] });
  };

  const pick = (optionId: string): void => {
    if (!mayVote) return;
    if (poll.allowMultiple) {
      setSelected((current) =>
        current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId],
      );
      return;
    }
    // Single choice: the tap *is* the vote, and it replaces whatever was
    // selected before — exactly what the service does inside one transaction.
    setSelected([optionId]);
    submit([optionId]);
  };

  return (
    <article className="rounded-xl border border-border bg-card p-4 shadow-xs">
      <AuthorLine
        roster={props.roster}
        authorId={poll.createdById}
        createdAt={poll.createdAt}
        trailing={
          poll.isClosed ? (
            <Badge variant="secondary" className="gap-1">
              <Lock className="size-3" aria-hidden />
              {WALL_RU.polls.closed}
            </Badge>
          ) : (
            <Badge variant="outline">{WALL_RU.polls.open}</Badge>
          )
        }
      />

      <h3 className="mt-3 wrap-break-word text-base font-semibold text-foreground">
        {poll.question}
      </h3>
      {!poll.isClosed && poll.closesAt ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {WALL_RU.polls.closesIn(formatDateTime(poll.closesAt))}
        </p>
      ) : null}

      <ul className="mt-3 space-y-2">
        {poll.options.map((option) => {
          const isChosen = selected.includes(option.id);
          const share = shares.get(option.id) ?? 0;
          const label = (
            <>
              <span className="min-w-0 flex-1 wrap-break-word text-sm text-foreground">
                {option.label}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {WALL_RU.polls.resultShare(share)}
              </span>
            </>
          );

          return (
            <li key={option.id}>
              <div
                className={cn(
                  'relative overflow-hidden rounded-lg border',
                  isChosen ? 'border-primary/50' : 'border-border',
                )}
              >
                {/* Proportional bar, painted behind the label. */}
                <div
                  aria-hidden
                  className={cn(
                    'absolute inset-y-0 left-0 transition-[width] duration-300',
                    isChosen ? 'bg-primary/20' : 'bg-muted',
                  )}
                  style={{ width: `${String(share)}%` }}
                />
                {mayVote ? (
                  <button
                    type="button"
                    role={poll.allowMultiple ? 'checkbox' : 'radio'}
                    aria-checked={isChosen}
                    onClick={() => {
                      pick(option.id);
                    }}
                    className="relative flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center border',
                        poll.allowMultiple ? 'rounded-sm' : 'rounded-full',
                        isChosen
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input',
                      )}
                    >
                      {isChosen ? <Check className="size-3.5" /> : null}
                    </span>
                    {label}
                  </button>
                ) : (
                  <div className="relative flex min-h-11 w-full items-center gap-2 px-3 py-2">
                    {isChosen ? (
                      <Badge variant="secondary" className="shrink-0">
                        {WALL_RU.polls.yourChoice}
                      </Badge>
                    ) : null}
                    {label}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {poll.totalVoters > 0
            ? WALL_RU.polls.totalVoters(poll.totalVoters)
            : WALL_RU.polls.noVotesYet}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {mayVote && poll.allowMultiple ? (
            <Button
              type="button"
              size="sm"
              className="min-h-11"
              disabled={selected.length === 0 || vote.isPending}
              onClick={() => {
                submit(selected);
              }}
            >
              {vote.isPending ? <InlineSpinner className="mr-2" /> : null}
              {vote.isPending ? WALL_RU.polls.voting : WALL_RU.polls.vote}
            </Button>
          ) : null}
          {mayClose ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                setConfirmingClose(true);
              }}
            >
              {WALL_RU.polls.close}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-2">
        <CommentThread target={{ entityType: 'poll', entityId: poll.id }} commentCount={0} />
      </div>

      <ConfirmDialog
        open={confirmingClose}
        onOpenChange={setConfirmingClose}
        destructive={false}
        confirmLabel={WALL_RU.polls.close}
        title={WALL_RU.polls.closeConfirmTitle}
        description={WALL_RU.polls.closeConfirmDescription}
        onConfirm={() => {
          close.mutate(poll.id);
        }}
      />
    </article>
  );
}
