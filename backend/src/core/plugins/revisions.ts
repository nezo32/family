import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import type { ChangeDomain } from '@family/shared';

import { bumpRevisions } from '../revisions.js';

/**
 * The write side of the change feed (D12, `docs/architecture/sync.md` §4).
 *
 * One `onResponse` hook: every successful non-GET under `/api` bumps the
 * revision counter of the domain its route belongs to, and every client polling
 * `GET /api/changes` sees the number move within a tick.
 *
 * ## Why `onResponse` and not `onSend` or a per-handler call
 *
 * A bump must mean "a write **completed** and **succeeded**". `onResponse` runs
 * after the reply has left, so a rejected write (validation, permission,
 * conflict) is already excluded by its status code, and nothing here can add
 * latency to the request that triggered it — the bump is fire-and-forget by
 * construction. Calling `bumpRevisions` from each handler instead would be
 * fifty call sites, forty-nine of which stay correct and one of which is
 * forgotten in six months' time.
 *
 * ## Why the route *pattern*
 *
 * `request.routeOptions.url` is the pattern, not the concrete URL — so
 * `/api/shopping/items/:id/toggle` is one table entry, not one per item id.
 * Verified against Fastify 5: the pattern carries the `/api` prefix that
 * `app.register(registerModules, { prefix: '/api' })` applies, so the table
 * below is written with it.
 */

/**
 * Route prefix → domains, **ordered, first match wins**, so the special cases
 * sit above the general ones.
 *
 * An entry mapping to no domains is **explicit, not a fallthrough**: it records
 * a decision that this write changes nothing another client can see. A write
 * route matching nothing at all is a build error, caught by the coverage guard
 * in `modules/changes/changes.test.ts` — the same shape as the boot assertion
 * in `auth.ts` that no route may ship without an access rule.
 *
 * The non-obvious rows:
 *
 * - **Chores are `tasks`.** Rotations, swaps and blackouts all render on the
 *   tasks screens and share the `['tasks']` key root. `/chores/kudos` is the
 *   exception, because kudos render on the wall. Fairness is not in that list:
 *   no screen draws a split of the housework any more (D5). The mapping is
 *   unchanged regardless — a rotation write still bumps `tasks`, because the
 *   assignment it produces is what those screens show.
 * - **Comments and reactions are `wall` wherever they are mounted.**
 *   `wall.routes.ts` mounts the generic discussion routes on five segments —
 *   `posts`, `polls`, `tasks`, `events`, `goals` — and a comment on a task
 *   changes no task: it changes the thread, which the client keys under
 *   `['wall','comments',…]`. Only wall *posts* carry a `commentCount`, so
 *   nothing else needs bumping alongside. These rows sit above the general
 *   `/api/tasks`, `/api/events` and `/api/goals` entries; without them a
 *   comment posted on a task would invalidate the task list and leave an open
 *   thread on another phone stale. (`/api/posts` and `/api/polls` exist only as
 *   comment/reaction mounts, so they take a plain prefix row.)
 * - **`/media` is classified as changing nothing, and that is the interesting
 *   row.** An upload is a **private draft**: it has no `entity_id` yet, nobody
 *   but its uploader can even fetch it, and no screen in the app lists it. It
 *   becomes visible to the family at the moment the post or comment carrying
 *   its id is written — and *that* write bumps `wall` through the rows below.
 *   Bumping `wall` here as well would make every other phone in the house
 *   refetch the feed once per file while somebody is still choosing photos, and
 *   show them nothing new each time. `DELETE /media/:id` is the same act in
 *   reverse and only ever reaches a draft (an attached file is removed by
 *   editing the post, which is a `/wall` write). Media *on* a live post is
 *   changed only through `PATCH /api/wall/posts/:id` and `PATCH
 *   /api/comments/:id`, both already `wall`.
 * - **`/notifications/deliveries/*`** are the D11 acknowledgement endpoints,
 *   written by the service worker on behalf of the device that just received a
 *   push. They change no shared state and must not make every open client
 *   refetch its inbox. The rest of `/notifications/*` that is settings —
 *   preferences, quiet hours, digest, subscriptions, telegram — is likewise
 *   nobody else's business (there is deliberately no `settings` domain).
 * - **`/me`** is `members`, because your display name and avatar appear on the
 *   family roster. It also carries the `['me']` invalidation on the client,
 *   which is what repairs a stale *affordance* list after a role change.
 * - **`/auth/*`** and **`/dashboard/digest/preview`** change no shared state;
 *   the latter is a read-shaped POST.
 */
export const ROUTE_DOMAINS: readonly (readonly [string, readonly ChangeDomain[]])[] = [
  ['/api/chores/kudos', ['wall']],
  ['/api/tasks/:id/comments', ['wall']],
  ['/api/tasks/:id/reactions', ['wall']],
  ['/api/events/:id/comments', ['wall']],
  ['/api/events/:id/reactions', ['wall']],
  ['/api/goals/:id/comments', ['wall']],
  ['/api/goals/:id/reactions', ['wall']],
  // «Спасибо» is a card in the feed now (§D7.6), so a thank-you takes comments
  // and reactions through the same generic mounts everything else uses. Both
  // land on Стена, so both bump `wall` and nothing else.
  ['/api/kudos/:id/comments', ['wall']],
  ['/api/kudos/:id/reactions', ['wall']],
  ['/api/media', []],
  ['/api/posts', ['wall']],
  ['/api/polls', ['wall']],
  ['/api/notifications/preferences', []],
  ['/api/notifications/quiet-hours', []],
  ['/api/notifications/digest', []],
  ['/api/notifications/subscriptions', []],
  ['/api/notifications/telegram', []],
  ['/api/notifications/deliveries', []],
  ['/api/notifications', ['notifications']],
  ['/api/tasks', ['tasks']],
  ['/api/chores', ['tasks']],
  ['/api/events', ['events']],
  ['/api/goals', ['goals']],
  ['/api/shopping', ['shopping']],
  ['/api/wall', ['wall']],
  ['/api/comments', ['wall']],
  ['/api/members', ['members']],
  ['/api/users', ['members']],
  ['/api/me', ['members']],
  ['/api/auth', []],
  ['/api/dashboard', []],
];

/**
 * The domains a route pattern belongs to, or `null` when the table says
 * nothing about it.
 *
 * `null` and `[]` are different answers and the difference is the point: `[]`
 * is "classified, and it changes nothing", `null` is "nobody has classified
 * this yet". Only the second is a bug.
 */
export function domainsForRoute(url: string | undefined): readonly ChangeDomain[] | null {
  if (!url) return null;
  for (const [prefix, domains] of ROUTE_DOMAINS) {
    if (url === prefix || url.startsWith(`${prefix}/`)) return domains;
  }
  return null;
}

/** Methods that cannot change anything, so they cannot bump anything. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const revisionsPlugin = fp(
  async (app: FastifyInstance) => {
    app.addHook('onResponse', async (request, reply) => {
      if (READ_METHODS.has(request.method)) return;
      // A rejected write changed nothing.
      if (reply.statusCode >= 400) return;

      const domains = domainsForRoute(request.routeOptions.url);
      if (!domains || domains.length === 0) return;

      // Fire and forget: the response is already sent, `bumpRevisions` never
      // throws, and nothing the client is waiting for may block on Redis.
      void bumpRevisions(domains);
    });
  },
  { name: 'revisions' },
);
