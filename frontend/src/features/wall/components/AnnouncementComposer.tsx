import { useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pin, Type } from 'lucide-react';
import { createPostSchema } from '@family/shared';
import type { z } from 'zod';
import { useCan } from '@/shared/auth';
import { FormSheet } from '@/shared/ui/form-sheet';
import { Section, SectionStack } from '@/shared/ui/section';
import { ValueRow } from '@/shared/ui/value-row';
import { OptionList, OptionRow, PickerSheet, TextSheet } from '@/shared/ui/option-sheet';
import { Textarea } from '@/shared/ui/textarea';
import { cn } from '@/shared/lib/utils';
import { isoInDays } from '../api';
import { composerNoteClass } from '../composer-field';
import { useCreatePost } from '../hooks';
import { WALL_RU } from '../locale';
import { MAX_PER_POST } from '../media/limits';
import { useOnline } from '../media/online';
import { useAttachments, type PersistedAttachment } from '../media/use-attachments';
import { AttachmentField } from './AttachmentField';

/**
 * Write an announcement (§F3).
 *
 * ## The note is the form
 *
 * What goes on a board is a line of text — «в субботу едем к бабушке, выезжаем
 * в 10:00». So the sheet opens on a focused textarea and nothing else: one
 * typed line and «Повесить» is the whole common case, and the submit control is
 * a sibling of the scroll container, so it can never be pushed below the fold
 * however long the note gets.
 *
 * Everything that is *not* the note — an optional heading, and how long to keep
 * it at the top — is a `ValueRow` under «Подробнее» that states its own value
 * and opens a sheet (§F5). The old form put a labelled «Заголовок» input above
 * the text, which is a decision the family makes about one announcement in ten
 * placed in front of the one they make about all ten.
 *
 * ## Pinning
 *
 * Folded in here rather than hidden behind a second step, because «закрепить на
 * неделю» is a decision people make while writing. The row only exists for a
 * holder of `post:pin` — a teenager writing «я дома» never sees it (D4:
 * `useCan()`, never a role comparison) — and a pin always carries an expiry,
 * never a flag, so «закреплено до» self-clears.
 *
 * The sheet is controlled from `BoardCompose`, which owns exactly one instance
 * of it. This component has no trigger of its own on purpose: two triggers is
 * two dialogs is two drafts.
 */

const composerSchema = createPostSchema.omit({ pinnedUntil: true, attachmentIds: true });
type ComposerInput = z.input<typeof composerSchema>;
type ComposerValues = z.output<typeof composerSchema>;

/**
 * What survives a cold start (§F9, §D7.14.7).
 *
 * iOS returns a backgrounded PWA as a **cold start at `start_url`**, and a
 * `File` handle cannot be persisted. So the draft carries the *ids* of the
 * uploads that already finished — three strings and a few uuids, which fit in
 * `sessionStorage` trivially — and the server's 24-hour unclaimed window is the
 * durability. A member interrupted by a phone call comes back to their sheet
 * with their already-uploaded photos still on it, and loses only whatever was
 * still in flight.
 *
 * That is deliberately the *cheap* half of what an outbox would have been, and
 * §D7.14.7 argues at length for why the expensive half is not built. See the
 * header of `media/use-attachments.ts`.
 */
interface Draft {
  title: string;
  body: string;
  pinDays: number | null;
  attachments: PersistedAttachment[];
}

/** `null` = do not pin. Otherwise the number of days the pin should live. */
const PIN_CHOICES = [
  { days: null, label: WALL_RU.post.pinNone },
  { days: 1, label: WALL_RU.post.pinDay },
  { days: 3, label: WALL_RU.post.pinThreeDays },
  { days: 7, label: WALL_RU.post.pinWeek },
] as const;

function pinLabel(days: number | null): string {
  return (PIN_CHOICES.find((choice) => choice.days === days) ?? PIN_CHOICES[0]).label;
}

type SheetKey = 'title' | 'pin';

export function AnnouncementComposer(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pinDays, setPinDays] = useState<number | null>(null);
  const [openSheet, setOpenSheet] = useState<SheetKey | null>(null);
  const { can } = useCan();
  const create = useCreatePost();
  const formId = useId();

  const form = useForm<ComposerInput, unknown, ComposerValues>({
    resolver: zodResolver(composerSchema),
    defaultValues: { title: '', body: '' },
  });

  const attachments = useAttachments({ max: MAX_PER_POST });
  const online = useOnline();

  const mayPin = can('post:pin');
  const title = form.watch('title') ?? '';
  const body = form.watch('body');

  // Closing is always deliberate (the guard in `FormSheet` has already asked),
  // so the next opening starts clean.
  useEffect(() => {
    if (props.open) return;
    setOpenSheet(null);
  }, [props.open]);

  const submit = form.handleSubmit((values) => {
    const trimmed = values.title?.trim();
    const attachmentIds = attachments.attachmentIds;
    create.mutate(
      {
        ...(trimmed && trimmed.length > 0 ? { title: trimmed } : {}),
        body: values.body,
        pinnedUntil: mayPin && pinDays !== null ? isoInDays(pinDays) : null,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      },
      {
        onSuccess: () => {
          form.reset({ title: '', body: '' });
          setPinDays(null);
          // Claimed inside the post's own transaction, so the tiles are dropped
          // rather than discarded — calling `DELETE /api/media/:id` on them now
          // would answer 409 and would be asking to delete the photos that just
          // went up.
          attachments.clear();
          props.onOpenChange(false);
        },
      },
    );
  });

  return (
    <>
      <FormSheet<Draft>
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={WALL_RU.post.composeTitle}
        description={WALL_RU.post.composeDescription}
        submitLabel={WALL_RU.post.publish}
        formId={formId}
        /*
          **A photo with no caption is a whole note** (§D7.14.4). The gate used
          to be `body.trim().length === 0` alone, which is right while a post is
          words and nothing else; the backend now enforces *body or attachment,
          at least one*, so the client's gate has to say the same thing or it
          refuses what the server would accept.

          «Повесить» is also disabled while any tile is still going up, and the
          footer says why in words rather than presenting a dead button. It is
          **not** disabled by a *failed* tile: a member may post the note without
          the photo that would not go, and that is usually what they want at that
          point.
        */
        submitDisabled={
          (body.trim().length === 0 && attachments.attachmentIds.length === 0) ||
          attachments.uploading
        }
        {...(attachments.uploading
          ? {
              // `banner` is fixed under the header, which on a coarse pointer is
              // where «Повесить» lives — so the explanation sits beside the
              // button it is explaining.
              banner: (
                <p className="px-4 py-2 text-[13px] leading-[18px] font-medium text-muted-foreground">
                  {WALL_RU.media.uploadingFooter}
                </p>
              ),
            }
          : {})}
        submitting={create.isPending}
        dirty={form.formState.isDirty || pinDays !== null || attachments.tiles.length > 0}
        draft={{
          key: 'family:wall-post-draft',
          read: () => ({ title, body, pinDays, attachments: attachments.persisted() }),
          restore: (value) => {
            form.reset({ title: value.title, body: value.body }, { keepDefaultValues: true });
            setPinDays(value.pinDays);
            // Older drafts, written before media existed, have no such field.
            attachments.restore(value.attachments ?? []);
          },
          enabled: !create.isPending,
        }}
      >
        <form id={formId} onSubmit={submit} noValidate>
          <SectionStack className="gap-6 pt-2">
            <Section surface="card">
              {/*
                The note itself, and nothing above it. This `div` is the row:
                it owns the ground (the `Section`), the radius and the 16/12
                inset — the same `px-4 py-3` the «Заголовок» row below uses — and
                `composerNoteClass` is what stops the field drawing a second box
                inside it (§D7.6, and the note on that constant).
              */}
              <div className="w-full max-w-row-measure px-4 py-3">
                <Textarea
                  autoFocus
                  rows={5}
                  maxLength={8000}
                  aria-label={WALL_RU.post.fieldBody}
                  placeholder={WALL_RU.post.fieldBodyPlaceholder}
                  className={cn(composerNoteClass, 'min-h-32')}
                  {...form.register('body')}
                />
              </div>
            </Section>

            <Section surface="card">
              <ValueRow
                icon={<Type />}
                label={WALL_RU.post.fieldTitle}
                value={title.trim().length > 0 ? title : undefined}
                onClick={() => {
                  setOpenSheet('title');
                }}
              />
              {mayPin ? (
                <ValueRow
                  icon={<Pin />}
                  label={WALL_RU.post.pinFor}
                  value={pinLabel(pinDays)}
                  onClick={() => {
                    setOpenSheet('pin');
                  }}
                />
              ) : null}
            </Section>

            {/*
              A row inside the same kind of `Section` as «Заголовок» — not a new
              field, not a bar, and not a second surface. `composer-field.ts`
              was restructured to stop these composers drawing a box inside the
              box; the strip draws no ground, no radius and no border of its
              own, and the tiles are the only bordered things in it.
            */}
            <Section surface="card">
              {online ? (
                <AttachmentField attachments={attachments} max={MAX_PER_POST} />
              ) : (
                <p className="px-4 py-3 text-[15px] leading-[22px] text-muted-foreground">
                  {WALL_RU.media.offline}
                </p>
              )}
            </Section>
          </SectionStack>
        </form>
      </FormSheet>

      <TextSheet
        open={openSheet === 'title'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'title' : null);
        }}
        title={WALL_RU.post.fieldTitle}
        placeholder={WALL_RU.post.fieldTitlePlaceholder}
        maxLength={160}
        value={title}
        onChange={(value) => {
          form.setValue('title', value, { shouldDirty: true });
        }}
      />

      <PickerSheet
        open={openSheet === 'pin'}
        onOpenChange={(next) => {
          setOpenSheet(next ? 'pin' : null);
        }}
        title={WALL_RU.post.pinFor}
      >
        <OptionList label={WALL_RU.post.pinFor}>
          {PIN_CHOICES.map((choice) => (
            <OptionRow
              key={choice.label}
              label={choice.label}
              selected={pinDays === choice.days}
              onSelect={() => {
                setPinDays(choice.days);
                setOpenSheet(null);
              }}
            />
          ))}
        </OptionList>
      </PickerSheet>
    </>
  );
}
