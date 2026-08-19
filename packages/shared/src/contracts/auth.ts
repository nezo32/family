import { z } from 'zod';

import { isoDateTimeSchema, nonEmptyString } from './common.js';
import { publicUserSchema, userStatusSchema } from './users.js';

/**
 * Auth contracts.
 *
 * Import direction is one-way: `auth.ts -> users.ts -> common.ts`. Nothing in
 * `users.ts` may import from here, or the zod const initialisation deadlocks on
 * an ESM cycle.
 */

/* -------------------------------------------------------------------------- */
/* providers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors the `auth_provider` pgEnum. `password` is listed as a provider because
 * the unlink guard counts login methods, and "email + password" is one of them:
 * without it here, a user could unlink their last OAuth identity and lock
 * themselves out of an account that still has a password.
 */
export const AUTH_PROVIDERS = ['google', 'apple', 'telegram', 'password'] as const;
export const authProviderSchema = z.enum(AUTH_PROVIDERS);
export type AuthProvider = z.infer<typeof authProviderSchema>;

/** The three that actually run an OAuth/OIDC round trip. */
export const OAUTH_PROVIDERS = ['google', 'apple', 'telegram'] as const;
export const oauthProviderSchema = z.enum(OAUTH_PROVIDERS);
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

/* -------------------------------------------------------------------------- */
/* password credentials                                                        */
/* -------------------------------------------------------------------------- */

/** Stored lowercase; compared case-insensitively against `users.email`. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Некорректный адрес электронной почты')
  .max(254);

/**
 * Length first, composition second: 12 characters buys far more entropy than
 * character-class rules do, and the classes are here only to stop the obvious
 * `parolparol` shapes. Upper bound guards the argon2 work factor against a
 * megabyte-long password used as a DoS vector.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Минимум 12 символов')
  .max(200, 'Не длиннее 200 символов')
  .regex(/[a-zа-яё]/u, 'Нужна хотя бы одна строчная буква')
  .regex(/[A-ZА-ЯЁ]/u, 'Нужна хотя бы одна заглавная буква')
  .regex(/\d/u, 'Нужна хотя бы одна цифра');

/** `POST /api/auth/login`. Never applies the strength rule — old hashes exist. */
export const loginRequestSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Введите пароль').max(200),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** `POST /api/auth/register`. Creates a `pending_approval` user and no session. */
export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: nonEmptyString(80),
  })
  .strict();
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    /** Omitted only when the account has no password yet (OAuth-first signup). */
    currentPassword: z.string().min(1).max(200).optional(),
    newPassword: passwordSchema,
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/* -------------------------------------------------------------------------- */
/* sessions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The body of a successful login / refresh.
 *
 * The refresh token is **not** in here — it is set as the `__Host-rt` HttpOnly
 * cookie and is never readable by JavaScript. The access token lives in JS
 * memory only: never `localStorage`, which is XSS-readable and subject to iOS's
 * 7-day script-writable storage cap.
 */
export const sessionResponseSchema = z.object({
  /** HS256 JWT, 10 minutes. */
  accessToken: z.string(),
  /** Lifetime of `accessToken` in **seconds**, for the client's refresh timer. */
  expiresIn: z.number().int().positive(),
  user: publicUserSchema,
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** Claims the backend puts in the access JWT. Documented here so both sides agree. */
export const accessTokenClaimsSchema = z.object({
  sub: z.string().uuid(),
  role: z.string(),
  status: userStatusSchema,
  /** Hash of the effective permission set; a mismatch tells the client to refetch `/me`. */
  pv: z.string(),
  /** The refresh family this access token was minted from. */
  sid: z.string().uuid(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export const logoutRequestSchema = z
  .object({
    /** `true` revokes every refresh family of the user, not just this device. */
    allDevices: z.boolean().default(false),
  })
  .strict();
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

/** One row of the active-sessions screen. */
export const activeSessionSchema = z.object({
  familyId: z.string().uuid(),
  current: z.boolean(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  issuedAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema,
});
export type ActiveSession = z.infer<typeof activeSessionSchema>;

/* -------------------------------------------------------------------------- */
/* OAuth flow                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where to send the browser after a successful callback.
 *
 * Must be a **same-origin absolute path**: `//evil.example` and
 * `https://evil.example` are both rejected, because an open redirect on the
 * callback is how OAuth flows leak tokens.
 */
export const safeRedirectSchema = z
  .string()
  .max(512)
  .regex(/^\/(?!\/)[\w\-./?%&=#:+~[\]@!$'()*,;]*$/, 'Ожидается относительный путь');

/** `GET /api/auth/:provider/start`. */
export const oauthStartQuerySchema = z
  .object({
    redirect: safeRedirectSchema.optional(),
    /**
     * `link` requires an authenticated session; the route stores the caller's id
     * as `link_user_id` in the transaction row. Never auto-link on email match
     * (D3) — linking is always an explicit, authenticated act.
     */
    intent: z.enum(['login', 'link']).default('login'),
  })
  .strict();
export type OAuthStartQuery = z.infer<typeof oauthStartQuerySchema>;

/** What `/start` returns to an XHR caller; the browser flow just 302s instead. */
export const oauthStartResponseSchema = z.object({
  authorizationUrl: z.string().url(),
  state: z.string(),
});
export type OAuthStartResponse = z.infer<typeof oauthStartResponseSchema>;

/** Google / Telegram callback — `response_mode=query`. */
export const oauthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
export type OAuthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;

/**
 * Apple callback — `response_mode=form_post`, so this arrives as a cross-site
 * POST body (hence the server-side state store).
 *
 * `user` is a **JSON string**, present only on the very first authorization, and
 * is **unsigned** — trust it for the display name and nothing else. Parse it with
 * `appleUserPayloadSchema` and persist immediately or lose it forever.
 */
export const appleCallbackBodySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  id_token: z.string().optional(),
  user: z.string().max(4096).optional(),
  error: z.string().optional(),
});
export type AppleCallbackBody = z.infer<typeof appleCallbackBodySchema>;

export const appleUserPayloadSchema = z.object({
  name: z
    .object({
      firstName: z.string().max(100).optional(),
      lastName: z.string().max(100).optional(),
    })
    .optional(),
  email: z.string().max(254).optional(),
});
export type AppleUserPayload = z.infer<typeof appleUserPayloadSchema>;

/* -------------------------------------------------------------------------- */
/* Telegram legacy fallbacks                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The archived hash-based Login Widget. Kept as a fallback behind the OIDC flow
 * at `https://oauth.telegram.org`.
 *
 * Verification: build the data-check string from every field except `hash`, sorted
 * by key, joined with `\n`; the secret is `sha256(botToken)`; compare
 * `hmac_sha256` in constant time. Reject when `auth_date` is older than 24 h.
 * Field names are snake_case because Telegram sends them that way.
 */
export const telegramWidgetPayloadSchema = z
  .object({
    id: z.coerce.number().int().positive(),
    first_name: z.string().max(200),
    last_name: z.string().max(200).optional(),
    username: z.string().max(64).optional(),
    photo_url: z.string().url().max(2048).optional(),
    /** Unix seconds. Replay window, not a session lifetime. */
    auth_date: z.coerce.number().int().positive(),
    hash: z.string().length(64),
  })
  .passthrough();
export type TelegramWidgetPayload = z.infer<typeof telegramWidgetPayloadSchema>;

/**
 * Telegram Mini App `initData` — the raw, still-encoded query string exactly as
 * `window.Telegram.WebApp.initData` produced it.
 *
 * It is passed through verbatim on purpose: the HMAC is computed over the raw
 * pairs, so any re-encoding or key reordering on the client breaks verification.
 * Here the secret is `hmac_sha256('WebAppData', botToken)`.
 */
export const telegramInitDataSchema = z
  .object({
    initData: nonEmptyString(4096),
  })
  .strict();
export type TelegramInitData = z.infer<typeof telegramInitDataSchema>;

/* -------------------------------------------------------------------------- */
/* linked identities                                                           */
/* -------------------------------------------------------------------------- */

/** A row of `GET /api/me/identities`. Never exposes `providerUserId` or tokens. */
export const linkedIdentitySchema = z.object({
  provider: authProviderSchema,
  providerUsername: z.string().nullable(),
  providerEmail: z.string().nullable(),
  linkedAt: isoDateTimeSchema,
  /**
   * The provider this session was established with. Display hint only — the
   * unlink guard is a server-side `SELECT ... FOR UPDATE` + login-method count,
   * not this flag.
   */
  isPrimary: z.boolean(),
});
export type LinkedIdentity = z.infer<typeof linkedIdentitySchema>;

export const linkedIdentityListSchema = z.object({
  items: z.array(linkedIdentitySchema),
  /** Providers not yet linked — what the settings screen offers as buttons. */
  available: z.array(authProviderSchema),
});
export type LinkedIdentityList = z.infer<typeof linkedIdentityListSchema>;

export const unlinkIdentityParamsSchema = z.object({
  provider: authProviderSchema,
});
export type UnlinkIdentityParams = z.infer<typeof unlinkIdentityParamsSchema>;

/* -------------------------------------------------------------------------- */
/* account status gate                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/auth/status` — the payload behind the pending / rejected / suspended
 * screens.
 *
 * These pages are **fully unauthenticated** (D3): a `pending_approval` user gets
 * no session at all, not even a scoped one. The client therefore identifies
 * itself with the short-lived opaque `ticket` handed out by register/callback,
 * never with a token.
 */
export const accountStatusQuerySchema = z
  .object({
    ticket: nonEmptyString(200),
  })
  .strict();
export type AccountStatusQuery = z.infer<typeof accountStatusQuerySchema>;

export const accountStatusResponseSchema = z.object({
  status: userStatusSchema,
  /** So the screen can say "Привет, Аня" without exposing anything else. */
  displayName: z.string().nullable(),
  /** When the signup was submitted, for "ожидает одобрения с ...". */
  submittedAt: isoDateTimeSchema.nullable(),
  /** Admin-supplied reason for `rejected` / `suspended`; null otherwise. */
  reason: z.string().nullable(),
});
export type AccountStatusResponse = z.infer<typeof accountStatusResponseSchema>;

/**
 * What register / OAuth-callback return when the account may not have a session
 * yet. Exactly one of `session` / `pending` is non-null.
 */
export const authOutcomeSchema = z.object({
  session: sessionResponseSchema.nullable(),
  pending: z
    .object({
      status: userStatusSchema,
      ticket: z.string(),
    })
    .nullable(),
});
export type AuthOutcome = z.infer<typeof authOutcomeSchema>;
