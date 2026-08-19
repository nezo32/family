import type { FastifyPluginAsync } from 'fastify';

/**
 * Module registry.
 *
 * Every feature module exposes a default-exported Fastify plugin from its
 * `*.routes.ts` and is registered here under `/api`. Order matters only for
 * prefixes, not for behaviour — modules must not depend on each other's
 * registration order.
 *
 * Owned by the lead. Module agents write their own `*.routes.ts`; the lead
 * enables the corresponding line here as each module lands, so that a
 * half-finished module never breaks everyone else's typecheck.
 */

type ModuleLoader = () => Promise<{ default: FastifyPluginAsync }>;

const MODULE_LOADERS: ModuleLoader[] = [
  () => import('./identity/auth.routes.js'),
  () => import('./identity/oauth/oauth.routes.js'),
  () => import('./identity/users.routes.js'),
  () => import('./goals/goals.routes.js'),
  () => import('./shopping/shopping.routes.js'),
  () => import('./wall/wall.routes.js'),
  () => import('./tasks/tasks.routes.js'),
  () => import('./events/events.routes.js'),
  () => import('./chores/chores.routes.js'),
  () => import('./notifications/notifications.routes.js'),
  () => import('./dashboard/dashboard.routes.js'),
];

export const registerModules: FastifyPluginAsync = async (app) => {
  for (const load of MODULE_LOADERS) {
    const mod = await load();
    await app.register(mod.default);
  }
};
