import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  digestPreviewRequestSchema,
  digestPreviewResponseSchema,
  todayResponseSchema,
  weekQuerySchema,
  weekResponseSchema,
} from '@family/shared/contracts/dashboard';

import type { AuthContext } from '../../core/auth/context.js';
import { getDb } from '../../core/db.js';
import { unauthenticated } from '../../core/errors.js';
import { createDashboardPort, getToday, getWeek } from './dashboard.service.js';
import { createDigestPort, previewDigest } from './digest.service.js';

/**
 * Dashboard HTTP surface — three routes, mounted under `/api` by the module
 * registry.
 *
 * ## Access control (D4)
 *
 * Every route declares its access in the `config` block; `core/plugins/auth`
 * asserts at boot that no registered route declares nothing, so a forgotten
 * guard fails the app rather than shipping an open endpoint. There is no
 * `config: { public: true }` in this module, by design.
 *
 * `/dashboard/today` and `/dashboard/week` declare only `authenticated: true`
 * and **not** a specific permission, deliberately: they are the home screen,
 * every role must be able to open them, and a guest with almost no permissions
 * should get a small honest payload rather than a 403 on the app's front door.
 * The permission checks that matter happen *inside* the aggregate, per section,
 * and a section the caller may not read is never fetched at all — so a child's
 * response contains no goal title, no target and no amount rather than a
 * filtered version of one.
 *
 * `/dashboard/digest/preview` is a personal-settings action and declares
 * `notification:manage:own`, matching the `GET/PUT /notifications/digest`
 * routes it sits next to on the settings screen. It is a write-shaped action on
 * a section its caller can already see, so it stays 403 on a denial rather than
 * taking `notFoundOnDeny` — there is nothing here whose existence is a secret,
 * which is exactly why the two reads need no permission at all.
 *
 * ## Why the preview is a POST
 *
 * It takes a body (the section list being edited, which is not yet saved) and
 * it is not a cacheable representation of a resource — the settings screen
 * renders "what would my digest look like *right now* with these sections". A
 * GET with a repeated `sections` query parameter would be both uglier and
 * misleadingly cacheable.
 */

/**
 * The declared access for every route here, as data.
 *
 * Exported so `dashboard.test.ts` can assert that what is actually registered
 * matches what is documented — the check that catches a guard quietly loosened
 * during a refactor.
 */
export const DASHBOARD_ROUTE_ACCESS = {
  'GET /dashboard/today': { authenticated: true },
  'GET /dashboard/week': { authenticated: true },
  'POST /dashboard/digest/preview': { permission: 'notification:manage:own' },
} as const;

/**
 * No dashboard route is public, so a null `auth` means the auth plugin was
 * bypassed. Fail loudly rather than inventing an anonymous actor.
 */
function actorOf(auth: AuthContext | null): AuthContext {
  if (!auth) throw unauthenticated();
  return auth;
}

const dashboardRoutes: FastifyPluginAsync = async (instance: FastifyInstance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/dashboard/today',
    {
      config: { authenticated: true },
      schema: {
        tags: ['dashboard'],
        summary: 'Экран «Сегодня» — один агрегат на всё',
        response: { 200: todayResponseSchema },
      },
    },
    async (request) => getToday(createDashboardPort(getDb()), actorOf(request.auth)),
  );

  app.get(
    '/dashboard/week',
    {
      config: { authenticated: true },
      schema: {
        tags: ['dashboard'],
        summary: 'Ближайшая неделя, разложенная по локальным дням',
        querystring: weekQuerySchema,
        response: { 200: weekResponseSchema },
      },
    },
    async (request) => getWeek(createDashboardPort(getDb()), actorOf(request.auth), request.query),
  );

  app.post(
    '/dashboard/digest/preview',
    {
      config: { permission: 'notification:manage:own' },
      schema: {
        tags: ['dashboard'],
        summary: 'Как будет выглядеть мой дайджест',
        body: digestPreviewRequestSchema,
        response: { 200: digestPreviewResponseSchema },
      },
    },
    async (request) =>
      previewDigest(createDigestPort(getDb()), actorOf(request.auth), request.body.sections),
  );
};

export default dashboardRoutes;
