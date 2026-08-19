import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  appleCallbackBodySchema,
  oauthCallbackQuerySchema,
  oauthProviderSchema,
  oauthStartQuerySchema,
  oauthStartResponseSchema,
  safeRedirectSchema,
  sessionResponseSchema,
  telegramInitDataSchema,
  telegramWidgetPayloadSchema,
  type OAuthProvider,
  type SessionResponse,
  type UserStatus,
} from '@family/shared';

import { refreshCookieName, refreshCookieOptions } from '../../../core/auth/tokens.js';
import { getConfig } from '../../../core/config.js';
import { getDb } from '../../../core/db.js';
import { AppError } from '../../../core/errors.js';
import type { OAuthIntent } from '../identity.schema.js';
import {
  assertActive,
  createStatusTicket,
  issueSession,
  toSessionResponse,
  type IssuedSession,
} from '../session.service.js';
import type { UserRow } from '../users.schema.js';
import {
  exchangeAppleCode,
  buildAppleAuthorizationUrl,
  newAppleAuthNonce,
  parseAppleUserField,
} from './apple.js';
import { buildGoogleAuthorizationUrl, exchangeGoogleCode, newGoogleAuthSecrets } from './google.js';
import { resolveOAuthIdentityAndNotify, type OAuthProfile } from './linking.js';
import {
  buildTelegramAuthorizationUrl,
  exchangeTelegramCode,
  newTelegramAuthSecrets,
  verifyTelegramInitData,
  verifyTelegramWidget,
} from './telegram.js';
import {
  createOAuthTransactionStore,
  type OAuthTransaction,
  type OAuthTransactionStore,
} from './transactions.js';

/**
 * OAuth / OIDC routes for Google, Apple and Telegram.
 *
 * Registered under `/api`, so the public paths are `/api/auth/...` — which is
 * exactly what `config.oauth.<provider>.redirectUri` builds and therefore what
 * must be registered in each provider's console.
 *
 * Two rules run through everything below:
 *
 * - **`state` is server-side.** Every flow starts by writing an
 *   `oauth_transactions` row and ends by consuming it exactly once. Apple's
 *   `form_post` callback is a cross-site POST, where a `SameSite=Lax` cookie
 *   would not be sent at all.
 * - **No session below `active`.** A `pending_approval` / `rejected` /
 *   `suspended` account gets no token, not even a scoped one; the browser is
 *   redirected to a fully unauthenticated status page instead (D3).
 */

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Where a non-active account is sent. These pages are fully unauthenticated. */
const STATUS_REDIRECT: Record<Exclude<UserStatus, 'active'>, string> = {
  pending_approval: '/auth/pending',
  rejected: '/auth/rejected',
  suspended: '/auth/suspended',
};

/** Resolves a validated same-origin relative path against the PWA's origin. */
function appUrl(path: string): string {
  return new URL(path, getConfig().publicOrigin).href;
}

/**
 * A provider with no credentials configured is *absent*, not broken: it must
 * answer cleanly rather than throw its way into a 500 at the first `undefined`.
 */
function assertProviderEnabled(provider: OAuthProvider): void {
  if (!getConfig().oauth[provider].enabled) {
    throw new AppError('SERVICE_UNAVAILABLE', `${provider} sign-in is not configured`);
  }
}

function store(): OAuthTransactionStore {
  return createOAuthTransactionStore(getDb());
}

interface BeginInput {
  provider: OAuthProvider;
  intent: OAuthIntent;
  linkUserId: string | null;
  redirectAfter: string | null;
}

async function beginAuthorization(
  input: BeginInput,
): Promise<{ authorizationUrl: string; state: string }> {
  assertProviderEnabled(input.provider);
  const transactions = store();
  const common = {
    intent: input.intent,
    linkUserId: input.linkUserId,
    redirectAfter: input.redirectAfter,
  };

  switch (input.provider) {
    case 'google': {
      const { nonce, codeVerifier } = newGoogleAuthSecrets();
      const state = await transactions.create({ provider: 'google', nonce, codeVerifier, ...common });
      return {
        state,
        authorizationUrl: await buildGoogleAuthorizationUrl({ state, nonce, codeVerifier }),
      };
    }
    case 'apple': {
      // Apple does not support PKCE — `code_verifier` stays NULL and `state` +
      // `nonce` carry the anti-forgery burden on their own.
      const nonce = newAppleAuthNonce();
      const state = await transactions.create({
        provider: 'apple',
        nonce,
        codeVerifier: null,
        ...common,
      });
      return { state, authorizationUrl: buildAppleAuthorizationUrl({ state, nonce }) };
    }
    case 'telegram': {
      const { nonce, codeVerifier } = newTelegramAuthSecrets();
      const state = await transactions.create({
        provider: 'telegram',
        nonce,
        codeVerifier,
        ...common,
      });
      return {
        state,
        authorizationUrl: await buildTelegramAuthorizationUrl({ state, nonce, codeVerifier }),
      };
    }
  }
}

interface Resolution {
  user: UserRow;
  session: IssuedSession | null;
}

/**
 * Applies the linking decision table and, for an `active` account only, issues
 * the session and sets the refresh cookie.
 */
async function resolveAndIssue(
  request: FastifyRequest,
  reply: FastifyReply,
  args: { profile: OAuthProfile; intent: OAuthIntent; sessionUserId: string | null },
): Promise<Resolution> {
  const db = getDb();
  // The user insert and the identity insert have to land together — half a
  // signup is an account nobody can ever sign into again.
  // ...and the "somebody is waiting for approval" notification has to be
  // dispatched *after* that transaction commits, which is what the wrapper does.
  // Calling `resolveOAuthIdentity` directly writes the intent and drops the
  // dispatch, so admins would silently never hear about an OAuth signup.
  const resolved = await resolveOAuthIdentityAndNotify(db, args);

  // D3: no session below `active`. Not a limited one, not a scoped one.
  if (resolved.user.status !== 'active') return { user: resolved.user, session: null };

  const session = await issueSession(db, resolved.user, {
    userAgent: request.headers['user-agent'] ?? null,
    ip: request.ip,
  });

  reply.setCookie(refreshCookieName(), session.refreshToken, refreshCookieOptions());
  return { user: resolved.user, session };
}

/** Browser flows (`/callback`) always end in a 302, never in a JSON body. */
async function finishBrowserFlow(
  request: FastifyRequest,
  reply: FastifyReply,
  profile: OAuthProfile,
  transaction: OAuthTransaction,
): Promise<FastifyReply> {
  const { user } = await resolveAndIssue(request, reply, {
    profile,
    intent: transaction.intent,
    sessionUserId: transaction.linkUserId,
  });

  if (user.status !== 'active') {
    // The status pages are fully unauthenticated; the ticket carries no
    // authority beyond reading this one account's status.
    const url = new URL(appUrl(STATUS_REDIRECT[user.status]));
    url.searchParams.set('ticket', createStatusTicket(user.id));
    return reply.redirect(url.href, 302);
  }
  return reply.redirect(appUrl(transaction.redirectAfter ?? '/'), 302);
}

/** XHR flows (the Telegram fallbacks) return the session body instead. */
async function finishApiFlow(
  request: FastifyRequest,
  reply: FastifyReply,
  profile: OAuthProfile,
): Promise<SessionResponse> {
  const { user, session } = await resolveAndIssue(request, reply, {
    profile,
    intent: 'login',
    sessionUserId: null,
  });
  // Throws ACCOUNT_PENDING_APPROVAL / _REJECTED / _SUSPENDED.
  assertActive(user);
  if (!session) throw new AppError('INTERNAL_ERROR', 'Session was not issued');
  return toSessionResponse(user, session);
}

function providerError(provider: string, error: string, description?: string): AppError {
  return new AppError('OAUTH_PROVIDER_ERROR', `${provider} returned an error`, {
    context: { error, description },
  });
}

/* -------------------------------------------------------------------------- */
/* plugin                                                                      */
/* -------------------------------------------------------------------------- */

const oauthRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const providerParams = z.object({ provider: oauthProviderSchema });

  /* ------------------------------ /start -------------------------------- */

  r.get(
    '/auth/:provider/start',
    {
      config: { public: true },
      schema: {
        summary: 'Begin an OAuth login',
        params: providerParams,
        querystring: oauthStartQuerySchema,
      },
    },
    async (request, reply) => {
      if (request.query.intent === 'link') {
        // A public route has no session to attribute the link to. The
        // authenticated variant below is the only way to start a link flow.
        throw new AppError('UNAUTHENTICATED', 'Use GET /auth/:provider/link to link a provider');
      }
      const { authorizationUrl } = await beginAuthorization({
        provider: request.params.provider,
        intent: 'login',
        linkUserId: null,
        redirectAfter: request.query.redirect ?? null,
      });
      return reply.redirect(authorizationUrl, 302);
    },
  );

  /* ------------------------------- /link -------------------------------- */

  /**
   * Returns JSON rather than redirecting: a top-level browser navigation cannot
   * carry the in-memory bearer token, so the PWA calls this with `fetch` and
   * then assigns `location.href` itself.
   */
  r.get(
    '/auth/:provider/link',
    {
      config: { permission: 'identity:manage:own' },
      schema: {
        summary: 'Begin linking a provider to the current account',
        params: providerParams,
        querystring: z.object({ redirect: safeRedirectSchema.optional() }).strict(),
        response: { 200: oauthStartResponseSchema },
      },
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw new AppError('UNAUTHENTICATED', 'Authentication required');
      return beginAuthorization({
        provider: request.params.provider,
        intent: 'link',
        linkUserId: auth.userId,
        redirectAfter: request.query.redirect ?? null,
      });
    },
  );

  /* -------------------------- google callback --------------------------- */

  r.get(
    '/auth/google/callback',
    {
      config: { public: true },
      schema: { summary: 'Google OIDC callback', querystring: oauthCallbackQuerySchema },
    },
    async (request, reply) => {
      // Checked before anything touches the database: a provider with no
      // credentials must answer 503, not fail somewhere deeper.
      assertProviderEnabled('google');
      const { code, state, error, error_description } = request.query;
      if (error) throw providerError('google', error, error_description);
      if (!code || !state) throw new AppError('BAD_REQUEST', 'Missing code or state');

      const transaction = await store().consume(state, 'google');
      if (!transaction.codeVerifier) {
        throw new AppError('BAD_REQUEST', 'OAuth transaction is missing its PKCE verifier');
      }

      const profile = await exchangeGoogleCode({
        code,
        codeVerifier: transaction.codeVerifier,
        nonce: transaction.nonce,
      });
      return finishBrowserFlow(request, reply, profile, transaction);
    },
  );

  /* --------------------------- apple callback --------------------------- */

  /**
   * `allowCrossSite` is mandatory here: Apple posts this form from
   * `appleid.apple.com`, so `Sec-Fetch-Site: cross-site` is correct and the
   * security plugin would otherwise reject it. `state` is the anti-forgery token
   * for this route, and it is single-use and server-side.
   */
  r.post(
    '/auth/apple/callback',
    {
      config: { public: true, allowCrossSite: true },
      schema: { summary: 'Sign in with Apple form_post callback', body: appleCallbackBodySchema },
    },
    async (request, reply) => {
      assertProviderEnabled('apple');
      const { code, state, error, user } = request.body;
      if (error) throw providerError('apple', error);
      if (!code || !state) throw new AppError('BAD_REQUEST', 'Missing code or state');

      const transaction = await store().consume(state, 'apple');

      // Unsigned, and present only on the very first authorization. Parsed
      // before the exchange so it can be persisted in the same transaction that
      // creates the identity — there is no second chance at the name.
      const userField = parseAppleUserField(user);

      const profile = await exchangeAppleCode({ code, nonce: transaction.nonce, userField });
      return finishBrowserFlow(request, reply, profile, transaction);
    },
  );

  /* ------------------------- telegram callback -------------------------- */

  r.get(
    '/auth/telegram/callback',
    {
      config: { public: true },
      schema: { summary: 'Telegram OIDC callback', querystring: oauthCallbackQuerySchema },
    },
    async (request, reply) => {
      assertProviderEnabled('telegram');
      const { code, state, error, error_description } = request.query;
      if (error) throw providerError('telegram', error, error_description);
      if (!code || !state) throw new AppError('BAD_REQUEST', 'Missing code or state');

      const transaction = await store().consume(state, 'telegram');
      if (!transaction.codeVerifier) {
        throw new AppError('BAD_REQUEST', 'OAuth transaction is missing its PKCE verifier');
      }

      const profile = await exchangeTelegramCode({
        code,
        state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
      });
      return finishBrowserFlow(request, reply, profile, transaction);
    },
  );

  /* ------------------ telegram login widget (legacy) -------------------- */

  /**
   * `allowCrossSite` because the widget can post from Telegram's own origin.
   * That is not a CSRF hole: the request carries no ambient authority at all —
   * it is authenticated solely by the HMAC over the payload.
   */
  r.post(
    '/auth/telegram/widget',
    {
      config: { public: true, allowCrossSite: true },
      schema: {
        summary: 'Telegram Login Widget fallback (hash-verified)',
        body: telegramWidgetPayloadSchema,
        response: { 200: sessionResponseSchema },
      },
    },
    async (request, reply) => {
      assertProviderEnabled('telegram');
      const profile = verifyTelegramWidget({
        payload: request.body,
        botToken: getConfig().oauth.telegram.botToken,
      });
      return finishApiFlow(request, reply, profile);
    },
  );

  /* ---------------------- telegram mini app initData -------------------- */

  r.post(
    '/auth/telegram/miniapp',
    {
      config: { public: true, allowCrossSite: true },
      schema: {
        summary: 'Telegram Mini App initData fallback (hash-verified)',
        body: telegramInitDataSchema,
        response: { 200: sessionResponseSchema },
      },
    },
    async (request, reply) => {
      assertProviderEnabled('telegram');
      const profile = verifyTelegramInitData({
        initData: request.body.initData,
        botToken: getConfig().oauth.telegram.botToken,
      });
      return finishApiFlow(request, reply, profile);
    },
  );
};

export default oauthRoutes;
