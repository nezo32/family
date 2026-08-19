import type { Permission } from '@family/shared';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { AuthContext } from '../core/auth/context.js';
import type { RouteAccessConfig } from '../core/plugins/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated caller. `null` on `config: { public: true }` routes. */
    auth: AuthContext | null;
    /** Set by `config: { scoped: '<base>' }` — narrow your query with it. */
    scope: 'any' | 'own' | null;
  }

  interface FastifyInstance {
    requirePermission(permission: Permission): preHandlerHookHandler;
    requireAny(...permissions: Permission[]): preHandlerHookHandler;
  }

  interface FastifyContextConfig extends RouteAccessConfig {
    /** Skip the mutating-request Origin/Sec-Fetch-Site check (OAuth callbacks). */
    allowCrossSite?: boolean;
  }
}

export type AuthenticatedRequest = FastifyRequest & { auth: AuthContext };
