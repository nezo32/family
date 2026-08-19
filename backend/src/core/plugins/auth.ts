import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';

import type { Permission } from '@family/shared';

import { users } from '../../modules/identity/users.schema.js';
import { buildAuthContext, type AuthContext } from '../auth/context.js';
import { verifyAccessToken } from '../auth/tokens.js';
import { getDb } from '../db.js';
import { AppError } from '../errors.js';

/**
 * Authentication + authorization.
 *
 * Access control is declared in the route's `config` block rather than as a
 * pile of preHandlers, which makes it (a) impossible to forget — see the boot
 * assertion at the bottom — and (b) visible in one place when reading a route.
 *
 *   config: { public: true }                    // no authentication at all
 *   config: { authenticated: true }             // signed in, no specific permission
 *   config: { permission: 'task:create' }       // must hold exactly this
 *   config: { anyPermission: ['a', 'b'] }       // must hold at least one
 *   config: { scoped: 'task:read' }             // must hold :own or :any
 *
 * Add `notFoundOnDeny: true` when lacking the permission means the caller
 * cannot see that the section exists at all — a child has no `goal:*`
 * permission whatsoever, so `/goals` must answer 404, not 403. A 403 would
 * confirm the family has a moneybox (D4).
 *
 * With `scoped`, the resolved scope is stashed on `req.scope` so the handler can
 * narrow its query without re-deriving anything.
 */

/**
 * Routes registered by third-party plugins that we do not author. The OpenAPI
 * reference is deliberately reachable without a session — it is documentation
 * and exposes no data.
 */
const EXEMPT_PREFIXES = ['/documentation', '/docs'];

export interface RouteAccessConfig {
  public?: boolean;
  authenticated?: boolean;
  permission?: Permission;
  anyPermission?: Permission[];
  scoped?: string;
  /** Answer 404 instead of 403 when the permission check fails. See D4. */
  notFoundOnDeny?: boolean;
}

function accessConfigOf(request: FastifyRequest): RouteAccessConfig {
  return (request.routeOptions.config ?? {}) as RouteAccessConfig;
}

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

async function resolveAuth(request: FastifyRequest): Promise<AuthContext> {
  const token = extractBearer(request);
  if (!token) throw new AppError('UNAUTHENTICATED', 'Missing bearer token');

  const claims = await verifyAccessToken(token);

  // The token asserts a status, but the row is authoritative: a user suspended
  // one second ago must not survive on a token minted ten minutes ago.
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  if (!user) throw new AppError('UNAUTHENTICATED', 'User no longer exists');

  switch (user.status) {
    case 'active':
      break;
    case 'pending_approval':
      throw new AppError('ACCOUNT_PENDING_APPROVAL', 'Account is awaiting admin approval');
    case 'rejected':
      throw new AppError('ACCOUNT_REJECTED', 'Access request was declined');
    case 'suspended':
      throw new AppError('ACCOUNT_SUSPENDED', 'Account has been suspended');
  }

  return buildAuthContext(user);
}

/**
 * The caller, reduced to what an access decision actually reads. Anything
 * shaped like this — including a fixture built by `buildAuthContext` — can be
 * put through `decideAccess`, which is what makes the 404-vs-403 rule testable
 * without a database or an HTTP request.
 */
export type AccessActor = Pick<AuthContext, 'role' | 'can' | 'canAny' | 'scopeFor'>;

export type AccessDecision =
  | { readonly allowed: true; readonly scope: 'any' | 'own' | null }
  | { readonly allowed: false; readonly error: AppError };

/**
 * The one place a denial picks its status code.
 *
 * `notFoundOnDeny` routes answer 404 because the caller must not learn the
 * section exists; everything else answers 403, the honest "you can see it, you
 * may not do that to it" (D4). Both the `onRequest` hook and the
 * `requirePermission` / `requireAny` preHandlers come through here, so a route
 * cannot be 404 through one door and 403 through the other.
 */
export function denyError(
  access: RouteAccessConfig,
  required: string,
  context: Record<string, unknown>,
): AppError {
  if (access.notFoundOnDeny) {
    return new AppError('NOT_FOUND', 'Resource not found', { context });
  }
  return new AppError('FORBIDDEN', `Missing permission: ${required}`, { context });
}

/**
 * Pure: config + caller in, allow-or-error out. `enforce` is the thin wrapper
 * that applies the result to the request.
 */
export function decideAccess(access: RouteAccessConfig, auth: AccessActor): AccessDecision {
  if (access.permission && !auth.can(access.permission)) {
    return {
      allowed: false,
      error: denyError(access, access.permission, {
        required: access.permission,
        role: auth.role,
      }),
    };
  }

  if (access.anyPermission?.length && !auth.canAny(...access.anyPermission)) {
    return {
      allowed: false,
      error: denyError(access, access.anyPermission.join(' | '), {
        requiredAnyOf: access.anyPermission,
        role: auth.role,
      }),
    };
  }

  if (access.scoped) {
    const scope = auth.scopeFor(access.scoped);
    if (!scope) {
      return {
        allowed: false,
        error: denyError(access, `${access.scoped}:own`, {
          required: `${access.scoped}:own`,
          role: auth.role,
        }),
      };
    }
    return { allowed: true, scope };
  }

  return { allowed: true, scope: null };
}

function enforce(request: FastifyRequest, access: RouteAccessConfig): void {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', 'Authentication required');

  const decision = decideAccess(access, auth);
  if (!decision.allowed) throw decision.error;
  request.scope = decision.scope;
}

export const authPlugin = fp(
  async (app: FastifyInstance) => {
    app.decorateRequest('auth', null);
    app.decorateRequest('scope', null);

    app.addHook('onRequest', async (request) => {
      /**
       * An unmatched URL has no route and therefore no access config. Without
       * this guard the deny-by-default branch below would turn every 404 into a
       * 403, which both leaks nothing useful and directly contradicts D4's rule
       * that a missing resource must look missing.
       */
      if (request.is404) return;
      if (EXEMPT_PREFIXES.some((prefix) => request.url.startsWith(prefix))) return;

      const access = accessConfigOf(request);
      if (access.public) return;

      // A route that declares nothing is a bug, not a public route. The boot
      // assertion below normally catches this first; this is the runtime guard.
      const declaresAccess =
        access.authenticated ?? Boolean(access.permission ?? access.anyPermission ?? access.scoped);
      if (!declaresAccess) {
        request.log.error(
          { url: request.url, method: request.method },
          'route has no access configuration — denying by default',
        );
        throw new AppError('FORBIDDEN', 'Route has no access configuration');
      }

      request.auth = await resolveAuth(request);
      enforce(request, access);
    });

    /**
     * Deny-by-default, verified at boot rather than in production traffic.
     * Every registered route must opt in to exactly one access mode.
     */
    const undeclared: string[] = [];

    app.addHook('onRoute', (route: RouteOptions) => {
      if (route.method === 'HEAD') return;
      if (EXEMPT_PREFIXES.some((prefix) => route.url.startsWith(prefix))) return;
      const access = (route.config ?? {}) as RouteAccessConfig;
      const declared =
        access.public ??
        access.authenticated ??
        Boolean(access.permission ?? access.anyPermission ?? access.scoped);
      if (!declared) {
        const methods = Array.isArray(route.method) ? route.method.join(',') : route.method;
        undeclared.push(`${methods} ${route.url}`);
      }
    });

    app.addHook('onReady', async () => {
      if (undeclared.length > 0) {
        throw new Error(
          'These routes declare no access configuration. Add `config: { public: true }` ' +
            'or a permission guard:\n' +
            undeclared.map((r) => `  - ${r}`).join('\n'),
        );
      }
    });

    /* --- preHandler factories, for the rare route that needs a dynamic check --- */

    /**
     * These route through `denyError` with the route's own access config, so a
     * `notFoundOnDeny` route stays 404 no matter which door the denial comes
     * out of. Hard-coding 403 here — as they used to — meant a dynamic check on
     * a hidden section confirmed its existence anyway.
     */
    app.decorate('requirePermission', (permission: Permission) => {
      return async (request: FastifyRequest) => {
        if (!request.auth?.can(permission)) {
          throw denyError(accessConfigOf(request), permission, {
            required: permission,
            role: request.auth?.role,
          });
        }
      };
    });

    app.decorate('requireAny', (...permissions: Permission[]) => {
      return async (request: FastifyRequest) => {
        if (!request.auth?.canAny(...permissions)) {
          throw denyError(accessConfigOf(request), permissions.join(' | '), {
            requiredAnyOf: permissions,
            role: request.auth?.role,
          });
        }
      };
    });
  },
  { name: 'auth' },
);
