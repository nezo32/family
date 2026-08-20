/**
 * Writes in flight that TanStack Query cannot see.
 *
 * The change feed must never invalidate on top of an optimistic update, and its
 * guard for that is `queryClient.isMutating()`. That covers every write in the
 * app except one: the shopping outbox is a durable IndexedDB queue, not a
 * `useMutation`, so a tick sitting in it is invisible to the mutation cache —
 * and the shopping list is both the screen that polls fastest and the screen
 * where a reverted tick would be the most visible bug in the app.
 *
 * So anything that writes outside the mutation cache registers itself here, and
 * the feed treats "busy" exactly as it treats a pending mutation: hold the
 * changed domains, flush when it goes idle.
 *
 * Registration happens in `app/providers.tsx` rather than inside `shared/sync`,
 * so this module stays a leaf and does not import a feature.
 */

export interface SyncActivitySource {
  /** Called with a listener; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** True while this source has an unacknowledged write. */
  isBusy: () => boolean;
}

const sources = new Set<SyncActivitySource>();
const listeners = new Set<() => void>();
const unsubscribes = new Map<SyncActivitySource, () => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function registerSyncActivitySource(source: SyncActivitySource): () => void {
  sources.add(source);
  unsubscribes.set(source, source.subscribe(notify));
  notify();
  return () => {
    unsubscribes.get(source)?.();
    unsubscribes.delete(source);
    sources.delete(source);
    notify();
  };
}

/** Subscribe to "some source changed state". */
export function subscribeSyncActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True while any registered source is mid-write.
 *
 * Deliberately global rather than per domain, matching the `isMutating()` rule
 * it sits beside: one coarse predicate is one thing to reason about, and the
 * cost of being coarse is at most one poll interval of delay on a domain that
 * was going to be reconciled by the write itself anyway.
 */
export function isSyncActivityBusy(): boolean {
  for (const source of sources) {
    if (source.isBusy()) return true;
  }
  return false;
}

/** Test-only. */
export function clearSyncActivitySources(): void {
  for (const unsubscribe of unsubscribes.values()) unsubscribe();
  unsubscribes.clear();
  sources.clear();
  notify();
}
