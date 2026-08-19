import { ERROR_STATUS, type ErrorCode } from '@family/shared';

/**
 * The only error type route handlers, services and repositories should throw.
 *
 * The HTTP status is derived from the code, so callers never have to remember
 * which number goes with which failure — and the frontend switches on `code`,
 * never on the English `message`.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, string[]> | undefined;
  /** Attached to the log line but never sent to the client. */
  readonly context: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message?: string,
    options?: {
      details?: Record<string, string[]>;
      context?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message ?? code, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.details = options?.details;
    this.context = options?.context;
    Error.captureStackTrace?.(this, AppError);
  }

  static isAppError(err: unknown): err is AppError {
    return err instanceof AppError;
  }
}

/* ------------------------------------------------------------------ */
/* Shorthand constructors — these read better at the call site than a  */
/* bare `new AppError('NOT_FOUND', ...)` and keep messages consistent. */
/* ------------------------------------------------------------------ */

export const badRequest = (message: string, details?: Record<string, string[]>) =>
  new AppError('BAD_REQUEST', message, details ? { details } : undefined);

export const unauthenticated = (message = 'Authentication required') =>
  new AppError('UNAUTHENTICATED', message);

export const forbidden = (message = 'Insufficient permissions', context?: Record<string, unknown>) =>
  new AppError('FORBIDDEN', message, context ? { context } : undefined);

/**
 * Use this — not `forbidden` — whenever the caller is outside the *read* scope
 * for a resource. Returning 403 would confirm the resource exists (D4).
 *
 * `what` is an **English** noun: it is interpolated into an English sentence
 * and `AppError.message` is developer-facing (D7) — the client renders the
 * Russian text it keys off `error.code`. A Russian noun here produces the
 * half-translated `"Событие not found"`, which is worse than either language.
 */
export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);

export const conflict = (message: string, code: ErrorCode = 'CONFLICT') =>
  new AppError(code, message);

export const internal = (message = 'Internal server error', cause?: unknown) =>
  new AppError('INTERNAL_ERROR', message, cause !== undefined ? { cause } : undefined);

/** Guard that narrows and throws `NOT_FOUND` — handy after a `.limit(1)` query. */
export function assertFound<T>(value: T | null | undefined, what = 'Resource'): T {
  if (value === null || value === undefined) throw notFound(what);
  return value;
}
