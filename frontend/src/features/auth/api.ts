import { z } from 'zod';
import {
  accountStatusResponseSchema,
  authOutcomeSchema,
  sessionResponseSchema,
  type AccountStatusResponse,
  type AuthOutcome,
  type LoginRequest,
  type OAuthProvider,
  type RegisterRequest,
} from '@family/shared';
import { api } from '@/shared/api/client';
import { apiUrl } from '@/shared/api/config';

/**
 * Typed fetchers for the auth feature.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. **OAuth starts with a top-level navigation, never `window.open`.**
 *    A popup is dead weight in an installed iOS PWA: `window.open` either opens
 *    Safari (a different storage partition, so the `__Host-rt` cookie the
 *    callback sets never comes back to the app) or is blocked outright. The
 *    only flow that works everywhere is `location.assign` on the top frame, with
 *    the backend 302-ing back into scope — `scope: '/'` in the manifest keeps
 *    the return trip inside the installed app.
 *
 * 2. **The account-status endpoints are anonymous.** A `pending_approval` user
 *    holds no session of any kind (D3), so those calls pass `anonymous: true`
 *    to skip the bearer header and the 401-refresh dance entirely — otherwise
 *    the pending screen would bounce itself to `/login`.
 */

/* -------------------------------------------------------------------------- */
/* query keys                                                                  */
/* -------------------------------------------------------------------------- */

export const authKeys = {
  all: ['auth'] as const,
  status: () => [...authKeys.all, 'status'] as const,
  statusFor: (ticket: string) => [...authKeys.status(), ticket] as const,
};

/* -------------------------------------------------------------------------- */
/* password credentials                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Login and register both answer with an `AuthOutcome` — exactly one of
 * `session` / `pending` is non-null, because an admin-gated signup (and a
 * suspended account trying to sign in) must not receive a session.
 *
 * The union also tolerates a bare `SessionResponse`: a backend build that
 * returns the session directly should log the user in rather than blow up on a
 * schema mismatch.
 */
const authOutcomeCompatSchema = z.union([
  authOutcomeSchema,
  sessionResponseSchema.transform((session) => ({ session, pending: null })),
]);

export async function login(body: LoginRequest): Promise<AuthOutcome> {
  const raw = await api.post<unknown>('/auth/login', body, { anonymous: true });
  return authOutcomeCompatSchema.parse(raw);
}

export async function register(body: RegisterRequest): Promise<AuthOutcome> {
  const raw = await api.post<unknown>('/auth/register', body, { anonymous: true });
  return authOutcomeCompatSchema.parse(raw);
}

/** `GET /api/auth/status?ticket=...` — unauthenticated by design (D3). */
export async function fetchAccountStatus(
  ticket: string,
  signal?: AbortSignal,
): Promise<AccountStatusResponse> {
  const raw = await api.get<unknown>('/auth/status', {
    query: { ticket },
    anonymous: true,
    ...(signal ? { signal } : {}),
  });
  return accountStatusResponseSchema.parse(raw);
}

/* -------------------------------------------------------------------------- */
/* OAuth                                                                       */
/* -------------------------------------------------------------------------- */

export interface OAuthStartOptions {
  /** Same-origin path to land on after a successful callback. */
  redirect?: string | null;
  /** `link` requires a session; used by Settings, not by this screen. */
  intent?: 'login' | 'link';
}

/** The URL the browser must navigate to in order to begin a provider flow. */
export function oauthStartUrl(provider: OAuthProvider, options: OAuthStartOptions = {}): string {
  const query: Record<string, string> = {};
  // Only a same-origin absolute path is accepted server-side (open-redirect guard).
  if (options.redirect && options.redirect.startsWith('/') && !options.redirect.startsWith('//')) {
    query.redirect = options.redirect;
  }
  if (options.intent && options.intent !== 'login') query.intent = options.intent;
  return apiUrl(`/auth/${provider}/start`, query);
}

/**
 * Begin an OAuth flow.
 *
 * **Top-level navigation on purpose.** Never `window.open`: see the note at the
 * top of this file. Keeping this the single call site is what makes the rule
 * enforceable — and testable.
 */
export function startOAuth(provider: OAuthProvider, options: OAuthStartOptions = {}): void {
  window.location.assign(oauthStartUrl(provider, options));
}

/* -------------------------------------------------------------------------- */
/* which providers this deployment actually has                                */
/* -------------------------------------------------------------------------- */

/**
 * A provider button is only worth showing when this deployment is configured
 * for it — a dead "Войти через Apple" that 500s is worse than no button.
 *
 * Convention: one public build-time variable per provider. None of them is a
 * secret (an OAuth client id is public by definition and the bot username is on
 * the Telegram profile); they exist as presence flags, plus the widget username
 * for Telegram.
 *
 * Fallback rule: when the build carries **no** provider variables at all — dev
 * shells, tests, a container that never received them — every provider is
 * offered and the backend decides. Silently hiding all three would make the
 * login screen look broken.
 */
export const PROVIDER_ENV_KEYS: Record<OAuthProvider, string> = {
  google: 'VITE_GOOGLE_CLIENT_ID',
  apple: 'VITE_APPLE_CLIENT_ID',
  telegram: 'VITE_TELEGRAM_BOT_USERNAME',
};

export const OAUTH_PROVIDER_ORDER: readonly OAuthProvider[] = ['google', 'apple', 'telegram'];

type EnvRecord = Record<string, string | boolean | undefined>;

/** `import.meta.env` widened, so reading an undeclared key is not a type error. */
function readEnv(): EnvRecord {
  return import.meta.env as unknown as EnvRecord;
}

function isConfigured(env: EnvRecord, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0;
}

/** The providers to render, in display order. Never empty. */
export function enabledOAuthProviders(env: EnvRecord = readEnv()): readonly OAuthProvider[] {
  const configured = OAUTH_PROVIDER_ORDER.filter((provider) =>
    isConfigured(env, PROVIDER_ENV_KEYS[provider]),
  );
  return configured.length > 0 ? configured : OAUTH_PROVIDER_ORDER;
}

/* -------------------------------------------------------------------------- */
/* the pending ticket                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The opaque handle that lets an account-status screen ask "what happened to my
 * signup?" without a session. It is short-lived and read-only, and it lives in
 * `sessionStorage` rather than `localStorage`: D3 bans persistent
 * script-writable storage for anything credential-shaped, and a ticket only has
 * to survive a reload of the very tab that received it.
 */
export const TICKET_STORAGE_KEY = 'family.auth.ticket';
export const TICKET_QUERY_PARAM = 'ticket';

export function rememberTicket(ticket: string): void {
  try {
    window.sessionStorage.setItem(TICKET_STORAGE_KEY, ticket);
  } catch {
    // Private mode / storage disabled — the URL parameter still carries it.
  }
}

export function readStoredTicket(): string | null {
  try {
    return window.sessionStorage.getItem(TICKET_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function forgetTicket(): void {
  try {
    window.sessionStorage.removeItem(TICKET_STORAGE_KEY);
  } catch {
    // Nothing to do: the ticket expires server-side anyway.
  }
}
