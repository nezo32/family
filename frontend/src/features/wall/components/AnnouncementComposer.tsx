import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { PenLine } from 'lucide-react';
import { createPostSchema } from '@family/shared';
import type { z } from 'zod';
import { useCan } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/shared/ui/form';
import { Input } from '@/shared/ui/input';
import { Textarea } from '@/shared/ui/textarea';
import { Label } from '@/shared/ui/label';
import { InlineSpinner } from '@/shared/components';
import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { isoInDays } from '../api';
import { useCreatePost } from '../hooks';
import { WALL_RU } from '../locale';

/**
 * Write an announcement.
 *
 * Pinning is folded into the composer rather than hidden behind a second step,
 * because "закрепить на неделю" is a decision people make while writing. The
 * control only exists for a holder of `post:pin` — a teenager writing «я дома»
 * never sees it (D4: `useCan()`, never a role comparison).
 */

const composerSchema = createPostSchema.omit({ pinnedUntil: true });
type ComposerInput = z.input<typeof composerSchema>;
type ComposerValues = z.output<typeof composerSchema>;

/** `null` = do not pin. Otherwise the number of days the pin should live. */
const PIN_CHOICES = [
  { days: null, label: WALL_RU.post.pinNone },
  { days: 1, label: WALL_RU.post.pinDay },
  { days: 3, label: WALL_RU.post.pinThreeDays },
  { days: 7, label: WALL_RU.post.pinWeek },
] as const;

export function AnnouncementComposer() {
  const [open, setOpen] = useState(false);
  const [pinDays, setPinDays] = useState<number | null>(null);
  const { can } = useCan();
  const create = useCreatePost();

  const form = useForm<ComposerInput, unknown, ComposerValues>({
    resolver: zodResolver(composerSchema),
    defaultValues: { title: '', body: '' },
  });

  const mayPin = can('post:pin');

  const submit = form.handleSubmit((values) => {
    const title = values.title?.trim();
    create.mutate(
      {
        ...(title && title.length > 0 ? { title } : {}),
        body: values.body,
        pinnedUntil: mayPin && pinDays !== null ? isoInDays(pinDays) : null,
      },
      {
        onSuccess: () => {
          form.reset({ title: '', body: '' });
          setPinDays(null);
          setOpen(false);
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" className="min-h-11">
          <PenLine className="size-4" aria-hidden />
          {WALL_RU.post.compose}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{WALL_RU.post.composeTitle}</DialogTitle>
          <DialogDescription>{WALL_RU.post.composeDescription}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={submit} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{WALL_RU.post.fieldTitle}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      maxLength={160}
                      placeholder={WALL_RU.post.fieldTitlePlaceholder}
                      className="text-base"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="body"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{WALL_RU.post.fieldBody}</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={4}
                      maxLength={8000}
                      placeholder={WALL_RU.post.fieldBodyPlaceholder}
                      className="text-base"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {mayPin ? (
              <div className="space-y-2">
                <Label>{WALL_RU.post.pinFor}</Label>
                <div className="flex flex-wrap gap-2" role="group" aria-label={WALL_RU.post.pinFor}>
                  {PIN_CHOICES.map((choice) => (
                    <button
                      key={choice.label}
                      type="button"
                      aria-pressed={pinDays === choice.days}
                      onClick={() => {
                        setPinDays(choice.days);
                      }}
                      className={cn(
                        'min-h-11 rounded-full border px-4 text-sm transition-colors',
                        pinDays === choice.days
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-accent',
                      )}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

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
              <Button type="submit" className="min-h-11" disabled={create.isPending}>
                {create.isPending ? <InlineSpinner className="mr-2" /> : null}
                {create.isPending ? WALL_RU.post.publishing : WALL_RU.post.publish}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
