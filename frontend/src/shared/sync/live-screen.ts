import { useEffect, useSyncExternalStore } from 'react';

/**
 * Which screens want the fast poll (D12, `docs/architecture/sync.md` §5.2).
 *
 * A module-level counter behind `useSyncExternalStore`, mirroring the `useOnline`
 * pattern in `features/shopping/hooks.ts`: no new dependency, no store to keep
 * in sync, and a mounted screen is the only thing that can raise the rate.
 *
 * The bar for calling `useLiveScreen()` is «two people would plausibly be
 * looking at this at the same moment». Today exactly one page clears it — the
 * shopping list, the kitchen case D12 was written for. Adding it to a screen
 * that does not need it costs the family battery for nothing.
 */

let liveCount = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Raise the poll rate for as long as this component is mounted. */
export function useLiveScreen(): void {
  useEffect(() => {
    liveCount += 1;
    emit();
    return () => {
      liveCount -= 1;
      emit();
    };
  }, []);
}

/** True while at least one mounted screen has asked for the fast rate. */
export function useIsLiveScreen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => liveCount > 0,
    () => false,
  );
}

/** Test-only reset; the counter is module state and outlives a render tree. */
export function resetLiveScreens(): void {
  liveCount = 0;
  emit();
}
