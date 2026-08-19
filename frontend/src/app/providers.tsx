import { useEffect, useMemo, type ReactNode } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '@/shared/ui/tooltip';
import { Toaster } from '@/shared/ui/sonner';
import { queryClientConfig } from '@/shared/api/query-client';
import { isApiError } from '@/shared/api/errors';
import { onAccessTokenChange } from '@/shared/api/token-store';
import { meKeys } from '@/shared/auth/use-me';
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
 * 2. A single place to log unexpected failures in development.
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

export function Providers(props: { children?: ReactNode }) {
  const queryClient = useMemo(() => createClient(), []);
  const router = useMemo(() => createAppRouter(), []);

  useResetCacheOnSignOut(queryClient);

  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={300}>
            <RouterProvider router={router} />
            <Toaster richColors closeButton />
            {props.children}
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  );
}
