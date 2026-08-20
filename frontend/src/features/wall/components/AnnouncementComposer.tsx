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
import { isoInDays } from '../api';
import { useCreatePost } from '../hooks';
import { WALL_RU } from '../locale';

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

const composerSchema = createPostSchema.omit({ pinnedUntil: true });
type ComposerInput = z.input<typeof composerSchema>;
type ComposerValues = z.output<typeof composerSchema>;

interface Draft {
  title: string;
  body: string;
  pinDays: number | null;
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
    create.mutate(
      {
        ...(trimmed && trimmed.length > 0 ? { title: trimmed } : {}),
        body: values.body,
        pinnedUntil: mayPin && pinDays !== null ? isoInDays(pinDays) : null,
      },
      {
        onSuccess: () => {
          form.reset({ title: '', body: '' });
          setPinDays(null);
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
        submitDisabled={body.trim().length === 0}
        submitting={create.isPending}
        dirty={form.formState.isDirty || pinDays !== null}
        draft={{
          key: 'family:wall-post-draft',
          read: () => ({ title, body, pinDays }),
          restore: (value) => {
            form.reset({ title: value.title, body: value.body }, { keepDefaultValues: true });
            setPinDays(value.pinDays);
          },
          enabled: !create.isPending,
        }}
      >
        <form id={formId} onSubmit={submit} noValidate>
          <SectionStack className="gap-6 pt-2">
            <Section surface="card">
              {/*
                The note itself, and nothing above it. `text-[17px]` on every
                surface: below 16 iOS zooms the viewport on focus and never
                zooms back (§F2).
              */}
              <div className="w-full max-w-row-measure px-4 py-3">
                <Textarea
                  autoFocus
                  rows={5}
                  maxLength={8000}
                  aria-label={WALL_RU.post.fieldBody}
                  placeholder={WALL_RU.post.fieldBodyPlaceholder}
                  className="min-h-32 resize-none border-0 bg-transparent px-0 text-[17px] leading-6 shadow-none focus-visible:ring-0 md:text-[17px]"
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
