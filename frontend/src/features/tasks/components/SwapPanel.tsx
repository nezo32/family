import { useState } from 'react';
import { HandHeart } from 'lucide-react';
import type { PublicUser, SwapResponse, TaskOccurrenceResponse } from '@family/shared';
import { Button } from '@/shared/ui/button';
import { MemberDisc } from '@/shared/ui/member-disc';
import { Section } from '@/shared/ui/section';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { COMMON } from '@/shared/lib/i18n';
import { formatDateTime } from '@/shared/lib/format';
import { TASKS_RU } from '../locale';
import { useCancelSwap, useCreateSwap, useRespondToSwap } from '../hooks';
import { SegmentedControl } from './SegmentedControl';

/**
 * Chore swaps (D5 §Swaps).
 *
 * A swap is the pressure valve that keeps a frozen rotation humane: assignment
 * is written once and never rebalanced, so "у меня тренировка" has to have an
 * answer that is not "edit the schedule".
 */

function memberName(members: readonly PublicUser[], id: string | null): string {
  if (!id) return TASKS_RU.swap.toAnyone;
  return members.find((member) => member.id === id)?.displayName ?? '—';
}

/**
 * Incoming swap requests — **band 2 of §C2**, the one attention block on Задачи.
 *
 * A swap is the pressure valve that keeps a frozen rotation humane: assignment
 * is written once and never rebalanced, so «у меня тренировка» has to have an
 * answer that is not "edit the schedule".
 *
 * ## Why this is at the top of the page and not in the side column
 *
 * It used to live in the side column, which below 1088px collapses to the
 * bottom of the main column — i.e. **below the entire task list**. That was
 * survivable while nothing linked to it. It stopped being survivable when
 * `chore_swap_requested` notifications started navigating to `/tasks`, and they
 * navigate there *precisely because this panel is the only place «Помогу» and
 * «Не смогу» exist* — `TaskDetailPage` has no accept control at all. The flow
 * became: someone asks you to cover a chore, you tap the notification, and you
 * land on a screen where the question you were just asked is under fifty rows.
 * Reachable is not the same as answered.
 *
 * So it takes the attention band instead. This is the shape §C2 reserves that
 * band for: **rare** (it renders `null` the rest of the time, which is almost
 * always), addressed to you personally, and answerable in one tap. It costs
 * nothing on the days when there is nothing to answer, which is why hoisting it
 * does not break "one loud thing per screen" — on a normal day there is still
 * exactly zero.
 *
 * ## The filled «Помогу»
 *
 * Two filled primaries on one screen would break §B4, and «Новое дело» is
 * already one in the app bar. The precedent is §D10, where the pending-member
 * queue — also an attention block — carries «Одобрить» (primary) next to
 * «Отклонить» (ghost). Inside the wash the accept/reject pair *is* the action
 * the reader came for, and the wash is what stops the two primaries reading as
 * a tie. «Не смогу» is `ghost`, not `outline`: declining is not destructive,
 * it is just the other answer.
 */
export function SwapInbox(props: {
  swaps: readonly SwapResponse[];
  members: readonly PublicUser[];
}) {
  const respond = useRespondToSwap();
  const pending = props.swaps.filter((swap) => swap.status === 'pending');
  if (pending.length === 0) return null;

  return (
    <Section
      surface="attention"
      label={
        <span className="flex items-center gap-1.5">
          <HandHeart className="size-3.5" aria-hidden />
          {TASKS_RU.swap.attentionLabel}
        </span>
      }
    >
      <div className="flex min-h-11 w-full max-w-row-measure items-center gap-3 px-4 py-1.5">
        <h3 className="min-w-0 flex-1 truncate font-display text-[17px] leading-6 font-semibold">
          {TASKS_RU.swap.incoming}
        </h3>
        <span className="shrink-0 text-[13px] leading-[18px] font-medium tabular-nums">
          {pending.length}
        </span>
      </div>

      {pending.map((swap) => (
        <div key={swap.id} className="flex max-w-row-measure flex-col gap-1.5 px-4 py-3">
          <span className="flex min-w-0 items-center gap-2">
            <MemberDisc
              id={swap.fromUserId}
              displayName={memberName(props.members, swap.fromUserId)}
              avatarUrl={
                props.members.find((member) => member.id === swap.fromUserId)?.avatarUrl ?? null
              }
            />
            <span className="min-w-0 truncate text-[13px] leading-[18px] font-medium opacity-80">
              {memberName(props.members, swap.fromUserId)}
            </span>
          </span>

          <span className="truncate text-[17px] leading-6 font-medium">{swap.occurrenceTitle}</span>
          <span className="text-[13px] leading-[18px] font-medium tabular-nums opacity-80">
            {TASKS_RU.swap.dueAt}: {formatDateTime(swap.occurrenceDueAt)}
          </span>

          {swap.message ? (
            <span className="text-[15px] leading-[22px] text-pretty opacity-90">
              «{swap.message}»
            </span>
          ) : null}

          <span className="flex flex-wrap gap-2 pt-1.5">
            <Button
              type="button"
              className="h-11 flex-1 sm:flex-none sm:px-8"
              disabled={respond.isPending}
              onClick={() => {
                respond.mutate({ swapId: swap.id, body: { accept: true } });
              }}
            >
              {TASKS_RU.swap.accept}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-11 flex-1 bg-card/60 sm:flex-none sm:px-8"
              disabled={respond.isPending}
              onClick={() => {
                respond.mutate({ swapId: swap.id, body: { accept: false } });
              }}
            >
              {TASKS_RU.swap.decline}
            </Button>
          </span>
        </div>
      ))}
    </Section>
  );
}

/** "Попросить подмениться" for one occurrence. */
export function SwapRequestButton(props: {
  occurrence: TaskOccurrenceResponse;
  members: readonly PublicUser[];
  /** A live pending swap I created, if any. */
  outgoing?: SwapResponse | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [toUserId, setToUserId] = useState<string>('anyone');
  const [message, setMessage] = useState('');
  const create = useCreateSwap();
  const cancel = useCancelSwap();

  if (props.outgoing && props.outgoing.status === 'pending') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {TASKS_RU.swap.outgoing}: {memberName(props.members, props.outgoing.toUserId)}
        </span>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={cancel.isPending}
          onClick={() => {
            if (props.outgoing) cancel.mutate({ swapId: props.outgoing.id });
          }}
        >
          {TASKS_RU.swap.cancel}
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={() => {
          setOpen(true);
        }}
      >
        <HandHeart className="size-4" aria-hidden />
        {TASKS_RU.swap.ask}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(32rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>{TASKS_RU.swap.askTitle}</DialogTitle>
            <DialogDescription>{TASKS_RU.swap.askDescription}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <SegmentedControl
              label={TASKS_RU.swap.toPerson}
              value={toUserId}
              onChange={setToUserId}
              options={[
                { value: 'anyone', label: TASKS_RU.swap.toAnyone },
                ...props.members.map((member) => ({
                  value: member.id,
                  label: member.displayName,
                })),
              ]}
            />

            <div className="space-y-1.5">
              <Label htmlFor="swap-message">{TASKS_RU.swap.message}</Label>
              <Textarea
                id="swap-message"
                value={message}
                placeholder={TASKS_RU.swap.messagePlaceholder}
                onChange={(event) => {
                  setMessage(event.target.value);
                }}
                className="min-h-20 text-base"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => {
                setOpen(false);
              }}
            >
              {COMMON.cancel}
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={create.isPending}
              onClick={() => {
                create.mutate(
                  {
                    occurrenceId: props.occurrence.id,
                    ...(toUserId === 'anyone' ? {} : { toUserId }),
                    message: message.trim() === '' ? null : message.trim(),
                  },
                  {
                    onSuccess: () => {
                      setOpen(false);
                    },
                  },
                );
              }}
            >
              {TASKS_RU.swap.send}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
