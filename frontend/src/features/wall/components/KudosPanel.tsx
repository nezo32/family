import { useState } from 'react';
import { Heart } from 'lucide-react';
import { Can, useCan } from '@/shared/auth';
import { EmptyState, InlineSpinner, UserAvatar } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';
import { Skeleton } from '@/shared/ui/skeleton';
import { cn } from '@/shared/lib/utils';
import { COMMON, relativeTime } from '@/shared/lib/i18n';
import { useGiveKudos, useKudosTotals, useRecentKudos, useRoster } from '../hooks';
import { KUDOS_EMOJI, WALL_RU } from '../locale';

/**
 * «Спасибо» — the warm corner of the app.
 *
 * The one design rule here is negative: **nothing may read as a ranking.**
 * Totals are listed alphabetically, never sorted by count; there is no place,
 * no medal, no "лидер недели"; a member with zero appears in the same list with
 * the same weight as everyone else. A sibling leaderboard would turn the one
 * screen that exists to make people feel good into another scoreboard (D5 says
 * the same thing about chore load, for the same reason).
 */
export function KudosPanel() {
  const roster = useRoster();
  const totals = useKudosTotals();
  const recent = useRecentKudos();

  const rows = [...(totals.data?.items ?? [])].sort((left, right) =>
    left.displayName.localeCompare(right.displayName, 'ru'),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold text-foreground">{WALL_RU.kudos.totalsTitle}</h2>
          <p className="text-sm text-muted-foreground">{WALL_RU.kudos.subtitle}</p>
        </div>
        <Can perm="kudos:give">
          <GiveKudosDialog />
        </Can>
      </div>

      {totals.isPending ? (
        <div className="space-y-2" aria-hidden>
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Heart}
          title={WALL_RU.kudos.empty}
          description={WALL_RU.kudos.emptyDescription}
          compact
        />
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.userId}
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-3"
              >
                <UserAvatar
                  user={{
                    id: row.userId,
                    displayName: row.displayName,
                    avatarUrl: roster.byId.get(row.userId)?.avatarUrl ?? null,
                  }}
                  size="sm"
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {row.displayName}
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-3 py-1 text-xs',
                    row.received > 0
                      ? 'bg-primary/10 text-foreground'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {row.received > 0
                    ? WALL_RU.kudos.received(row.received)
                    : WALL_RU.kudos.receivedNone}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{WALL_RU.kudos.totalsHint}</p>
        </>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">{WALL_RU.kudos.recentTitle}</h3>
        <ul className="space-y-2">
          {(recent.data?.items ?? []).map((item) => (
            <li key={item.id} className="flex items-start gap-2.5 px-1 py-1.5">
              <span aria-hidden className="text-lg leading-none">
                {item.emoji}
              </span>
              <div className="min-w-0 flex-1">
                <p className="wrap-break-word text-sm text-foreground">
                  {roster.nameOf(item.fromUserId)} → {roster.nameOf(item.toUserId)}
                </p>
                {item.message ? (
                  <p className="wrap-break-word text-sm text-muted-foreground">{item.message}</p>
                ) : null}
                <time dateTime={item.createdAt} className="text-xs text-muted-foreground/80">
                  {relativeTime(item.createdAt)}
                </time>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function GiveKudosDialog() {
  const [open, setOpen] = useState(false);
  const [toUserId, setToUserId] = useState('');
  const [emoji, setEmoji] = useState<string>(KUDOS_EMOJI[0]);
  const [message, setMessage] = useState('');
  const roster = useRoster();
  const { userId } = useCan();
  const give = useGiveKudos();

  // You cannot thank yourself; the picker simply does not offer it.
  const candidates = roster.members.filter((member) => member.id !== userId);

  const submit = (): void => {
    if (toUserId.length === 0) return;
    const trimmed = message.trim();
    give.mutate(
      {
        toUserId,
        emoji,
        message: trimmed.length > 0 ? trimmed : null,
      },
      {
        onSuccess: () => {
          setToUserId('');
          setMessage('');
          setEmoji(KUDOS_EMOJI[0]);
          setOpen(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" className="min-h-11">
          <Heart className="size-4" aria-hidden />
          {WALL_RU.kudos.give}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{WALL_RU.kudos.giveTitle}</DialogTitle>
          <DialogDescription>{WALL_RU.kudos.giveDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="kudos-to">{WALL_RU.kudos.to}</Label>
            <Select value={toUserId} onValueChange={setToUserId}>
              <SelectTrigger id="kudos-to" className="min-h-11 w-full">
                <SelectValue placeholder={WALL_RU.kudos.pickPerson} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {member.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{WALL_RU.kudos.emoji}</Label>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={WALL_RU.kudos.emoji}>
              {KUDOS_EMOJI.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-label={candidate}
                  aria-pressed={emoji === candidate}
                  onClick={() => {
                    setEmoji(candidate);
                  }}
                  className={cn(
                    'flex size-11 items-center justify-center rounded-full border text-xl',
                    emoji === candidate ? 'border-primary bg-primary/10' : 'border-border',
                  )}
                >
                  <span aria-hidden>{candidate}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="kudos-message">{WALL_RU.kudos.message}</Label>
            <Textarea
              id="kudos-message"
              value={message}
              rows={3}
              maxLength={280}
              placeholder={WALL_RU.kudos.messagePlaceholder}
              onChange={(event) => {
                setMessage(event.target.value);
              }}
              className="text-base"
            />
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
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
              disabled={toUserId.length === 0 || give.isPending}
              onClick={submit}
            >
              {give.isPending ? <InlineSpinner className="mr-2" /> : null}
              {give.isPending ? WALL_RU.kudos.sending : WALL_RU.kudos.send}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
