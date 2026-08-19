import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useNavigate, type NavigateFunction } from 'react-router-dom';
import type {
  AccountStatusResponse,
  AuthOutcome,
  LoginRequest,
  RegisterRequest,
  UserStatus,
} from '@family/shared';
import { ROUTES } from '@/shared/lib/routes';
import { meKeys } from '@/shared/auth/use-me';
import { setAccessToken } from '@/shared/api/token-store';
import { resetRefreshState, signOut } from '@/shared/api/refresh';
import {
  authKeys,
  fetchAccountStatus,
  forgetTicket,
  login,
  register,
  rememberTicket,
} from './api';

/**
 * TanStack Query wrappers for the auth feature.
 *
 * The interesting part is what happens *after* a successful call: an
 * `AuthOutcome` carries either a session or a pending ticket, never both, and
 * the two paths lead to completely different screens (D3). Doing that routing
 * in one place keeps the login and register pages free of branching.
 */

/** Where a non-active account has to land. */
export function routeForStatus(status: UserStatus): string {
  switch (status) {
    case 'pending_approval':
      return ROUTES.authPending;
    case 'rejected':
      return ROUTES.authRejected;
    case 'suspended':
      return ROUTES.authSuspended;
    case 'active':
      return ROUTES.today;
  }
}

function withTicket(path: string, ticket: string): string {
  return `${path}?ticket=${encodeURIComponent(ticket)}`;
}

/** Same-origin absolute paths only — `next` comes from a query parameter. */
function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return ROUTES.today;
  return next;
}

interface OutcomeContext {
  navigate: NavigateFunction;
  onSession: () => void;
  next?: string | null;
}

function applyAuthOutcome(outcome: AuthOutcome, context: OutcomeContext): void {
  if (outcome.session) {
    // A previous failed refresh in this tab latches `sessionEnded`, which would
    // make the very first 401 after login give up instead of refreshing.
    resetRefreshState();
    setAccessToken(outcome.session.accessToken);
    forgetTicket();
    context.onSession();
    context.navigate(safeNext(context.next), { replace: true });
    return;
  }

  if (outcome.pending) {
    // No session of any kind for a non-active account — only the opaque ticket
    // that the (unauthenticated) status screen can ask about.
    rememberTicket(outcome.pending.ticket);
    context.navigate(withTicket(routeForStatus(outcome.pending.status), outcome.pending.ticket), {
      replace: true,
    });
    return;
  }

  // Neither branch: treat as "nothing happened" rather than pretending to be
  // signed in. The caller still renders its error state.
  context.navigate(ROUTES.login, { replace: true });
}

/* -------------------------------------------------------------------------- */
/* mutations                                                                   */
/* -------------------------------------------------------------------------- */

export function useLogin(next?: string | null): UseMutationResult<AuthOutcome, Error, LoginRequest> {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: LoginRequest) => login(body),
    onSuccess: (outcome) => {
      applyAuthOutcome(outcome, {
        navigate,
        next,
        onSession: () => {
          // The permission list is the root of every UI access decision (D4) —
          // refetch it for the identity we just became.
          void queryClient.invalidateQueries({ queryKey: meKeys.all });
        },
      });
    },
  });
}

export function useRegister(
  next?: string | null,
): UseMutationResult<AuthOutcome, Error, RegisterRequest> {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: RegisterRequest) => register(body),
    onSuccess: (outcome) => {
      // Normally this ends on `/auth/pending`; the very first member of a brand
      // new family is approved by construction and gets a session instead.
      applyAuthOutcome(outcome, {
        navigate,
        next,
        onSession: () => {
          void queryClient.invalidateQueries({ queryKey: meKeys.all });
        },
      });
    },
  });
}

/**
 * Sign out. `signOut()` revokes the refresh family server-side, clears the
 * in-memory access token and redirects to `/login`; the cache is dropped here so
 * the next account cannot see the previous one's data for a frame.
 */
export function useLogout(): { logout: () => Promise<void>; isPending: boolean } {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      await signOut();
    },
    onSettled: () => {
      queryClient.clear();
    },
  });

  const logout = useCallback(async () => {
    await mutation.mutateAsync();
  }, [mutation]);

  return { logout, isPending: mutation.isPending };
}

/* -------------------------------------------------------------------------- */
/* queries                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The payload behind the pending / rejected / suspended screens.
 *
 * Anonymous and ticket-based: these pages must work for a user who has no
 * session at all, so this never touches `/api/me` and never triggers a refresh.
 * Without a ticket the query simply stays idle and the screen renders its
 * generic copy.
 */
export function useAccountStatus(
  ticket: string | null,
): UseQueryResult<AccountStatusResponse, Error> {
  return useQuery({
    queryKey: authKeys.statusFor(ticket ?? 'none'),
    queryFn: ({ signal }) => fetchAccountStatus(ticket ?? '', signal),
    enabled: Boolean(ticket),
    // An expired or unknown ticket is a 404/400 that will not become a 200.
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}
