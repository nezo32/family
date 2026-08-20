import type { ReactNode } from 'react';
import { PageHeader } from '@/shared/components/PageHeader';
import { Skeleton } from '@/shared/ui/skeleton';
import { TODAY_RU } from '../locale';

/**
 * The loading state of the home screen (§D common conventions).
 *
 * Two rules, both of which the previous version broke:
 *
 * 1. **The greeting does not get a skeleton.** It comes from `useMe`, which has
 *    already resolved by the time this renders — putting a grey bar where the
 *    reader's own name is about to appear is a placeholder for information we
 *    are not waiting for. The title node is passed straight through.
 * 2. **The shapes match the real content**: one attention-shaped block and
 *    three 56px rows, not two cards with an icon tile and a 44px avatar each.
 *    A skeleton whose geometry differs from the content is just a different
 *    layout that then jumps.
 *
 * No shimmer. A static `--muted` block is calmer, cheaper, and does not animate
 * on the first paint of a cold PWA start (§G8).
 */
export function TodaySkeleton(props: { title?: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{TODAY_RU.loadingLabel}</span>

      {props.title ? <PageHeader displayTitle title={props.title} /> : null}

      <div className="flex flex-col gap-6">
        {/* Band 2: one attention-shaped block, ~120px. */}
        <Skeleton className="h-[120px] w-full max-w-row-measure rounded-xl" />

        {/* Band 3: a section header, then three 56px rows on one surface. */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between px-4 pb-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-14" />
          </div>
          <div className="max-w-row-measure overflow-hidden rounded-xl border border-border bg-card">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex h-14 items-center gap-3 px-4">
                <Skeleton className="size-7 shrink-0 rounded-full" />
                <Skeleton className="h-4 w-2/5" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
