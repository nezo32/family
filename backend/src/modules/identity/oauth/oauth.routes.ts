import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  oauthCallbackQuerySchema,
  oauthProviderSchema,
  oauthStartQuerySchema,
  oauthStartResponseSchema,
  safeRedirectSchema,
  sessionResponseSchema,
  telegramInitDataSchema,
  telegramWidgetPayloadSchema,
  type ErrorCode,
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
  flowHintFromState,
  type OAuthTransaction,
  type OAuthTransactionStore,
} from './transactions.js';

/**
 * OAuth / OIDC routes for Google and Telegram.
 *
 * Registered under `/api`, so the public paths are `/api/auth/...` — which is
 * exactly what `config.oauth.<provider>.redirectUri` builds and therefore what
 * must be registered in each provider's console.
 *
 * Two rules run through everything below:
 *
 * - **`state` is server-side.** Every flow starts by writing an
 *   `oauth_transactions` row and ends by consuming it exactly once. A cookie
 *   store would not survive the cross-site POSTs the Telegram fallbacks arrive
 *   on, where a `SameSite=Lax` cookie is not sent at all.
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
      const state = await transactions.create({
        provider: 'google',
        nonce,
        codeVerifier,
        ...common,
      });
      return {
        state,
        authorizationUrl: await buildGoogleAuthorizationUrl({ state, nonce, codeVerifier }),
      };
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

/**
 * Where a failed `/start` lands.
 *
 * `/start` is a **top-level browser navigation**, so throwing renders the JSON
 * error envelope into the address bar: English, developer-facing, and with no
 * way back to the app. The login screen already turns `?error=<ErrorCode>` into
 * a Russian sentence; `provider` lets it name which provider is unavailable
 * instead of blaming sign-in as a whole.
 */
function loginErrorUrl(provider: OAuthProvider, code: ErrorCode): string {
  const url = new URL(appUrl('/login'));
  url.searchParams.set('error', code);
  url.searchParams.set('provider', provider);
  return url.href;
}

function providerError(provider: string, error: string, description?: string): AppError {
  return new AppError('OAUTH_PROVIDER_ERROR', `${provider} returned an error`, {
    context: { error, description },
  });
}

/* -------------------------------------------------------------------------- */
/* callback failures — the same rule as /start, for the same reason            */
/* -------------------------------------------------------------------------- */

/**
 * Where a browser flow lands when it could not be finished. Mirrors
 * `ROUTES.login` / `ROUTES.settingsAccounts` in
 * `frontend/src/shared/lib/routes.ts`.
 *
 * A failed *link* must not be dumped on the login screen: the user is signed in
 * and was standing on Настройки → Способы входа, which is also the one screen
 * that can show them whether the link actually took.
 */
const CALLBACK_LANDING: Record<OAuthIntent, string> = {
  login: '/login',
  link: '/settings/accounts',
};

/**
 * `?oauth=replayed` — the callback ran twice and this is the second one.
 *
 * Deliberately **not** `?error=`: the landing pages render it as a neutral
 * notice, not a failure. See `callbackFailureUrl` for why that is the honest
 * reading and what it is careful not to claim.
 */
export const REPLAYED_STATE_PARAM = 'oauth';
export const REPLAYED_STATE_VALUE = 'replayed';

/** The `reason` `assertTransactionUsable` attaches when there was no row at all. */
function isUnknownStateFailure(error: unknown): boolean {
  return (
    AppError.isAppError(error) &&
    error.code === 'BAD_REQUEST' &&
    error.context?.['reason'] === 'unknown'
  );
}

/**
 * Turn a dead callback into a place in the app, never into a JSON envelope.
 *
 * The callback is a **top-level browser navigation** — the same fact that made
 * `/start` redirect. Everything it can throw (a provider that is not
 * configured, a token exchange that failed, a subject already bound to somebody
 * else, a state that will not redeem) was being rendered into the address bar
 * as `{"error":{"code":"BAD_REQUEST","message":"OAuth state is unknown or has
 * already been used","requestId":"…"}}`: English, developer-facing, no way back.
 *
 * ### The replay case is not an error
 *
 * When the state is unknown *because it was already consumed*, the flow the
 * human performed succeeded — a second callback for one authorization is a
 * client-side duplicate (see `frontend/src/sw.ts`), and its 400 is the *first*
 * one's success viewed from the losing side. Showing an error there is simply
 * wrong.
 *
 * We cannot prove that from here, and we do not try to. Delete-on-read is the
 * replay guard (D3), so "already consumed" and "never existed" are the same
 * observation by construction, and the second is also what an attacker
 * replaying a stolen link would present. Keeping a recently-consumed set to
 * tell them apart would put back the state D3 deletes, and would still only
 * change the wording.
 *
 * So the redirect claims nothing. It carries `?oauth=replayed`, and the page it
 * lands on is the one that already knows the truth: Способы входа lists the
 * linked providers, and `/login` bounces a signed-in visitor into the app. The
 * user is told what actually happened by the app's own state rather than by a
 * sentence we guessed. An unknown state costs an attacker one redirect to a
 * screen that is behind the session guard.
 */
function callbackFailureUrl(
  provider: OAuthProvider,
  intent: OAuthIntent,
  error: unknown,
): { url: string; replayed: boolean } {
  const url = new URL(appUrl(CALLBACK_LANDING[intent]));
  url.searchParams.set('provider', provider);

  if (isUnknownStateFailure(error)) {
    url.searchParams.set(REPLAYED_STATE_PARAM, REPLAYED_STATE_VALUE);
    return { url: url.href, replayed: true };
  }

  // Expired states, provider mismatches, token-exchange failures, a subject
  // that belongs to somebody else — all real failures, all with Russian copy
  // already keyed off the code.
  const code: ErrorCode = AppError.isAppError(error) ? error.code : 'INTERNAL_ERROR';
  url.searchParams.set('error', code);
  return { url: url.href, replayed: false };
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
      const provider = request.params.provider;
      try {
        const { authorizationUrl } = await beginAuthorization({
          provider,
          intent: 'login',
          linkUserId: null,
          redirectAfter: request.query.redirect ?? null,
        });
        return reply.redirect(authorizationUrl, 302);
      } catch (error) {
        // Only *our side or the provider's* failures come back as a screen. A
        // 4xx (unknown provider, `intent=link` here) is a caller mistake and
        // stays a JSON error, so a broken client is not disguised as an outage.
        if (!AppError.isAppError(error) || error.statusCode < 500) throw error;
        request.log.error(
          { err: error, code: error.code, context: error.context, provider },
          'oauth start failed before the user ever reached the provider',
        );
        return reply.redirect(loginErrorUrl(provider, error.code), 302);
      }
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

  /* --------------------------- the callbacks ---------------------------- */

  /**
   * One handler for both providers, on purpose.
   *
   * Everything that differs between Google and Telegram is the token exchange;
   * everything that goes wrong — a duplicate callback, an expired state, a
   * refused exchange — goes wrong identically for both, and for `intent=login`
   * and `intent=link` alike. A fix written into one provider's branch would
   * have left the other three combinations rendering JSON at the user.
   */
  const browserCallback = (provider: OAuthProvider) =>
    async function handleCallback(
      request: FastifyRequest<{ Querystring: z.infer<typeof oauthCallbackQuerySchema> }>,
      reply: FastifyReply,
    ): Promise<FastifyReply> {
      const { code, state, error, error_description } = request.query;
      // Known only from the row; until it is consumed, the state's own marker is
      // the best guess at where this browser came from.
      let intent: OAuthIntent = flowHintFromState(state);

      try {
        // Checked before anything touches the database: a provider with no
        // credentials must answer cleanly, not fail somewhere deeper.
        assertProviderEnabled(provider);
        if (error) throw providerError(provider, error, error_description);
        if (!code || !state) throw new AppError('BAD_REQUEST', 'Missing code or state');

        const transaction = await store().consume(state, provider);
        intent = transaction.intent;
        if (!transaction.codeVerifier) {
          throw new AppError('BAD_REQUEST', 'OAuth transaction is missing its PKCE verifier');
        }

        const profile =
          provider === 'google'
            ? await exchangeGoogleCode({
                code,
                codeVerifier: transaction.codeVerifier,
                nonce: transaction.nonce,
              })
            : await exchangeTelegramCode({
                code,
                state,
                nonce: transaction.nonce,
                codeVerifier: transaction.codeVerifier,
              });

        return await finishBrowserFlow(request, reply, profile, transaction);
      } catch (failure) {
        const { url, replayed } = callbackFailureUrl(provider, intent, failure);
        // A replay is the expected shape of a duplicated navigation, not an
        // incident; everything else is worth an error line with its context.
        request.log[replayed ? 'info' : 'error'](
          {
            err: failure,
            provider,
            intent,
            ...(AppError.isAppError(failure)
              ? { code: failure.code, context: failure.context }
              : {}),
          },
          replayed
            ? 'oauth callback replayed a spent state — redirecting instead of erroring'
            : 'oauth callback failed — redirecting the browser into the app',
        );
        return reply.redirect(url, 302);
      }
    };

  r.get(
    '/auth/google/callback',
    {
      config: { public: true },
      schema: { summary: 'Google OIDC callback', querystring: oauthCallbackQuerySchema },
    },
    browserCallback('google'),
  );

  r.get(
    '/auth/telegram/callback',
    {
      config: { public: true },
      schema: { summary: 'Telegram OIDC callback', querystring: oauthCallbackQuerySchema },
    },
    browserCallback('telegram'),
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
