import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  idSchema,
  okSchema,
  taskAssignSchema,
  taskCalendarQuerySchema,
  taskCompleteSchema,
  taskOccurrenceListQuerySchema,
  taskOccurrenceListResponseSchema,
  taskOccurrenceResponseSchema,
  taskOccurrenceUpdateSchema,
  taskSeriesCreateSchema,
  taskSeriesDeleteSchema,
  taskSeriesListQuerySchema,
  taskSeriesListResponseSchema,
  taskSeriesResponseSchema,
  taskSeriesUpdateSchema,
  taskSkipSchema,
  taskTodayResponseSchema,
  taskUncompleteSchema,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import { getDb } from '../../core/db.js';
import { unauthenticated } from '../../core/errors.js';
import { TasksService } from './tasks.service.js';

/**
 * Task & chore HTTP surface — the route table from
 * `docs/architecture/scheduling.md` §8, mounted under `/api`.
 *
 * Thin by design (D8): parse, delegate, serialise. Everything worth arguing
 * about — the four mutation scopes, idempotent completion, the derived overdue
 * predicate, visibility — lives in `tasks.service.ts` and is unit-testable
 * without a database.
 *
 * ## Access control
 *
 * Every route declares its access in `config`, which `core/plugins/auth`
 * asserts at boot, so a forgotten guard fails the app rather than shipping an
 * open endpoint (D4 deny-by-default). There is no `public: true` route here.
 *
 * Reads use `scoped: 'task:read'` so the handler gets `req.scope` and the
 * service narrows `own` vs `any` **in SQL**. They also carry
 * `notFoundOnDeny: true`: a caller with no `task:read:*` at all — a guest —
 * must get 404, not 403, because a 403 confirms the family has tasks. Writes
 * use plain permissions and answer 403, which is the honest signal for "you can
 * see it, you may not do that to it".
 *
 * ## 404, not 403, outside read scope
 *
 * A `private` task somebody else owns, or a `restricted` one a child is not
 * meant to know about, is filtered inside the SQL predicate — it never reaches
 * a handler, so there is no code path that could leak its existence through a
 * different status code or a timing difference.
 */

/* -------------------------------------------------------------------------- */
/* Declared access, as data                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What each route declares. Exported so `tasks.test.ts` can assert the
 * registered guards still match this table — the check that catches a guard
 * quietly loosened during a refactor.
 */
export const TASK_ROUTE_ACCESS = {
  'GET /tasks/series': { scoped: 'task:read', notFoundOnDeny: true },
  'POST /tasks/series': { permission: 'task:create' },
  'GET /tasks/series/:id': { scoped: 'task:read', notFoundOnDeny: true },
  'PATCH /tasks/series/:id': { scoped: 'task:update' },
  'DELETE /tasks/series/:id': { scoped: 'task:delete' },
  'POST /tasks/series/:id/archive': { scoped: 'task:update' },
  'GET /tasks/occurrences': { scoped: 'task:read', notFoundOnDeny: true },
  'GET /tasks/calendar': { scoped: 'task:read', notFoundOnDeny: true },
  'GET /tasks/today': { scoped: 'task:read', notFoundOnDeny: true },
  'GET /tasks/occurrences/:id': { scoped: 'task:read', notFoundOnDeny: true },
  'PATCH /tasks/occurrences/:id': { scoped: 'task:update' },
  'POST /tasks/occurrences/:id/complete': { scoped: 'task:complete' },
  'POST /tasks/occurrences/:id/uncomplete': { permission: 'task:complete:any' },
  'POST /tasks/occurrences/:id/skip': { scoped: 'task:update' },
  'POST /tasks/occurrences/:id/assign': { permission: 'task:assign:any' },
  'POST /tasks/occurrences/:id/claim': { scoped: 'task:complete' },
} as const;

/* -------------------------------------------------------------------------- */
/* Local schemas                                                               */
/* -------------------------------------------------------------------------- */

const idParamsSchema = z.object({ id: idSchema });

const calendarResponseSchema = z.object({
  items: z.array(taskOccurrenceResponseSchema),
});

/**
 * Bodies that may legitimately be empty.
 *
 * `.nullish()`, not `.optional()`: a POST with no body at all arrives as
 * `null`, and `.optional()` would reject it — the kind of failure that only
 * shows up from a real client, never from a test that always sends `{}`.
 */
const archiveBodySchema = z.object({}).nullish();
const claimBodySchema = z.object({}).nullish();
const uncompleteBodySchema = taskUncompleteSchema.nullish();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * No route here is public, so a null `auth` means the auth plugin was bypassed.
 * Fail loudly rather than inventing an anonymous actor whose `userId` would
 * then be `undefined` inside a visibility predicate.
 */
function actorOf(auth: AuthContext | null): AuthContext {
  if (!auth) throw unauthenticated();
  return auth;
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                      */
/* -------------------------------------------------------------------------- */

const tasksRoutes: FastifyPluginAsync = async (instance: FastifyInstance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const service = new TasksService(getDb());

  /* ------------------------------- series -------------------------------- */

  app.get(
    '/tasks/series',
    {
      config: TASK_ROUTE_ACCESS['GET /tasks/series'],
      schema: {
        tags: ['tasks'],
        summary: 'Список серий задач',
        querystring: taskSeriesListQuerySchema,
        response: { 200: taskSeriesListResponseSchema },
      },
    },
    async (request) => service.listSeries(actorOf(request.auth), request.query),
  );

  app.post(
    '/tasks/series',
    {
      config: TASK_ROUTE_ACCESS['POST /tasks/series'],
      schema: {
        tags: ['tasks'],
        summary: 'Создать задачу (одиночную или повторяющуюся)',
        description:
          'Материализует занятия в 90-дневном горизонте в той же транзакции, ' +
          'поэтому созданная задача видна сразу, а не после ночного джоба.',
        body: taskSeriesCreateSchema,
        response: { 201: taskSeriesResponseSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.createSeries(actorOf(request.auth), request.body)),
  );

  app.get(
    '/tasks/series/:id',
    {
      config: TASK_ROUTE_ACCESS['GET /tasks/series/:id'],
      schema: {
        tags: ['tasks'],
        summary: 'Серия задач с описанием расписания',
        params: idParamsSchema,
        response: { 200: taskSeriesResponseSchema },
      },
    },
    async (request) => service.getSeries(actorOf(request.auth), request.params.id),
  );

  app.patch(
    '/tasks/series/:id',
    {
      config: TASK_ROUTE_ACCESS['PATCH /tasks/series/:id'],
      schema: {
        tags: ['tasks'],
        summary: 'Изменить задачу',
        description:
          '`scope` обязателен: this — только этот экземпляр, this_and_future — ' +
          'разделение серии, all — вся серия начиная с текущего момента.',
        params: idParamsSchema,
        body: taskSeriesUpdateSchema,
        response: { 200: taskSeriesResponseSchema },
      },
    },
    async (request) => service.updateSeries(actorOf(request.auth), request.params.id, request.body),
  );

  app.delete(
    '/tasks/series/:id',
    {
      config: TASK_ROUTE_ACCESS['DELETE /tasks/series/:id'],
      schema: {
        tags: ['tasks'],
        summary: 'Удалить задачу',
        params: idParamsSchema,
        body: taskSeriesDeleteSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await service.deleteSeries(actorOf(request.auth), request.params.id, request.body);
      return { ok: true } as const;
    },
  );

  app.post(
    '/tasks/series/:id/archive',
    {
      config: TASK_ROUTE_ACCESS['POST /tasks/series/:id/archive'],
      schema: {
        tags: ['tasks'],
        summary: 'Остановить серию, сохранив историю',
        params: idParamsSchema,
        body: archiveBodySchema,
        response: { 200: taskSeriesResponseSchema },
      },
    },
    async (request) => service.archiveSeries(actorOf(request.auth), request.params.id),
  );

  /* ---------------------------- occurrences ------------------------------ */

  app.get(
    '/tasks/occurrences',
    {
      config: TASK_ROUTE_ACCESS['GET /tasks/occurrences'],
      schema: {
        tags: ['tasks'],
        summary: 'Экземпляры задач',
        description:
          '`overdueOnly` использует вычисляемый предикат ' +
          '(status = scheduled и срок + отсрочка в прошлом); хранимого флага нет.',
        querystring: taskOccurrenceListQuerySchema,
        response: { 200: taskOccurrenceListResponseSchema },
      },
    },
    async (request) => service.listOccurrences(actorOf(request.auth), request.query),
  );

  app.get(
    '/tasks/calendar',
    {
      config: TASK_ROUTE_ACCESS['GET /tasks/calendar'],
      schema: {
        tags: ['tasks'],
        summary: 'Окно календаря по локальным датам',
        querystring: taskCalendarQuerySchema,
        response: { 200: calendarResponseSchema },
      },
    },
    async (request) => ({
      items: await service.calendar(actorOf(request.auth), request.query),
    }),
  );

  app.get(
    '/tasks/today',
    {
      config: TASK_ROUTE_ACCESS['GET /tasks/today'],
      schema: {
        tags: ['tasks'],
        summary: 'Сводка на сегодня одним запросом',
        response: { 200: taskTodayResponseSchema },
      },
    },
    async (request) => service.today(actorOf(request.auth)),
  );

  app.get(
    '/tasks/occurrences/:id',
    {
      config: TASK_ROUTE_ACCESS['GET /tasks/occurrences/:id'],
      schema: {
        tags: ['tasks'],
        summary: 'Один экземпляр задачи',
        params: idParamsSchema,
        response: { 200: taskOccurrenceResponseSchema },
      },
    },
    async (request) => service.getOccurrence(actorOf(request.auth), request.params.id),
  );

  app.patch(
    '/tasks/occurrences/:id',
    {
      config: TASK_ROUTE_ACCESS['PATCH /tasks/occurrences/:id'],
      schema: {
        tags: ['tasks'],
        summary: 'Изменить или перенести один экземпляр',
        description:
          'Ставит is_exception = true. Перенос меняет время, но никогда — ' +
          'occurrenceKey: это неизменяемая идентичность экземпляра.',
        params: idParamsSchema,
        body: taskOccurrenceUpdateSchema,
        response: { 200: taskOccurrenceResponseSchema },
      },
    },
    async (request) =>
      service.updateOccurrence(actorOf(request.auth), request.params.id, request.body),
  );

  app.post(
    '/tasks/occurrences/:id/complete',
    {
      config: TASK_ROUTE_ACCESS['POST /tasks/occurrences/:id/complete'],
      schema: {
        tags: ['tasks'],
        summary: 'Отметить выполнение',
        description:
          'Идемпотентно: повторный запрос возвращает ту же задачу и ничего не ' +
          'записывает второй раз. Дело засчитывается тому, кто его сделал, ' +
          'а не тому, кому оно было назначено.',
        params: idParamsSchema,
        body: taskCompleteSchema,
        response: { 200: taskOccurrenceResponseSchema },
      },
    },
    async (request) => service.complete(actorOf(request.auth), request.params.id, request.body),
  );

  app.post(
    '/tasks/occurrences/:id/uncomplete',
    {
      config: TASK_ROUTE_ACCESS['POST /tasks/occurrences/:id/uncomplete'],
      schema: {
        tags: ['tasks'],
        summary: 'Отменить выполнение (дело перестаёт засчитываться)',
        params: idParamsSchema,
        body: uncompleteBodySchema,
        response: { 200: taskOccurrenceResponseSchema },
      },
    },
    async (request) => service.uncomplete(actorOf(request.auth), request.params.id),
  );

  app.post(
    '/tasks/occurrences/:id/skip',
    {
      config: TASK_ROUTE_ACCESS['POST /tasks/occurrences/:id/skip'],
      schema: {
        tags: ['tasks'],
        summary: 'Пропустить экземпляр, сохранив строку',
        description:
          'Меняет только статус. EXDATE записывается лишь при suppressFuture: ' +
          'иначе история «не сделали 14-го» была бы стёрта.',
        params: idParamsSchema,
        body: taskSkipSchema,
        response: { 200: taskOccurrenceResponseSchema },
      },
    },
    async (request) => service.skip(actorOf(request.auth), request.params.id, request.body),
  );

  app.post(
    '/tasks/occurrences/:id/assign',
    {
      config: TASK_ROUTE_ACCESS['POST /tasks/occurrences/:id/assign'],
      schema: {
        tags: ['tasks'],
        summary: 'Назначить исполнителя вручную',
        params: idParamsSchema,
        body: taskAssignSchema,
        response: { 200: taskOccurrenceResponseSchema },
      },
    },
    async (request) => service.assign(actorOf(request.auth), request.params.id, request.body),
  );

  app.post(
    '/tasks/occurrences/:id/claim',
    {
      config: TASK_ROUTE_ACCESS['POST /tasks/occurrences/:id/claim'],
      schema: {
        tags: ['tasks'],
        summary: 'Взять свободную задачу себе',
        params: idParamsSchema,
        body: claimBodySchema,
        response: { 200: taskOccurrenceResponseSchema },
      },
    },
    async (request) => service.claim(actorOf(request.auth), request.params.id),
  );
};

export default tasksRoutes;
