import { useState } from 'react';
import { CalendarPlus, Check, Copy, Rss } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Skeleton } from '@/shared/ui/skeleton';
import { ErrorState } from '@/shared/components/ErrorState';
import { notify } from '@/shared/lib/toast';
import { cn } from '@/shared/lib/utils';
import { useCalendarFeed } from '../hooks';
import { CALENDAR_RU } from '../locale';

/**
 * «Подписаться в Календаре» — the personal ICS feed.
 *
 * This is how the family actually sees events: in the iPhone Calendar app,
 * without opening the PWA. So it lives in the page header and in a card under
 * the calendar, not three levels deep in Settings.
 */
export function SubscribePanel(props: { className?: string }) {
  const feed = useCalendarFeed();
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    const url = feed.data?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      notify.success(CALENDAR_RU.subscribe.copied);
      window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      notify.warning(CALENDAR_RU.subscribe.copyFailed);
    }
  };

  if (feed.isPending) {
    return (
      <div className={cn('space-y-3', props.className)}>
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (feed.isError || !feed.data?.url) {
    return (
      <ErrorState
        className={props.className}
        title={CALENDAR_RU.subscribe.loadFailed}
        error={feed.error}
        onRetry={() => {
          void feed.refetch();
        }}
      />
    );
  }

  const { url, webcalUrl } = feed.data;

  return (
    <div className={cn('space-y-4', props.className)}>
      <p className="text-sm text-muted-foreground">{CALENDAR_RU.subscribe.lead}</p>

      <div className="space-y-2">
        <label
          htmlFor="calendar-feed-url"
          className="text-xs font-medium text-muted-foreground"
        >
          {CALENDAR_RU.subscribe.urlLabel}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="calendar-feed-url"
            readOnly
            value={url}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            className="h-11 min-w-0 flex-1 font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              className="h-11 flex-1"
              onClick={() => {
                void copy();
              }}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? CALENDAR_RU.subscribe.copied : CALENDAR_RU.subscribe.copy}
            </Button>
            <Button asChild variant="outline" className="h-11">
              <a href={webcalUrl}>
                <CalendarPlus aria-hidden />
                <span className="sr-only sm:not-sr-only">
                  {CALENDAR_RU.subscribe.openInCalendar}
                </span>
              </a>
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{CALENDAR_RU.subscribe.privacy}</p>
      </div>

      <div className="rounded-xl bg-muted/60 p-3">
        <h3 className="text-sm font-medium text-foreground">
          {CALENDAR_RU.subscribe.iphoneTitle}
        </h3>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm text-muted-foreground">
          {CALENDAR_RU.subscribe.iphoneSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>

      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">{CALENDAR_RU.subscribe.otherTitle}</h3>
        <p className="text-sm text-muted-foreground">{CALENDAR_RU.subscribe.otherSteps}</p>
      </div>

      <p className="text-xs text-muted-foreground">{CALENDAR_RU.subscribe.refreshNote}</p>
    </div>
  );
}

/** Header action: opens the panel above in a dialog. */
export function SubscribeDialog(props: { trigger?: React.ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {props.trigger ?? (
          <Button variant="outline" className="h-11">
            <Rss aria-hidden />
            {CALENDAR_RU.subscribe.short}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] max-w-lg overflow-y-auto" data-scroll-pane>
        <DialogHeader>
          <DialogTitle>{CALENDAR_RU.subscribe.title}</DialogTitle>
          <DialogDescription className="sr-only">
            {CALENDAR_RU.subscribe.lead}
          </DialogDescription>
        </DialogHeader>
        <SubscribePanel />
      </DialogContent>
    </Dialog>
  );
}

/** The discoverable teaser that sits under the calendar itself. */
export function SubscribeCard() {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-border bg-card/60 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{CALENDAR_RU.subscribe.title}</p>
        <p className="text-sm text-pretty text-muted-foreground">{CALENDAR_RU.subscribe.lead}</p>
      </div>
      <SubscribeDialog
        trigger={
          <Button variant="default" className="h-11 shrink-0">
            <Rss aria-hidden />
            {CALENDAR_RU.subscribe.short}
          </Button>
        }
      />
    </div>
  );
}
