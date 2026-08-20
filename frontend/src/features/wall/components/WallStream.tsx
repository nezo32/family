import { useEffect, useMemo, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import type { WallFeedItem } from '@family/shared';
import { ErrorState } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { Section } from '@/shared/ui/section';
import { Skeleton } from '@/shared/ui/skeleton';
import { COMMON } from '@/shared/lib/i18n';
import { cn } from '@/shared/lib/utils';
import {
  AUTO_LOAD_PAGES,
  buildHead,
  coalesceFeed,
  headFrom,
  useAtLeast,
  useFeedCommit,
  useRoster,
  useWallFeed,
} from '../hooks';
import { WALL_RU } from '../locale';
import { ActivityDigest } from './ActivityRow';
import { AnnouncementNote } from './AnnouncementNote';
import { useBoardCompose } from './BoardCompose';
import { ComposeRow } from './ComposeRow';
import { KudosCard } from './KudosCard';
import { PollCard } from './PollCard';

/**
 * Стена — one continuous stream of cards (§D7, D13).
 *
 * ```
 * ┌────────────────────────────────────────┐
 * │ (П)  Что повесить на доску?         ⊕ │  the one door, never a field
 * ├────────────────────────────────────────┤
 * │ the head: at most one wash, then pins, │  no header, no label, no divider
 * │ then open polls, capped at five        │
 * ├────────────────────────────────────────┤
 * │ the stream, createdAt desc             │
 * └────────────────────────────────────────┘
 *              Это всё, что было
 * ```
 *
 * ## Three departures from the apps whose shape this borrows
 *
 * 1. **The feed ends, visibly.** When `nextCursor` is `null` the last thing on
 *    screen is «Это всё, что было», in `meta`, with no box and no button. Auto
 *    load is bounded to four pages and then *asks*. There is no unread badge
 *    on the «Стена» tab and there never will be. An Instagram feed is
 *    engineered never to bottom out, because bottoming out is when you leave;
 *    a family noticeboard wants you to leave — you came to find out whether
 *    anything needs you, and «нет, это всё» is a good answer.
 * 2. **Reactions are faces, not digits** (`ReactionBar`, §D7.7).
 * 3. **No inline "last comment" preview** (`CommentThread`, §D7.8): the preview
 *    *is* a reply, a visible reply invites a reply, and now the stream is a
 *    conversation with a scroll bar.
 *
 * ## One surface, hairlines, and full bleed on a phone
 *
 * Below `sm` the surface is full-bleed — `-mx-4`, no side border, no radius —
 * so a card is the full 390px and media (when it has a contract) has the whole
 * screen. From `sm` up it is an ordinary L1 surface. `Section` is used **once**,
 * for the whole feed, never once per group: there are no groups, because there
 * are no section headers on this screen at all.
 */
export function WallStream() {
  const roster = useRoster();
  const query = useWallFeed();
  const compose = useBoardCompose();
  const feed = useFeedCommit(query.data);

  /**
   * How many batches of four the reader has granted (§D7.9). The first is
   * free; every «Показать ещё» grants another. Roughly every sixty items the
   * feed stops and asks whether they actually want to keep going.
   */
  const [grants, setGrants] = useState(1);
  const pagesLoaded = query.data?.pages.length ?? 0;
  const autoLoadAllowed = pagesLoaded < AUTO_LOAD_PAGES * grants;

  /**
   * The sentinel is held in **state**, not in a ref, and that is load-bearing.
   *
   * With a ref, the effect below runs on the render where `hasNextPage` flips
   * to `true` — which, because the skeleton is latched on screen for 250 ms
   * (§D7.12), is one render *before* the foot exists in the DOM. `ref.current`
   * is `null`, the effect returns, its dependencies never change again, and
   * the observer is never attached: the feed silently stops after page one.
   * Measured in the built app — fifteen cards, sentinel plainly on screen,
   * exactly one `/wall/feed` request. A callback ref re-runs the effect when
   * the node appears, which is the only signal that cannot be missed.
   */
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  /*
    Read off the query *before* the early returns below: `isPending` and
    `isError` narrow the result union, and inside the success branch
    `isFetchNextPageError` is the literal `false`, so the foot's error row
    would be unreachable code rather than an unreachable state.
  */
  const fetchNext = query.fetchNextPage;
  const fetchingNext = query.isFetchingNextPage;
  const nextPageFailed = query.isFetchNextPageError;
  const hasNextPage = query.hasNextPage;
  const canFetch = hasNextPage && !fetchingNext && !nextPageFailed;

  useEffect(() => {
    if (!sentinel || !canFetch || !autoLoadAllowed) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNext();
      },
      // A little early, so the next page is usually there before the reader is.
      { rootMargin: '400px' },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [sentinel, canFetch, autoLoadAllowed, fetchNext, pagesLoaded]);

  /**
   * The view: page one as the reader last committed it (§D7.10), then every
   * later page live from the query. Ids are de-duplicated because a refetch
   * that grew the top can push a row across a page boundary, and the same card
   * twice is worse than one card late.
   */
  const items = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const first = feed.firstPage;
    const source: WallFeedItem[] = [
      ...(first?.items ?? []),
      ...pages.slice(1).flatMap((p) => p.items),
    ];
    const seen = new Set<string>();
    return source.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  }, [query.data, feed.firstPage]);

  const head = useMemo(
    () =>
      buildHead(
        feed.firstPage
          ? { pinned: feed.firstPage.pinned, openPolls: feed.firstPage.openPolls }
          : headFrom(undefined),
      ),
    [feed.firstPage],
  );

  const blocks = useMemo(() => coalesceFeed(items), [items]);
  // Minimum 250 ms on screen, so a cached or LAN-fast page one cannot make the
  // skeletons flash (§D7.12).
  const loading = useAtLeast(query.isPending);

  if (loading) return <FeedSkeleton />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title={WALL_RU.feed.loadError}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const mayWrite = compose.available.length > 0;
  const isEmpty = head.length === 0 && blocks.length === 0;

  return (
    <div className="flex flex-col">
      {feed.hasPending ? <NewItemsPill onCommit={feed.commit} /> : null}

      <Section
        surface="card"
        // Full bleed below `sm` (§D7.3): the card is the screen down there.
        bodyClassName="-mx-4 rounded-none border-x-0 sm:mx-0 sm:rounded-xl sm:border-x"
      >
        <ComposeRow />

        {head.map((card) =>
          card.kind === 'post' ? (
            <AnnouncementNote
              key={`head-${card.id}`}
              post={card.post}
              roster={roster}
              tone={card.tone}
            />
          ) : (
            <PollCard
              key={`head-${card.id}`}
              poll={card.poll}
              roster={roster}
              tone={card.tone}
              // The card states its own status, because there is no heading
              // above it and colour is never the only signal (§B4).
              eyebrow={
                card.tone === 'attention' ? WALL_RU.polls.needsYou : WALL_RU.polls.openEyebrow
              }
            />
          ),
        )}

        {blocks.map((block) => (
          <div
            key={block.id}
            // Cheap off-screen skipping: the browser stops laying out cards
            // nowhere near the viewport, and the intrinsic size keeps the
            // scrollbar honest so nothing jumps when they come back.
            style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 140px' }}
          >
            {block.kind === 'digest' ? (
              <ActivityDigest items={block.items.map((item) => item.activity)} roster={roster} />
            ) : block.item.kind === 'post' ? (
              <AnnouncementNote post={block.item.post} roster={roster} />
            ) : block.item.kind === 'poll' ? (
              <PollCard poll={block.item.poll} roster={roster} />
            ) : (
              <KudosCard kudos={block.item.kudos} roster={roster} />
            )}
          </div>
        ))}

        {isEmpty && !mayWrite ? (
          /*
            A reader who may not write anything. **Not `EmptyState`**: §E made
            `action` required, and there is no honest action to offer somebody
            whose every write would 403. This is the one place in the app where
            that requirement is met by not using the component.
          */
          <p className="w-full max-w-row-measure px-4 py-6 text-[15px] leading-[22px] text-pretty text-muted-foreground">
            {WALL_RU.feed.emptyReadOnly}
          </p>
        ) : null}
      </Section>

      {isEmpty && mayWrite ? (
        // The compose row *is* the invitation, so no illustration above it —
        // the same rule §D6 applies to the shopping composer.
        <p className="px-4 pt-3 text-[13px] leading-[18px] font-medium text-muted-foreground">
          {WALL_RU.feed.emptyInvite}
        </p>
      ) : null}

      {/* Band 4 (§C2): quiet, no box, no chrome. */}
      <div ref={setSentinel} className="flex flex-col items-center gap-1 pt-4">
        {fetchingNext ? (
          <div className="w-full" aria-hidden>
            <SkeletonCard />
          </div>
        ) : nextPageFailed ? (
          /*
            A later page failed. Quiet, inline, and never `role="alert"`:
            fifteen cards that loaded perfectly well must not be shouted over
            by page four.
          */
          <div className="flex flex-wrap items-center justify-center gap-2">
            <p className="text-[13px] leading-[18px] font-medium text-muted-foreground">
              {WALL_RU.feed.moreError}
            </p>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 text-[13px] font-medium"
              onClick={() => {
                void fetchNext();
              }}
            >
              {COMMON.retry}
            </Button>
          </div>
        ) : hasNextPage ? (
          autoLoadAllowed ? null : (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 text-[13px] leading-[18px] font-medium text-muted-foreground"
              onClick={() => {
                setGrants((value) => value + 1);
                void fetchNext();
              }}
            >
              {WALL_RU.feed.more}
            </Button>
          )
        ) : !isEmpty ? (
          <p className="py-2 text-[13px] leading-[18px] font-medium text-muted-foreground">
            {WALL_RU.feed.end}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * «Новое на стене» (§D7.10) — sticky under the app bar, and carrying **no
 * number**.
 *
 * «Новое на стене · 7» is an unread badge with extra steps, which is the
 * obligation meter §D7.2 refuses. The pill says something is up there; the
 * feed says what.
 *
 * **`h-0`, and that is the whole point of the wrapper.** A sticky element is
 * still in normal flow, so the first version of this pushed the entire feed
 * down by its own height the moment it appeared — measured: the reader's
 * scroll position moved under their thumb while they were reading, which is
 * precisely the failure the pill exists to prevent. Zero height means it
 * floats over the stream and nothing below it moves at all.
 */
function NewItemsPill(props: { onCommit: () => void }) {
  return (
    <div
      className={cn(
        'pointer-events-none sticky z-20 flex h-0 justify-center',
        'top-[calc(var(--spacing-appbar)+env(safe-area-inset-top,0px)+0.5rem)]',
      )}
    >
      <Button
        type="button"
        variant="secondary"
        className="pointer-events-auto h-11 rounded-full border border-border px-4 text-[13px] font-medium shadow-none"
        onClick={props.onCommit}
      >
        <ArrowUp className="size-4" aria-hidden />
        {WALL_RU.feed.newItems}
      </Button>
    </div>
  );
}

/**
 * Three card skeletons of the same shape and count as the real thing (§D7.12),
 * so the feed does not change size when it arrives.
 */
function FeedSkeleton() {
  return (
    <Section
      surface="card"
      bodyClassName="-mx-4 rounded-none border-x-0 sm:mx-0 sm:rounded-xl sm:border-x"
    >
      {[0, 1, 2].map((index) => (
        <SkeletonCard key={index} />
      ))}
    </Section>
  );
}

function SkeletonCard() {
  return (
    <div className="space-y-2 px-4 py-3" aria-hidden>
      <div className="flex items-center gap-2">
        <Skeleton className="size-8 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
