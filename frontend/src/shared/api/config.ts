/**
 * API location.
 *
 * In dev `VITE_API_URL` is empty and requests go to the relative `/api/...`,
 * which Vite proxies to `localhost:3000`. Keeping the browser origin identical
 * to the app origin is what lets the `__Host-rt` refresh cookie work at all —
 * `__Host-` cookies are same-origin by definition.
 *
 * In production Caddy serves the SPA and the API from one origin, so the value
 * stays empty there too. `VITE_API_URL` exists for the split-origin case
 * (staging, native shell) and then also requires the backend CORS allow-list.
 */
const RAW_BASE = import.meta.env.VITE_API_URL ?? '';

/**
 * Base **origin**, without a trailing slash. Empty string means "same origin".
 *
 * A trailing `/api` is stripped defensively. `VITE_API_URL` is an origin, not a
 * path, but `/api` is the obvious thing to put there — and getting it wrong
 * produces requests to `/api/api/...`, which 404 on every screen while dev
 * (where the variable is unset) keeps working perfectly.
 */
export const API_BASE_URL = RAW_BASE.replace(/\/+$/, '').replace(/\/api$/, '');

/** Prefix every API route carries. */
export const API_PREFIX = '/api';

/**
 * Build an absolute (or origin-relative) API URL.
 * `path` may be given with or without the `/api` prefix.
 */
export function apiUrl(
  path: string,
  searchParams?: Record<string, string | number | boolean>,
): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const withPrefix = normalized.startsWith(`${API_PREFIX}/`)
    ? normalized
    : `${API_PREFIX}${normalized}`;
  const base = `${API_BASE_URL}${withPrefix}`;
  if (!searchParams) return base;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) query.set(key, String(value));
  const qs = query.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Endpoints the API layer itself knows about. */
export const AUTH_ENDPOINTS = {
  refresh: '/auth/refresh',
  logout: '/auth/logout',
  me: '/me',
} as const;
