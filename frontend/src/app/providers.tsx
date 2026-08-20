import { useEffect, useMemo, type ReactNode } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '@/shared/ui/tooltip';
import { Toaster } from '@/shared/ui/sonner';
import { queryClientConfig } from '@/shared/api/query-client';
import { isApiError } from '@/shared/api/errors';
import { onAccessTokenChange } from '@/shared/api/token-store';
import { meKeys } from '@/shared/auth/use-me';
import { recordEngagement } from '@/features/auth/components/install';
import { registerSyncActivitySource } from '@/shared/sync';
import { useChangeFeed } from '@/shared/sync/use-change-feed';
import { getOutboxState, subscribeOutbox } from '@/features/shopping/outbox';
import { AppErrorBoundary } from './ErrorBoundary';
import { ThemeProvider } from './theme-provider';
import { createAppRouter } from './router';

/**
 * Everything the app is wrapped in, in dependency order:
 *
 *   ErrorBoundary → Theme → QueryClient → Router (RootLayout installs the
 *                                                   navigate bridge)
 *                                       ↘ Tooltip → Toaster
 *
 * The router is created once, at module level of this component's memo, because
 * `createBrowserRouter` builds a history object — recreating it on a re-render
 * resets the navigation stack.
 */

/**
 * Builds the QueryClient with two global behaviours on top of the tuned
 * defaults in `shared/api/query-client.ts`:
 *
 * 1. **403 self-heal (D7).** If the server refuses something the UI believed was
 *    allowed, our copy of the permission list is stale — an admin changed a role
 *    or an override while this tab was open. Invalidating `['me']` refetches the
 *    effective permissions and the affordances correct themselves within a
 *    render, instead of the user staring at a button that keeps failing.
 * 2. **Engagement counting.** Every successful mutation is the user doing
 *    something real — creating a task, ticking an item off, adding an event —
 *    and that is precisely the gate both self-raised prompts wait on
 *    (`shouldOfferInstall`, `shouldOfferPushPrompt`). Counting it here rather
 *    than in a dozen feature hooks means no new screen has to remember to
 *    opt in, and no read can ever be mistaken for an action. Mutations that are
 *    not the user *using* the app — signing in, signing out — opt out with
 *    `meta: { engagement: false }`.
 * 3. A single place to log unexpected failures in development.
 */
function createClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    ...queryClientConfig,
    queryCache: new QueryCache({
      onError: (error) => {
        handleForbidden(client, error);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        handleForbidden(client, error);
      },
      onSuccess: (_data, _variables, _context, mutation) => {
        if (mutation.meta?.engagement === false) return;
        recordEngagement();
      },
    }),
  });
  return client;
}

function handleForbidden(client: QueryClient, error: unknown): void {
  if (!isApiError(error)) return;
  // Account-status 403s are handled by the API layer (it redirects); only a
  // plain permission refusal means "your permission list is out of date".
  if (error.status === 403 && error.code === 'FORBIDDEN') {
    void client.invalidateQueries({ queryKey: meKeys.all });
  }
}

/** Wipes cached server state when the session ends, so the next user starts clean. */
function useResetCacheOnSignOut(client: QueryClient): void {
  useEffect(
    () =>
      onAccessTokenChange((token) => {
        if (token === null) client.clear();
      }),
    [client],
  );
}

/**
 * The shopping outbox, told to the change feed (D12).
 *
 * Every other write in the app is a `useMutation`, so `isMutating()` sees it and
 * the feed holds its invalidations back until it settles. The outbox is not: it
 * is a durable IndexedDB queue, and a tick sitting in it is invisible to the
 * mutation cache. Registering it here — rather than importing a feature from
 * `shared/sync` — keeps the sync module a leaf.
 *
 * "Busy" is `flushing || pending > 0` and not merely `flushing`, because the
 * dangerous window opens the moment the optimistic row is written to the cache,
 * which is before the flush starts.
 */
const shoppingOutboxActivity = {
  subscribe: subscribeOutbox,
  isBusy: () => {
    const state = getOutboxState();
    return state.flushing || state.pending > 0;
  },
};

/**
 * The cross-client change feed, mounted once.
 *
 * It lives in a component of its own so the poll's re-renders (visibility,
 * live-screen, every 15 s tick) stay inside a node that renders nothing, rather
 * than re-rendering the router on every tick.
 */
function ChangeFeed(): null {
  useChangeFeed();
  return null;
}

export function Providers(props: { children?: ReactNode }) {
  const queryClient = useMemo(() => createClient(), []);
  const router = useMemo(() => createAppRouter(), []);

  useResetCacheOnSignOut(queryClient);
  useEffect(() => registerSyncActivitySource(shoppingOutboxActivity), []);

  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={300}>
            <ChangeFeed />
            <RouterProvider router={router} />
            <Toaster richColors closeButton />
            {props.children}
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  );
}
