import type { ApiErrorBody, ErrorCode } from '@family/shared';

/**
 * Every non-2xx API response becomes one of these.
 *
 * The `message` field the server sends is a developer-facing English string
 * (see `packages/shared/src/domain/errors.ts`) and must never reach the user.
 * Render `errorMessageRu(error)` from `./errors-ru` instead.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Field-level validation issues, keyed by dotted path. */
  readonly details: Record<string, string[]> | undefined;
  /** `x-request-id`, for correlating with backend logs. */
  readonly requestId: string | undefined;

  constructor(args: {
    code: ErrorCode;
    status: number;
    message?: string;
    details?: Record<string, string[]>;
    requestId?: string;
  }) {
    super(args.message ?? args.code);
    this.name = 'ApiError';
    this.code = args.code;
    this.status = args.status;
    this.details = args.details;
    this.requestId = args.requestId;
  }
}

/** Thrown when the request never reached the server (offline, DNS, abort). */
export class NetworkError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super('Network request failed');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError;
}

/** Narrow to a specific code, e.g. `hasErrorCode(err, 'STALE_VERSION')`. */
export function hasErrorCode(error: unknown, ...codes: ErrorCode[]): boolean {
  return isApiError(error) && codes.includes(error.code);
}

/** The three 403s that mean "your account is not usable", not "you lack a permission". */
export const ACCOUNT_STATUS_CODES = [
  'ACCOUNT_PENDING_APPROVAL',
  'ACCOUNT_REJECTED',
  'ACCOUNT_SUSPENDED',
] as const satisfies readonly ErrorCode[];

export type AccountStatusCode = (typeof ACCOUNT_STATUS_CODES)[number];

export function isAccountStatusCode(code: ErrorCode): code is AccountStatusCode {
  return (ACCOUNT_STATUS_CODES as readonly ErrorCode[]).includes(code);
}

/** Best-effort parse of an error body into an `ApiError`. */
export function toApiError(status: number, body: unknown, requestId?: string): ApiError {
  const parsed = body as Partial<ApiErrorBody> | null | undefined;
  const inner = parsed?.error;
  if (inner && typeof inner.code === 'string') {
    return new ApiError({
      code: inner.code,
      status,
      message: inner.message,
      ...(inner.details ? { details: inner.details } : {}),
      ...(inner.requestId ?? requestId ? { requestId: inner.requestId ?? requestId } : {}),
    });
  }
  return new ApiError({
    code: fallbackCodeForStatus(status),
    status,
    message: `HTTP ${String(status)}`,
    ...(requestId ? { requestId } : {}),
  });
}

/** Used when a proxy or CDN returns a non-JSON error page. */
export function fallbackCodeForStatus(status: number): ErrorCode {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_MEDIA_TYPE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}
