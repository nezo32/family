/**
 * Machine-readable API error codes. The frontend maps these to Russian messages
 * (see `frontend/src/shared/lib/api-errors.ts`) — never render `message` from
 * the server directly to the user.
 */
export const ERROR_CODES = [
  // 400
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  // 401
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'REFRESH_TOKEN_REUSED',
  // 403
  'FORBIDDEN',
  'ACCOUNT_PENDING_APPROVAL',
  'ACCOUNT_REJECTED',
  'ACCOUNT_SUSPENDED',
  'LAST_LOGIN_METHOD',
  'LAST_OWNER',
  // 404
  'NOT_FOUND',
  // 409
  'CONFLICT',
  'ALREADY_EXISTS',
  'IDENTITY_ALREADY_LINKED',
  'STALE_VERSION',
  // 413 / 415
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  // 429
  'RATE_LIMITED',
  // 500+
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'OAUTH_PROVIDER_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Shape returned by every non-2xx API response. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    /** Developer-facing English message. Not for end users. */
    message: string;
    /** Field-level validation issues, keyed by dotted path. */
    details?: Record<string, string[]>;
    /** Correlation id from the `x-request-id` header, for log lookup. */
    requestId?: string;
  };
}

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  REFRESH_TOKEN_REUSED: 401,
  FORBIDDEN: 403,
  ACCOUNT_PENDING_APPROVAL: 403,
  ACCOUNT_REJECTED: 403,
  ACCOUNT_SUSPENDED: 403,
  LAST_LOGIN_METHOD: 403,
  LAST_OWNER: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  IDENTITY_ALREADY_LINKED: 409,
  STALE_VERSION: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  OAUTH_PROVIDER_ERROR: 502,
};
