import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  accountStatusQuerySchema,
  accountStatusResponseSchema,
  authOutcomeSchema,
  loginRequestSchema,
  logoutRequestSchema,
  okSchema,
  registerRequestSchema,
  sessionResponseSchema,
} from '@family/shared';

import { refreshCookieName, refreshCookieOptions } from '../../core/auth/tokens.js';
import { getDb } from '../../core/db.js';
import { assertLoginAttemptAllowed, clearLoginThrottle } from './login-throttle.js';
import { AppError } from '../../core/errors.js';
import * as service from './identity.service.js';
import { rotateRefreshToken, toPublicUser } from './session.service.js';

/**
 * Password authentication and session lifecycle.
 *
 * The OAuth providers live in `oauth.routes.ts`; both go through
 * `session.service.ts` so there is exactly one place a credential is minted.
 *
 * Two rules run through every handler here:
 *
 * 1. **Refresh and logout are POST-only and cookie-authenticated.** `SameSite=Lax`
 *    withholds the cookie from cross-site POSTs, which — together with the
 *    `Origin` / `Sec-Fetch-Site` check in `core/plugins/security.ts` — is the
 *    entire CSRF defence for these two routes (D3).
 * 2. **Every 401 clears the refresh cookie.** Otherwise an installed PWA that
 *    has been offline for a month retries a dead token on every single boot,
 *    burns a request, and shows the login screen anyway.
 */

function sessionContext(request: FastifyRequest): service.RequestContext {
  return {
    userAgent: request.headers['user-agent'] ?? null,
    ip: request.ip,
    actorId: request.auth?.userId ?? null,
  };
}

function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(refreshCookieName(), token, refreshCookieOptions());
}

/**
 * `maxAge` is dropped: `clearCookie` expires the cookie, and sending both a
 * `Max-Age` and an expiry in the past makes some browsers keep the larger one.
 * Every other attribute must match the original or the browser treats it as a
 * different cookie and the dead one survives.
 */
function clearRefreshCookie(reply: FastifyReply): void {
  const { maxAge: _maxAge, ...attributes } = refreshCookieOptions();
  reply.clearCookie(refreshCookieName(), attributes);
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * Rule 2, enforced once for every route in this plugin so it cannot be
   * forgotten in a future one.
   *
   * Scoped to 401 on purpose. Clearing on any `>= 400` would mean a signed-in
   * member who fat-fingers the registration form loses their session to a
   * validation error; the account-status 403s, where the cookie really is
   * worthless, are handled explicitly in the refresh handler below.
   */
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode === 401) clearRefreshCookie(reply);
    return payload;
  });

  /* ---------------------------------------------------------------------- */
  /* POST /auth/register                                                     */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/auth/register',
    {
      config: {
        public: true,
        // Registration is admin-gated and this family has single digits of
        // members: five attempts an hour from one address is generous.
        rateLimit: { max: 5, timeWindow: '1 hour' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Register with email and password',
        description:
          'Creates a `pending_approval` member and returns **no session**. The first ' +
          'ever user (or one matching BOOTSTRAP_OWNER_EMAIL) is auto-approved as owner ' +
          'and does receive one.',
        body: registerRequestSchema,
        response: { 200: authOutcomeSchema },
      },
    },
    async (request, reply) => {
      const { outcome, refreshToken } = await service.register(
        getDb(),
        request.body,
        sessionContext(request),
      );
      if (refreshToken) setRefreshCookie(reply, refreshToken);
      return outcome;
    },
  );

  /* ---------------------------------------------------------------------- */
  /* POST /auth/login                                                        */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/auth/login',
    {
      config: {
        public: true,
        // Per-IP dimension. Runs on `onRequest`, before the body is parsed.
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          keyGenerator: (request) => `login:ip:${request.ip}`,
        },
      },
      schema: {
        tags: ['auth'],
        summary: 'Sign in with email and password',
        body: loginRequestSchema,
        response: { 200: sessionResponseSchema },
      },
    },
    async (request, reply) => {
      // Per-account throttle. Counted before the password is checked, so a
      // botnet spread over many IPs cannot walk one account's password list
      // while each individual address stays under the per-IP limit.
      await assertLoginAttemptAllowed(request.body.email);

      const { session, issued } = await service.login(
        getDb(),
        request.body,
        sessionContext(request),
      );

      await clearLoginThrottle(request.body.email);
      setRefreshCookie(reply, issued.refreshToken);
      return session;
    },
  );

  /* ---------------------------------------------------------------------- */
  /* POST /auth/refresh                                                      */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/auth/refresh',
    {
      config: {
        // "public" in the sense of "no bearer token": the refresh cookie is the
        // credential. Never make this a GET — a GET would be reachable from a
        // cross-site <img> and `SameSite=Lax` does send cookies on top-level GETs.
        public: true,
        // Deliberately loose. A dashboard resuming on iOS legitimately fires
        // several refreshes at once; that is what the grace window is for, and
        // rate-limiting it would turn a benign burst into a logout.
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Rotate the refresh cookie and mint a new access token',
        description:
          'Rotation with token-family reuse detection and a REFRESH_GRACE_SECONDS ' +
          'window for concurrent callers. A replayed revoked token revokes the ' +
          'entire family and returns REFRESH_TOKEN_REUSED.',
        response: { 200: sessionResponseSchema },
      },
    },
    async (request, reply) => {
      const raw = request.cookies[refreshCookieName()];
      // The `onSend` hook above turns this 401 into a cookie clear.
      if (!raw) throw new AppError('UNAUTHENTICATED', 'No refresh cookie');

      try {
        const rotated = await rotateRefreshToken(getDb(), raw, sessionContext(request));

        // `null` on the grace path: the request that won the race already set
        // the new cookie in this same browser, so answering with no `Set-Cookie`
        // leaves the right value in place. See `RotatedSession.refreshToken`.
        if (rotated.refreshToken) setRefreshCookie(reply, rotated.refreshToken);

        return {
          accessToken: rotated.accessToken,
          expiresIn: rotated.expiresIn,
          user: toPublicUser(rotated.user),
        };
      } catch (error) {
        // The 401s are already covered by the hook; this catches the
        // account-status 403s (pending / rejected / suspended), where the
        // cookie is equally worthless and keeping it only guarantees one failed
        // request on every future boot of the installed PWA.
        if (AppError.isAppError(error) && error.statusCode !== 401) {
          clearRefreshCookie(reply);
        }
        throw error;
      }
    },
  );

  /* ---------------------------------------------------------------------- */
  /* POST /auth/logout                                                       */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/auth/logout',
    {
      config: {
        public: true,
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Revoke this session (or every session) and clear the cookie',
        description: 'Idempotent: always 200, with or without a valid cookie.',
        // `nullish`, not `optional`: Fastify hands the validator `null` (not
        // `undefined`) when a request carries no body, and the client signs out
        // with a bare POST. A logout that 400s because a header was missing is a
        // logout users stop trusting.
        body: logoutRequestSchema.nullish(),
        response: { 200: okSchema },
      },
    },
    async (request, reply) => {
      const raw = request.cookies[refreshCookieName()] ?? null;
      await service.logout(
        getDb(),
        raw,
        request.body?.allDevices ?? false,
        sessionContext(request),
      );
      clearRefreshCookie(reply);
      return { ok: true } as const;
    },
  );

  /* ---------------------------------------------------------------------- */
  /* GET /auth/status                                                        */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/auth/status',
    {
      config: {
        // Fully unauthenticated by design (D3): a pending member has no session
        // of any kind, so the waiting screen identifies itself with the opaque
        // ticket handed out by register / the OAuth callback.
        public: true,
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Read one account status by ticket',
        querystring: accountStatusQuerySchema,
        response: { 200: accountStatusResponseSchema },
      },
    },
    async (request) => service.accountStatus(getDb(), request.query.ticket),
  );
};

export default authRoutes;
