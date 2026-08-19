import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { FastifyPluginAsync } from 'fastify';

import type { Permission, Role } from '@family/shared';

import { buildAuthContext, type AuthContext } from '../core/auth/context.js';
import { decideAccess, type RouteAccessConfig } from '../core/plugins/auth.js';
import type { UserRow } from '../modules/identity/users.schema.js';

/**
 * Route-guard fixtures — "what status does this caller get on this route",
 * answered without a database, a token or an HTTP request.
 *
 * Two pieces, and the point of both is that they are **not** a re-implementation
 * of the thing under test:
 *
 * - `authFor()` builds the caller with the real `buildAuthContext`, so
 *   `permission_denies` behaves here exactly as it does in production. A test
 *   that hand-rolls `can: (p) => set.has(p)` cannot catch a revocation bug,
 *   because it has already assumed the revocation was applied.
 * - `collectRouteAccess()` reads what a route module actually registered, and
 *   `statusFor()` runs the real `decideAccess()` over it. A copy of the
 *   404-vs-403 rule living in a test file would keep passing after somebody
 *   changed the rule.
 *
 * What this cannot cover is the parts of the request lifecycle before the
 * guard — token verification, the suspended-user re-check. Those need the app
 * and a database, and live in `*.integration.test.ts`.
 */

export interface FakeUserOptions {
  readonly userId?: string;
  readonly displayName?: string;
  readonly timezone?: string | null;
  readonly status?: UserRow['status'];
  /** Per-user additions, exactly as the `permission_grants` column carries them. */
  readonly grants?: readonly Permission[];
  /** Per-user revocations. These win over the role matrix and over `grants`. */
  readonly denies?: readonly Permission[];
}

const ROLE_IDS: Record<Role, string> = {
  owner: '00000000-0000-4000-8000-0000000000a1',
  admin: '00000000-0000-4000-8000-0000000000a2',
  adult: '00000000-0000-4000-8000-0000000000a3',
  teen: '00000000-0000-4000-8000-0000000000a4',
  child: '00000000-0000-4000-8000-0000000000a5',
  guest: '00000000-0000-4000-8000-0000000000a6',
};

/**
 * A caller of the given role, resolved through the real permission pipeline.
 *
 * The cast is deliberate: `buildAuthContext` reads six columns of `UserRow` and
 * a fixture that filled in the other twenty would only make it harder to see
 * which ones matter.
 */
export function authFor(role: Role, options: FakeUserOptions = {}): AuthContext {
  const row = {
    id: options.userId ?? ROLE_IDS[role],
    role,
    status: options.status ?? 'active',
    displayName: options.displayName ?? `Тест (${role})`,
    timezone: options.timezone ?? 'Europe/Moscow',
    permissionGrants: [...(options.grants ?? [])],
    permissionDenies: [...(options.denies ?? [])],
  } as unknown as UserRow;

  return buildAuthContext(row);
}

export interface CollectedRoute {
  readonly method: string;
  readonly url: string;
  readonly key: string;
  readonly access: RouteAccessConfig;
}

/**
 * Every route a plugin registers, with the access config it declared.
 *
 * Registration never runs a handler, so no database or Redis is involved — the
 * services these modules construct at registration time are lazy about their
 * connections.
 */
export async function collectRouteAccess(plugin: FastifyPluginAsync): Promise<CollectedRoute[]> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const routes: CollectedRoute[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      routes.push({
        method,
        url: route.url,
        key: `${method} ${route.url}`,
        access: route.config ?? {},
      });
    }
  });

  await app.register(plugin);
  await app.ready();
  await app.close();
  return routes;
}

/** The HTTP status the guard would answer with. `200` means "the handler runs". */
export function statusFor(access: RouteAccessConfig, auth: AuthContext): number {
  if (access.public) return 200;
  const decision = decideAccess(access, auth);
  return decision.allowed ? 200 : decision.error.statusCode;
}
