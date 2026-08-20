import { ClipboardList } from 'lucide-react';
import { EmptyState, ErrorState } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { Section, type SectionSurface } from '@/shared/ui/section';
import { Skeleton } from '@/shared/ui/skeleton';
import { pinnedFrom, useRoster, useWallFeed } from '../hooks';
import { WALL_RU } from '../locale';
import { AnnouncementNote } from './AnnouncementNote';
import { ActivityRow } from './ActivityRow';
import { BoardComposeInvite, useBoardCompose } from './BoardCompose';

/**
 * The board itself: what is pinned up, and what has happened since.
 *
 * ## Paginated, and deliberately **not** auto-loading
 *
 * The previous build fetched the next page from an `IntersectionObserver` as
 * soon as the sentinel came near the viewport, which made the main column
 * unbounded. That is the single fact that forced Стена to mount a different
 * tree per width: everything the shell places *after* the main column — the
 * side column, which collapses to the bottom of the page below 1088px — is
 * unreachable in practice under a scroll that never ends, so «Спасибо» had to
 * become a tab, and a tab needs a phone-only tree.
 *
 * A board is finite. Twelve notes (≈1.5 phone viewports, §C5's density target)
 * and then one quiet «Что было раньше» row that the reader taps if they want
 * more. The side column below is then one flick away, `useTwoColumn` is gone
 * from this screen, and the board reads as a thing with edges rather than as a
 * feed — which is also the difference between a noticeboard and a chat.
 *
 * ## Two layers, one surface
 *
 * Announcements and activity lines share a single `Section`, hairline-separated
 * (§B3). Twelve bordered cards is twelve boxes of near-identical weight; one
 * surface with notes of different sizes on it is a board. The size difference
 * *is* the hierarchy: «Лиза полила цветы» is a muted line, «В субботу едем к
 * бабушке» is a heading with a body and a discussion under it.
 */
export function WallStream(props: {
  /** Set by `WallPage`'s band-2 precedence. Never decided here (§C2). */
  pinnedSurface: SectionSurface;
}) {
  const roster = useRoster();
  const query = useWallFeed();
  const compose = useBoardCompose();

  if (query.isPending) return <BoardSkeleton />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title={WALL_RU.board.loadError}
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
        icon={ClipboardList}
        title={WALL_RU.board.empty}
        description={
          compose.available.length > 0
            ? WALL_RU.board.emptyDescription
            : WALL_RU.board.emptyReadOnly
        }
        /*
          The one door, as a secondary control — the filled primary is already
          in the app bar (§B4). `BoardComposeInvite` renders nothing for a
          reader who holds no `post:create`, so a guest gets an honest empty
          board instead of a button that would 403.
        */
        action={<BoardComposeInvite kind="post" label={WALL_RU.compose.open} />}
      />
    );
  }

  return (
    <>
      {pinned.length > 0 ? (
        <Section label={WALL_RU.board.pinnedLabel} surface={props.pinnedSurface}>
          {pinned.map((post) => (
            <AnnouncementNote key={post.id} post={post} roster={roster} />
          ))}
        </Section>
      ) : null}

      <Section label={WALL_RU.board.label} surface="card">
        {items.map((item) => (
          <div
            key={`${item.kind}-${item.id}`}
            // Cheap off-screen skipping: the browser stops laying out rows that
            // are nowhere near the viewport, and the intrinsic size keeps the
            // scrollbar honest so nothing jumps when they come back.
            style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}
          >
            {item.kind === 'post' ? (
              <AnnouncementNote post={item.post} roster={roster} />
            ) : (
              <ActivityRow activity={item.activity} roster={roster} />
            )}
          </div>
        ))}
      </Section>

      {/* Band 4 (§C2): quiet, no box, no chrome. */}
      <div className="flex justify-center">
        {query.hasNextPage ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 text-[13px] leading-[18px] font-medium text-muted-foreground"
            disabled={query.isFetchingNextPage}
            onClick={() => {
              void query.fetchNextPage();
            }}
          >
            {query.isFetchingNextPage ? WALL_RU.board.loadingMore : WALL_RU.board.more}
          </Button>
        ) : (
          <p className="py-2 text-[13px] leading-[18px] font-medium text-muted-foreground">
            {WALL_RU.board.end}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The same shape and count as the real thing (§D), so the board does not
 * change size when it arrives.
 */
function BoardSkeleton() {
  return (
    <Section label={WALL_RU.board.label} surface="card">
      {[0, 1, 2].map((index) => (
        <div key={index} className="space-y-2 px-4 py-3" aria-hidden>
          <div className="flex items-center gap-2">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </Section>
  );
}
