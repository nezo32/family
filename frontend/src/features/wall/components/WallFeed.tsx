import { useCallback, useEffect, useRef } from 'react';
import { MessageSquareHeart } from 'lucide-react';
import { EmptyState, ErrorState } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { pinnedFrom, useRoster, useWallFeed } from '../hooks';
import { WALL_RU } from '../locale';
import { AnnouncementCard } from './AnnouncementCard';
import { ActivityRow } from './ActivityRow';

/**
 * The merged timeline: pinned announcements, then posts and activity in one
 * cursor-paginated stream.
 *
 * **Paginated, not virtualised.** A window virtualiser needs a measured scroll
 * container, and the app's scroll container is the document itself — iOS only
 * collapses the URL bar and only honours "tap the status bar to scroll up" for
 * the document scroller, so the shell deliberately does not create an inner
 * pane. Instead the list stays cheap by pulling twenty rows at a time and
 * letting the browser skip rendering off-screen ones via `content-visibility`,
 * which costs nothing and cannot break scroll restoration.
 */
export function WallFeed() {
  const roster = useRoster();
  const query = useWallFeed();
  const sentinelRef = useAutoLoad(query.hasNextPage, query.isFetchingNextPage, () => {
    void query.fetchNextPage();
  });

  if (query.isPending) return <FeedSkeleton />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const pinned = pinnedFrom(query.data);
  const items = query.data.pages.flatMap((page) => page.items);

  if (pinned.length === 0 && items.length === 0) {
    return (
      <EmptyState
        icon={MessageSquareHeart}
        title={WALL_RU.feed.empty}
        description={WALL_RU.feed.emptyDescription}
      />
    );
  }

  return (
    <div className="space-y-4">
      {pinned.length > 0 ? (
        <section aria-label={WALL_RU.feed.pinnedSection} className="space-y-3">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {WALL_RU.feed.pinnedSection}
          </h2>
          {pinned.map((post) => (
            <AnnouncementCard key={post.id} post={post} roster={roster} emphasised />
          ))}
        </section>
      ) : null}

      <section aria-label={WALL_RU.tabs.feed} className="space-y-2">
        {items.map((item) => (
          <div
            key={`${item.kind}-${item.id}`}
            // Cheap off-screen skipping: the browser stops laying out rows that
            // are nowhere near the viewport, and the intrinsic size keeps the
            // scrollbar honest so nothing jumps when they come back.
            style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}
          >
            {item.kind === 'post' ? (
              <AnnouncementCard post={item.post} roster={roster} />
            ) : (
              <ActivityRow activity={item.activity} roster={roster} />
            )}
          </div>
        ))}
      </section>

      <div ref={sentinelRef} aria-hidden className="h-px" />

      <div className="flex justify-center pb-2">
        {query.hasNextPage ? (
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
        ) : (
          <p className="text-xs text-muted-foreground">{WALL_RU.feed.end}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Fetch the next page when the sentinel comes into view.
 *
 * The explicit "показать ещё" button stays rendered underneath: an
 * `IntersectionObserver` that never fires (reduced data mode, a stubbed
 * environment, a very tall viewport) must not strand the reader.
 */
function useAutoLoad(
  hasNextPage: boolean,
  isFetching: boolean,
  loadMore: () => void,
): (node: HTMLDivElement | null) => void {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  const setNode = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
  }, []);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node || !hasNextPage || isFetching) return;
    if (typeof IntersectionObserver !== 'function') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetching]);

  return setNode;
}

function FeedSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1, 2].map((index) => (
        <div key={index} className="space-y-2 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  );
}
