import multipart from '@fastify/multipart';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { MEDIA_MAX_BYTES, idSchema, selfUserSchema } from '@family/shared';

import { getConfig } from '../../core/config.js';
import { getDb } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { ALLOWED_IMAGE_TYPES } from './image.js';
import mediaRoutes from './media.routes.js';
import { getStorage } from './s3.adapter.js';
import * as service from './storage.service.js';

/**
 * Avatar upload, removal and delivery.
 *
 * ## Why the bytes come back through us
 *
 * The bucket is on the `data` network with no route to the internet and no
 * published port, and it stays that way: no presigned URLs, no public bucket
 * policy, no second hostname to get TLS onto. `GET /api/users/:id/avatar` is
 * the only door, which means a family photo is readable exactly as long as the
 * session is — the same rule as every other row in the database.
 *
 * The cost is one proxy hop per image, paid once per member per year thanks to
 * the immutable `Cache-Control`: the URL carries the object name, so a new
 * avatar is a new URL and a cached one can never be stale.
 *
 * ## Access
 *
 * The two writes are `profile:update:own` — a member may change their own face
 * and nobody else's, and there is deliberately no admin route to change
 * somebody else's. The read is `member:read` (which every role holds) with
 * `notFoundOnDeny`, so it can never answer 403 on a GET — the invariant
 * `core/plugins/route-access.test.ts` asserts across the whole app.
 */

const avatarParamsSchema = z.object({ id: idSchema });

/**
 * `?v=` is the object name, used purely as a cache buster. It is documented
 * here so the OpenAPI reader knows it is expected, and then ignored: the
 * handler resolves the key from the stored row, never from the query.
 */
const avatarQuerySchema = z.object({ v: z.string().max(128).optional() });

function requireUserId(request: FastifyRequest): string {
  if (!request.auth) throw new AppError('UNAUTHENTICATED', 'Authentication required');
  return request.auth.userId;
}

/**
 * Headers shared by the 200 and the 304.
 *
 * `nosniff` is not decoration. The bytes were verified against a magic-byte
 * table on the way in and the `Content-Type` is derived from that same check,
 * so the only remaining way to get script execution out of this endpoint would
 * be a browser deciding for itself that our `image/png` looks like HTML. This
 * header is what forbids that. `default-src 'none'` is the second lock: even if
 * a document were somehow rendered here, it could load nothing.
 */
function applyAvatarHeaders(reply: FastifyReply, etag: string | undefined): void {
  reply.header('cache-control', service.AVATAR_CACHE_CONTROL);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', "default-src 'none'; sandbox");
  // Cache-key on the header that actually changes the answer.
  reply.header('vary', 'authorization');
  if (etag) reply.header('etag', etag);
}

const storageRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const config = getConfig();

  /**
   * Scoped to this plugin, so the `multipart/form-data` content-type parser
   * exists on these four routes and nowhere else — every other endpoint in the
   * app still rejects a multipart body with 415 rather than quietly accepting
   * one.
   *
   * `fileSize` is the **media** ceiling, not the avatar one, because the media
   * routes registered below share this parser and a video is fifty times an
   * avatar. The avatar route narrows it back per call (`request.file({ limits
   * })`), which is what keeps a 2 MB endpoint from ever holding 100 MB in
   * memory: `@fastify/multipart` merges per-call options over these.
   *
   * Both limits are still needed. The one here stops the transport; the check
   * in each service is what a direct call to that service still gets, and the
   * per-kind limits (photo vs video vs audio) can only be applied once the
   * bytes have been sniffed.
   */
  await app.register(multipart, {
    limits: {
      fileSize: MEDIA_MAX_BYTES,
      files: 1,
      fields: 4,
      // A part name long enough to be interesting is an attack, not a filename.
      fieldNameSize: 200,
      headerPairs: 200,
    },
    // Fail the request when the limit is hit instead of silently handing the
    // handler a truncated file — a half-decoded JPEG is worse than an error.
    throwFileSizeLimit: true,
  });

  /**
   * Photo, video and audio for the wall — a sibling of the avatar routes rather
   * than a separate module, so that both live behind the one multipart
   * registration above and `modules/index.ts` (the lead's file) does not have
   * to change to enable them.
   */
  await app.register(mediaRoutes);

  /**
   * Create the bucket at boot rather than on the first upload, so a
   * misconfigured endpoint shows up in the startup log instead of in the face
   * of the first member who tries to set a photo.
   *
   * A failure here is logged and swallowed: RustFS may simply be slower to
   * accept connections than we are, and `put()` calls `ensureBucket()` again
   * anyway. The one thing this must not do is stop the app from booting.
   */
  app.addHook('onReady', async () => {
    const storage = getStorage();
    if (!storage) {
      app.log.info('object storage is not configured — avatar uploads will answer 503');
      return;
    }
    try {
      await storage.ensureBucket();
      app.log.info({ bucket: storage.bucket }, 'object storage ready');
    } catch (error) {
      app.log.warn({ err: error, bucket: storage.bucket }, 'could not ensure the storage bucket');
    }
  });

  /* ====================================================================== */
  /* self                                                                    */
  /* ====================================================================== */

  app.post(
    '/me/avatar',
    {
      config: { permission: 'profile:update:own' },
      schema: {
        tags: ['me'],
        summary: 'Upload your avatar',
        description:
          `Multipart, one file part named \`file\`. Accepts ${ALLOWED_IMAGE_TYPES.join(', ')} ` +
          'up to the configured limit, decided by **sniffing the magic bytes** — the ' +
          'declared `Content-Type` and the filename are never trusted and never stored. ' +
          'The object key is generated server-side. Replacing an avatar deletes the ' +
          'previous object. The client is expected to have already resized and ' +
          're-encoded the image to 512×512 WebP in a canvas.',
        consumes: ['multipart/form-data'],
        response: { 200: selfUserSchema },
      },
    },
    async (request) => {
      // The narrower cap, per call: an avatar has no business being read into
      // memory at the video ceiling this plugin's parser allows.
      const part = await request.file({ limits: { fileSize: config.storage.avatarMaxBytes } });
      if (!part) throw new AppError('BAD_REQUEST', 'Expected one multipart file part');

      const bytes = await part.toBuffer();

      return service.setAvatar(
        getDb(),
        requireUserId(request),
        { bytes, declaredType: part.mimetype },
        config.storage.avatarMaxBytes,
      );
    },
  );

  app.delete(
    '/me/avatar',
    {
      config: { permission: 'profile:update:own' },
      schema: {
        tags: ['me'],
        summary: 'Remove your avatar',
        description:
          'Idempotent — a member with no avatar gets their unchanged profile back. ' +
          'Clears `avatarUrl` and deletes the object when we stored it; an avatar ' +
          'that came from an OAuth provider is only unlinked.',
        response: { 200: selfUserSchema },
      },
    },
    async (request) => service.clearAvatar(getDb(), requireUserId(request)),
  );

  /* ====================================================================== */
  /* delivery                                                                */
  /* ====================================================================== */

  app.get(
    '/users/:id/avatar',
    {
      // `member:read` is held by every role including `guest`; `notFoundOnDeny`
      // keeps a denial from being the one GET in the app that answers 403.
      config: { permission: 'member:read', notFoundOnDeny: true },
      schema: {
        tags: ['members'],
        summary: "Stream a member's avatar",
        description:
          'Streams the object out of the private bucket. `?v` is a cache buster only — ' +
          'the object is resolved from the stored row, so editing it changes nothing. ' +
          'Answers 404 identically for "no such member", "no avatar", "avatar hosted ' +
          'elsewhere" and "object missing", so the endpoint cannot be used to enumerate ' +
          'user ids (D4).',
        params: avatarParamsSchema,
        querystring: avatarQuerySchema,
        // No response schema: the body is a binary stream, and a serializer
        // would try to JSON-encode it.
        produces: [...ALLOWED_IMAGE_TYPES],
      },
    },
    async (request, reply) => {
      const db = getDb();
      const userId = request.params.id;

      const ifNoneMatch = request.headers['if-none-match'];
      if (ifNoneMatch) {
        const meta = await service.statAvatar(db, userId);
        if (!meta) throw new AppError('NOT_FOUND', 'Avatar not found');
        if (meta.etag && matchesEtag(ifNoneMatch, meta.etag)) {
          applyAvatarHeaders(reply, meta.etag);
          return reply.code(304).send();
        }
      }

      const object = await service.openAvatar(db, userId);
      if (!object) throw new AppError('NOT_FOUND', 'Avatar not found');

      applyAvatarHeaders(reply, object.etag);
      // Straight from the object, which was set from the sniffed bytes.
      reply.type(object.contentType);
      if (object.contentLength !== undefined) {
        reply.header('content-length', object.contentLength);
      }
      return reply.send(object.body);
    },
  );
};

/**
 * RFC 9110 `If-None-Match`: a comma-separated list, or `*`. Weak validators
 * (`W/"…"`) compare equal to their strong form for this purpose, and we only
 * ever emit strong ones.
 */
function matchesEtag(header: string, etag: string): boolean {
  const normalize = (value: string) => value.trim().replace(/^W\//, '');
  const target = normalize(etag);
  return header
    .split(',')
    .some((candidate) => candidate.trim() === '*' || normalize(candidate) === target);
}

export default storageRoutes;
