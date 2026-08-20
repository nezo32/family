import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  CommentListResponse,
  CommentResponse,
  CreatePoll,
  CreatePost,
  EntityRef,
  KudosCreate,
  KudosResponse,
  PollListResponse,
  PollResponse,
  PostResponse,
  PublicUser,
  ReactionSummary,
  WallClearResponse,
  WallFeedItem,
} from '@family/shared';
import { hasErrorCode } from '@/shared/api/errors';
import { notify } from '@/shared/lib/toast';
import { useCan } from '@/shared/auth';
import { usePrefersReducedMotion } from '@/shared/ui/use-reduced-motion';
import {
  clearWall,
  closePoll,
  createComment,
  createPoll,
  createPost,
  deleteComment,
  deletePost,
  fetchComments,
  fetchKudos,
  fetchKudosTotals,
  fetchMembers,
  fetchPolls,
  fetchReactions,
  fetchWallFeed,
  giveKudos,
  restoreWall,
  setPostPin,
  toggleReaction,
  votePoll,
  wallKeys,
  type KudosListResponse,
  type KudosTotals,
  type PollStatusFilter,
  type WallFeedPage,
} from './api';
import { WALL_RU } from './locale';

/**
 * TanStack Query wrappers for the wall.
 *
 * The interesting part here is the optimism. Reactions, comments and votes are
 * the three things a family member does dozens of times a day from a phone on a
 * bad connection, and each one must feel instant. All three therefore write to
 * the query cache in `onMutate`, keep the previous value in the mutation
 * context, and put it back in `onError` — a failed tap leaves the UI exactly as
 * it was, never in a half-applied state.
 *
 * The feed cursor is opaque (base64url keyset). It is read from `nextCursor`
 * and handed straight back; nothing in this file constructs one.
 */

/**
 * Fifteen (§D7.9), up from the board's twelve: after activity coalescing that
 * is roughly two phone viewports of mixed content.
 */
export const FEED_PAGE_SIZE = 15;

/**
 * How many pages the sentinel may fetch before the feed stops and **asks**
 * (§D7.9).
 *
 * This is the board's first refusal, kept as a feed mechanic: an unbounded
 * scroll creates obligation, and a family of six must not feel behind on their
 * own kitchen wall. Four pages is roughly sixty items — at which point the
 * reader is asked, once, whether they actually want to keep going. An
 * Instagram feed is engineered never to bottom out because bottoming out is
 * when you leave; a family noticeboard wants you to leave.
 */
export const AUTO_LOAD_PAGES = 4;

const COMMENT_PAGE_SIZE = 30;
const KUDOS_WINDOW_DAYS = 30;

/** Marks a row that exists only in the cache while its POST is in flight. */
const OPTIMISTIC_PREFIX = 'optimistic:';

export function isOptimistic(id: string): boolean {
  return id.startsWith(OPTIMISTIC_PREFIX);
}

function optimisticId(): string {
  const webCrypto: Crypto | undefined = globalThis.crypto;
  const suffix =
    typeof webCrypto?.randomUUID === 'function'
      ? webCrypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}${String(Date.now())}`;
  return `${OPTIMISTIC_PREFIX}${suffix}`;
}

/* ========================================================================== */
/* the merged feed                                                             */
/* ========================================================================== */

export function useWallFeed(): UseInfiniteQueryResult<InfiniteData<WallFeedPage>, Error> {
  return useInfiniteQuery({
    queryKey: wallKeys.feed(),
    queryFn: ({ pageParam, signal }) =>
      fetchWallFeed({ cursor: pageParam, limit: FEED_PAGE_SIZE }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // The wall is a "what happened while I was away" surface; a 30s window keeps
    // a tab switch from re-fetching six pages.
    staleTime: 30_000,
    // Page one renders from cache while offline (§D7.12), so the compose row
    // and everything already read still work on a train.
    gcTime: 30 * 60_000,
  });
}

/**
 * The head (§D7.4): live pins and open polls, both served outside the cursor
 * stream, so they exist on page one only and never move as the feed grows.
 */
export function headFrom(data: InfiniteData<WallFeedPage> | undefined): {
  pinned: PostResponse[];
  openPolls: PollResponse[];
} {
  const first = data?.pages[0];
  return { pinned: first?.pinned ?? [], openPolls: first?.openPolls ?? [] };
}

/*
  The feed also echoes `clearedAt`, the «Очистить доску» horizon. Nothing reads
  it on the client and nothing should have to: the clear writes a system post
  stamped just after the horizon, so the *feed itself* explains its own floor —
  «Доску очистили 20 августа» — rather than the UI having to infer it.
*/

/* -------------------------------------------------------------------------- */
/* the head, as a pure function                                                */
/* -------------------------------------------------------------------------- */

export type HeadCard =
  | { kind: 'poll'; id: string; poll: PollResponse; tone: 'attention' | 'plain' }
  | { kind: 'post'; id: string; post: PostResponse; tone: 'attention' | 'plain' };

/**
 * What floats above the stream, and which single card is loud.
 *
 * §D7.4, evaluated live on every render:
 *
 * 1. **At most one card in the attention wash.** Precedence: an open poll the
 *    reader has not answered → a live pin → nothing. §C2 band 2 allows exactly
 *    one tinted card per screen, and answering the poll moves the wash to the
 *    pin in the same frame because this is a function, not state.
 * 2. Then the remaining live pins, then the remaining open polls.
 * 3. **Capped at five.** Beyond that, excess pins stay in chronological
 *    position — a head that fills the first viewport has become a section with
 *    the label filed off, which is the one thing «не делить явно на секции»
 *    was about.
 *
 * Colour is never the only signal (§B4): every card the head returns states
 * its status in words on its own eyebrow line, which is the card's job, not
 * this function's.
 */
export const HEAD_CARD_LIMIT = 5;

export function buildHead(head: {
  pinned: readonly PostResponse[];
  openPolls: readonly PollResponse[];
}): HeadCard[] {
  const unanswered = head.openPolls.find((poll) => !isAnsweredByMe(poll));
  const cards: HeadCard[] = [];

  if (unanswered) {
    cards.push({ kind: 'poll', id: unanswered.id, poll: unanswered, tone: 'attention' });
  }

  head.pinned.forEach((post, index) => {
    const tone = !unanswered && index === 0 ? 'attention' : 'plain';
    cards.push({ kind: 'post', id: post.id, post, tone });
  });

  for (const poll of head.openPolls) {
    if (poll.id === unanswered?.id) continue;
    cards.push({ kind: 'poll', id: poll.id, poll, tone: 'plain' });
  }

  return cards.slice(0, HEAD_CARD_LIMIT);
}

/* -------------------------------------------------------------------------- */
/* activity coalescing                                                         */
/* -------------------------------------------------------------------------- */

export type FeedBlock =
  | { kind: 'card'; id: string; item: Exclude<WallFeedItem, { kind: 'activity' }> }
  | { kind: 'digest'; id: string; items: Extract<WallFeedItem, { kind: 'activity' }>[] };

/**
 * A run of **consecutive** activity items renders as **one** card (§D7.6).
 *
 * This is the mechanic that makes a chronological feed survivable, and it is
 * the direct answer to "recency ordering treats an unanswered poll and «Лиза
 * полила цветы» identically". Without it a Saturday of chores produces twenty
 * near-identical muted lines and the announcement about Sunday sits below all
 * of them — which is exactly the burial the board's ordering prevented.
 *
 * The rule is about runs, not about a minimum: a single activity item between
 * two announcements is still a one-line digest card of the same kind.
 */
export function coalesceFeed(items: readonly WallFeedItem[]): FeedBlock[] {
  const blocks: FeedBlock[] = [];
  for (const item of items) {
    if (item.kind === 'activity') {
      const last = blocks.at(-1);
      if (last?.kind === 'digest') {
        last.items.push(item);
        continue;
      }
      blocks.push({ kind: 'digest', id: `digest-${item.id}`, items: [item] });
      continue;
    }
    blocks.push({ kind: 'card', id: `${item.kind}-${item.id}`, item });
  }
  return blocks;
}

/**
 * Keeps a skeleton on screen for at least 250 ms once it has appeared (§D7.12,
 * and the common convention at the head of §D).
 *
 * A cached or LAN-fast page one answers in ~30 ms, and three skeleton cards
 * that appear and vanish inside two frames read as a glitch rather than as
 * loading. This latches on the first `true` and releases on a timer, so the
 * feed either does not flash or does not flicker.
 */
export function useAtLeast(active: boolean, ms = 250): boolean {
  const [held, setHeld] = useState(active);
  const since = useRef<number>(active ? Date.now() : 0);

  useEffect(() => {
    if (active) {
      if (!held) since.current = Date.now();
      setHeld(true);
      return;
    }
    const elapsed = Date.now() - since.current;
    if (elapsed >= ms) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => {
      setHeld(false);
    }, ms - elapsed);
    return () => {
      clearTimeout(timer);
    };
  }, [active, held, ms]);

  return held;
}

/* ========================================================================== */
/* announcements                                                               */
/* ========================================================================== */

interface FeedSnapshot {
  previous: InfiniteData<WallFeedPage> | undefined;
}

/**
 * Writing a note, with the card appearing before the server answers (§D7.10).
 *
 * **The reader's own post never goes behind the «Новое на стене» pill.** The
 * optimistic row goes straight into page one, `markSelfWrite()` tells the feed
 * to commit rather than hold, and a failure rolls the whole page back and
 * says so — you always see your own note appear.
 */
export function useCreatePost(): UseMutationResult<PostResponse, Error, CreatePost, FeedSnapshot> {
  const queryClient = useQueryClient();
  const { userId } = useCan();
  const key = wallKeys.feed();

  return useMutation<PostResponse, Error, CreatePost, FeedSnapshot>({
    mutationFn: (body: CreatePost) => createPost(body),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<InfiniteData<WallFeedPage>>(key);
      const now = new Date().toISOString();
      const draft: PostResponse = {
        id: optimisticId(),
        authorId: userId ?? null,
        type: 'announcement',
        title: body.title?.trim() ? body.title.trim() : null,
        body: body.body,
        pinnedUntil: body.pinnedUntil ?? null,
        // An optimistic pin never joins the head: the head is server state, and
        // a card that jumped there and back would be worse than one that waits.
        isPinned: false,
        commentCount: 0,
        reactions: [],
        /*
          Empty, and it stays empty until the server answers.

          The composer knows the ids it just claimed, but not the `width`,
          `height` or `durationMs` that go with them — and those are exactly
          what reserves the aspect box (§D7.14.2). Drawing a guessed box that
          the real dimensions then correct is the reflow the whole reservation
          exists to prevent, and it would happen on the reader's *own* note,
          which is the one card they are certainly watching. So the optimistic
          card is the words, and the photo arrives a beat later with its own
          shape already known.

          `attachments` is `.default([])` in the contract now rather than
          `.optional()`, which is what lets this be an honest empty array
          instead of an omitted field.
        */
        attachments: [],
        createdAt: now,
        updatedAt: now,
      };

      markSelfWrite();
      queryClient.setQueryData<InfiniteData<WallFeedPage>>(key, (data) => {
        if (!data) return data;
        const [first, ...rest] = data.pages;
        if (!first) return data;
        return {
          ...data,
          pages: [
            {
              ...first,
              items: [
                { kind: 'post' as const, id: draft.id, createdAt: now, post: draft },
                ...first.items,
              ],
            },
            ...rest,
          ],
        };
      });
      return { previous };
    },
    onError: (error, _body, context) => {
      if (context) queryClient.setQueryData(key, context.previous);
      notify.error(error);
    },
    onSuccess: () => {
      notify.success(WALL_RU.post.published);
      markSelfWrite();
      void queryClient.invalidateQueries({ queryKey: wallKeys.feed() });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* «Новое на стене» — the pill, and who is allowed to move the feed            */
/* -------------------------------------------------------------------------- */

/**
 * Set when *this reader* wrote something, cleared when the feed commits.
 *
 * D12 polls `/api/changes` and invalidates `['wall']` within ~20 s, and a
 * stream that grows above a thumb halfway down it is the classic way to lose a
 * reader's place (§D7.10). So a refetch that arrives while the reader is
 * scrolled down is **held** behind a pill — except when the new row is their
 * own note, which must always appear.
 *
 * A module-level flag rather than context or query meta: the writer
 * (`useCreatePost`) and the reader (`useFeedCommit`) are in different subtrees
 * with no common owner but the page, and one boolean that is set immediately
 * before a cache write and consumed on the very next render is easier to
 * verify than a provider threaded through both.
 */
let selfWrite = false;

export function markSelfWrite(): void {
  selfWrite = true;
}

export function consumeSelfWrite(): boolean {
  const value = selfWrite;
  selfWrite = false;
  return value;
}

/** What "the head of the feed changed" means: the top card, the pins, the open polls. */
function headSignature(page: WallFeedPage | undefined): string {
  if (!page) return '';
  return [
    page.items[0]?.id ?? '',
    page.pinned.map((post) => post.id).join(','),
    page.openPolls.map((poll) => poll.id).join(','),
    page.clearedAt ?? '',
  ].join('|');
}

export interface FeedCommit {
  /** The page-one snapshot the reader is actually looking at. */
  firstPage: WallFeedPage | undefined;
  /** Something newer is waiting above them. The pill says so; it never says how many. */
  hasPending: boolean;
  /** Take the new head and go to the top, in one action. */
  commit: () => void;
}

/**
 * Holds a growing head above the reader's thumb (§D7.10).
 *
 * > New items are never inserted above the reader's viewport. If `scrollY > 0`,
 * > page one refetches into the cache and the feed does **not** re-render its
 * > head; a pill appears instead, and it carries no number.
 *
 * Only page **one** is frozen. Later pages come straight from the query, so a
 * bounded auto-load keeps working while the pill is up, and «Показать ещё»
 * still appends. `scrollY === 0` inserts directly and silently — the reader is
 * at the top, content grows downward from the compose row, and nothing they
 * are reading moves. Pull-to-refresh (§G6) only fires at the top, so it takes
 * the same silent path and dismisses the pill on the way.
 *
 * No count on the pill, deliberately: «Новое на стене · 7» is an unread badge
 * with extra steps, and that is the obligation meter §D7.2 refuses.
 */
export function useFeedCommit(data: InfiniteData<WallFeedPage> | undefined): FeedCommit {
  const [frozen, setFrozen] = useState<WallFeedPage | null>(null);
  const shown = useRef<{ page: WallFeedPage; signature: string } | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const live = data?.pages[0];

  useEffect(() => {
    if (!live) return;
    const signature = headSignature(live);

    // First page ever, or the reader is already holding an older one.
    if (shown.current === null) {
      shown.current = { page: live, signature };
      return;
    }
    if (frozen !== null) return;

    // Pagination, an edited body, a new comment count: same head, no pill.
    if (signature === shown.current.signature) {
      shown.current = { page: live, signature };
      return;
    }

    // Their own note, or they are at the top and nothing they read can move.
    if (consumeSelfWrite() || window.scrollY <= 0) {
      shown.current = { page: live, signature };
      return;
    }

    setFrozen(shown.current.page);
  }, [live, frozen]);

  const commit = useCallback(() => {
    if (live) shown.current = { page: live, signature: headSignature(live) };
    setFrozen(null);
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [live, reducedMotion]);

  return { firstPage: frozen ?? live, hasPending: frozen !== null, commit };
}

export function useSetPin(): UseMutationResult<
  PostResponse,
  Error,
  { id: string; pinnedUntil: string | null }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pinnedUntil }: { id: string; pinnedUntil: string | null }) =>
      setPostPin(id, pinnedUntil),
    onSuccess: (_post, variables) => {
      notify.success(variables.pinnedUntil ? WALL_RU.post.pinnedToast : WALL_RU.post.unpinnedToast);
      void queryClient.invalidateQueries({ queryKey: wallKeys.feed() });
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

export function useDeletePost(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePost(id),
    onSuccess: () => {
      notify.success(WALL_RU.post.deleted);
      void queryClient.invalidateQueries({ queryKey: wallKeys.feed() });
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

/* ========================================================================== */
/* comments                                                                    */
/* ========================================================================== */

export function useComments(
  ref: EntityRef,
  enabled: boolean,
): UseInfiniteQueryResult<InfiniteData<CommentListResponse>, Error> {
  return useInfiniteQuery({
    queryKey: wallKeys.comments(ref),
    queryFn: ({ pageParam, signal }) =>
      fetchComments(ref, { cursor: pageParam, limit: COMMENT_PAGE_SIZE }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // A thread is only fetched once its card is expanded — a feed page would
    // otherwise fire twenty requests nobody asked for.
    enabled,
    staleTime: 15_000,
  });
}

export function flattenComments(
  data: InfiniteData<CommentListResponse> | undefined,
): CommentResponse[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

interface CommentsSnapshot {
  previous: InfiniteData<CommentListResponse> | undefined;
}

/**
 * What the composer sends: words, an attachment, or both (§D7.8b).
 *
 * It used to be a bare `string`. A comment may now be **media-only** — a photo
 * with no words is a legitimate reply («вот, купила») and forcing a caption
 * produces «вот» five hundred times — so the mutation takes the pair, and the
 * service enforces the same *body or attachment, at least one* rule the post
 * route does.
 */
export interface NewComment {
  body: string;
  attachmentIds: readonly string[];
}

export function useAddComment(
  ref: EntityRef,
): UseMutationResult<CommentResponse, Error, NewComment, CommentsSnapshot> {
  const queryClient = useQueryClient();
  const { userId } = useCan();
  const key = wallKeys.comments(ref);

  return useMutation<CommentResponse, Error, NewComment, CommentsSnapshot>({
    mutationFn: (input: NewComment) =>
      createComment(ref, {
        body: input.body,
        ...(input.attachmentIds.length > 0 ? { attachmentIds: [...input.attachmentIds] } : {}),
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<InfiniteData<CommentListResponse>>(key);
      const now = new Date().toISOString();
      const draft: CommentResponse = {
        id: optimisticId(),
        entityType: ref.entityType,
        entityId: ref.entityId,
        authorId: userId ?? '',
        body: input.body,
        reactions: [],
        // Empty for the same reason a post's optimistic draft is — the
        // dimensions that reserve the box are the server's to state.
        attachments: [],
        createdAt: now,
        updatedAt: now,
      };
      // Comments read oldest-first, so a new one belongs at the end of the last
      // page. With no page loaded yet we mint one rather than dropping it.
      queryClient.setQueryData<InfiniteData<CommentListResponse>>(key, (data) => {
        if (!data || data.pages.length === 0) {
          return {
            pages: [{ items: [draft], nextCursor: null }],
            pageParams: [null],
          };
        }
        const pages = data.pages.map((page, index) =>
          index === data.pages.length - 1 ? { ...page, items: [...page.items, draft] } : page,
        );
        return { ...data, pages };
      });
      return { previous };
    },
    onError: (error, _body, context) => {
      if (context) queryClient.setQueryData(key, context.previous);
      notify.error(error);
    },
    onSuccess: (created) => {
      // Swap the placeholder for the real row in place, so the thread does not
      // jump while the list re-sorts.
      queryClient.setQueryData<InfiniteData<CommentListResponse>>(key, (data) => {
        if (!data) return data;
        let replaced = false;
        const pages = data.pages.map((page) => ({
          ...page,
          items: page.items.map((item) => {
            if (replaced || !isOptimistic(item.id)) return item;
            replaced = true;
            return created;
          }),
        }));
        return { ...data, pages };
      });
      void queryClient.invalidateQueries({ queryKey: wallKeys.feed() });
    },
  });
}

export function useDeleteComment(
  ref: EntityRef,
): UseMutationResult<void, Error, string, CommentsSnapshot> {
  const queryClient = useQueryClient();
  const key = wallKeys.comments(ref);

  return useMutation<void, Error, string, CommentsSnapshot>({
    mutationFn: (id: string) => deleteComment(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<InfiniteData<CommentListResponse>>(key);
      queryClient.setQueryData<InfiniteData<CommentListResponse>>(key, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== id),
              })),
            }
          : data,
      );
      return { previous };
    },
    onError: (error, _id, context) => {
      if (context) queryClient.setQueryData(key, context.previous);
      notify.error(error);
    },
    onSuccess: () => {
      notify.success(WALL_RU.comments.deleted);
      void queryClient.invalidateQueries({ queryKey: wallKeys.feed() });
    },
  });
}

/* ========================================================================== */
/* reactions                                                                   */
/* ========================================================================== */

/**
 * Pure toggle over a reaction summary — the same rule the server applies, so
 * the optimistic render and the answer agree.
 *
 * An emoji that drops to zero is removed entirely rather than left as a `0`
 * chip; a row of empty counters is visual noise.
 */
export function applyReactionToggle(
  summaries: readonly ReactionSummary[],
  emoji: string,
  userId: string | null,
): ReactionSummary[] {
  const existing = summaries.find((item) => item.emoji === emoji);
  if (!existing) {
    return [...summaries, { emoji, count: 1, reacted: true, userIds: userId ? [userId] : [] }];
  }

  return summaries
    .map((item) => {
      if (item.emoji !== emoji) return item;
      const userIds = item.reacted
        ? item.userIds.filter((id) => id !== userId)
        : userId && !item.userIds.includes(userId)
          ? [...item.userIds, userId]
          : item.userIds;
      return {
        ...item,
        // The faces move with the tap, not just the tally: the chip *is* the
        // discs (§D7.7), so an optimistic toggle that left them alone would
        // draw a chip nobody is on.
        userIds,
        count: item.reacted ? Math.max(0, item.count - 1) : item.count + 1,
        reacted: !item.reacted,
      };
    })
    .filter((item) => item.count > 0);
}

/**
 * Reaction state for one target, held in its own cache entry.
 *
 * The list arrives embedded in whatever carried the row (a feed page, a comment
 * page), but the toggle has to mutate it in isolation and roll back cleanly, so
 * it gets a key of its own seeded from that payload. The query never fetches on
 * its own — `enabled: false` — because the data is already on screen; the
 * fetcher exists for an explicit refetch.
 */
export function useReactionState(ref: EntityRef, server: readonly ReactionSummary[]) {
  const queryClient = useQueryClient();
  // Keyed on the two primitives, not on `ref`: callers pass an inline object, and
  // a fresh identity every render would re-seed over an in-flight toggle.
  const { entityType, entityId } = ref;
  const key = useMemo(() => wallKeys.reactions({ entityType, entityId }), [entityType, entityId]);
  const signature = reactionSignature(server);
  const serverRef = useRef(server);
  serverRef.current = server;

  // Re-seed only when the server payload genuinely changed: re-seeding on every
  // render would stamp on an in-flight optimistic toggle.
  useEffect(() => {
    queryClient.setQueryData<ReactionSummary[]>(key, [...serverRef.current]);
  }, [queryClient, key, signature]);

  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchReactions(ref, signal).then((response) => response.reactions),
    enabled: false,
    initialData: () => [...server],
    staleTime: Infinity,
  });

  return query.data;
}

function reactionSignature(summaries: readonly ReactionSummary[]): string {
  // The reactor ids are part of what is drawn now (§D7.7), so a chip that
  // gained a face without changing its count is still a changed payload.
  return summaries
    .map((item) => `${item.emoji}:${item.userIds.join(',')}:${item.reacted ? '1' : '0'}`)
    .join('|');
}

interface ReactionSnapshot {
  previous: ReactionSummary[] | undefined;
}

export function useToggleReaction(
  ref: EntityRef,
): UseMutationResult<ReactionSummary[], Error, string, ReactionSnapshot> {
  const queryClient = useQueryClient();
  const { userId } = useCan();
  const { entityType, entityId } = ref;
  const key = useMemo(() => wallKeys.reactions({ entityType, entityId }), [entityType, entityId]);

  return useMutation<ReactionSummary[], Error, string, ReactionSnapshot>({
    mutationFn: (emoji: string) =>
      toggleReaction(ref, emoji).then((response) => response.reactions),
    onMutate: async (emoji) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ReactionSummary[]>(key);
      queryClient.setQueryData<ReactionSummary[]>(key, (current) =>
        applyReactionToggle(current ?? [], emoji, userId),
      );
      return { previous };
    },
    onError: (error, _emoji, context) => {
      // Put the counter back exactly as it was. A reaction that silently sticks
      // when the request failed is worse than one that visibly bounces back.
      if (context) queryClient.setQueryData(key, context.previous);
      notify.error(error);
    },
    onSuccess: (summaries) => {
      queryClient.setQueryData<ReactionSummary[]>(key, summaries);
    },
  });
}

/* ========================================================================== */
/* polls                                                                       */
/* ========================================================================== */

const POLLS_ROOT: QueryKey = ['wall', 'polls'];

export function usePolls(
  status: PollStatusFilter,
): UseInfiniteQueryResult<InfiniteData<PollListResponse>, Error> {
  return useInfiniteQuery({
    queryKey: wallKeys.polls(status),
    queryFn: ({ pageParam, signal }) => fetchPolls({ status, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 30_000,
  });
}

/**
 * Pure vote application, mirroring the service rule: re-voting **replaces** the
 * caller's previous selection, and a single-choice poll keeps exactly one id.
 */
export function applyVote(
  poll: PollResponse,
  optionIds: readonly string[],
  userId: string | null,
): PollResponse {
  const chosen = new Set(poll.allowMultiple ? optionIds : optionIds.slice(0, 1));
  const previous = new Set(poll.myOptionIds);

  const options = poll.options.map((option) => {
    const wasChosen = previous.has(option.id);
    const isChosen = chosen.has(option.id);
    if (wasChosen === isChosen) return option;

    const voterIds =
      isChosen && userId
        ? option.voterIds.includes(userId)
          ? option.voterIds
          : [...option.voterIds, userId]
        : option.voterIds.filter((id) => id !== userId);

    return {
      ...option,
      voteCount: Math.max(0, option.voteCount + (isChosen ? 1 : -1)),
      voterIds,
    };
  });

  const votedBefore = previous.size > 0;
  const votesNow = chosen.size > 0;
  const delta = votesNow && !votedBefore ? 1 : !votesNow && votedBefore ? -1 : 0;

  return {
    ...poll,
    options,
    myOptionIds: [...chosen],
    totalVoters: Math.max(0, poll.totalVoters + delta),
  };
}

/**
 * Has the reader answered this poll?
 *
 * This is the predicate that decides what the board shouts about (§D7): an
 * unanswered open poll is the one thing on Стена that is genuinely addressed to
 * *you*, and it is what takes the attention wash. Once you have answered, the
 * same poll stays on the board and stops being loud.
 */
export function isAnsweredByMe(poll: PollResponse): boolean {
  return poll.myOptionIds.length > 0;
}

/**
 * Everyone who has answered, once each, in option order.
 *
 * Rendered as member discs rather than as «Проголосовали: 3». The discs say the
 * useful thing — whom the family is still waiting on — without printing a
 * number beside anybody's name, and a poll is a decision, not a tally of
 * people.
 */
export function votersOf(poll: PollResponse): string[] {
  const seen = new Set<string>();
  for (const option of poll.options) {
    for (const id of option.voterIds) seen.add(id);
  }
  return [...seen];
}

/**
 * What the family decided: the option with the most answers, or `null` when two
 * options tie at the top.
 *
 * A tie is reported as a tie rather than resolved by array order — «Решили: на
 * дачу» when half the family said «в город» is the kind of quiet lie a family
 * app cannot afford.
 */
export function decidedOption(poll: PollResponse): { label: string; share: number } | null {
  let best: { label: string; voteCount: number } | null = null;
  let tied = false;
  for (const option of poll.options) {
    if (!best || option.voteCount > best.voteCount) {
      best = { label: option.label, voteCount: option.voteCount };
      tied = false;
    } else if (option.voteCount === best.voteCount) {
      tied = true;
    }
  }
  if (!best || tied || best.voteCount === 0) return null;
  return {
    label: best.label,
    share: Math.round((best.voteCount / Math.max(1, poll.totalVoters)) * 100),
  };
}

interface PollsSnapshot {
  previous: [QueryKey, InfiniteData<PollListResponse> | undefined][];
  /** The feed carries its own copy of every open poll, so it rolls back too. */
  feed?: { key: QueryKey; data: InfiniteData<WallFeedPage> } | undefined;
}

/**
 * Applies one change to every cache a poll can be sitting in.
 *
 * Since §D7 that is **two**: `['wall','polls']`, which «Что решили» reads, and
 * the feed — where an open poll rides in the head and a closed one takes its
 * chronological place. Patching only the first is how an optimistic vote used
 * to look like it had not registered: the card the reader was actually looking
 * at came from the feed.
 */
function patchPollCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  pollId: string,
  update: (poll: PollResponse) => PollResponse,
): void {
  queryClient.setQueriesData<InfiniteData<PollListResponse>>({ queryKey: POLLS_ROOT }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((poll) => (poll.id === pollId ? update(poll) : poll)),
          })),
        }
      : data,
  );

  queryClient.setQueryData<InfiniteData<WallFeedPage>>(wallKeys.feed(), (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            openPolls: page.openPolls.map((poll) => (poll.id === pollId ? update(poll) : poll)),
            items: page.items.map((item) =>
              item.kind === 'poll' && item.poll.id === pollId
                ? { ...item, poll: update(item.poll) }
                : item,
            ),
          })),
        }
      : data,
  );
}

export function useVotePoll(): UseMutationResult<
  PollResponse,
  Error,
  { pollId: string; optionIds: string[] },
  PollsSnapshot
> {
  const queryClient = useQueryClient();
  const { userId } = useCan();

  return useMutation<PollResponse, Error, { pollId: string; optionIds: string[] }, PollsSnapshot>({
    mutationFn: ({ pollId, optionIds }) => votePoll(pollId, optionIds),
    onMutate: async ({ pollId, optionIds }) => {
      await queryClient.cancelQueries({ queryKey: POLLS_ROOT });
      // Both caches are snapshotted, because both are patched: the rollback has
      // to put the feed's own copy of the poll back too.
      const previous: PollsSnapshot['previous'] = [
        ...queryClient.getQueriesData<InfiniteData<PollListResponse>>({ queryKey: POLLS_ROOT }),
      ];
      const feedKey = wallKeys.feed();
      const feedBefore = queryClient.getQueryData<InfiniteData<WallFeedPage>>(feedKey);
      patchPollCaches(queryClient, pollId, (poll) => applyVote(poll, optionIds, userId));
      return { previous, feed: feedBefore ? { key: feedKey, data: feedBefore } : undefined };
    },
    onError: (error, _variables, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
      if (context?.feed) queryClient.setQueryData(context.feed.key, context.feed.data);
      // A vote that lost a race with the deadline is not a failure the user
      // caused — show the result, not a red toast (the card re-renders closed).
      if (hasErrorCode(error, 'CONFLICT')) {
        notify.info(WALL_RU.polls.closedAlready);
        void queryClient.invalidateQueries({ queryKey: POLLS_ROOT });
        void queryClient.invalidateQueries({ queryKey: wallKeys.feed() });
        return;
      }
      notify.error(error);
    },
    onSuccess: (poll) => {
      patchPollCaches(queryClient, poll.id, () => poll);
    },
  });
}

export function useCreatePoll(): UseMutationResult<PollResponse, Error, CreatePoll> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePoll) => createPoll(body),
    onSuccess: () => {
      notify.success(WALL_RU.polls.published);
      void queryClient.invalidateQueries({ queryKey: POLLS_ROOT });
      // A question you just asked belongs in the head immediately, not behind
      // a pill (§D7.10) — it is your own write.
      markSelfWrite();
      void queryClient.invalidateQueries({ queryKey: wallKeys.feed() });
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

export function useClosePoll(): UseMutationResult<PollResponse, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => closePoll(id),
    onSuccess: (poll) => {
      notify.success(WALL_RU.polls.closedToast);
      patchPollCaches(queryClient, poll.id, () => poll);
      void queryClient.invalidateQueries({ queryKey: POLLS_ROOT });
      // Closing moves the card out of the head and into its chronological
      // place, which only the server can decide — so the feed refetches
      // rather than being patched into a shape it would not have chosen.
      markSelfWrite();
      void queryClient.invalidateQueries({ queryKey: wallKeys.feed() });
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

/* ========================================================================== */
/* kudos                                                                       */
/* ========================================================================== */

export function useKudosTotals(
  sinceDays: number = KUDOS_WINDOW_DAYS,
): UseQueryResult<KudosTotals, Error> {
  return useQuery({
    queryKey: wallKeys.kudosTotals(sinceDays),
    queryFn: ({ signal }) => fetchKudosTotals(sinceDays, signal),
    staleTime: 60_000,
  });
}

export function useRecentKudos(): UseQueryResult<KudosListResponse, Error> {
  return useQuery({
    queryKey: wallKeys.kudos(),
    queryFn: ({ signal }) => fetchKudos({ limit: 20 }, signal),
    staleTime: 60_000,
  });
}

export function useGiveKudos(): UseMutationResult<KudosResponse, Error, KudosCreate> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: KudosCreate) => giveKudos(body),
    onSuccess: () => {
      notify.success(WALL_RU.kudos.sent);
      markSelfWrite();
      void queryClient.invalidateQueries({ queryKey: wallKeys.kudos() });
      void queryClient.invalidateQueries({ queryKey: wallKeys.feed() });
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

/* ========================================================================== */
/* «Очистить доску» — a horizon, not a delete                                  */
/* ========================================================================== */

/**
 * Clear the wall, with six seconds to change your mind (§D7.11, §G4).
 *
 * Nothing is deleted anywhere: the server writes one column on the family
 * settings row and the feed starts after it. The undo hands the previous
 * horizon straight back — `null` included, which is "it had never been
 * cleared" — and takes the marker post with it.
 *
 * Every other reversible action in this app is a `sonner` toast with «Вернуть»
 * on it, and this one is no different in kind, only in blast radius.
 */
export function useClearWall(): UseMutationResult<WallClearResponse, Error, void> {
  const queryClient = useQueryClient();

  const undo = (result: WallClearResponse): void => {
    void restoreWall({
      clearedAt: result.previousClearedAt,
      systemPostId: result.systemPostId,
    })
      .then(() => {
        notify.success(WALL_RU.clear.restored);
        markSelfWrite();
        return queryClient.invalidateQueries({ queryKey: wallKeys.all });
      })
      .catch((error: unknown) => {
        notify.error(error);
      });
  };

  return useMutation<WallClearResponse, Error, void>({
    mutationFn: () => clearWall(),
    onSuccess: (result) => {
      // The clear moves the head on purpose, so it is a self-write: the reader
      // asked for it and must see it, not a pill.
      markSelfWrite();
      void queryClient.invalidateQueries({ queryKey: wallKeys.all });
      // Six seconds, the same window every other reversible action in the app
      // gets (§G4) — `swipe-row.tsx` raises the identical shape.
      notify.raw(WALL_RU.clear.done, {
        duration: 6000,
        action: {
          label: WALL_RU.clear.undo,
          onClick: () => {
            undo(result);
          },
        },
      });
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

/* ========================================================================== */
/* the roster                                                                  */
/* ========================================================================== */

export interface Roster {
  byId: ReadonlyMap<string, PublicUser>;
  members: readonly PublicUser[];
  /** Never throws and never renders an id: an unknown author is «Участник». */
  nameOf: (id: string | null | undefined) => string;
}

export function useRoster(): Roster {
  const query = useQuery({
    queryKey: wallKeys.members(),
    queryFn: ({ signal }) => fetchMembers(signal),
    staleTime: 5 * 60_000,
    // A roster we are not allowed to read must not take the wall down with it.
    retry: false,
  });

  return useMemo(() => {
    const members = query.data ?? [];
    const byId = new Map(members.map((member) => [member.id, member]));
    return {
      byId,
      members,
      nameOf: (id) =>
        id ? (byId.get(id)?.displayName ?? WALL_RU.feed.unknownAuthor) : WALL_RU.feed.systemAuthor,
    };
  }, [query.data]);
}
