import { QueryClient, type QueryClientConfig } from '@tanstack/react-query';
import { isApiError, isNetworkError } from './errors';

/**
 * TanStack Query defaults, tuned for an installed mobile PWA.
 *
 * Reasoning behind each non-default value:
 *
 * `staleTime: 30s`
 *   A family app is opened, glanced at and closed. Zero stale time means every
 *   mount refetches, which on a phone means a spinner on a screen the user just
 *   left. 30 s is long enough to make back-navigation instant and short enough
 *   that "кто-то отметил задачу" shows up quickly.
 *
 * `gcTime: 30 min`
 *   iOS freezes a backgrounded PWA rather than killing it. Keeping the cache for
 *   half an hour means resuming from the app switcher renders instantly from
 *   cache and revalidates behind the scenes.
 *
 * `retry` — never on 4xx
 *   A `403`/`404`/`409` will not become a `200` by asking again; retrying just
 *   delays the error UI by seconds. Network failures and 5xx get two retries
 *   with backoff.
 *
 * `refetchOnWindowFocus: true`
 *   This is the single most valuable default on mobile: `focus` fires when the
 *   PWA returns from the background, which is exactly when the data is stalest.
 *
 * `refetchOnReconnect: true`
 *   Same argument for going from Wi-Fi/tunnel/lift back online.
 *
 * `networkMode: 'offlineFirst'`
 *   The default `'online'` pauses queries when the browser thinks it is offline.
 *   `navigator.onLine` is notoriously unreliable (captive portals, iOS reporting
 *   `false` on resume for a beat), and a paused query renders an eternal
 *   spinner. `offlineFirst` lets the request run, serve from the SW cache when
 *   it can, and fail honestly when it cannot — the error state is a better
 *   experience than a hang. Mutations keep `'online'` so a write issued with no
 *   connection is queued and replayed on reconnect instead of failing.
 */

/** Do not retry anything the server already answered with a 4xx. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error)) {
    if (error.status >= 400 && error.status < 500) return false;
    return failureCount < 2;
  }
  if (isNetworkError(error)) return failureCount < 2;
  return false;
}

export const queryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      retry: shouldRetry,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: true,
      networkMode: 'offlineFirst',
      // Keeps list screens from flashing a skeleton when only the filter changed.
      placeholderData: undefined,
    },
    mutations: {
      // A mutation must not silently fire twice against a non-idempotent route.
      retry: false,
      networkMode: 'online',
    },
  },
};

export function createQueryClient(): QueryClient {
  return new QueryClient(queryClientConfig);
}
