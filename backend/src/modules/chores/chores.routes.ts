import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  blackoutCreateSchema,
  blackoutListQuerySchema,
  blackoutListResponseSchema,
  blackoutResponseSchema,
  fairnessQuerySchema,
  fairnessSummaryResponseSchema,
  idSchema,
  kudosCreateSchema,
  kudosListQuerySchema,
  kudosListResponseSchema,
  kudosResponseSchema,
  okSchema,
  pointsAwardSchema,
  pointsBalanceSchema,
  pointsEntryResponseSchema,
  pointsLedgerQuerySchema,
  pointsLedgerResponseSchema,
  rotationCreateSchema,
  rotationListQuerySchema,
  rotationListResponseSchema,
  rotationPreviewQuerySchema,
  rotationPreviewResponseSchema,
  rotationResponseSchema,
  rotationUpdateSchema,
  swapCreateSchema,
  swapListQuerySchema,
  swapListResponseSchema,
  swapRespondSchema,
  swapResponseSchema,
} from '@family/shared';

import { getDb } from '../../core/db.js';
import { unauthenticated } from '../../core/errors.js';
import { ChoresService, type ChoreActor } from './chores.service.js';

/**
 * Chore routes — the table in `docs/architecture/scheduling.md` §8.
 *
 * Thin by design (D8): parse, call the service, serialise. Every route declares
 * its access in `config`, which the auth plugin asserts at boot; there is no
 * `public: true` route in this domain.
 *
 * ## The permission split
 *
 * Rotations are family policy, so creating and editing them is `task:assign:any`
 * — an adult-and-above permission. Reading them is `task:read:any`, which teens
 * hold: a rotation you cannot see is a rotation you cannot argue with, and the
 * preview endpoint exists precisely so fairness is auditable by the people it
 * applies to.
 *
 * Swaps are the interesting case, and they are guarded by the catalog strings
 * written for them: `chore:swap:request` and `chore:swap:accept`. Both are held
 * from `child` upwards, which is the point — asking your sister to take the
 * bins, and volunteering to take hers, is exactly the negotiation this app
 * exists to support.
 *
 * These guards used to be `task:update:own` / `task:assign:any`, which a child
 * does not hold, so the role matrix granted a child two permissions the router
 * then refused to honour. `POST /chores/swaps/:id/respond` admits either swap
 * permission because declining is not a handoff; `swaps.service.ts` requires
 * `chore:swap:accept` on the accept branch specifically, so the taking-over
 * decision stays in the service where the rest of the swap rules live.
 *
 * `GET /chores/fairness` is `task:read:any` and returns the neutral load bar.
 * It has no rank field and must never grow one (D5).
 *
 * ## 404, not 403
 *
 * Every read here carries `notFoundOnDeny: true`. A caller without
 * `task:read:*` — a guest — must not learn the family runs rotations at all,
 * and one without `task:read:any` must not learn there is a family-wide
 * fairness board (D4). Writes keep 403: they are all reachable by somebody who
 * can already see what they are asking to change.
 */

const idParamsSchema = z.object({ id: idSchema });

const balanceQuerySchema = z.object({
  /** Defaults to the caller. Another member needs `task:read:any`. */
  userId: idSchema.optional(),
  windowDays: z.coerce.number().int().min(1).max(365).default(28),
});

/** The auth plugin guarantees `req.auth` on every guarded route; this narrows it. */
function actorOf(request: FastifyRequest): ChoreActor {
  const auth = request.auth;
  if (!auth) throw unauthenticated();
  return {
    id: auth.userId,
    displayName: auth.displayName,
    can: (permission) => auth.can(permission),
  };
}

const choresRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new ChoresService(getDb());

  /* ----------------------------- rotations ----------------------------- */

  app.get(
    '/chores/rotations',
    {
      config: { permission: 'task:read:any', notFoundOnDeny: true },
      schema: {
        tags: ['chores'],
        summary: 'Список дежурств',
        querystring: rotationListQuerySchema,
        response: { 200: rotationListResponseSchema },
      },
    },
    async (request) => service.listRotations(request.query),
  );

  app.post(
    '/chores/rotations',
    {
      config: { permission: 'task:assign:any' },
      schema: {
        tags: ['chores'],
        summary: 'Создать дежурство',
        body: rotationCreateSchema,
        response: { 201: rotationResponseSchema },
      },
    },
    async (request, reply) => reply.code(201).send(await service.createRotation(request.body)),
  );

  app.get(
    '/chores/rotations/:id',
    {
      config: { permission: 'task:read:any', notFoundOnDeny: true },
      schema: {
        tags: ['chores'],
        summary: 'Дежурство',
        params: idParamsSchema,
        response: { 200: rotationResponseSchema },
      },
    },
    async (request) => service.getRotation(request.params.id),
  );

  app.patch(
    '/chores/rotations/:id',
    {
      config: { permission: 'task:assign:any' },
      schema: {
        tags: ['chores'],
        summary: 'Изменить дежурство (reassignFuture по умолчанию выключен)',
        params: idParamsSchema,
        body: rotationUpdateSchema,
        response: { 200: rotationResponseSchema },
      },
    },
    async (request) => service.updateRotation(request.params.id, request.body),
  );

  app.delete(
    '/chores/rotations/:id',
    {
      config: { permission: 'task:assign:any' },
      schema: {
        tags: ['chores'],
        summary: 'Удалить дежурство (409, пока на него ссылаются задачи)',
        params: idParamsSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await service.deleteRotation(request.params.id);
      return { ok: true as const };
    },
  );

  app.get(
    '/chores/rotations/:id/preview',
    {
      config: { permission: 'task:read:any', notFoundOnDeny: true },
      schema: {
        tags: ['chores'],
        summary: 'Сухой прогон: кого выберет дежурство и почему',
        params: idParamsSchema,
        querystring: rotationPreviewQuerySchema,
        response: { 200: rotationPreviewResponseSchema },
      },
    },
    async (request) => service.previewRotation(request.params.id, request.query),
  );

  /* ----------------------------- blackouts ----------------------------- */

  app.get(
    '/chores/blackouts',
    {
      config: { scoped: 'task:read', notFoundOnDeny: true },
      schema: {
        tags: ['chores'],
        summary: 'Периоды недоступности',
        querystring: blackoutListQuerySchema,
        response: { 200: blackoutListResponseSchema },
      },
    },
    async (request) => service.listBlackouts(actorOf(request), request.query),
  );

  app.post(
    '/chores/blackouts',
    {
      // `task:update:own` covers your own window; the service additionally
      // requires `task:assign:any` to create one for somebody else.
      config: { anyPermission: ['task:update:own', 'task:assign:any'] },
      schema: {
        tags: ['chores'],
        summary: 'Отметить период недоступности',
        body: blackoutCreateSchema,
        response: { 201: blackoutResponseSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.createBlackout(actorOf(request), request.body)),
  );

  app.delete(
    '/chores/blackouts/:id',
    {
      config: { scoped: 'task:update' },
      schema: {
        tags: ['chores'],
        summary: 'Убрать период недоступности',
        params: idParamsSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await service.deleteBlackout(actorOf(request), request.params.id);
      return { ok: true as const };
    },
  );

  /* -------------------------------- swaps ------------------------------ */

  app.get(
    '/chores/swaps',
    {
      config: { scoped: 'task:read', notFoundOnDeny: true },
      schema: {
        tags: ['chores'],
        summary: 'Предложения обмена',
        querystring: swapListQuerySchema,
        response: { 200: swapListResponseSchema },
      },
    },
    async (request) => service.swaps.list(actorOf(request), request.query),
  );

  app.post(
    '/chores/swaps',
    {
      config: { permission: 'chore:swap:request' },
      schema: {
        tags: ['chores'],
        summary: 'Предложить обмен (одно активное предложение на задачу — иначе 409)',
        body: swapCreateSchema,
        response: { 201: swapResponseSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.swaps.request(actorOf(request), request.body)),
  );

  app.post(
    '/chores/swaps/:id/respond',
    {
      // Anyone with `task:update:own` may decline; the service requires
      // `task:assign:any` to accept, because a handoff needs an adult.
      config: { anyPermission: ['chore:swap:accept', 'chore:swap:request'] },
      schema: {
        tags: ['chores'],
        summary: 'Принять или отклонить обмен (принимает взрослый)',
        params: idParamsSchema,
        body: swapRespondSchema,
        response: { 200: swapResponseSchema },
      },
    },
    async (request) => service.swaps.respond(actorOf(request), request.params.id, request.body),
  );

  app.post(
    '/chores/swaps/:id/cancel',
    {
      config: { permission: 'chore:swap:request' },
      schema: {
        tags: ['chores'],
        summary: 'Отменить своё предложение',
        params: idParamsSchema,
        response: { 200: swapResponseSchema },
      },
    },
    async (request) => service.swaps.cancel(actorOf(request), request.params.id),
  );

  /* ------------------------------- points ------------------------------ */

  app.get(
    '/chores/points',
    {
      config: { scoped: 'task:read', notFoundOnDeny: true },
      schema: {
        tags: ['chores'],
        summary: 'История очков (журнал только на добавление)',
        querystring: pointsLedgerQuerySchema,
        response: { 200: pointsLedgerResponseSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      // Without `:any` you only ever see your own ledger (D4: narrow, don't 403).
      const userId = actor.can('task:read:any') ? request.query.userId : actor.id;
      return service.points.listLedger({ ...request.query, userId });
    },
  );

  app.post(
    '/chores/points',
    {
      config: { permission: 'task:assign:any' },
      schema: {
        tags: ['chores'],
        summary: 'Начислить или списать очки вручную',
        body: pointsAwardSchema,
        response: { 201: pointsEntryResponseSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.points.award(actorOf(request), request.body)),
  );

  app.get(
    '/chores/points/balance',
    {
      config: { scoped: 'task:read', notFoundOnDeny: true },
      schema: {
        tags: ['chores'],
        summary: 'Баланс очков и серии',
        querystring: balanceQuerySchema,
        response: { 200: pointsBalanceSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const userId = actor.can('task:read:any') ? (request.query.userId ?? actor.id) : actor.id;
      return service.points.balanceFor(userId, request.query.windowDays);
    },
  );

  /* ------------------------------ fairness ----------------------------- */

  app.get(
    '/chores/fairness',
    {
      config: { permission: 'task:read:any', notFoundOnDeny: true },
      schema: {
        tags: ['chores'],
        summary: 'Нагрузка за период — нейтральная полоса, без рейтинга',
        querystring: fairnessQuerySchema,
        response: { 200: fairnessSummaryResponseSchema },
      },
    },
    async (request) => service.fairnessSummary(request.query),
  );

  /* -------------------------------- kudos ------------------------------ */

  app.get(
    '/chores/kudos',
    {
      config: { permission: 'kudos:give', notFoundOnDeny: true },
      schema: {
        tags: ['chores'],
        summary: 'Благодарности',
        querystring: kudosListQuerySchema,
        response: { 200: kudosListResponseSchema },
      },
    },
    async (request) => service.listKudos(request.query),
  );

  app.post(
    '/chores/kudos',
    {
      config: { permission: 'kudos:give' },
      schema: {
        tags: ['chores'],
        summary: 'Сказать спасибо (409 на повторный одинаковый эмодзи)',
        body: kudosCreateSchema,
        response: { 201: kudosResponseSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.giveKudos(actorOf(request), request.body)),
  );
};

export default choresRoutes;
