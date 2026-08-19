import { useEffect, useMemo, useRef } from 'react';
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
} from '@family/shared';
import { hasErrorCode } from '@/shared/api/errors';
import { notify } from '@/shared/lib/toast';
import { useCan } from '@/shared/auth';
import {
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

const FEED_PAGE_SIZE = 20;
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
  });
}

/** Live pins ride outside the cursor stream, so they only exist on page one. */
export function pinnedFrom(data: InfiniteData<WallFeedPage> | undefined): PostResponse[] {
  return data?.pages[0]?.pinned ?? [];
}

/* ========================================================================== */
/* announcements                                                               */
/* ========================================================================== */

export function useCreatePost(): UseMutationResult<PostResponse, Error, CreatePost> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePost) => createPost(body),
    onSuccess: () => {
      notify.success(WALL_RU.post.published);
      void queryClient.invalidateQueries({ queryKey: wallKeys.feed() });
    },
    onError: (error) => {
      notify.error(error);
    },
  });
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

export function useAddComment(
  ref: EntityRef,
): UseMutationResult<CommentResponse, Error, string, CommentsSnapshot> {
  const queryClient = useQueryClient();
  const { userId } = useCan();
  const key = wallKeys.comments(ref);

  return useMutation<CommentResponse, Error, string, CommentsSnapshot>({
    mutationFn: (body: string) => createComment(ref, { body }),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<InfiniteData<CommentListResponse>>(key);
      const now = new Date().toISOString();
      const draft: CommentResponse = {
        id: optimisticId(),
        entityType: ref.entityType,
        entityId: ref.entityId,
        authorId: userId ?? '',
        body,
        reactions: [],
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
): ReactionSummary[] {
  const existing = summaries.find((item) => item.emoji === emoji);
  if (!existing) return [...summaries, { emoji, count: 1, reacted: true }];

  return summaries
    .map((item) =>
      item.emoji === emoji
        ? {
            ...item,
            count: item.reacted ? Math.max(0, item.count - 1) : item.count + 1,
            reacted: !item.reacted,
          }
        : item,
    )
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
  return summaries
    .map((item) => `${item.emoji}:${String(item.count)}:${item.reacted ? '1' : '0'}`)
    .join('|');
}

interface ReactionSnapshot {
  previous: ReactionSummary[] | undefined;
}

export function useToggleReaction(
  ref: EntityRef,
): UseMutationResult<ReactionSummary[], Error, string, ReactionSnapshot> {
  const queryClient = useQueryClient();
  const { entityType, entityId } = ref;
  const key = useMemo(() => wallKeys.reactions({ entityType, entityId }), [entityType, entityId]);

  return useMutation<ReactionSummary[], Error, string, ReactionSnapshot>({
    mutationFn: (emoji: string) => toggleReaction(ref, emoji).then((response) => response.reactions),
    onMutate: async (emoji) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ReactionSummary[]>(key);
      queryClient.setQueryData<ReactionSummary[]>(key, (current) =>
        applyReactionToggle(current ?? [], emoji),
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

interface PollsSnapshot {
  previous: [QueryKey, InfiniteData<PollListResponse> | undefined][];
}

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
      const previous =
        queryClient.getQueriesData<InfiniteData<PollListResponse>>({ queryKey: POLLS_ROOT });
      patchPollCaches(queryClient, pollId, (poll) => applyVote(poll, optionIds, userId));
      return { previous };
    },
    onError: (error, _variables, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
      // A vote that lost a race with the deadline is not a failure the user
      // caused — show the result, not a red toast (the card re-renders closed).
      if (hasErrorCode(error, 'CONFLICT')) {
        notify.info(WALL_RU.polls.closedAlready);
        void queryClient.invalidateQueries({ queryKey: POLLS_ROOT });
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
      notify.success(WALL_RU.polls.closed_);
      patchPollCaches(queryClient, poll.id, () => poll);
      void queryClient.invalidateQueries({ queryKey: POLLS_ROOT });
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
      void queryClient.invalidateQueries({ queryKey: wallKeys.kudos() });
      void queryClient.invalidateQueries({ queryKey: wallKeys.feed() });
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
      nameOf: (id) => (id ? (byId.get(id)?.displayName ?? WALL_RU.feed.unknownAuthor) : WALL_RU.feed.systemAuthor),
    };
  }, [query.data]);
}
