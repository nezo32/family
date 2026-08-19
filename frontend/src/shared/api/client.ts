import { apiUrl } from './config';
import {
  ApiError,
  NetworkError,
  isAccountStatusCode,
  toApiError,
} from './errors';
import { handleAccountStatus, refreshAccessToken } from './refresh';
import { getAccessToken } from './token-store';

/**
 * The one fetch wrapper the whole app goes through.
 *
 *  - base URL from `VITE_API_URL` (empty in dev/prod: same origin)
 *  - `credentials: 'same-origin'` so the `__Host-rt` cookie rides along on the
 *    auth endpoints and nothing leaks cross-origin
 *  - JSON in, JSON out, `204`/empty bodies resolve to `undefined`
 *  - `Authorization: Bearer <in-memory access token>` (D3 — never storage)
 *  - a `401` triggers exactly one silent refresh + retry (see `refresh.ts`)
 *  - a `403` with an account-status code routes to the explanation screen
 *  - every failure is an `ApiError` carrying the machine-readable `ErrorCode`
 *
 * Feature modules should not call `fetch` directly. Build typed fetchers on top
 * of `api.get/post/patch/put/del` in `features/<domain>/api.ts`.
 */

export interface RequestOptions {
  /** Query string, appended to the path. `undefined` / `null` values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON request body. Mutually exclusive with `formData`. */
  body?: unknown;
  /** Multipart body; the browser sets the boundary, so we must not set the header. */
  formData?: FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Skip the bearer header and the 401 refresh dance (login, OAuth callbacks). */
  anonymous?: boolean;
  /** Internal: prevents a refresh loop. */
  _retried?: boolean;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
  const url = apiUrl(path, cleanQuery(options.query));

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...options.headers,
  };

  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  if (!options.anonymous) {
    const token = getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      // Auth endpoints need the `__Host-rt` cookie; everything else is bearer
      // based and structurally CSRF-immune (D3).
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body !== undefined ? { body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    // An aborted request is a caller decision, not a network fault — rethrow it
    // untouched so TanStack Query treats it as a cancellation.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new NetworkError(cause);
  }

  if (response.ok) return (await parseBody(response)) as T;

  const requestId = response.headers.get('x-request-id') ?? undefined;
  const parsed = await safeJson(response);
  const error = toApiError(response.status, parsed, requestId);

  // ---- 401: refresh once, then retry the original request ------------------
  if (response.status === 401 && !options.anonymous && !options._retried) {
    const token = await refreshAccessToken();
    if (token) {
      return request<T>(method, path, { ...options, _retried: true });
    }
    // `refreshAccessToken` already cleared the token and scheduled the redirect.
    throw error;
  }

  // ---- 403: distinguish "no permission" from "account not usable" ----------
  if (response.status === 403 && isAccountStatusCode(error.code)) {
    handleAccountStatus(error.code);
    throw error;
  }

  throw error;
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    return text.length > 0 ? text : undefined;
  }
  const text = await response.text();
  if (text.length === 0) return undefined;
  return JSON.parse(text) as unknown;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function cleanQuery(
  query: RequestOptions['query'],
): Record<string, string | number | boolean> | undefined {
  if (!query) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  del: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options),
};

export { ApiError, NetworkError };
