import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  activityItemSchema,
  commentListResponseSchema,
  commentResponseSchema,
  createCommentSchema,
  createPollSchema,
  createPostSchema,
  cursorPaginationSchema,
  idSchema,
  isoDateTimeSchema,
  kudosCreateSchema,
  kudosListQuerySchema,
  kudosListResponseSchema,
  kudosResponseSchema,
  listActivityQuerySchema,
  listCommentsQuerySchema,
  listPollsQuerySchema,
  listPostsQuerySchema,
  okSchema,
  pollListResponseSchema,
  pollResponseSchema,
  postListResponseSchema,
  postResponseSchema,
  reactionListResponseSchema,
  toggleReactionSchema,
  updateCommentSchema,
  updatePollSchema,
  updatePostSchema,
  votePollSchema,
  type CommentableEntityType,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import { getDb } from '../../core/db.js';
import { unauthenticated } from '../../core/errors.js';
import * as comments from './comments.service.js';
import * as pollsService from './polls.service.js';
import * as wall from './wall.service.js';

/**
 * Wall routes (household.md §1).
 *
 * Every route declares its access in the `config` block — the boot assertion in
 * `core/plugins/auth.ts` refuses to start otherwise (D4 deny-by-default). Where
 * a rule needs the row (author checks, private targets), the guard is the
 * coarse one and the service does the narrowing, returning **404 rather than
 * 403** for anything outside the caller's read scope.
 */

const idParams = z.object({ id: idSchema });

const feedItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('post'),
    id: idSchema,
    createdAt: isoDateTimeSchema,
    post: postResponseSchema,
  }),
  z.object({
    kind: z.literal('activity'),
    id: idSchema,
    createdAt: isoDateTimeSchema,
    activity: activityItemSchema,
  }),
]);

const feedResponseSchema = z.object({
  /** Live pins, served outside the cursor stream so page 2 never repeats them. */
  pinned: z.array(postResponseSchema),
  items: z.array(feedItemSchema),
  nextCursor: z.string().nullable(),
});

const activityListSchema = z.object({
  items: z.array(activityItemSchema),
  nextCursor: z.string().nullable(),
});

const kudosTotalsSchema = z.object({
  items: z.array(
    z.object({
      userId: idSchema,
      displayName: z.string(),
      received: z.number().int().min(0),
    }),
  ),
});

const pinBodySchema = z.object({
  /** `null` unpins. Pins always expire — see `wall.service.setPin`. */
  pinnedUntil: isoDateTimeSchema.nullable(),
});

/**
 * URL segment → `entityType`. The generic comment endpoints are mounted once
 * per commentable type instead of behind a `/:entityType/` wildcard: a wildcard
 * at the root would swallow every other module's routes, and the closed enum is
 * the whole point of the polymorphic design.
 */
const COMMENT_MOUNTS: ReadonlyArray<{ segment: string; entityType: CommentableEntityType }> = [
  { segment: 'posts', entityType: 'post' },
  { segment: 'tasks', entityType: 'task' },
  { segment: 'events', entityType: 'event' },
  { segment: 'goals', entityType: 'goal' },
  { segment: 'polls', entityType: 'poll' },
];

function callerOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

const wallRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /* ------------------------------- the feed ------------------------------- */

  app.get(
    '/wall/feed',
    {
      config: { authenticated: true },
      schema: {
        tags: ['wall'],
        summary: 'Announcements, system posts and activity in one timeline',
        querystring: cursorPaginationSchema,
        response: { 200: feedResponseSchema },
      },
    },
    async (request) => wall.getWallFeed(getDb(), callerOf(request), request.query),
  );

  /* --------------------------------- posts -------------------------------- */

  app.get(
    '/wall/posts',
    {
      config: { authenticated: true },
      schema: {
        tags: ['wall'],
        summary: 'Announcements, pinned first',
        querystring: listPostsQuerySchema,
        response: { 200: postListResponseSchema },
      },
    },
    async (request) => wall.listPosts(getDb(), callerOf(request), request.query),
  );

  app.post(
    '/wall/posts',
    {
      config: { permission: 'post:create' },
      schema: {
        tags: ['wall'],
        body: createPostSchema,
        response: { 201: postResponseSchema },
      },
    },
    async (request, reply) => {
      const post = await wall.createAnnouncement(getDb(), callerOf(request), request.body);
      return reply.code(201).send(post);
    },
  );

  app.get(
    '/wall/posts/:id',
    {
      config: { authenticated: true },
      schema: {
        tags: ['wall'],
        params: idParams,
        response: { 200: postResponseSchema },
      },
    },
    async (request) => wall.getPost(getDb(), callerOf(request), request.params.id),
  );

  app.patch(
    '/wall/posts/:id',
    {
      // Editing is scoped exactly like deleting (household.md §1, footnote 1):
      // the author, or a holder of `post:delete:any`.
      config: { scoped: 'post:delete' },
      schema: {
        tags: ['wall'],
        params: idParams,
        body: updatePostSchema,
        response: { 200: postResponseSchema },
      },
    },
    async (request) =>
      wall.updateAnnouncement(getDb(), callerOf(request), request.params.id, request.body),
  );

  app.post(
    '/wall/posts/:id/pin',
    {
      config: { permission: 'post:pin' },
      schema: {
        tags: ['wall'],
        params: idParams,
        body: pinBodySchema,
        response: { 200: postResponseSchema },
      },
    },
    async (request) =>
      wall.setPin(getDb(), callerOf(request), request.params.id, request.body.pinnedUntil),
  );

  app.delete(
    '/wall/posts/:id',
    {
      config: { scoped: 'post:delete' },
      schema: {
        tags: ['wall'],
        params: idParams,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await wall.deletePost(getDb(), callerOf(request), request.params.id);
      return { ok: true as const };
    },
  );

  /* ---------------------- comments & reactions (generic) ------------------- */

  for (const { segment, entityType } of COMMENT_MOUNTS) {
    app.get(
      `/${segment}/:id/comments`,
      {
        // The permission that matters is the **target's** read permission, which
        // only the service can resolve; it throws 404 when the target is out of
        // scope, so an unreadable goal's discussion does not even exist here.
        config: { authenticated: true },
        schema: {
          tags: ['wall'],
          summary: `Comments on a ${entityType}`,
          params: idParams,
          querystring: listCommentsQuerySchema,
          response: { 200: commentListResponseSchema },
        },
      },
      async (request) =>
        comments.listCommentsFor(
          getDb(),
          callerOf(request),
          { entityType, entityId: request.params.id },
          request.query,
        ),
    );

    app.post(
      `/${segment}/:id/comments`,
      {
        config: { permission: 'comment:create' },
        schema: {
          tags: ['wall'],
          params: idParams,
          body: createCommentSchema,
          response: { 201: commentResponseSchema },
        },
      },
      async (request, reply) => {
        const comment = await comments.addComment(
          getDb(),
          callerOf(request),
          { entityType, entityId: request.params.id },
          request.body,
        );
        return reply.code(201).send(comment);
      },
    );

    app.get(
      `/${segment}/:id/reactions`,
      {
        config: { authenticated: true },
        schema: {
          tags: ['wall'],
          params: idParams,
          response: { 200: reactionListResponseSchema },
        },
      },
      async (request) =>
        comments.getReactionSummary(getDb(), callerOf(request), {
          entityType,
          entityId: request.params.id,
        }),
    );

    app.post(
      `/${segment}/:id/reactions`,
      {
        // Reacting is comment-level, not kudos-level. See comments.service.ts.
        config: { permission: 'comment:create' },
        schema: {
          tags: ['wall'],
          summary: 'Idempotent toggle; returns the fresh summary',
          params: idParams,
          body: toggleReactionSchema,
          response: { 200: reactionListResponseSchema },
        },
      },
      async (request) =>
        comments.toggleReaction(
          getDb(),
          callerOf(request),
          { entityType, entityId: request.params.id },
          request.body,
        ),
    );
  }

  app.patch(
    '/comments/:id',
    {
      // Author-only, and the service enforces it: there is no `:any` override
      // for editing somebody else's words.
      config: { permission: 'comment:create' },
      schema: {
        tags: ['wall'],
        params: idParams,
        body: updateCommentSchema,
        response: { 200: commentResponseSchema },
      },
    },
    async (request) =>
      comments.editComment(getDb(), callerOf(request), request.params.id, request.body),
  );

  app.delete(
    '/comments/:id',
    {
      config: { scoped: 'comment:delete' },
      schema: {
        tags: ['wall'],
        params: idParams,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await comments.deleteComment(getDb(), callerOf(request), request.params.id);
      return { ok: true as const };
    },
  );

  /* --------------------------------- kudos -------------------------------- */

  app.get(
    '/wall/kudos',
    {
      config: { authenticated: true },
      schema: {
        tags: ['wall'],
        querystring: kudosListQuerySchema,
        response: { 200: kudosListResponseSchema },
      },
    },
    async (request) => wall.listKudos(getDb(), request.query),
  );

  app.post(
    '/wall/kudos',
    {
      config: { permission: 'kudos:give' },
      schema: {
        tags: ['wall'],
        body: kudosCreateSchema,
        response: { 201: kudosResponseSchema },
      },
    },
    async (request, reply) => {
      const given = await wall.giveKudos(getDb(), callerOf(request), request.body);
      return reply.code(201).send(given);
    },
  );

  app.get(
    '/wall/kudos/totals',
    {
      config: { authenticated: true },
      schema: {
        tags: ['wall'],
        summary: 'Kudos received per member — every member, never a top-N leaderboard',
        querystring: z.object({ sinceDays: z.coerce.number().int().min(1).max(365).optional() }),
        response: { 200: kudosTotalsSchema },
      },
    },
    async (request) => {
      const { sinceDays } = request.query;
      const since = sinceDays
        ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
        : undefined;
      return { items: await wall.kudosTotals(getDb(), since ? { since } : {}) };
    },
  );

  /* --------------------------------- polls -------------------------------- */

  app.get(
    '/wall/polls',
    {
      config: { authenticated: true },
      schema: {
        tags: ['wall'],
        querystring: listPollsQuerySchema,
        response: { 200: pollListResponseSchema },
      },
    },
    async (request) => pollsService.listPolls(getDb(), callerOf(request), request.query),
  );

  app.post(
    '/wall/polls',
    {
      config: { permission: 'poll:create' },
      schema: {
        tags: ['wall'],
        body: createPollSchema,
        response: { 201: pollResponseSchema },
      },
    },
    async (request, reply) => {
      const poll = await pollsService.createPoll(getDb(), callerOf(request), request.body);
      return reply.code(201).send(poll);
    },
  );

  app.get(
    '/wall/polls/:id',
    {
      config: { authenticated: true },
      schema: {
        tags: ['wall'],
        params: idParams,
        response: { 200: pollResponseSchema },
      },
    },
    async (request) => pollsService.getPoll(getDb(), callerOf(request), request.params.id),
  );

  app.patch(
    '/wall/polls/:id',
    {
      // Author + `poll:close`, or the `post:delete:any` moderator override.
      // Resolved in the service, which needs the row to know the author.
      config: { authenticated: true },
      schema: {
        tags: ['wall'],
        params: idParams,
        body: updatePollSchema,
        response: { 200: pollResponseSchema },
      },
    },
    async (request) =>
      pollsService.updatePoll(getDb(), callerOf(request), request.params.id, request.body),
  );

  app.delete(
    '/wall/polls/:id',
    {
      config: { authenticated: true },
      schema: {
        tags: ['wall'],
        params: idParams,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await pollsService.deletePoll(getDb(), callerOf(request), request.params.id);
      return { ok: true as const };
    },
  );

  app.post(
    '/wall/polls/:id/votes',
    {
      config: { permission: 'poll:vote' },
      schema: {
        tags: ['wall'],
        summary: 'Replaces the caller’s selection; a closed poll answers 409',
        params: idParams,
        body: votePollSchema,
        response: { 200: pollResponseSchema },
      },
    },
    async (request) =>
      pollsService.castVote(getDb(), callerOf(request), request.params.id, request.body),
  );

  /* ------------------------------- activity ------------------------------- */

  app.get(
    '/activity',
    {
      // Not the security audit log: `audit:read` covers auth events, this is the
      // family's own "who did what" and every active member sees it.
      config: { authenticated: true },
      schema: {
        tags: ['wall'],
        querystring: listActivityQuerySchema,
        response: { 200: activityListSchema },
      },
    },
    async (request) => wall.listActivity(getDb(), request.query),
  );
};

export default wallRoutes;
