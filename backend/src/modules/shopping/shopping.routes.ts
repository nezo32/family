import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  bulkAddItemsResponseSchema,
  bulkAddItemsSchema,
  clearBoughtItemsSchema,
  createShoppingItemSchema,
  createShoppingListSchema,
  idSchema,
  listShoppingItemsQuerySchema,
  listShoppingListsQuerySchema,
  okSchema,
  productSuggestionSchema,
  productSuggestQuerySchema,
  reorderShoppingItemsSchema,
  shoppingItemListResponseSchema,
  shoppingItemResponseSchema,
  shoppingListResponseSchema,
  toggleItemSchema,
  updateProductSchema,
  updateShoppingItemSchema,
  updateShoppingListSchema,
} from '@family/shared';

import { getDb } from '../../core/db.js';
import { unauthenticated } from '../../core/errors.js';
import { ShoppingService, type ShoppingActor } from './shopping.service.js';

/**
 * Shopping routes — the route table in `docs/architecture/household.md` §1.
 *
 * Thin by design (D8): parse, call the service, serialise. Every route declares
 * its access in `config`, which the auth plugin asserts at boot — there is no
 * `public: true` route in this domain (D4 deny-by-default).
 *
 * The permission split is the interesting part. `shopping:read`/`shopping:write`
 * cover items and **children hold both**: adding «мороженое» to the list is
 * exactly the participation this app wants. Only owning a whole list —
 * creating, archiving, deleting, clearing the bought tail, editing the
 * catalogue — needs `shopping:list:manage`.
 *
 * ## 404, not 403
 *
 * Every route gated on `shopping:read` carries `notFoundOnDeny: true`: a caller
 * without it — a guest holds no `shopping:*` at all — must not learn the family
 * keeps a shopping list (D4). The `shopping:write` and `shopping:list:manage`
 * routes keep 403 on purpose: that caller holds `shopping:read`, is looking at
 * the list, and "you may not do that to it" is the honest answer.
 */

const idParamsSchema = z.object({ id: idSchema });

const listsResponseSchema = z.object({ items: z.array(shoppingListResponseSchema) });
const productsResponseSchema = z.object({ items: z.array(productSuggestionSchema) });
const clearBoughtResponseSchema = z.object({
  /** How many bought/cancelled items the list holds. */
  matched: z.number().int().min(0),
  /** How many were actually deleted — `0` unless `confirm` was set. */
  removed: z.number().int().min(0),
});
const reorderResponseSchema = z.object({ updated: z.number().int().min(0) });
const frequentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** The auth plugin guarantees `req.auth` on every guarded route; this narrows it. */
function actorOf(request: FastifyRequest): ShoppingActor {
  if (!request.auth) throw unauthenticated();
  return { id: request.auth.userId, displayName: request.auth.displayName };
}

const shoppingRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new ShoppingService(getDb());

  /* ------------------------------- lists -------------------------------- */

  app.get(
    '/shopping/lists',
    {
      config: { permission: 'shopping:read', notFoundOnDeny: true },
      schema: {
        tags: ['shopping'],
        summary: 'Списки покупок',
        querystring: listShoppingListsQuerySchema,
        response: { 200: listsResponseSchema },
      },
    },
    async (request) => ({ items: await service.listLists(request.query) }),
  );

  app.post(
    '/shopping/lists',
    {
      config: { permission: 'shopping:list:manage' },
      schema: {
        tags: ['shopping'],
        summary: 'Создать список',
        body: createShoppingListSchema,
        response: { 201: shoppingListResponseSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.createList(actorOf(request), request.body)),
  );

  app.patch(
    '/shopping/lists/:id',
    {
      config: { permission: 'shopping:list:manage' },
      schema: {
        tags: ['shopping'],
        summary: 'Изменить список (в том числе архивировать)',
        params: idParamsSchema,
        body: updateShoppingListSchema,
        response: { 200: shoppingListResponseSchema },
      },
    },
    async (request) => service.updateList(request.params.id, request.body),
  );

  app.delete(
    '/shopping/lists/:id',
    {
      config: { permission: 'shopping:list:manage' },
      schema: {
        tags: ['shopping'],
        summary: 'Удалить список вместе с позициями',
        params: idParamsSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await service.deleteList(request.params.id);
      return { ok: true } as const;
    },
  );

  /* ------------------------------- items -------------------------------- */

  app.get(
    '/shopping/lists/:id/items',
    {
      config: { permission: 'shopping:read', notFoundOnDeny: true },
      schema: {
        tags: ['shopping'],
        summary: 'Позиции списка',
        description:
          'При `groupByCategory=true` позиции возвращаются в порядке обхода магазина: ' +
          'по категориям, внутри категории — сначала нужные и срочные.',
        params: idParamsSchema,
        querystring: listShoppingItemsQuerySchema,
        response: { 200: shoppingItemListResponseSchema },
      },
    },
    async (request) => service.listItems(request.params.id, request.query),
  );

  app.post(
    '/shopping/lists/:id/items',
    {
      config: { permission: 'shopping:write' },
      schema: {
        tags: ['shopping'],
        summary: 'Добавить позицию',
        description:
          'Идемпотентно по `clientId`: повторная доставка той же мутации из офлайн-очереди ' +
          'возвращает уже созданную строку с кодом 200 вместо дубля с 201.',
        params: idParamsSchema,
        body: createShoppingItemSchema,
        response: { 200: shoppingItemResponseSchema, 201: shoppingItemResponseSchema },
      },
    },
    async (request, reply) => {
      const { item, created } = await service.addItem(
        actorOf(request),
        request.params.id,
        request.body,
      );
      return reply.code(created ? 201 : 200).send(item);
    },
  );

  app.post(
    '/shopping/lists/:id/items/bulk',
    {
      config: { permission: 'shopping:write' },
      schema: {
        tags: ['shopping'],
        summary: 'Быстрый ввод: одна позиция в строке',
        description:
          'Либо сырой `text` («2 кг картошки\\nмолоко 3 шт»), который разбирает сервер, ' +
          'либо уже разобранный `items[]` от офлайн-клиента.',
        params: idParamsSchema,
        body: bulkAddItemsSchema,
        response: { 200: bulkAddItemsResponseSchema },
      },
    },
    async (request) => service.bulkAdd(actorOf(request), request.params.id, request.body),
  );

  app.patch(
    '/shopping/items/:id',
    {
      config: { permission: 'shopping:write' },
      schema: {
        tags: ['shopping'],
        summary: 'Изменить позицию (в том числе перенести в другой список)',
        params: idParamsSchema,
        body: updateShoppingItemSchema,
        response: { 200: shoppingItemResponseSchema },
      },
    },
    async (request) => service.updateItem(actorOf(request), request.params.id, request.body),
  );

  app.post(
    '/shopping/items/:id/toggle',
    {
      config: { permission: 'shopping:write' },
      schema: {
        tags: ['shopping'],
        summary: 'Отметить купленным / вернуть в список',
        description:
          'Идемпотентно: повтор той же отметки ничего не меняет. `occurredAt` — время нажатия ' +
          'на телефоне, а не время прихода запроса.',
        params: idParamsSchema,
        body: toggleItemSchema,
        response: { 200: shoppingItemResponseSchema },
      },
    },
    async (request) => service.toggleItem(actorOf(request), request.params.id, request.body),
  );

  app.delete(
    '/shopping/items/:id',
    {
      config: { permission: 'shopping:write' },
      schema: {
        tags: ['shopping'],
        summary: 'Удалить позицию',
        params: idParamsSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await service.deleteItem(request.params.id);
      return { ok: true } as const;
    },
  );

  app.post(
    '/shopping/lists/:id/clear-bought',
    {
      config: { permission: 'shopping:list:manage' },
      schema: {
        tags: ['shopping'],
        summary: 'Очистить купленное',
        description: 'Без `confirm` только считает, сколько позиций будет удалено.',
        params: idParamsSchema,
        body: clearBoughtItemsSchema,
        response: { 200: clearBoughtResponseSchema },
      },
    },
    async (request) => service.clearBought(request.params.id, request.body),
  );

  app.post(
    '/shopping/lists/:id/reorder',
    {
      config: { permission: 'shopping:write' },
      schema: {
        tags: ['shopping'],
        summary: 'Задать порядок позиций',
        params: idParamsSchema,
        body: reorderShoppingItemsSchema,
        response: { 200: reorderResponseSchema },
      },
    },
    async (request) => service.reorderItems(request.params.id, request.body),
  );

  /* --------------------------- product catalogue -------------------------- */

  app.get(
    '/shopping/products/suggest',
    {
      config: { permission: 'shopping:read', notFoundOnDeny: true },
      schema: {
        tags: ['shopping'],
        summary: 'Автодополнение по истории семьи',
        description: 'Источник — только то, что покупала эта семья. Внешней базы товаров нет.',
        querystring: productSuggestQuerySchema,
        response: { 200: productsResponseSchema },
      },
    },
    async (request) => ({ items: await service.suggestProducts(request.query) }),
  );

  app.get(
    '/shopping/products/frequent',
    {
      config: { permission: 'shopping:read', notFoundOnDeny: true },
      schema: {
        tags: ['shopping'],
        summary: 'Часто покупаемое',
        description: 'Полоса быстрого повторного добавления, ранжирование по `usageCount`.',
        querystring: frequentQuerySchema,
        response: { 200: productsResponseSchema },
      },
    },
    async (request) => ({ items: await service.frequentProducts(request.query.limit) }),
  );

  app.patch(
    '/shopping/products/:id',
    {
      config: { permission: 'shopping:list:manage' },
      schema: {
        tags: ['shopping'],
        summary: 'Избранное, единица измерения и категория по умолчанию',
        params: idParamsSchema,
        body: updateProductSchema,
        response: { 200: productSuggestionSchema },
      },
    },
    async (request) => service.updateProduct(request.params.id, request.body),
  );
};

export default shoppingRoutes;
