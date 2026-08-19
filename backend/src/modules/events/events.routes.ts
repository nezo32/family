import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  eventAttendeesUpdateSchema,
  eventCalendarQuerySchema,
  eventOccurrenceListQuerySchema,
  eventOccurrenceListResponseSchema,
  eventOccurrenceResponseSchema,
  eventOccurrenceUpdateSchema,
  eventRsvpSchema,
  eventSeriesCreateSchema,
  eventSeriesDeleteSchema,
  eventSeriesListQuerySchema,
  eventSeriesListResponseSchema,
  eventSeriesResponseSchema,
  eventSeriesUpdateSchema,
  eventTodayResponseSchema,
  idSchema,
  okSchema,
  timeZoneSchema,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import { getDb } from '../../core/db.js';
import { notFound, unauthenticated } from '../../core/errors.js';
import * as service from './events.service.js';
import { feedUrlFor, webcalUrlFor } from './ics.service.js';

/**
 * Calendar HTTP surface — the route table from
 * `docs/architecture/scheduling.md` §8, mounted under `/api`.
 *
 * The layer is thin (D8): parse, delegate, map. Every rule worth arguing about
 * — the four mutation scopes, the all-day date range, wall-clock ends,
 * visibility — lives in `events.service.ts`.
 *
 * ## Access control
 *
 * Every route declares its access in the `config` block and `core/plugins/auth`
 * asserts at boot that none declares nothing (D4 deny-by-default). Reads use
 * the flat `event:read`; writes use `scoped: 'event:update'` / `'event:delete'`
 * so the handler receives `req.scope` and the service narrows `own` vs `any`.
 *
 * **404, not 403, outside read scope.** A `private` or `restricted` event the
 * caller is not part of is filtered *in SQL* and comes back as 404 — the caller
 * cannot tell "hidden" from "does not exist". 403 is reserved for "you can see
 * it but you may not do that to it", which is the only case where the
 * distinction helps the user.
 *
 * The same rule at the guard: every route gated on `event:read` carries
 * `notFoundOnDeny: true`, because `event:read` *is* the permission that makes
 * the calendar visible — a member it has been revoked from must see an absent
 * section, not a forbidden one (D4). That includes the two non-GET routes gated
 * on it (`rsvp`, `feed/token/rotate`): a caller who cannot read the event must
 * not learn it exists by trying to RSVP to it. The `scoped: 'event:update'` /
 * `'event:delete'` writes keep 403 — that caller holds `event:read` and is
 * looking straight at the event.
 *
 * ## The one public route
 *
 * `GET /events/feed.ics` is `config: { public: true }` because a calendar
 * client cannot send a bearer token — see the design note in `ics.service.ts`.
 * The URL token *is* the guard, and it is checked before anything is read.
 */

/* -------------------------------------------------------------------------- */
/* Declared access, as data                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What each route declares. Exported so `events.test.ts` can assert that the
 * registered guards still match this table — the check that catches a guard
 * quietly loosened during a refactor.
 */
export const EVENT_ROUTE_ACCESS = {
  'GET /events/series': { permission: 'event:read', notFoundOnDeny: true },
  'POST /events/series': { permission: 'event:create' },
  'GET /events/series/:id': { permission: 'event:read', notFoundOnDeny: true },
  'PATCH /events/series/:id': { scoped: 'event:update' },
  'DELETE /events/series/:id': { scoped: 'event:delete' },
  'PUT /events/series/:id/attendees': { scoped: 'event:update' },
  'GET /events/occurrences': { permission: 'event:read', notFoundOnDeny: true },
  'GET /events/occurrences/:id': { permission: 'event:read', notFoundOnDeny: true },
  'PATCH /events/occurrences/:id': { scoped: 'event:update' },
  'POST /events/occurrences/:id/cancel': { scoped: 'event:delete' },
  'PUT /events/occurrences/:id/rsvp': { permission: 'event:read', notFoundOnDeny: true },
  'GET /events/calendar': { permission: 'event:read', notFoundOnDeny: true },
  'GET /events/today': { permission: 'event:read', notFoundOnDeny: true },
  'GET /events/feed/token': { permission: 'event:read', notFoundOnDeny: true },
  'POST /events/feed/token/rotate': { permission: 'event:read', notFoundOnDeny: true },
  'GET /events/feed.ics': { public: true },
} as const;

/* -------------------------------------------------------------------------- */
/* Local schemas                                                               */
/* -------------------------------------------------------------------------- */

const seriesParamsSchema = z.object({ id: idSchema });
const occurrenceParamsSchema = z.object({ id: idSchema });

/** A series plus its resolved invite list — the shape the detail screen wants. */
const seriesDetailResponseSchema = eventSeriesResponseSchema.extend({
  attendeeIds: z.array(idSchema),
});

const calendarResponseSchema = z.object({
  timezone: timeZoneSchema,
  items: z.array(eventOccurrenceResponseSchema),
});

const deleteSeriesResponseSchema = okSchema.extend({
  archived: z.boolean(),
  deleted: z.boolean(),
});

const attendeesResponseSchema = z.object({ attendeeIds: z.array(idSchema) });

/**
 * The subscription links. Two forms of the same URL: `https` for Google
 * Calendar and desktop clients, `webcal` because tapping it on iOS opens
 * Calendar's subscribe sheet instead of downloading a file into Safari.
 */
const feedTokenResponseSchema = z.object({
  token: z.string(),
  url: z.string(),
  webcalUrl: z.string(),
});

const feedQuerySchema = z.object({ token: z.string().min(1).max(512) });

const todayQuerySchema = z.object({ timezone: timeZoneSchema.optional() });

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Only `/events/feed.ics` is public, so a null `auth` anywhere else means the
 * auth plugin was bypassed. Fail loudly rather than inventing an anonymous
 * actor whose `userId` would then be `undefined` inside a visibility predicate.
 */
function actorOf(auth: AuthContext | null): AuthContext {
  if (!auth) throw unauthenticated();
  return auth;
}

function toDetail(detail: service.SeriesDetail) {
  return { ...service.toSeriesResponse(detail.series), attendeeIds: detail.attendeeIds };
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                      */
/* -------------------------------------------------------------------------- */

const eventsRoutes: FastifyPluginAsync = async (instance: FastifyInstance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /* ------------------------------- series -------------------------------- */

  app.get(
    '/events/series',
    {
      config: EVENT_ROUTE_ACCESS['GET /events/series'],
      schema: {
        tags: ['events'],
        summary: 'Список серий событий',
        querystring: eventSeriesListQuerySchema,
        response: { 200: eventSeriesListResponseSchema },
      },
    },
    async (request) => {
      const page = await service.listSeries(getDb(), actorOf(request.auth), request.query);
      return { items: page.items.map(service.toSeriesResponse), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/events/series',
    {
      config: EVENT_ROUTE_ACCESS['POST /events/series'],
      schema: {
        tags: ['events'],
        summary: 'Создать событие (одиночное или повторяющееся)',
        body: eventSeriesCreateSchema,
        response: { 201: seriesDetailResponseSchema },
      },
    },
    async (request, reply) => {
      const detail = await service.createSeries(getDb(), actorOf(request.auth), request.body);
      return reply.code(201).send(toDetail(detail));
    },
  );

  // Registered before `/events/series/:id`? Not needed — find-my-way always
  // prefers a static segment over a parametric one regardless of order.
  app.get(
    '/events/series/:id',
    {
      config: EVENT_ROUTE_ACCESS['GET /events/series/:id'],
      schema: {
        tags: ['events'],
        params: seriesParamsSchema,
        response: { 200: seriesDetailResponseSchema },
      },
    },
    async (request) =>
      toDetail(await service.getSeries(getDb(), actorOf(request.auth), request.params.id)),
  );

  app.patch(
    '/events/series/:id',
    {
      config: EVENT_ROUTE_ACCESS['PATCH /events/series/:id'],
      schema: {
        tags: ['events'],
        summary: 'Изменить событие (требуется scope: this | this_and_future | all)',
        params: seriesParamsSchema,
        body: eventSeriesUpdateSchema,
        response: { 200: seriesDetailResponseSchema },
      },
    },
    async (request) =>
      toDetail(
        await service.updateSeries(getDb(), actorOf(request.auth), request.params.id, request.body),
      ),
  );

  app.delete(
    '/events/series/:id',
    {
      config: EVENT_ROUTE_ACCESS['DELETE /events/series/:id'],
      schema: {
        tags: ['events'],
        summary: 'Удалить событие (требуется scope)',
        params: seriesParamsSchema,
        body: eventSeriesDeleteSchema,
        response: { 200: deleteSeriesResponseSchema },
      },
    },
    async (request) => {
      const result = await service.deleteSeries(
        getDb(),
        actorOf(request.auth),
        request.params.id,
        request.body,
      );
      return { ok: true as const, ...result };
    },
  );

  app.put(
    '/events/series/:id/attendees',
    {
      config: EVENT_ROUTE_ACCESS['PUT /events/series/:id/attendees'],
      schema: {
        tags: ['events'],
        summary: 'Изменить список участников',
        params: seriesParamsSchema,
        body: eventAttendeesUpdateSchema,
        response: { 200: attendeesResponseSchema },
      },
    },
    async (request) => ({
      attendeeIds: await service.setAttendees(
        getDb(),
        actorOf(request.auth),
        request.params.id,
        request.body,
      ),
    }),
  );

  /* ----------------------------- occurrences ------------------------------ */

  app.get(
    '/events/occurrences',
    {
      config: EVENT_ROUTE_ACCESS['GET /events/occurrences'],
      schema: {
        tags: ['events'],
        querystring: eventOccurrenceListQuerySchema,
        response: { 200: eventOccurrenceListResponseSchema },
      },
    },
    async (request) => service.listOccurrences(getDb(), actorOf(request.auth), request.query),
  );

  app.get(
    '/events/occurrences/:id',
    {
      config: EVENT_ROUTE_ACCESS['GET /events/occurrences/:id'],
      schema: {
        tags: ['events'],
        params: occurrenceParamsSchema,
        response: { 200: eventOccurrenceResponseSchema },
      },
    },
    async (request) => service.getOccurrence(getDb(), actorOf(request.auth), request.params.id),
  );

  app.patch(
    '/events/occurrences/:id',
    {
      config: EVENT_ROUTE_ACCESS['PATCH /events/occurrences/:id'],
      schema: {
        tags: ['events'],
        summary: 'Перенести / изменить один экземпляр (occurrenceKey не меняется)',
        params: occurrenceParamsSchema,
        body: eventOccurrenceUpdateSchema,
        response: { 200: eventOccurrenceResponseSchema },
      },
    },
    async (request) =>
      service.updateOccurrence(getDb(), actorOf(request.auth), request.params.id, request.body),
  );

  app.post(
    '/events/occurrences/:id/cancel',
    {
      config: EVENT_ROUTE_ACCESS['POST /events/occurrences/:id/cancel'],
      schema: {
        tags: ['events'],
        params: occurrenceParamsSchema,
        response: { 200: eventOccurrenceResponseSchema },
      },
    },
    async (request) => service.cancelOccurrence(getDb(), actorOf(request.auth), request.params.id),
  );

  app.put(
    '/events/occurrences/:id/rsvp',
    {
      config: EVENT_ROUTE_ACCESS['PUT /events/occurrences/:id/rsvp'],
      schema: {
        tags: ['events'],
        summary: 'Ответить на приглашение (за другого — нужен event:update:any)',
        params: occurrenceParamsSchema,
        body: eventRsvpSchema,
        response: { 200: eventOccurrenceResponseSchema },
      },
    },
    async (request) =>
      service.setRsvp(getDb(), actorOf(request.auth), request.params.id, request.body),
  );

  /* ------------------------------ calendar -------------------------------- */

  app.get(
    '/events/calendar',
    {
      config: EVENT_ROUTE_ACCESS['GET /events/calendar'],
      schema: {
        tags: ['events'],
        summary: 'Сетка календаря за диапазон локальных дат',
        querystring: eventCalendarQuerySchema,
        response: { 200: calendarResponseSchema },
      },
    },
    async (request) => service.getCalendar(getDb(), actorOf(request.auth), request.query),
  );

  app.get(
    '/events/today',
    {
      config: EVENT_ROUTE_ACCESS['GET /events/today'],
      schema: {
        tags: ['events'],
        summary: 'Лента «сегодня / завтра» для главного экрана',
        querystring: todayQuerySchema,
        response: { 200: eventTodayResponseSchema },
      },
    },
    async (request) => service.getToday(getDb(), actorOf(request.auth), request.query.timezone),
  );

  /* ---------------------------- the ICS feed ------------------------------ */

  app.get(
    '/events/feed/token',
    {
      config: EVENT_ROUTE_ACCESS['GET /events/feed/token'],
      schema: {
        tags: ['events'],
        summary: 'Ссылка на подписку в календаре телефона',
        response: { 200: feedTokenResponseSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request.auth);
      const token = await service.getFeedToken(getDb(), actor.userId);
      return { token, url: feedUrlFor(token), webcalUrl: webcalUrlFor(token) };
    },
  );

  app.post(
    '/events/feed/token/rotate',
    {
      config: EVENT_ROUTE_ACCESS['POST /events/feed/token/rotate'],
      schema: {
        tags: ['events'],
        summary: 'Отозвать старую ссылку и выдать новую',
        response: { 200: feedTokenResponseSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request.auth);
      const token = await service.rotateFeedToken(getDb(), actor, actor.userId);
      return { token, url: feedUrlFor(token), webcalUrl: webcalUrlFor(token) };
    },
  );

  /**
   * The subscribed calendar.
   *
   * `public: true` and authenticated from the URL token alone: iOS Calendar
   * fetches this from a background daemon with no session and no way to run our
   * refresh flow, so a bearer token is not an option (D4 permits a public route
   * precisely when it carries its own guard, as this one does).
   *
   * No zod `response` schema: the body is `text/calendar`, not JSON, and running
   * it through the JSON serializer would quote and escape the whole document.
   */
  app.get(
    '/events/feed.ics',
    {
      config: EVENT_ROUTE_ACCESS['GET /events/feed.ics'],
      schema: {
        tags: ['events'],
        summary: 'ICS-подписка (только чтение, авторизация по токену в ссылке)',
        querystring: feedQuerySchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const userId = await service.authenticateFeedToken(db, request.query.token);
      // 404, not 401: a revoked or forged link must not confirm that a feed
      // exists at this URL, and no calendar client shows the difference anyway.
      if (userId === null) throw notFound('Календарь');

      const feed = await service.buildFeedForUser(db, userId);

      reply.header('ETag', feed.etag);
      // Private: this document is one person's view of the family calendar.
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
      reply.header('Content-Disposition', 'inline; filename="family.ics"');

      const ifNoneMatch = request.headers['if-none-match'];
      if (
        typeof ifNoneMatch === 'string' &&
        ifNoneMatch.split(',').some((t) => t.trim() === feed.etag)
      ) {
        return reply.code(304).send();
      }

      return reply.type('text/calendar; charset=utf-8').send(feed.body);
    },
  );
};

export default eventsRoutes;
