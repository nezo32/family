import { Skeleton } from '@/shared/ui/skeleton';

/** Placeholder rows shaped like `TaskCard`, so nothing jumps when data lands. */
export function TaskListSkeleton(props: { rows?: number }) {
  const rows = props.rows ?? 5;
  return (
    <div className="space-y-6" aria-hidden>
      {[0, 1].map((group) => (
        <div key={group} className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <ul className="space-y-2">
            {Array.from({ length: group === 0 ? rows : 2 }, (_, index) => (
              <li
                key={index}
                className="flex items-start gap-3 rounded-xl border border-border bg-card p-3"
              >
                <Skeleton className="size-11 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </li>
            ))}
          </ul>
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

export function LoadBarSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className="space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-2.5 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}
