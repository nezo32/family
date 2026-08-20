import { useEffect, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AuthProvider,
  LinkedIdentityList,
  NotificationPreference,
  NotificationTestRequest,
  NotificationTestResponse,
  PreferencesResponse,
  PushSubscriptionSummary,
  QuietHours,
  QuietHoursInput,
  SelfUser,
  UpdateProfileRequest,
} from '@family/shared';
import { meKeys } from '@/shared/auth/use-me';
import {
  fetchIdentities,
  fetchPreferences,
  fetchSubscriptions,
  removeAvatar,
  removeSubscription,
  savePreferences,
  saveQuietHours,
  sendTestNotification,
  settingsKeys,
  unlinkIdentity,
  updateProfile,
  uploadAvatar,
} from './api';
import { currentEndpoint } from './push/push';

/**
 * TanStack Query wrappers for Настройки.
 *
 * Everything on these screens is either identity state or notification state,
 * and both are cheap and rarely stale — so the queries are configured to
 * refetch on focus. That matters more here than elsewhere: an installed iOS PWA
 * comes back from the background as a cold start with arbitrarily stale data
 * (research doc §8), and a settings screen showing yesterday's device list is
 * how a family member concludes the app is broken.
 */

/* -------------------------------------------------------------------------- */
/* profile                                                                     */
/* -------------------------------------------------------------------------- */

export function useUpdateProfile(): UseMutationResult<SelfUser, Error, UpdateProfileRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateProfile,
    onSuccess: () => {
      // The avatar, name and colour are rendered by the shell from `/api/me`.
      void queryClient.invalidateQueries({ queryKey: meKeys.all });
    },
  });
}

/**
 * Upload a cropped avatar.
 *
 * `setQueryData` on `['me']` **and** an invalidate: the optimistic write puts
 * the new URL on screen the instant the request returns, and the invalidate
 * makes the server the authority a moment later. The URL carries the object
 * name (`?v=…`), so it differs from the previous one and no cached image can
 * survive the change — which is what lets the serving route send a year-long
 * `Cache-Control` without ever showing a stale face.
 */
export function useUploadAvatar(): UseMutationResult<SelfUser, Error, { blob: Blob; filename: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ blob, filename }: { blob: Blob; filename: string }) =>
      uploadAvatar(blob, filename),
    onSuccess: (user) => {
      writeSelfUser(queryClient, user);
      void queryClient.invalidateQueries({ queryKey: meKeys.all });
    },
  });
}

export function useRemoveAvatar(): UseMutationResult<SelfUser, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => removeAvatar(),
    onSuccess: (user) => {
      writeSelfUser(queryClient, user);
      void queryClient.invalidateQueries({ queryKey: meKeys.all });
    },
  });
}

/**
 * Patch the `user` half of the cached `/api/me` response.
 *
 * The avatar endpoints answer with a `SelfUser`, not the whole `MeResponse`, so
 * the permissions and family context in the cache have to be left alone —
 * replacing the entry wholesale would blank the client's authorization state
 * until the refetch landed, and every `useCan()` on screen would flicker.
 */
function writeSelfUser(queryClient: ReturnType<typeof useQueryClient>, user: SelfUser): void {
  queryClient.setQueriesData<{ user: SelfUser }>({ queryKey: meKeys.all }, (previous) =>
    previous ? { ...previous, user } : previous,
  );
}

/* -------------------------------------------------------------------------- */
/* linked identities                                                           */
/* -------------------------------------------------------------------------- */

export function useIdentities(): UseQueryResult<LinkedIdentityList, Error> {
  return useQuery({
    queryKey: settingsKeys.identities(),
    queryFn: ({ signal }) => fetchIdentities(signal),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Unbind a provider.
 *
 * The server answers `403 LAST_LOGIN_METHOD` when this is the only way in; the
 * screen is expected to have explained that *before* the button was reachable,
 * so reaching this error at all means the user has two tabs open or lost a race.
 * Either way `errorMessageRu` renders the Russian sentence — never the server's.
 */
export function useUnlinkIdentity(): UseMutationResult<LinkedIdentityList, Error, AuthProvider> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: unlinkIdentity,
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKeys.identities(), data);
      void queryClient.invalidateQueries({ queryKey: meKeys.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* notification preferences                                                    */
/* -------------------------------------------------------------------------- */

export function usePreferences(): UseQueryResult<PreferencesResponse, Error> {
  return useQuery({
    queryKey: settingsKeys.preferences(),
    queryFn: ({ signal }) => fetchPreferences(signal),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useSavePreferences(): UseMutationResult<
  PreferencesResponse,
  Error,
  readonly NotificationPreference[]
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: savePreferences,
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKeys.preferences(), data);
    },
  });
}

export function useSaveQuietHours(): UseMutationResult<
  QuietHours[],
  Error,
  readonly QuietHoursInput[]
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveQuietHours,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.preferences() });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* devices                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * This browser's push endpoint, resolved asynchronously.
 *
 * Needed as a *query parameter* on the device list so the server can flag the
 * matching row `isCurrent` — the response deliberately never contains an
 * endpoint, because it is a capability URL (research doc §14).
 */
export function useCurrentEndpoint(): string | null {
  const [endpoint, setEndpoint] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void currentEndpoint().then((value) => {
      if (alive) setEndpoint(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return endpoint;
}

export function useSubscriptions(
  endpoint: string | null,
): UseQueryResult<PushSubscriptionSummary[], Error> {
  return useQuery({
    queryKey: [...settingsKeys.subscriptions(), endpoint ?? 'unknown'],
    queryFn: ({ signal }) => fetchSubscriptions(endpoint, signal),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useRemoveSubscription(
  endpoint: string | null,
): UseMutationResult<void, Error, PushSubscriptionSummary> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (row: PushSubscriptionSummary) =>
      removeSubscription({ id: row.id, isCurrent: row.isCurrent, endpoint }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.notifications() });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* the test push                                                               */
/* -------------------------------------------------------------------------- */

/**
 * «Отправить тестовое уведомление» — the single biggest support-ticket
 * deflector in the app, and on iOS the only way to confirm the whole chain.
 */
export function useSendTestNotification(): UseMutationResult<
  NotificationTestResponse,
  Error,
  NotificationTestRequest | void
> {
  return useMutation({
    mutationFn: (body: NotificationTestRequest | void) =>
      sendTestNotification(body ?? { channel: 'push' }),
  });
}
