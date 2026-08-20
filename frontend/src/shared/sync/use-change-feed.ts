import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChangeDomain, RevisionMap } from '@family/shared';
import { hasAccessToken, onAccessTokenChange } from '@/shared/api/token-store';
import { isSyncActivityBusy, subscribeSyncActivity } from './activity';
import {
  CHANGE_DOMAIN_KEYS,
  changeKeys,
  diffRevisions,
  fetchChanges,
  pollIntervalMs,
} from './change-feed';
import { useIsLiveScreen } from './live-screen';

/**
 * The whole client half of the change feed (D12, `docs/architecture/sync.md`
 * §5.3). Mount it **once**, from `app/providers.tsx`.
 *
 * One query polls `GET /api/changes` while the tab is visible, diffs the
 * counters against what it last saw, and invalidates the query keys of the
 * domains that moved. It does not replace the existing focus/reconnect
 * refetching — it sits on top of it, and if it breaks entirely the app degrades
 * to today's behaviour rather than to nothing.
 */

/**
 * How many failures before we assume the feed is broken rather than flaky, and
 * fall back to a slow blanket refresh (§5.4).
 *
 * Counted **two ways**, because the two failures that matter look different.
 * A 5xx is retried twice by the shared `shouldRetry`, so one bad fetch reaches
 * three attempts on its own. A **404** — the route is missing, the deploy is
 * half-landed — is never retried at all, so it only ever shows one attempt per
 * fetch and has to be counted across fetches instead. Either way, three
 * failures is the threshold.
 */
const DEGRADED_AFTER_FAILURES = 3;
const DEGRADED_INTERVAL_MS = 60_000;

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => {
    document.removeEventListener('visibilitychange', listener);
  };
}

/** Re-renders the hook on `visibilitychange`, which recomputes `refetchInterval`. */
function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'visible',
    () => true,
  );
}

/**
 * Whether there is a session to poll with.
 *
 * `providers.tsx` mounts the feed above the router, so this is what keeps
 * `/login` and `/auth/*` from polling: no access token, no query. A page reload
 * starts tokenless by design (D3), so the feed switches on the moment the
 * silent refresh lands.
 */
function useSignedIn(): boolean {
  return useSyncExternalStore(onAccessTokenChange, hasAccessToken, () => false);
}

export function useChangeFeed(): void {
  const queryClient = useQueryClient();
  const live = useIsLiveScreen();
  const visible = useDocumentVisible();
  const signedIn = useSignedIn();

  /** Every counter this client has ever been told about. */
  const seenRef = useRef<RevisionMap>({});
  /** Domains that changed but have not been invalidated yet. Additive. */
  const pendingRef = useRef<Set<ChangeDomain>>(new Set());

  /**
   * **The rule that protects optimistic updates** (D12).
   *
   * An invalidation landing while a write is in flight refetches the server's
   * *pre-mutation* state and flashes the user's tick back off before their own
   * response arrives and turns it on again. On the shopping list — the screen
   * that polls fastest — that flicker would be the most visible bug in the app.
   *
   * So nothing is invalidated while anything is writing. Nothing is lost: the
   * pending set is additive and is retried on the next tick, when the mutation
   * cache reports idle, and when a non-mutation writer (the shopping outbox)
   * says it has drained. The delay is bounded by one interval and is invisible
   * beside the mutation's own `onSettled` invalidation, which was going to
   * reconcile the same data anyway.
   *
   * `isMutating()` is checked globally rather than per mutation key. That is
   * coarser than it could be and deliberately so: adding a `mutationKey` to
   * every feature's mutations would touch nine files owned by other people to
   * save at most one interval of latency in a case that already resolves
   * itself.
   */
  const isWriting = useCallback(
    () => queryClient.isMutating() > 0 || isSyncActivityBusy(),
    [queryClient],
  );

  const flush = useCallback(() => {
    if (pendingRef.current.size === 0) return;
    if (isWriting()) return;

    for (const domain of pendingRef.current) {
      for (const queryKey of CHANGE_DOMAIN_KEYS[domain]) {
        // `refetchType: 'active'` marks unmounted queries stale without
        // fetching them; they refresh on mount. Nothing is fetched that nobody
        // is looking at.
        void queryClient.invalidateQueries({ queryKey, refetchType: 'active' });
      }
    }
    pendingRef.current.clear();
  }, [isWriting, queryClient]);

  /**
   * Degraded mode is **latched**, not derived (§5.4).
   *
   * `failureCount` counts the attempts of the *current* fetch and resets to 0
   * the moment the next one starts, so a feed that is failing every time would
   * otherwise flicker in and out of degraded mode between polls and the
   * 60-second timer would be cleared before it ever fired. It is set when the
   * failures add up and cleared by the next success — nothing else.
   */
  const [degraded, setDegraded] = useState(false);
  /** Read inside `refetchInterval`, which is not re-created on every render. */
  const degradedRef = useRef(false);
  degradedRef.current = degraded;

  /** Failed *fetches* in a row, for the errors that are never retried (404). */
  const failedFetchesRef = useRef(0);

  const query = useQuery({
    queryKey: changeKeys.feed(),
    queryFn: ({ signal }) => fetchChanges(signal),
    enabled: signedIn,
    /**
     * A **function**, so it is recomputed after every fetch and on every
     * re-render — which is what lets walking into a shopping list switch
     * 15 s to 5 s without remounting anything.
     */
    refetchInterval: () => pollIntervalMs({ visible, live, degraded: degradedRef.current }),
    // Belt and braces with the `visible` check above: the option is the real
    // guard, `pollIntervalMs` is the part that is unit-testable.
    refetchIntervalInBackground: false,
    // Resume is free and exact: a phone returning from an hour in the pocket
    // asks "what moved?" within a beat and invalidates only those domains.
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // This query has no cache value; it is a signal.
    staleTime: 0,
    gcTime: 0,
    /**
     * The one query in the app that overrides the global `offlineFirst`. It
     * pauses while the browser believes it is offline instead of firing a
     * failing request every 15 seconds next to a shopping outbox that is busy
     * queueing writes, and `refetchOnReconnect` catches everything missed in
     * one diff.
     */
    networkMode: 'online',
  });

  const rev = query.data?.rev;
  const updatedAt = query.dataUpdatedAt;
  const failureCount = query.failureCount;
  const errorUpdatedAt = query.errorUpdatedAt;

  useEffect(() => {
    if (errorUpdatedAt === 0) return;
    failedFetchesRef.current += 1;
    if (
      failedFetchesRef.current >= DEGRADED_AFTER_FAILURES ||
      failureCount >= DEGRADED_AFTER_FAILURES
    ) {
      setDegraded(true);
    }
    // `failureCount` is read, not tracked: it is whatever the fetch that just
    // failed ended on, and a change to it alone is not a new failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorUpdatedAt]);

  useEffect(() => {
    if (rev) {
      const changed = diffRevisions(seenRef.current, rev);
      // Merged **unconditionally and before any invalidation**, so a failure to
      // invalidate can never turn into a permanent loop of re-detecting the
      // same change.
      seenRef.current = { ...seenRef.current, ...rev };
      for (const domain of changed) pendingRef.current.add(domain);
      // A response means the feed is working again.
      failedFetchesRef.current = 0;
      setDegraded((was) => (was ? false : was));
    }
    // Also the retry path: a tick that arrives while a write is in flight
    // leaves the set intact, and the next tick tries again.
    flush();
  }, [rev, updatedAt, flush]);

  /** Flush the moment the writers go quiet, rather than up to 15 seconds later. */
  useEffect(() => {
    const unsubscribeMutations = queryClient.getMutationCache().subscribe(() => {
      flush();
    });
    const unsubscribeActivity = subscribeSyncActivity(() => {
      flush();
    });
    return () => {
      unsubscribeMutations();
      unsubscribeActivity();
    };
  }, [flush, queryClient]);

  /**
   * A session ends — `providers.tsx` clears the cache, and the counters this
   * client remembers have to go with it, or the next user's first response
   * would diff against a stranger's numbers.
   */
  useEffect(
    () =>
      onAccessTokenChange((token) => {
        if (token !== null) return;
        seenRef.current = {};
        pendingRef.current.clear();
      }),
    [],
  );

  /**
   * Degraded mode (§5.4).
   *
   * A broken endpoint — a bad deploy, a missing route, a Redis outage — would
   * otherwise cost the app cross-client updates silently, and nobody would
   * notice for a month. After three consecutive failures the feed falls back to
   * a blanket invalidation once a minute, under the same write guard, and stops
   * as soon as it succeeds again. Deliberately not user-visible: «Не удалось
   * синхронизировать» on a family shopping list is noise, and the data still
   * arrives on focus.
   */
  useEffect(() => {
    if (!degraded || !signedIn) return;
    const timer = setInterval(() => {
      if (isWriting()) return;
      void queryClient.invalidateQueries({ refetchType: 'active' });
    }, DEGRADED_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [degraded, isWriting, queryClient, signedIn]);
}
