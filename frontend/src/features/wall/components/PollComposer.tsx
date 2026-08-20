import { useEffect, useState } from 'react';
import { Clock, Plus, Users, X } from 'lucide-react';
import { createPollSchema } from '@family/shared';
import { FormSheet } from '@/shared/ui/form-sheet';
import { Section, SectionStack } from '@/shared/ui/section';
import { ValueRow } from '@/shared/ui/value-row';
import { OptionList, OptionRow, PickerSheet } from '@/shared/ui/option-sheet';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';
import { isoInDays } from '../api';
import { useCreatePoll } from '../hooks';
import { WALL_RU } from '../locale';

/**
 * Ask the family something (§F3).
 *
 * The option list is dynamic, so validity is checked by running the **shared
 * contract** over the assembled draft rather than by re-implementing "at least
 * two non-empty options" here. Nothing is submitted until the contract agrees,
 * which is why this form shows no error text at all: «Спросить» is simply not
 * available yet, and an empty option row is self-explanatory.
 *
 * ## «Ждём ответы» is a duration, not a datetime
 *
 * The old form put a `datetime-local` pair in the middle of the sheet for a
 * deadline nobody sets to the minute. A family says «до завтра», so the choices
 * are «сколько нужно · сутки · 3 дня · неделю» behind one row that states the
 * current answer. The value still goes to the API as a real instant.
 */

const MAX_OPTIONS = 10;
const MIN_OPTIONS = 2;

const CLOSES_CHOICES = [
  { days: null, label: WALL_RU.polls.closesNever },
  { days: 1, label: WALL_RU.polls.closesDay },
  { days: 3, label: WALL_RU.polls.closesThreeDays },
  { days: 7, label: WALL_RU.polls.closesWeek },
] as const;

interface Draft {
  question: string;
  options: string[];
  allowMultiple: boolean;
  closesInDays: number | null;
}

const EMPTY: Draft = {
  question: '',
  options: ['', ''],
  allowMultiple: false,
  closesInDays: null,
};

export function PollComposer(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [closesSheet, setClosesSheet] = useState(false);
  const create = useCreatePoll();

  useEffect(() => {
    if (props.open) return;
    setClosesSheet(false);
  }, [props.open]);

  const payload = {
    question: draft.question.trim(),
    options: draft.options.map((option) => option.trim()).filter((option) => option.length > 0),
    allowMultiple: draft.allowMultiple,
    closesAt: draft.closesInDays === null ? null : isoInDays(draft.closesInDays),
  };
  const parsed = createPollSchema.safeParse(payload);

  const patch = (next: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const submit = (): void => {
    if (!parsed.success) return;
    create.mutate(parsed.data, {
      onSuccess: () => {
        setDraft(EMPTY);
        props.onOpenChange(false);
      },
    });
  };

  const closesLabel = (
    CLOSES_CHOICES.find((choice) => choice.days === draft.closesInDays) ?? CLOSES_CHOICES[0]
  ).label;

  return (
    <>
      <FormSheet<Draft>
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={WALL_RU.polls.createTitle}
        description={WALL_RU.polls.subtitle}
        submitLabel={WALL_RU.polls.publish}
        onSubmit={submit}
        submitDisabled={!parsed.success}
        submitting={create.isPending}
        dirty={draft.question.trim().length > 0 || payload.options.length > 0}
        draft={{
          key: 'family:wall-poll-draft',
          read: () => draft,
          restore: setDraft,
          enabled: !create.isPending,
        }}
      >
        <SectionStack className="gap-6 pt-2">
          <Section surface="card">
            <div className="w-full max-w-row-measure px-4 py-3">
              <Textarea
                autoFocus
                rows={2}
                maxLength={300}
                aria-label={WALL_RU.polls.question}
                placeholder={WALL_RU.polls.questionPlaceholder}
                value={draft.question}
                onChange={(event) => {
                  patch({ question: event.target.value });
                }}
                className="min-h-16 resize-none border-0 bg-transparent px-0 text-[17px] leading-6 shadow-none focus-visible:ring-0 md:text-[17px]"
              />
            </div>
          </Section>

          <Section label={WALL_RU.polls.options} surface="card">
            {draft.options.map((option, index) => (
              <div
                // Position is the identity here: the rows have no id, and a
                // value-based key would remount the field being typed into.
                key={index}
                className="flex w-full max-w-row-measure items-center gap-2 px-4 py-2"
              >
                <Input
                  value={option}
                  maxLength={160}
                  placeholder={WALL_RU.polls.optionPlaceholder(index + 1)}
                  aria-label={WALL_RU.polls.optionPlaceholder(index + 1)}
                  onChange={(event) => {
                    const next = event.target.value;
                    patch({
                      options: draft.options.map((item, position) =>
                        position === index ? next : item,
                      ),
                    });
                  }}
                  className="h-11 border-0 bg-transparent px-0 text-[17px] shadow-none focus-visible:ring-0 md:text-[17px]"
                />
                {draft.options.length > MIN_OPTIONS ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11 shrink-0 text-muted-foreground"
                    aria-label={WALL_RU.polls.removeOption}
                    onClick={() => {
                      patch({
                        options: draft.options.filter((_item, position) => position !== index),
                      });
                    }}
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </div>
            ))}

            {draft.options.length < MAX_OPTIONS ? (
              <ValueRow
                icon={<Plus />}
                label={WALL_RU.polls.addOption}
                onClick={() => {
                  patch({ options: [...draft.options, ''] });
                }}
              />
            ) : null}
          </Section>

          <Section surface="card">
            <ValueRow
              icon={<Users />}
              label={WALL_RU.polls.allowMultiple}
              trailing={
                <Switch
                  aria-label={WALL_RU.polls.allowMultiple}
                  checked={draft.allowMultiple}
                  onCheckedChange={(checked) => {
                    patch({ allowMultiple: checked });
                  }}
                />
              }
            />
            <ValueRow
              icon={<Clock />}
              label={WALL_RU.polls.closes}
              value={closesLabel}
              onClick={() => {
                setClosesSheet(true);
              }}
            />
          </Section>
        </SectionStack>
      </FormSheet>

      <PickerSheet open={closesSheet} onOpenChange={setClosesSheet} title={WALL_RU.polls.closes}>
        <OptionList label={WALL_RU.polls.closes}>
          {CLOSES_CHOICES.map((choice) => (
            <OptionRow
              key={choice.label}
              label={choice.label}
              selected={draft.closesInDays === choice.days}
              onSelect={() => {
                patch({ closesInDays: choice.days });
                setClosesSheet(false);
              }}
            />
          ))}
        </OptionList>
      </PickerSheet>
    </>
  );
}
