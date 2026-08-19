import { Card } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { TODAY_RU } from '../locale';

/**
 * The loading state of the home screen.
 *
 * A skeleton and not a spinner, because this screen is opened dozens of times a
 * day: the layout must not jump when the data lands, and a centred spinner on
 * the app's first paint reads as "the app is broken" on a slow cell. The shapes
 * below deliberately match the real cards' geometry.
 */
export function TodaySkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{TODAY_RU.loadingLabel}</span>

      <div className="space-y-2 pb-4">
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="h-4 w-40 max-w-full" />
      </div>

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start lg:gap-6">
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          <CardSkeleton rows={3} />
          <CardSkeleton rows={2} />
        </div>
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          <CardSkeleton rows={2} />
          <CardSkeleton rows={1} />
        </div>
      </div>
    </div>
  );
}

function CardSkeleton(props: { rows: number }) {
  return (
    <Card className="gap-0 py-4">
      <div className="flex items-center gap-3 px-4 sm:px-5">
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="space-y-3 px-4 pt-4 sm:px-5">
        {Array.from({ length: props.rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="size-11 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
