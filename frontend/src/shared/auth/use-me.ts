import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../api/client';
import { AUTH_ENDPOINTS } from '../api/config';
import { isApiError } from '../api/errors';
import { meSchema, type Me } from './types';

/**
 * `GET /api/me` — the identity + **effective permission list** (D4).
 *
 * This is the root of every access decision in the UI. It is fetched once, kept
 * warm for the whole session, and invalidated whenever the server tells us our
 * permission set was wrong (a 403 on a call the UI thought was allowed).
 */

export const meKeys = {
  all: ['me'] as const,
  detail: () => ['me'] as const,
};

async function fetchMe(signal: AbortSignal): Promise<Me> {
  const raw = await api.get<unknown>(AUTH_ENDPOINTS.me, { signal });
  // Parsed, not cast: a contract drift between backend and frontend should fail
  // loudly here rather than as `undefined.map` three components deep.
  return meSchema.parse(raw);
}

export function useMe(): UseQueryResult<Me> {
  return useQuery({
    queryKey: meKeys.detail(),
    queryFn: ({ signal }) => fetchMe(signal),
    // Permissions rarely change, and an unnecessary refetch on every screen
    // switch is wasted battery. A 403 invalidates this key explicitly.
    staleTime: 5 * 60_000,
    gcTime: 60 * 60_000,
    retry: (failureCount, error) => {
      // 401/403 here means "not signed in" / "account not usable" — the API
      // layer already redirected; retrying just delays the redirect.
      if (isApiError(error)) return false;
      return failureCount < 2;
    },
  });
}

/** `true` while we genuinely do not know yet whether the user is signed in. */
export function useIsAuthLoading(): boolean {
  const { isPending, isFetching, data } = useMe();
  return (isPending || isFetching) && data === undefined;
}

/** Imperative invalidation, used by the 403 self-heal in `app/providers.tsx`. */
export function useInvalidateMe(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: meKeys.all });
  };
}
