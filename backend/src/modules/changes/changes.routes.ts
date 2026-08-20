import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ChangeDomain, RevisionMap } from '@family/shared';
import { changesResponseSchema } from '@family/shared/contracts/changes';

import type { AuthContext } from '../../core/auth/context.js';
import { unauthenticated } from '../../core/errors.js';
import { readRevisions } from '../../core/revisions.js';

/**
 * `GET /api/changes` — the whole read side of the change feed (D12,
 * `docs/architecture/sync.md` §4.4).
 *
 * Roughly 120 bytes, polled every 15 seconds while the app is visible and every
 * 5 while a shopping list is on screen. One request covers every screen at once,
 * including the notification bell and the «Сегодня» dashboard, instead of one
 * interval per query each pulling a full list payload.
 *
 * It reuses the ordinary authenticated request path deliberately: a 401 mid-poll
 * goes through the single-flight refresh the client already has, which is the
 * argument that decided D12 against SSE. Nothing here may become a second auth
 * surface.
 *
 * No route-level rate-limit override (the global limiter allows 300/min keyed on
 * `userId`; the worst case here is 12/min), no `Cache-Control` work (the client
 * already sends `cache: 'no-store'` and the service worker never caches
 * `/api/*`), and no Caddy configuration — it is an ordinary short JSON GET.
 */

/**
 * Which read permission gates which domain.
 *
 * The map is filtered by the caller's **read** scope before it goes on the wire,
 * and that does two things at once: a child's client never learns that the goals
 * domain moved, and never invalidates a query it is not allowed to run. D4 —
 * the server decides, the client does not re-derive.
 *
 * `wall` and `notifications` have no entry because neither is gated: the wall
 * routes are `authenticated: true` and narrowed inside the service, and the
 * inbox is your own.
 *
 * `tasks` is a predicate rather than a permission name because task reads are
 * *scoped* — a child holds `task:read:own` and an adult `task:read:any`, and
 * there is no bare `task:read` to ask for. Anyone with either scope may see the
 * counter; what they are then allowed to fetch is the query's own business.
 */
const DOMAIN_VISIBLE: Partial<Record<ChangeDomain, (auth: AuthContext) => boolean>> = {
  tasks: (auth) => auth.scopeFor('task:read') !== null,
  events: (auth) => auth.can('event:read'),
  goals: (auth) => auth.can('goal:read'),
  shopping: (auth) => auth.can('shopping:read'),
  members: (auth) => auth.can('member:read'),
};

/**
 * A domain the caller may not read is **omitted**, never zeroed: on the client
 * "absent" is not a change, while a `0` would be a number that differs from
 * whatever was last seen and would trigger a pointless refetch.
 */
export function visibleRevisions(all: RevisionMap, auth: AuthContext): RevisionMap {
  const visible: RevisionMap = {};
  for (const [domain, revision] of Object.entries(all) as [ChangeDomain, number][]) {
    const isVisible = DOMAIN_VISIBLE[domain];
    if (isVisible && !isVisible(auth)) continue;
    visible[domain] = revision;
  }
  return visible;
}

const changesRoutes: FastifyPluginAsync = async (instance: FastifyInstance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/changes',
    {
      /**
       * `authenticated: true` and no permission: every role polls this, and the
       * filtering above is what makes that safe. It must answer **401** when
       * unauthenticated and never 403 — `route-access.test.ts` enforces that
       * repo-wide for reads.
       */
      config: { authenticated: true },
      schema: {
        tags: ['changes'],
        summary: 'Счётчики изменений по разделам',
        description:
          'Per-domain revision counters. The client remembers the map it last saw and ' +
          'invalidates the query keys of whichever domains moved. A domain the caller ' +
          'cannot read is omitted, not zeroed.',
        response: { 200: changesResponseSchema },
      },
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw unauthenticated();
      return { rev: visibleRevisions(await readRevisions(), auth) };
    },
  );
};

export default changesRoutes;
