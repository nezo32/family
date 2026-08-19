import type {
  AuthProvider,
  LinkedIdentityList,
  NotificationPreference,
  NotificationTestRequest,
  NotificationTestResponse,
  OAuthProvider,
  OAuthStartResponse,
  PreferencesResponse,
  PushSubscriptionSummary,
  QuietHours,
  QuietHoursInput,
  SelfUser,
  UpdateProfileRequest,
} from '@family/shared';
import { api } from '@/shared/api/client';

/**
 * Typed fetchers and query keys for Настройки.
 *
 * Two things here are load-bearing:
 *
 * 1. **OAuth linking is a top-level navigation, never a popup.** `window.open`
 *    is useless in an installed iOS PWA — it either opens Safari (a different
 *    storage partition, so the `__Host-rt` cookie the callback sets never comes
 *    back to the app) or is blocked outright. `GET /api/auth/:provider/link`
 *    answers with JSON rather than a 302 *because* a top-level navigation cannot
 *    carry the in-memory bearer token (D3); we fetch the URL and then assign
 *    `location.href` ourselves, which is still a top-level navigation — just one
 *    hop later.
 * 2. **Never render a server `message`.** Every failure here surfaces through
 *    `errorMessageRu(error)`, keyed on the machine-readable `ErrorCode`.
 */

/* -------------------------------------------------------------------------- */
/* query keys                                                                  */
/* -------------------------------------------------------------------------- */

export const settingsKeys = {
  all: ['settings'] as const,
  identities: () => [...settingsKeys.all, 'identities'] as const,
  notifications: () => [...settingsKeys.all, 'notifications'] as const,
  preferences: () => [...settingsKeys.notifications(), 'preferences'] as const,
  subscriptions: () => [...settingsKeys.notifications(), 'subscriptions'] as const,
};

/* -------------------------------------------------------------------------- */
/* profile                                                                     */
/* -------------------------------------------------------------------------- */

/** `PATCH /api/me` — the `.strict()` self-profile contract (D4: no role here). */
export function updateProfile(body: UpdateProfileRequest): Promise<SelfUser> {
  return api.patch<SelfUser>('/me', body);
}

/* -------------------------------------------------------------------------- */
/* linked identities                                                           */
/* -------------------------------------------------------------------------- */

export function fetchIdentities(signal?: AbortSignal): Promise<LinkedIdentityList> {
  return api.get<LinkedIdentityList>('/me/identities', signal ? { signal } : {});
}

/**
 * `DELETE /api/me/identities/:provider`.
 *
 * Returns `403 LAST_LOGIN_METHOD` when this is the only way in. The UI must
 * explain that *before* the user tries — see `canUnlink()` below — because an
 * error toast after the fact reads like a bug.
 */
export function unlinkIdentity(provider: AuthProvider): Promise<LinkedIdentityList> {
  return api.del<LinkedIdentityList>(`/me/identities/${provider}`);
}

/**
 * Begin linking a provider to the current account.
 *
 * Two steps on purpose: an authenticated `fetch` to obtain the provider's
 * authorization URL, then a **top-level** `location.assign`. No popup, ever.
 */
export async function startProviderLink(
  provider: OAuthProvider,
  redirect: string,
): Promise<string> {
  const response = await api.get<OAuthStartResponse>(`/auth/${provider}/link`, {
    query: { redirect },
  });
  return response.authorizationUrl;
}

/** Separated from the fetch so tests can assert "navigated, did not popup". */
export function navigateTop(url: string): void {
  window.location.assign(url);
}

/**
 * Client-side mirror of the server's last-login-method guard.
 *
 * Not security — the server holds a `SELECT … FOR UPDATE` and is the authority.
 * This exists so the button can be disabled with an explanation instead of
 * firing a request that comes back `LAST_LOGIN_METHOD`.
 */
export function canUnlink(identities: LinkedIdentityList | undefined): boolean {
  return (identities?.items.length ?? 0) > 1;
}

/* -------------------------------------------------------------------------- */
/* notification preferences                                                    */
/* -------------------------------------------------------------------------- */

export function fetchPreferences(signal?: AbortSignal): Promise<PreferencesResponse> {
  return api.get<PreferencesResponse>('/notifications/preferences', signal ? { signal } : {});
}

/** Bulk on purpose: the screen is a matrix and the whole change is one commit. */
export function savePreferences(
  preferences: readonly NotificationPreference[],
): Promise<PreferencesResponse> {
  return api.put<PreferencesResponse>('/notifications/preferences', { preferences });
}

/** `PUT /api/notifications/quiet-hours` replaces the entire window set. */
export function saveQuietHours(windows: readonly QuietHoursInput[]): Promise<QuietHours[]> {
  return api.put<QuietHours[]>('/notifications/quiet-hours', { windows });
}

/* -------------------------------------------------------------------------- */
/* devices                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/notifications/subscriptions`.
 *
 * `endpoint` is passed as a *query* parameter so the server can mark the row
 * belonging to this browser as `isCurrent`. It is never returned in the
 * response: an endpoint is a capability URL and therefore a secret (research
 * doc §14), which is also why removal below is asymmetric.
 */
export function fetchSubscriptions(
  currentEndpoint: string | null,
  signal?: AbortSignal,
): Promise<PushSubscriptionSummary[]> {
  return api.get<PushSubscriptionSummary[]>('/notifications/subscriptions', {
    ...(currentEndpoint ? { query: { endpoint: currentEndpoint } } : {}),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Remove one device from the list.
 *
 * `DELETE /api/notifications/subscriptions` takes the **endpoint**, which the
 * client only knows for the browser it is running in. For any other device we
 * fall back to a by-id route.
 *
 * The by-id route now exists, so revoking a lost or replaced phone from a
 * device you still have works. Both paths are idempotent.
 */
export function removeSubscription(row: {
  id: string;
  isCurrent: boolean;
  endpoint?: string | null;
}): Promise<void> {
  if (row.isCurrent && row.endpoint) {
    return api.del<void>('/notifications/subscriptions', { body: { endpoint: row.endpoint } });
  }
  return api.del<void>(`/notifications/subscriptions/${row.id}`);
}

/* -------------------------------------------------------------------------- */
/* the test push                                                               */
/* -------------------------------------------------------------------------- */

/**
 * «Отправить тестовое уведомление».
 *
 * On iOS this is the only honest way for a family member to find out whether
 * the whole chain works, which is why the response reports per-target results
 * rather than a bare 200. Rate-limited to 5/hour server-side.
 */
export function sendTestNotification(
  body: NotificationTestRequest = { channel: 'push' },
): Promise<NotificationTestResponse> {
  return api.post<NotificationTestResponse>('/notifications/test', body);
}
