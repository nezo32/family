import { useEffect, useState } from 'react';
import { Smile, UserRound } from 'lucide-react';
import { useCan } from '@/shared/auth';
import { FormSheet } from '@/shared/ui/form-sheet';
import { Section, SectionStack } from '@/shared/ui/section';
import { ValueRow } from '@/shared/ui/value-row';
import { OptionList, OptionRow, PickerSheet } from '@/shared/ui/option-sheet';
import { MemberDisc } from '@/shared/ui/member-disc';
import { Textarea } from '@/shared/ui/textarea';
import { cn } from '@/shared/lib/utils';
import { composerNoteClass } from '../composer-field';
import { useGiveKudos, useRoster } from '../hooks';
import { KUDOS_EMOJI, WALL_RU } from '../locale';

/**
 * «Сказать спасибо».
 *
 * Extracted out of `KudosPanel` — that is the change that lets the panel be a
 * pure function of server state, and therefore lets it be rendered wherever the
 * layout wants it without `useTwoColumn` picking a tree (see `BoardCompose`).
 *
 * The rule of this flow is negative and it is the same rule as the panel's:
 * **nothing here counts anything.** There is no "you have thanked N people",
 * no streak, no suggestion of whom you owe. Кому and за что, and that is all.
 *
 * You cannot thank yourself, so the picker does not offer you.
 *
 * **And you can only thank an `active` member.** `GET /members` subtracts
 * `rejected` at the source (identity.md §1.5), but it still serves
 * `pending_approval` and `suspended` — the roster is a roster, and the admin and
 * family screens need both. Neither belongs in a «кому сказать спасибо» list:
 * somebody waiting at the door has not joined the family yet, and somebody
 * suspended has been deliberately set aside. `giveKudos` agrees and is the
 * authority — it re-reads the recipient and answers `404` for any status but
 * `active` — so offering them was offering a row the server would refuse.
 *
 * `active` alone, and not the `['active', 'pending_approval']` that
 * `dashboard.loadMembers` uses: that set answers "who is in the household"
 * for a display surface, where showing the newcomer is the point. This one
 * answers "whom may I act upon", which is the narrower question every other
 * action-target picker in the app already answers the same way
 * (`tasks/api.ts`, `EventFormDialog`).
 */

type SheetKey = 'to' | 'emoji';

export function KudosComposer(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const roster = useRoster();
  const { userId } = useCan();
  const give = useGiveKudos();

  const [toUserId, setToUserId] = useState('');
  const [emoji, setEmoji] = useState<string>(KUDOS_EMOJI[0]);
  const [message, setMessage] = useState('');
  const [openSheet, setOpenSheet] = useState<SheetKey | null>(null);

  useEffect(() => {
    if (props.open) return;
    setOpenSheet(null);
  }, [props.open]);

  const candidates = roster.members.filter(
    (member) => member.id !== userId && member.status === 'active',
  );
  /**
   * Resolved against `candidates`, not the whole roster, so a restored draft
   * naming somebody who has since been suspended reads as "nobody picked yet"
   * rather than as a recipient the send would 404 on.
   */
  const recipient = candidates.find((member) => member.id === toUserId);

  const submit = (): void => {
    if (!recipient) return;
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
          props.onOpenChange(false);
        },
      },
    );
  };

  return (
    <>
      <FormSheet<{ toUserId: string; emoji: string; message: string }>
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={WALL_RU.kudos.giveTitle}
        description={WALL_RU.kudos.giveDescription}
        submitLabel={WALL_RU.kudos.send}
        onSubmit={submit}
        submitDisabled={!recipient}
        submitting={give.isPending}
        dirty={toUserId.length > 0 || message.trim().length > 0}
        draft={{
          key: 'family:wall-kudos-draft',
          read: () => ({ toUserId, emoji, message }),
          restore: (value) => {
            setToUserId(value.toUserId);
            setEmoji(value.emoji);
            setMessage(value.message);
          },
          enabled: !give.isPending,
        }}
      >
        <SectionStack className="gap-6 pt-2">
          <Section surface="card">
            <ValueRow
              icon={<UserRound />}
              label={WALL_RU.kudos.to}
              value={
                recipient ? (
                  <span className="flex items-center gap-2">
                    <MemberDisc
                      id={recipient.id}
                      displayName={recipient.displayName}
                      avatarUrl={recipient.avatarUrl}
                    />
                    {recipient.displayName}
                  </span>
                ) : undefined
              }
              hint={recipient ? undefined : WALL_RU.kudos.pickPerson}
              onClick={() => {
                setOpenSheet('to');
              }}
            />
            <ValueRow
              icon={<Smile />}
              label={WALL_RU.kudos.emoji}
              value={
                <span aria-hidden className="text-xl leading-none">
                  {emoji}
                </span>
              }
              onClick={() => {
                setOpenSheet('emoji');
              }}
            />
          </Section>

          <Section label={WALL_RU.kudos.message} surface="card">
            <div className="w-full max-w-row-measure px-4 py-3">
              <Textarea
                rows={3}
                maxLength={280}
                aria-label={WALL_RU.kudos.message}
                placeholder={WALL_RU.kudos.messagePlaceholder}
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value);
                }}
                className={cn(composerNoteClass, 'min-h-20')}
              />
            </div>
          </Section>
        </SectionStack>
      </FormSheet>

      <PickerSheet
        open={openSheet === 'to'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'to' : null);
        }}
        title={WALL_RU.kudos.giveTitle}
      >
        <OptionList label={WALL_RU.kudos.to}>
          {candidates.map((member) => (
            <OptionRow
              key={member.id}
              label={member.displayName}
              selected={toUserId === member.id}
              leading={
                <MemberDisc
                  id={member.id}
                  displayName={member.displayName}
                  avatarUrl={member.avatarUrl}
                  size="md"
                />
              }
              onSelect={() => {
                setToUserId(member.id);
                setOpenSheet(null);
              }}
            />
          ))}
        </OptionList>
      </PickerSheet>

      <PickerSheet
        open={openSheet === 'emoji'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'emoji' : null);
        }}
        title={WALL_RU.kudos.emoji}
      >
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={WALL_RU.kudos.emoji}>
          {KUDOS_EMOJI.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-label={candidate}
              aria-checked={emoji === candidate}
              onClick={() => {
                setEmoji(candidate);
                setOpenSheet(null);
              }}
              className={cn(
                'flex size-14 items-center justify-center rounded-xl border text-2xl',
                'touch-manipulation no-callout',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                emoji === candidate ? 'border-primary bg-primary/10' : 'border-border',
              )}
            >
              <span aria-hidden>{candidate}</span>
            </button>
          ))}
        </div>
      </PickerSheet>
    </>
  );
}
