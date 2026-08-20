import { Skeleton } from '@/shared/ui/skeleton';

/**
 * Placeholder rows shaped like the real ones, so nothing jumps when the data
 * lands (§D common conventions).
 *
 * Three groups of 3 / 3 / 5 rows at **56px** — the geometry `TaskCard` actually
 * produces. The version this replaces drew 96px bordered cards with a 44px
 * circle, which was the *old* row: the list visibly collapsed by ~400px the
 * moment the query resolved, which is exactly the jump a skeleton exists to
 * prevent.
 */
export function TaskListSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      {[3, 3, 5].map((rows, group) => (
        <div key={group} className="flex flex-col">
          <div className="flex items-center justify-between px-4 pb-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-6" />
          </div>
          <div className="max-w-row-measure overflow-hidden rounded-xl border border-border bg-card">
            {Array.from({ length: rows }, (_, index) => (
              <div key={index} className="flex h-14 items-center gap-3 px-4">
                <Skeleton className="size-7 shrink-0 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="size-6 shrink-0 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TaskDetailSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-4 w-1/3" />
      <div className="space-y-2 rounded-xl border border-border p-4">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/5" />
      </div>
      <Skeleton className="h-11 w-full sm:w-48" />
    </div>
  );
}
