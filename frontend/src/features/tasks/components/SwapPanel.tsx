import { useState } from 'react';
import { HandHeart } from 'lucide-react';
import type { PublicUser, SwapResponse, TaskOccurrenceResponse } from '@family/shared';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
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

/** Incoming requests addressed to me (or open to anyone). */
export function SwapInbox(props: { swaps: readonly SwapResponse[]; members: readonly PublicUser[] }) {
  const respond = useRespondToSwap();
  const pending = props.swaps.filter((swap) => swap.status === 'pending');
  if (pending.length === 0) return null;

  return (
    <section className="space-y-2 rounded-2xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <HandHeart className="size-4" aria-hidden />
        {TASKS_RU.swap.incoming}
      </h2>
      <ul className="space-y-3">
        {pending.map((swap) => {
          const from = props.members.find((member) => member.id === swap.fromUserId);
          return (
            <li key={swap.id} className="space-y-2 rounded-xl border border-border/70 p-3">
              <div className="flex items-center gap-2">
                {from ? <UserAvatar user={from} size="xs" /> : null}
                <span className="min-w-0 truncate text-sm text-foreground">
                  {memberName(props.members, swap.fromUserId)}
                </span>
              </div>
              <p className="text-sm font-medium text-foreground">{swap.occurrenceTitle}</p>
              <p className="text-xs text-muted-foreground">
                {TASKS_RU.swap.dueAt}: {formatDateTime(swap.occurrenceDueAt)}
              </p>
              {swap.message ? (
                <p className="text-sm text-pretty text-muted-foreground">«{swap.message}»</p>
              ) : null}
              {swap.bonusPoints > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {TASKS_RU.swap.bonus}: +{swap.bonusPoints}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="min-h-11 flex-1"
                  disabled={respond.isPending}
                  onClick={() => {
                    respond.mutate({ swapId: swap.id, body: { accept: true } });
                  }}
                >
                  {TASKS_RU.swap.accept}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 flex-1"
                  disabled={respond.isPending}
                  onClick={() => {
                    respond.mutate({ swapId: swap.id, body: { accept: false } });
                  }}
                >
                  {TASKS_RU.swap.decline}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
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
  const [bonus, setBonus] = useState(0);
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

            <div className="space-y-1.5">
              <Label htmlFor="swap-bonus">{TASKS_RU.swap.bonus}</Label>
              <Input
                id="swap-bonus"
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                value={String(bonus)}
                onChange={(event) => {
                  setBonus(Math.max(0, Math.min(100, Number(event.target.value) || 0)));
                }}
                className="h-11 w-24 text-base"
              />
              <p className="text-xs text-muted-foreground">{TASKS_RU.swap.bonusHint}</p>
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
                    bonusPoints: bonus,
                  },
                  { onSuccess: () => { setOpen(false); } },
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
