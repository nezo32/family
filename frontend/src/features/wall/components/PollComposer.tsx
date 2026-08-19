import { useState } from 'react';
import { Plus, Vote, X } from 'lucide-react';
import { createPollSchema } from '@family/shared';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Switch } from '@/shared/ui/switch';
import { InlineSpinner } from '@/shared/components';
import { COMMON } from '@/shared/lib/i18n';
import { useCreatePoll } from '../hooks';
import { WALL_RU } from '../locale';

const MAX_OPTIONS = 10;

/**
 * Ask the family something.
 *
 * The option list is dynamic, so validity is checked by running the shared
 * contract over the draft rather than by re-implementing "at least two
 * non-empty options" here. Nothing is submitted until the contract agrees,
 * which is why this form shows no error text at all: the button is simply not
 * available yet, and an empty option row is self-explanatory.
 */
export function PollComposer() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [closesAtLocal, setClosesAtLocal] = useState('');
  const create = useCreatePoll();

  const draft = {
    question,
    options: options.map((option) => option.trim()).filter((option) => option.length > 0),
    allowMultiple,
    closesAt: toIsoOrNull(closesAtLocal),
  };
  const parsed = createPollSchema.safeParse(draft);

  const reset = (): void => {
    setQuestion('');
    setOptions(['', '']);
    setAllowMultiple(false);
    setClosesAtLocal('');
  };

  const submit = (): void => {
    if (!parsed.success) return;
    create.mutate(parsed.data, {
      onSuccess: () => {
        reset();
        setOpen(false);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" className="min-h-11">
          <Vote className="size-4" aria-hidden />
          {WALL_RU.polls.create}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{WALL_RU.polls.createTitle}</DialogTitle>
          <DialogDescription>{WALL_RU.polls.subtitle}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="poll-question">{WALL_RU.polls.question}</Label>
            <Input
              id="poll-question"
              value={question}
              maxLength={300}
              placeholder={WALL_RU.polls.questionPlaceholder}
              onChange={(event) => {
                setQuestion(event.target.value);
              }}
              className="text-base"
            />
          </div>

          <div className="space-y-2">
            <Label>{WALL_RU.polls.options}</Label>
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={option}
                  maxLength={160}
                  placeholder={WALL_RU.polls.optionPlaceholder(index + 1)}
                  aria-label={WALL_RU.polls.optionPlaceholder(index + 1)}
                  onChange={(event) => {
                    const next = event.target.value;
                    setOptions((current) =>
                      current.map((item, position) => (position === index ? next : item)),
                    );
                  }}
                  className="text-base"
                />
                {options.length > 2 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11 shrink-0 text-muted-foreground"
                    aria-label={WALL_RU.polls.removeOption}
                    onClick={() => {
                      setOptions((current) =>
                        current.filter((_item, position) => position !== index),
                      );
                    }}
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </div>
            ))}
            {options.length < MAX_OPTIONS ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 px-2"
                onClick={() => {
                  setOptions((current) => [...current, '']);
                }}
              >
                <Plus className="size-4" aria-hidden />
                {WALL_RU.polls.addOption}
              </Button>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="poll-multiple" className="cursor-pointer">
              {WALL_RU.polls.allowMultiple}
            </Label>
            <Switch id="poll-multiple" checked={allowMultiple} onCheckedChange={setAllowMultiple} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="poll-closes">{WALL_RU.polls.closesAt}</Label>
            <Input
              id="poll-closes"
              type="datetime-local"
              value={closesAtLocal}
              onChange={(event) => {
                setClosesAtLocal(event.target.value);
              }}
              className="text-base"
            />
            <p className="text-xs text-muted-foreground">{WALL_RU.polls.closesAtHint}</p>
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
              disabled={!parsed.success || create.isPending}
              onClick={submit}
            >
              {create.isPending ? <InlineSpinner className="mr-2" /> : null}
              {WALL_RU.polls.publish}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `datetime-local` yields a wall-clock string with no offset. The deadline is a
 * real instant, so it is resolved against the device clock here; a family whose
 * members sit in different zones will see it rendered in the family timezone by
 * `formatDateTime`, which is the behaviour the format helpers guarantee.
 */
function toIsoOrNull(local: string): string | null {
  if (local.length === 0) return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
