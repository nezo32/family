import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  ALLOWED_MEDIA_TYPES,
  MAX_ATTACHMENTS,
  MEDIA_LIMITS,
  MEDIA_TICKET_TTL_SECONDS,
  idSchema,
  mediaAttachmentSchema,
  mediaTicketResponseSchema,
  okSchema,
  type ApiErrorBody,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import { getDb } from '../../core/db.js';
import { AppError, notFound, unauthenticated } from '../../core/errors.js';
import type { MediaAttachmentRow } from '../wall/wall.schema.js';
import {
  MEDIA_EXTENSIONS,
  formatDurationRu,
  formatMegabytes,
  isAllowedMediaType,
} from './media.js';
import { assertCanReadAttachment, ticketActor } from './media.access.js';
import * as service from './media.service.js';
import { mintMediaTicket, parseMediaTicket } from './media.ticket.js';
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

/** The playback ticket, as it rides in the URL. Stripped from every log line. */
const mediaTicketQuerySchema = z.object({ t: z.string().min(1).max(512) });

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

  /**
   * The bytes, once the caller has been established and cleared.
   *
   * One function, two doors: `GET /media/:id` (bearer) and
   * `GET /media/:id/stream` (playback ticket) both land here, so the security
   * headers, the conditional path, the range path and the generated filename
   * cannot drift between them. The alternative — a second copy for the ticket
   * route — is how one of the two ends up serving without `nosniff`.
   */
  async function sendAttachment(
    request: FastifyRequest,
    reply: FastifyReply,
    row: MediaAttachmentRow,
  ): Promise<FastifyReply> {
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
  }

  app.get(
    '/media/:id',
    {
      /**
       * **`media:read`, and this is the narrowing that matters** (D15 §4).
       *
       * It used to be `member:read`, which every role holds including `guest` —
       * so the only thing standing between a guest and every photograph on
       * Стена was the post's own readability, and a guest reads the wall. That
       * was scoped when the wall was text. `media:read` is granted from `child`
       * up and withheld from `guest`, and it is checked *here*, before the row
       * is even looked up, so a guest cannot use an id to find out what exists.
       *
       * `member:read` is not also listed: every role that holds `media:read`
       * holds it, so requiring both would be a second name for the same answer.
       * What the guard does **not** replace is `assertCanReadAttachment` below —
       * holding `media:read` says you may see family photographs, not that you
       * may see *this* one. A photo is exactly as private as the note it hangs
       * on, and that is still resolved per row.
       *
       * `notFoundOnDeny` keeps the refusal a 404. A 403 would confirm the
       * object exists to the one caller forbidden from knowing (D4).
       */
      config: { permission: 'media:read', notFoundOnDeny: true },
      schema: {
        tags: ['media'],
        summary: 'Stream a photo, video or audio file',
        description:
          'Streams the object out of the private bucket. Supports `Range` (a `206` with ' +
          '`Content-Range`, which is what makes video seekable and what Safari requires ' +
          'before it will play at all) and `If-None-Match` (a `304` that pulls no body). ' +
          'Requires `media:read`, which `guest` does not hold. A photo is exactly as ' +
          'private as the post or comment it hangs on; an unattached draft is visible ' +
          'only to whoever uploaded it. Every refusal is a 404, so the endpoint cannot ' +
          'be used to find out what exists (D4). A `<video>` cannot send a bearer ' +
          'token — use `POST /api/media/:id/ticket` and the `stream` route below.',
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

      return sendAttachment(request, reply, row);
    },
  );

  /* ====================================================================== */
  /* playback tickets                                                        */
  /* ====================================================================== */

  app.post(
    '/media/:id/ticket',
    {
      // Same guard as the read it is a credential for. A ticket may never open
      // a door its holder could not already open with their bearer.
      config: { permission: 'media:read', notFoundOnDeny: true },
      schema: {
        tags: ['media'],
        summary: 'Mint a short-lived playback URL for a video or an audio file',
        description:
          'A `<video>` or `<audio>` element sends no `Authorization` header, so the PWA ' +
          'otherwise has to download the whole file and hand the element an object URL — ' +
          'losing seeking and partial playback on exactly the files that need them. This ' +
          'returns a URL carrying a signed capability for **this** object and **this** ' +
          'member, good for ' +
          `${String(Math.round(MEDIA_TICKET_TTL_SECONDS / 60))} minutes, which goes ` +
          'straight into `src`. The stream route re-checks the member’s status, their ' +
          '`media:read` and the attachment’s own target on every request, so the ticket ' +
          'is a credential and never a frozen permission. Re-mint on a 404.',
        params: mediaParams,
        response: { 200: mediaTicketResponseSchema },
      },
    },
    async (request) => {
      const db = getDb();
      const auth = callerOf(request);

      const row = await service.findAttachment(db, request.params.id);
      if (!row) throw notFound('Attachment');
      await assertCanReadAttachment(db, row, auth);

      const ticket = mintMediaTicket(row.id, auth.userId);
      // Both ids came out of the database as uuids, so this is unreachable —
      // but minting is the one place a malformed id would become a URL.
      if (!ticket) throw notFound('Attachment');
      return { url: ticket.url, expiresAt: ticket.expiresAt.toISOString() };
    },
  );

  app.get(
    '/media/:id/stream',
    {
      /**
       * `public: true` for the same reason `GET /events/feed.ics` is, and with
       * the same discipline: **the ticket is the guard**, and it is verified
       * before a single row is read. D4 permits this only on that condition.
       *
       * What the ticket buys is a *credential*, not an authorisation: the whole
       * chain is re-run below — the signature and expiry, then the member's row
       * (`ticketActor`, which refuses anybody not `active`), then their
       * `media:read`, then the attachment's own target. Every one of those can
       * have changed since the ticket was minted, and the next range request is
       * where it takes effect.
       *
       * Every refusal is a 404 with no detail, so a stale or forged URL cannot
       * be used to tell "wrong signature" from "expired" from "no such object".
       */
      config: { public: true },
      schema: {
        tags: ['media'],
        summary: 'Stream a file using a playback ticket instead of a bearer token',
        description:
          'Identical bytes, identical headers and identical `Range` support to ' +
          '`GET /api/media/:id` — the only difference is where the credential comes ' +
          'from. Mint the URL with `POST /api/media/:id/ticket` and put it in a ' +
          '`<video src>`; the browser’s own media stack then issues the range requests, ' +
          'with no service worker and no object URL in the way. A ticket that is ' +
          'expired, forged, or minted by a member who has since lost access answers ' +
          '**404**, exactly like an id that does not exist.',
        params: mediaParams,
        querystring: mediaTicketQuerySchema,
        produces: [...ALLOWED_MEDIA_TYPES],
      },
    },
    async (request, reply) => {
      const db = getDb();

      const ticket = parseMediaTicket(request.query.t);
      // Not 401: this URL is what a `<video>` holds, and a 401 on a range
      // request would confirm the object to whoever is holding a stale link.
      if (!ticket || ticket.mediaId !== request.params.id) throw notFound('Attachment');

      const auth = await ticketActor(db, ticket.userId);
      if (!auth?.can('media:read')) throw notFound('Attachment');

      const row = await service.findAttachment(db, request.params.id);
      if (!row) throw notFound('Attachment');
      await assertCanReadAttachment(db, row, auth);

      return sendAttachment(request, reply, row);
    },
  );
};

export default mediaRoutes;
