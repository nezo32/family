import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  approveMemberRequestSchema,
  idSchema,
  linkedIdentityListSchema,
  meResponseSchema,
  memberListItemSchema,
  memberListQuerySchema,
  memberListResponseSchema,
  publicUserSchema,
  rejectMemberRequestSchema,
  selfUserSchema,
  suspendMemberRequestSchema,
  unlinkIdentityParamsSchema,
  updateMemberRequestSchema,
  updateProfileRequestSchema,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import { getDb } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import * as service from './identity.service.js';

/**
 * Self-service profile, linked identities and member administration.
 *
 * Every route declares its access in the `config` block (D4) — the boot
 * assertion in `core/plugins/auth.ts` fails the whole app if one does not.
 * Nothing here re-derives the permission matrix; the guard has already run by
 * the time a handler executes, and `request.auth` carries the resolved set.
 */

const memberParamsSchema = z.object({ id: idSchema });

/**
 * `request.auth` is typed nullable because public routes exist. Every route in
 * this file declares a guard, so it is non-null here — but a thrown
 * `UNAUTHENTICATED` is a better failure mode than a non-null assertion that
 * silently becomes wrong if somebody edits the `config` block.
 */
function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new AppError('UNAUTHENTICATED', 'Authentication required');
  return request.auth;
}

function requestContext(request: FastifyRequest): service.RequestContext {
  return {
    userAgent: request.headers['user-agent'] ?? null,
    ip: request.ip,
    actorId: request.auth?.userId ?? null,
  };
}

/**
 * The roster is served through one of two serializers depending on the caller's
 * permissions (see `identity.md` §1.5). The union is ordered admin-first: a full
 * row satisfies the admin schema, and a public row falls through to the narrow
 * one, so the wire shape always matches what the caller was actually allowed to
 * see rather than what the client asked for.
 */
const memberRosterResponseSchema = z.object({
  items: z.array(z.union([memberListItemSchema, publicUserSchema])),
  pendingCount: z.number().int().min(0),
});

const usersRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /* ====================================================================== */
  /* self                                                                    */
  /* ====================================================================== */

  app.get(
    '/me',
    {
      // No specific permission: every active member may read their own identity,
      // and this endpoint is what tells the client which permissions it has.
      config: { authenticated: true },
      schema: {
        tags: ['me'],
        summary: 'Profile, effective permissions and family context',
        description:
          'The single source of client-side authorization state (D4). `permissions` ' +
          'is the effective list (role matrix + grants − denies); the client never ' +
          're-derives it and never branches on `role`.',
        response: { 200: meResponseSchema },
      },
    },
    async (request) => service.getMe(getDb(), requireAuth(request).userId),
  );

  app.patch(
    '/me',
    {
      config: { permission: 'profile:update:own' },
      schema: {
        tags: ['me'],
        summary: 'Update your own profile',
        description:
          'The contract is `.strict()`, so an attempt to smuggle `role`, `status` ' +
          'or a permission override in here is a 400 rather than a silent no-op.',
        body: updateProfileRequestSchema,
        response: { 200: selfUserSchema },
      },
    },
    async (request) => service.updateProfile(getDb(), requireAuth(request).userId, request.body),
  );

  /* ====================================================================== */
  /* linked identities                                                       */
  /* ====================================================================== */

  app.get(
    '/me/identities',
    {
      config: { permission: 'identity:manage:own' },
      schema: {
        tags: ['me'],
        summary: 'Linked sign-in methods, plus the ones still available',
        response: { 200: linkedIdentityListSchema },
      },
    },
    async (request) => service.listLinkedIdentities(getDb(), requireAuth(request).userId),
  );

  app.delete(
    '/me/identities/:provider',
    {
      config: { permission: 'identity:manage:own' },
      schema: {
        tags: ['me'],
        summary: 'Unlink a sign-in method',
        description:
          'Guarded by `SELECT ... FOR UPDATE` on the user row plus a login-method ' +
          'count: removing the last way to sign in returns `403 LAST_LOGIN_METHOD`.',
        params: unlinkIdentityParamsSchema,
        response: { 200: linkedIdentityListSchema },
      },
    },
    async (request) =>
      service.unlinkIdentity(
        getDb(),
        requireAuth(request).userId,
        request.params.provider,
        requestContext(request),
      ),
  );

  /* ====================================================================== */
  /* member administration                                                   */
  /* ====================================================================== */

  app.get(
    '/members',
    {
      config: { permission: 'member:read' },
      schema: {
        tags: ['members'],
        summary: 'Family roster',
        description:
          'Callers with `member:update:any` receive the admin projection and the ' +
          'pending-approval badge count; everybody else receives the public one.',
        querystring: memberListQuerySchema,
        response: { 200: memberRosterResponseSchema },
      },
    },
    async (request) => service.listMembers(getDb(), requireAuth(request), request.query),
  );

  app.get(
    '/members/pending',
    {
      // Tighter than `/members`: the approval queue is moderation state, and
      // only somebody who can act on it has a reason to read it.
      config: { permission: 'member:approve' },
      schema: {
        tags: ['members'],
        summary: 'Signups awaiting approval',
        response: { 200: memberListResponseSchema },
      },
    },
    async () => service.listPendingMembers(getDb()),
  );

  app.patch(
    '/members/:id',
    {
      config: { permission: 'member:update:any' },
      schema: {
        tags: ['members'],
        summary: 'Update a member: role, chore weight, permission overrides',
        description:
          'A role change additionally requires `member:role:assign` and a strictly ' +
          'higher rank than both the target and the new role; permission grants are ' +
          'capped at what the actor holds; demoting the last owner is `LAST_OWNER`.',
        params: memberParamsSchema,
        body: updateMemberRequestSchema,
        response: { 200: memberListItemSchema },
      },
    },
    async (request) =>
      service.updateMember(
        getDb(),
        requireAuth(request),
        request.params.id,
        request.body,
        requestContext(request),
      ),
  );

  app.post(
    '/members/:id/approve',
    {
      config: { permission: 'member:approve' },
      schema: {
        tags: ['members'],
        summary: 'Approve a pending signup',
        description:
          'Conditional update on `status = pending_approval`: two admins clicking at ' +
          'the same moment produce one 200 and one 409 CONFLICT. The role is chosen ' +
          'here, never self-declared at signup.',
        params: memberParamsSchema,
        body: approveMemberRequestSchema,
        response: { 200: memberListItemSchema },
      },
    },
    async (request) =>
      service.approveMember(
        getDb(),
        requireAuth(request),
        request.params.id,
        request.body,
        requestContext(request),
      ),
  );

  app.post(
    '/members/:id/reject',
    {
      config: { permission: 'member:approve' },
      schema: {
        tags: ['members'],
        summary: 'Decline a pending signup',
        params: memberParamsSchema,
        // `nullish`: Fastify validates a bodyless POST as `null`, and the
        // reason is optional on this endpoint.
        body: rejectMemberRequestSchema.nullish(),
        response: { 200: memberListItemSchema },
      },
    },
    async (request) =>
      service.rejectMember(
        getDb(),
        requireAuth(request),
        request.params.id,
        request.body?.reason,
        requestContext(request),
      ),
  );

  app.post(
    '/members/:id/suspend',
    {
      config: { permission: 'member:update:any' },
      schema: {
        tags: ['members'],
        summary: 'Suspend an active member',
        description:
          'Revokes every refresh family in the same transaction, so the session ' +
          'cannot be renewed; the access token already in flight dies at the status ' +
          'gate on its next request.',
        params: memberParamsSchema,
        body: suspendMemberRequestSchema.nullish(),
        response: { 200: memberListItemSchema },
      },
    },
    async (request) =>
      service.suspendMember(
        getDb(),
        requireAuth(request),
        request.params.id,
        request.body?.reason,
        requestContext(request),
      ),
  );

  /**
   * `reactivate` and `reinstate` are the same operation under both names the
   * project uses for it — the route table in `docs/architecture/identity.md`
   * says `reinstate`, the module brief says `reactivate`. Registering both costs
   * nothing and spares the frontend a coin flip.
   */
  for (const path of ['/members/:id/reactivate', '/members/:id/reinstate'] as const) {
    app.post(
      path,
      {
        config: { permission: 'member:update:any' },
        schema: {
          tags: ['members'],
          summary: 'Return a suspended member to active',
          description:
            'Does not restore the revoked sessions — the member signs in again. ' +
            'Reviving a family revoked for cause would revive the leaked cookie too.',
          params: memberParamsSchema,
          response: { 200: memberListItemSchema },
          hide: path.endsWith('reinstate'),
        },
      },
      async (request) =>
        service.reactivateMember(
          getDb(),
          requireAuth(request),
          request.params.id,
          requestContext(request),
        ),
    );
  }
};

export default usersRoutes;
