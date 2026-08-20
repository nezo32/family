import { useEffect, useMemo, useState } from 'react';
import { Check, Lock, MessageCircleQuestion } from 'lucide-react';
import type { PollResponse } from '@family/shared';
import { useCan } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog, InlineSpinner } from '@/shared/components';
import { MemberDiscGroup } from '@/shared/ui/member-disc';
import { cn } from '@/shared/lib/utils';
import { formatDateTime } from '@/shared/lib/format';
import { isAnsweredByMe, useClosePoll, useVotePoll, votersOf, type Roster } from '../hooks';
import { WALL_RU } from '../locale';
import { AuthorLine } from './AuthorLine';
import { CommentThread } from './CommentThread';
import { ReactionBar } from './ReactionBar';

/**
 * One question the family is deciding together.
 *
 * ## The result is hidden until you have answered
 *
 * This is the one behavioural change in the poll, and it is the important one.
 * The card used to draw every option's share the moment it rendered, so the
 * first thing a ten-year-old saw was «На дачу 67 %» — and then they voted for
 * на дачу. A family is exactly the group in which that anchoring bites hardest,
 * because the two loudest votes are usually the parents'. So the bars appear
 * once you have answered, or once the poll is closed, and not before. Nothing
 * is hidden that you are entitled to: you get the whole result the instant you
 * have said your own piece.
 *
 * ## A closed poll renders the result, never a form
 *
 * Voting after the deadline is refused server-side with a `409`; showing a dead
 * radio button and then an error toast would be a small betrayal every time.
 * The card simply stops offering the choice. If a vote does lose the race with
 * the deadline, `useVotePoll` swallows the conflict and re-renders the closed
 * card instead of raising an error.
 *
 * ## Who has answered, as faces and not as a number
 *
 * «Проголосовали: 3» tells you nothing you can act on. Three member discs tell
 * you the family is waiting on Папа, which is the sentence somebody actually
 * says out loud. It is also not a tally against anybody's name: it is a set of
 * people who have answered *this* question, and it resets with the question.
 */
export function PollCard(props: {
  poll: PollResponse;
  roster: Roster;
  /**
   * Band 2 (§C2/§D7.4): at most one card on the screen wears the wash, and the
   * head decides which. Never decided here.
   */
  tone?: 'attention' | 'plain';
  /**
   * The status this card states about itself, in words, on its own line —
   * «Вас спрашивают» / «Открытый опрос». There is no section header above it
   * and there never will be (§D7.0); colour is never the only signal (§B4).
   */
  eyebrow?: string;
}) {
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

  const answered = isAnsweredByMe(poll);
  const mayVote = can('poll:vote') && !poll.isClosed;
  const mayClose =
    !poll.isClosed &&
    can('poll:close') &&
    (poll.createdById === userId || hasPermission('post:delete:any'));

  /** Bars only once the reader has said their own piece. See the note above. */
  const showResults = answered || poll.isClosed;

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

  const voters = useMemo(
    () =>
      votersOf(poll).map((id) => ({
        id,
        displayName: props.roster.nameOf(id),
        avatarUrl: props.roster.byId.get(id)?.avatarUrl ?? null,
      })),
    [poll, props.roster],
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
    <article
      className={cn(
        'flex w-full max-w-row-measure flex-col gap-2 px-4 py-3',
        props.tone === 'attention' && 'bg-surface-attention text-surface-attention-foreground',
      )}
    >
      <AuthorLine
        roster={props.roster}
        authorId={poll.createdById}
        createdAt={poll.createdAt}
        size="md"
        trailing={
          poll.isClosed ? (
            <span className="flex items-center gap-1 text-[13px] leading-[18px] font-medium opacity-70">
              <Lock className="size-3.5" aria-hidden />
              {WALL_RU.polls.closedBadge}
            </span>
          ) : answered ? (
            <span className="text-[13px] leading-[18px] font-medium opacity-70">
              {WALL_RU.polls.answered}
            </span>
          ) : null
        }
      />

      {props.eyebrow ? (
        <p className="flex items-center gap-1.5 text-[13px] leading-[18px] font-medium opacity-80">
          <MessageCircleQuestion className="size-3.5 shrink-0" aria-hidden />
          {props.eyebrow}
        </p>
      ) : null}

      <h3 className="wrap-break-word font-display text-[17px] leading-6 font-semibold">
        {poll.question}
      </h3>
      {!poll.isClosed && poll.closesAt ? (
        <p className="text-[13px] leading-[18px] font-medium opacity-70">
          {WALL_RU.polls.closesIn(formatDateTime(poll.closesAt))}
        </p>
      ) : null}

      <ul className="flex flex-col gap-1.5">
        {poll.options.map((option) => {
          const isChosen = selected.includes(option.id);
          const share = shares.get(option.id) ?? 0;
          const label = (
            <>
              <span className="min-w-0 flex-1 wrap-break-word text-[15px] leading-[22px]">
                {option.label}
              </span>
              {showResults ? (
                <span className="shrink-0 text-[13px] leading-[18px] font-medium tabular-nums opacity-70">
                  {WALL_RU.polls.resultShare(share)}
                </span>
              ) : null}
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
                {/* Proportional bar, painted behind the label — only once the
                    reader has answered, so it cannot anchor their answer. */}
                {showResults ? (
                  <div
                    aria-hidden
                    className={cn(
                      'absolute inset-y-0 left-0 transition-[width] duration-300',
                      isChosen ? 'bg-primary/20' : 'bg-muted',
                    )}
                    style={{ width: `${String(share)}%` }}
                  />
                ) : null}
                {mayVote ? (
                  <button
                    type="button"
                    role={poll.allowMultiple ? 'checkbox' : 'radio'}
                    aria-checked={isChosen}
                    onClick={() => {
                      pick(option.id);
                    }}
                    className="relative flex min-h-11 w-full touch-manipulation items-center gap-2.5 px-3 py-2 text-left"
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
                  <div className="relative flex min-h-11 w-full items-center gap-2.5 px-3 py-2">
                    {isChosen ? (
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[13px] leading-[18px] font-medium">
                        {WALL_RU.polls.yourChoice}
                      </span>
                    ) : null}
                    {label}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/*
        One footer row, not two: who has answered, the controls, and the thread
        toggle share the same 44px line. A poll is the loudest block on the
        board, and two stacked rows of chrome under it is 88px of nothing.
      */}
      <CommentThread
        target={{ entityType: 'poll', entityId: poll.id }}
        // `pollResponseSchema` carries this now (§D7.13 gap 2). It used to be
        // hard-coded to 0, which understated a live thread on every poll.
        commentCount={poll.commentCount}
        actions={
          <>
            <ReactionBar
              target={{ entityType: 'poll', entityId: poll.id }}
              reactions={poll.reactions}
              roster={props.roster}
            />
            {voters.length > 0 ? (
              <p className="flex min-w-0 items-center gap-2 pe-1 text-[13px] leading-[18px] font-medium opacity-70">
                <span>{WALL_RU.polls.answeredBy}</span>
                <MemberDiscGroup members={voters} />
                <span className="sr-only">
                  {voters.map((member) => member.displayName).join(', ')}
                </span>
              </p>
            ) : (
              <p className="pe-1 text-[13px] leading-[18px] font-medium opacity-70">
                {WALL_RU.polls.noVotesYet}
              </p>
            )}
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
                variant="ghost"
                className="min-h-11 text-[13px] font-medium text-muted-foreground"
                onClick={() => {
                  setConfirmingClose(true);
                }}
              >
                {WALL_RU.polls.close}
              </Button>
            ) : null}
          </>
        }
      />

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
