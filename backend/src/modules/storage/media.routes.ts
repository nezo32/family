import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  ALLOWED_MEDIA_TYPES,
  MAX_ATTACHMENTS,
  MEDIA_LIMITS,
  idSchema,
  mediaAttachmentSchema,
  okSchema,
  type ApiErrorBody,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import { getDb } from '../../core/db.js';
import { AppError, notFound, unauthenticated } from '../../core/errors.js';
import {
  MEDIA_EXTENSIONS,
  formatDurationRu,
  formatMegabytes,
  isAllowedMediaType,
} from './media.js';
import { assertCanReadAttachment } from './media.access.js';
import * as service from './media.service.js';
import { RangeNotSatisfiableError } from './s3.adapter.js';

/**
 * Upload, delivery and draft removal for photo, video and audio.
 *
 * ## Why the bytes come back through us, again
 *
 * Same answer as avatars, and it is worth restating because video makes the
 * cheap alternative look tempting: the bucket sits on the `data` network with
 * no route to the internet and no published port, so there are no presigned
 * URLs, no public bucket policy and no second hostname to get TLS onto. A
 * family video is readable exactly as long as the session is — the same rule as
 * every other row in the database.
 *
 * ## Where video stops being a bigger photo
 *
 * Three things change, and all three live in the GET below:
 *
 * 1. **`Range` is not optional.** Safari does not play a `<video>` from an
 *    endpoint that ignores ranges — it opens with `Range: bytes=0-1` and, given
 *    a `200` with the whole file, gives up. So the range is passed to the store
 *    and the answer is a real `206` with `Content-Range`, which is also what
 *    makes dragging the scrubber cost one request for the part you dragged to
 *    instead of a re-download.
 * 2. **The 304 path and the range path are exclusive.** A conditional `HEAD`
 *    before a ranged read would be a wasted round trip on every seek, and a
 *    `304` answering a `Range` request is the wrong answer to the question that
 *    was asked. `If-None-Match` is honoured only for a full read.
 * 3. **Nothing is buffered.** The upload spools to a temp file and the download
 *    is the store's stream piped straight to the socket; a 100 MB video never
 *    exists in this process's memory in either direction.
 */

const mediaParams = z.object({ id: idSchema });

function callerOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

/**
 * Headers shared by 200, 206 and 304.
 *
 * `nosniff` and the `default-src 'none'; sandbox` CSP are not decoration and
 * they matter *more* here than on avatars: this endpoint serves eight content
 * types instead of three, from our own origin, behind the family's session. The
 * bytes were matched against a magic-byte table on the way in and the
 * `Content-Type` is derived from that same check, so the only remaining route
 * to script execution would be a browser deciding for itself that our
 * `video/mp4` looks like HTML. These two headers forbid exactly that.
 */
function applyMediaHeaders(reply: FastifyReply, etag: string | undefined): void {
  reply.header('cache-control', service.MEDIA_CACHE_CONTROL);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', "default-src 'none'; sandbox");
  reply.header('accept-ranges', 'bytes');
  // Cache-key on the header that actually changes the answer.
  reply.header('vary', 'authorization');
  if (etag) reply.header('etag', etag);
}

/**
 * RFC 9110 `If-None-Match`: a comma-separated list, or `*`. Weak validators
 * compare equal to their strong form here, and we only ever emit strong ones.
 */
function matchesEtag(header: string, etag: string): boolean {
  const normalize = (value: string) => value.trim().replace(/^W\//, '');
  const target = normalize(etag);
  return header
    .split(',')
    .some((candidate) => candidate.trim() === '*' || normalize(candidate) === target);
}

/**
 * The one status code the shared `ErrorCode` table has no member for.
 *
 * 416 belongs to the media element, not to the client's error catalogue — a
 * `<video>` reacts to the status and never reads the body — so it is written
 * out here in the standard shape rather than given a code that would then have
 * to mean something to the PWA. The `Content-Range` header on the way out —
 * `bytes` then `*`, a slash and the real size — is the part that actually tells
 * the player what it should have asked for.
 */
function rangeNotSatisfiable(reply: FastifyReply, requestId: string, size: number): FastifyReply {
  const body: ApiErrorBody = {
    error: {
      code: 'BAD_REQUEST',
      message: 'Requested range is not satisfiable',
      requestId,
    },
  };
  reply.header('content-range', `bytes */${String(size)}`);
  return reply.code(416).send(body);
}

const mediaRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /* ====================================================================== */
  /* upload                                                                  */
  /* ====================================================================== */

  app.post(
    '/media',
    {
      /**
       * `comment:create` — the broadest "may add something to the family's
       * shared space" permission, held by everyone from `child` up and by no
       * `guest`. Deliberately not `post:create`: a photo on a reply is the same
       * act as a photo on a note, and gating the upload on the narrower of the
       * two would leave the wider one unable to use it.
       */
      config: { permission: 'comment:create' },
      schema: {
        tags: ['media'],
        summary: 'Upload one photo, video or audio file',
        description:
          `Multipart, one file part named \`file\`. Accepts ${ALLOWED_MEDIA_TYPES.join(', ')} ` +
          'decided by **sniffing the magic bytes** — the declared `Content-Type` and the ' +
          'filename are never trusted and never stored. Limits: photo ' +
          `${formatMegabytes(MEDIA_LIMITS.image.maxBytes)}, video ` +
          `${formatMegabytes(MEDIA_LIMITS.video.maxBytes)} / ` +
          `${formatDurationRu(MEDIA_LIMITS.video.maxDurationMs)}, audio ` +
          `${formatMegabytes(MEDIA_LIMITS.audio.maxBytes)} / ` +
          `${formatDurationRu(MEDIA_LIMITS.audio.maxDurationMs)}. ` +
          'The response carries an **id**; a post or a comment references that id in ' +
          '`attachmentIds`. Until it does, the upload is a private draft, visible to ' +
          `nobody else and swept after ${String(service.DRAFT_TTL_HOURS)} hours. At most ` +
          `${String(MAX_ATTACHMENTS)} per post or comment.`,
        consumes: ['multipart/form-data'],
        response: { 201: mediaAttachmentSchema },
      },
    },
    async (request, reply) => {
      const part = await request.file();
      if (!part) throw new AppError('BAD_REQUEST', 'Expected one multipart file part');

      const uploaded = await service.uploadMedia(getDb(), callerOf(request), {
        file: part.file,
        declaredType: part.mimetype,
        truncated: () => part.file.truncated,
      });
      return reply.code(201).send(uploaded);
    },
  );

  /* ====================================================================== */
  /* draft removal                                                           */
  /* ====================================================================== */

  app.delete(
    '/media/:id',
    {
      config: { permission: 'comment:create' },
      schema: {
        tags: ['media'],
        summary: 'Discard an upload that was never posted',
        description:
          'Only your own, and only while it is still a draft. Media already on a post or ' +
          'comment is removed by editing that post or comment’s `attachmentIds`, so the ' +
          'change and the note it belongs to commit together — this endpoint answers 409 ' +
          'for an attached id and 404 for somebody else’s.',
        params: mediaParams,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await service.deleteDraft(getDb(), callerOf(request), request.params.id);
      return { ok: true as const };
    },
  );

  /* ====================================================================== */
  /* delivery                                                                */
  /* ====================================================================== */

  app.get(
    '/media/:id',
    {
      // `member:read` is held by every role including `guest`; the real narrowing
      // is the attachment's own target, resolved in `media.access.ts`, which
      // answers 404 for everything it refuses. `notFoundOnDeny` keeps the guard
      // itself from being the one GET in the app that answers 403.
      config: { permission: 'member:read', notFoundOnDeny: true },
      schema: {
        tags: ['media'],
        summary: 'Stream a photo, video or audio file',
        description:
          'Streams the object out of the private bucket. Supports `Range` (a `206` with ' +
          '`Content-Range`, which is what makes video seekable and what Safari requires ' +
          'before it will play at all) and `If-None-Match` (a `304` that pulls no body). ' +
          'A photo is exactly as private as the post or comment it hangs on; an ' +
          'unattached draft is visible only to whoever uploaded it. Every refusal is a ' +
          '404, so the endpoint cannot be used to find out what exists (D4).',
        params: mediaParams,
        produces: [...ALLOWED_MEDIA_TYPES],
      },
    },
    async (request, reply) => {
      const db = getDb();
      const auth = callerOf(request);

      const row = await service.findAttachment(db, request.params.id);
      if (!row) throw notFound('Attachment');
      await assertCanReadAttachment(db, row, auth);

      const range = request.headers.range;
      const ifNoneMatch = request.headers['if-none-match'];

      // Conditional only for a full read — see the header note.
      if (!range && ifNoneMatch) {
        const meta = await service.statMedia(row);
        if (!meta) throw notFound('Attachment');
        if (meta.etag && matchesEtag(ifNoneMatch, meta.etag)) {
          applyMediaHeaders(reply, meta.etag);
          return reply.code(304).send();
        }
      }

      let object;
      try {
        object = await service.openMedia(row, { range });
      } catch (error) {
        if (error instanceof RangeNotSatisfiableError) {
          return rangeNotSatisfiable(reply, request.id, row.byteSize);
        }
        throw error;
      }
      if (!object) throw notFound('Attachment');

      applyMediaHeaders(reply, object.etag);
      // Straight from the object, which was set from the sniffed bytes.
      reply.type(object.contentType);
      // A generated filename, never the uploader's: `inline` keeps it in the
      // page, and the name is what a "save image" lands as.
      const extension = isAllowedMediaType(row.contentType)
        ? MEDIA_EXTENSIONS[row.contentType]
        : 'bin';
      reply.header('content-disposition', `inline; filename="${row.id}.${extension}"`);
      if (object.contentLength !== undefined) {
        reply.header('content-length', object.contentLength);
      }
      if (object.contentRange) {
        reply.header('content-range', object.contentRange);
        return reply.code(206).send(object.body);
      }
      return reply.send(object.body);
    },
  );
};

export default mediaRoutes;
