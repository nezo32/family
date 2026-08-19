import type { ErrorCode } from '@family/shared';
import { AUTH_ENDPOINTS, apiUrl } from './config';
import { ApiError, isAccountStatusCode, toApiError, type AccountStatusCode } from './errors';
import { currentLocationPath, redirectTo } from './navigation';
import { clearAccessToken, setAccessToken } from './token-store';
import { ROUTES, loginUrl } from '../lib/routes';

/**
 * Silent refresh.
 *
 * Flow (D3):
 *   request → 401 → refresh() → retry once → still 401 → sign out
 *
 * The refresh cookie is `__Host-rt; HttpOnly; SameSite=Lax; Path=/`, so the
 * browser attaches it automatically to this same-origin POST and JS never sees
 * it. The response body carries the new 10-minute access JWT, which goes into
 * the in-memory store only.
 *
 * ### Why de-duplication is mandatory
 * React 19 StrictMode double-invokes effects, a dashboard fires half a dozen
 * queries at once, and iOS resumes every open PWA tab simultaneously. Without a
 * single in-flight promise those all POST `/auth/refresh` at the same instant.
 * The backend has a 20-second grace window for exactly this reason, but relying
 * on it from the client is sloppy: N refreshes means N rotations and N chances
 * to trip the token-family reuse detector. One promise, shared by everybody.
 */

type RefreshResponse = { accessToken: string; expiresIn?: number };

/** The shared in-flight refresh. `null` when no refresh is running. */
let inFlight: Promise<string | null> | null = null;

/** Set once a refresh has definitively failed, so we stop hammering the endpoint. */
let sessionEnded = false;

export function resetRefreshState(): void {
  inFlight = null;
  sessionEnded = false;
}

/**
 * Exchange the refresh cookie for a fresh access token.
 * Returns the new token, or `null` when the session is over (the caller should
 * surface `UNAUTHENTICATED`; the redirect has already been scheduled).
 *
 * Concurrent callers all await the same promise.
 */
export function refreshAccessToken(): Promise<string | null> {
  if (sessionEnded) return Promise.resolve(null);
  inFlight ??= performRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function performRefresh(): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(apiUrl(AUTH_ENDPOINTS.refresh), {
      method: 'POST',
      // Same-origin by design: the refresh cookie is `__Host-` prefixed.
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      // Refresh is never served from a cache, ever.
      cache: 'no-store',
    });
  } catch {
    // Offline: do NOT end the session — the cookie is probably still valid and
    // the next attempt after reconnect should succeed.
    return null;
  }

  if (response.ok) {
    const body = (await response.json()) as RefreshResponse;
    if (typeof body.accessToken === 'string' && body.accessToken.length > 0) {
      sessionEnded = false;
      setAccessToken(body.accessToken);
      return body.accessToken;
    }
    endSession();
    return null;
  }

  const code = await readErrorCode(response);

  // 403 with an account-status code is not "log in again" — the credentials are
  // fine, the membership is not. Route to the matching explanation screen.
  if (code && isAccountStatusCode(code)) {
    endSession({ redirect: accountStatusRoute(code) });
    return null;
  }

  endSession();
  return null;
}

async function readErrorCode(response: Response): Promise<ErrorCode | null> {
  try {
    const body: unknown = await response.json();
    const error = toApiError(response.status, body);
    return error.code;
  } catch {
    return null;
  }
}

/** Map an account-status error code to the screen that explains it. */
export function accountStatusRoute(code: AccountStatusCode): string {
  switch (code) {
    case 'ACCOUNT_PENDING_APPROVAL':
      return ROUTES.authPending;
    case 'ACCOUNT_REJECTED':
      return ROUTES.authRejected;
    case 'ACCOUNT_SUSPENDED':
      return ROUTES.authSuspended;
  }
}

/**
 * Drop the in-memory token and send the user somewhere that makes sense.
 * Idempotent: a burst of failing requests produces exactly one redirect.
 */
export function endSession(options: { redirect?: string } = {}): void {
  const alreadyEnded = sessionEnded;
  sessionEnded = true;
  clearAccessToken();
  if (alreadyEnded) return;

  const target = options.redirect ?? loginUrl(currentLocationPath());
  if (
    typeof window !== 'undefined' &&
    window.location.pathname === new URL(target, window.location.origin).pathname
  ) {
    return;
  }
  redirectTo(target, { replace: true });
}

/** Called by the API layer when a *request* (not the refresh) returns an account-status 403. */
export function handleAccountStatus(code: AccountStatusCode): void {
  endSession({ redirect: accountStatusRoute(code) });
}

/** Explicit sign-out: revoke server-side, then clear locally regardless of outcome. */
export async function signOut(): Promise<void> {
  try {
    await fetch(apiUrl(AUTH_ENDPOINTS.logout), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    // Network failure on logout still clears the client; the refresh token
    // expires server-side within 30 days at worst.
  }
  clearAccessToken();
  sessionEnded = false;
  redirectTo(ROUTES.login, { replace: true });
}

/** Re-export so callers can `instanceof` without a second import. */
export { ApiError };
