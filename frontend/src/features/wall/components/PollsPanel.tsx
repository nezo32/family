import { useState } from 'react';
import { Vote } from 'lucide-react';
import { Can } from '@/shared/auth';
import { EmptyState, ErrorState } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { cn } from '@/shared/lib/utils';
import { usePolls, useRoster } from '../hooks';
import type { PollStatusFilter } from '../api';
import { WALL_RU } from '../locale';
import { PollCard } from './PollCard';
import { PollComposer } from './PollComposer';

const FILTERS: { value: PollStatusFilter; label: string }[] = [
  { value: 'open', label: WALL_RU.polls.filterOpen },
  { value: 'closed', label: WALL_RU.polls.filterClosed },
  { value: 'all', label: WALL_RU.polls.filterAll },
];

/** "Решаем вместе" — the shared-decision surface, kept off the main timeline. */
export function PollsPanel() {
  const [status, setStatus] = useState<PollStatusFilter>('open');
  const roster = useRoster();
  const query = usePolls(status);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={WALL_RU.polls.title}>
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={status === filter.value}
              onClick={() => {
                setStatus(filter.value);
              }}
              className={cn(
                'min-h-11 rounded-full border px-4 text-sm transition-colors',
                status === filter.value
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <Can perm="poll:create">
          <PollComposer />
        </Can>
      </div>

      <p className="text-sm text-muted-foreground">{WALL_RU.polls.subtitle}</p>

      {query.isPending ? (
        <div className="space-y-3" aria-hidden>
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : (
        <PollList query={query} roster={roster} />
      )}
    </div>
  );
}

function PollList(props: {
  query: ReturnType<typeof usePolls>;
  roster: ReturnType<typeof useRoster>;
}) {
  const { query } = props;
  const polls = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (polls.length === 0) {
    return (
      <EmptyState
        icon={Vote}
        title={WALL_RU.polls.empty}
        description={WALL_RU.polls.emptyDescription}
      />
    );
  }

  return (
    <div className="space-y-3">
      {polls.map((poll) => (
        <PollCard key={poll.id} poll={poll} roster={props.roster} />
      ))}
      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={query.isFetchingNextPage}
            onClick={() => {
              void query.fetchNextPage();
            }}
          >
            {query.isFetchingNextPage ? WALL_RU.feed.loadingMore : WALL_RU.feed.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
