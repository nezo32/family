import { z } from 'zod';

import {
  cursorPaginationSchema,
  idSchema,
  isoDateTimeSchema,
  nonEmptyString,
  paginatedSchema,
} from './common.js';

/**
 * Shopping list contracts.
 *
 * Two things drive the shape of this file:
 *
 * 1. **Quick entry.** Adding "молоко, хлеб, 2 кг картошки" must take one field
 *    and one tap, hence `bulkAddItemsSchema` with a raw multi-line `text` mode.
 * 2. **Offline.** The shop is where mobile data dies. Every mutation that
 *    creates or flips an item carries an optional `clientId` (a UUID minted by
 *    the client *before* the optimistic update). Replaying a queued mutation
 *    hits a partial unique index server-side and returns the existing row, so
 *    a flaky connection can never duplicate an item.
 *
 * There is no price field: shared expenses are deferred (D9). Quantities are
 * plain numbers — the only money in this app is the moneybox (D6).
 */

export const shoppingItemStateSchema = z.enum(['needed', 'bought', 'cancelled']);
export type ShoppingItemState = z.infer<typeof shoppingItemStateSchema>;

/** Free-form quantity: "1.5". Not money, so a plain number is fine. */
export const quantitySchema = z.number().positive().max(100000).nullish();

/* -------------------------------------------------------------------------- */
/* Lists                                                                       */
/* -------------------------------------------------------------------------- */

const listWritableFields = z.object({
  name: nonEmptyString(80),
  icon: z.string().trim().max(64).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullish(),
  sortOrder: z.number().int().min(0).optional(),
});

export const createShoppingListSchema = listWritableFields;
export type CreateShoppingList = z.infer<typeof createShoppingListSchema>;

export const updateShoppingListSchema = listWritableFields.partial().extend({
  isArchived: z.boolean().optional(),
});
export type UpdateShoppingList = z.infer<typeof updateShoppingListSchema>;

export const shoppingListResponseSchema = z.object({
  id: idSchema,
  name: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  isArchived: z.boolean(),
  sortOrder: z.number().int(),
  createdById: idSchema,
  /** Derived counters for the list chips. */
  neededCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ShoppingListResponse = z.infer<typeof shoppingListResponseSchema>;

export const listShoppingListsQuerySchema = z.object({
  includeArchived: z.coerce.boolean().default(false),
});
export type ListShoppingListsQuery = z.infer<typeof listShoppingListsQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

const itemWritableFields = z.object({
  name: nonEmptyString(160),
  quantity: quantitySchema,
  /** шт, кг, л, упак — free text. */
  unit: z.string().trim().max(24).nullish(),
  /** Store-aisle grouping; defaults from `product_catalog` when omitted. */
  category: z.string().trim().max(64).nullish(),
  note: z.string().trim().max(500).nullish(),
  isUrgent: z.boolean().default(false),
  sortOrder: z.number().int().min(0).optional(),
});

export const createShoppingItemSchema = itemWritableFields.extend({
  /**
   * Client-minted UUID for offline de-duplication. Replaying the same
   * `clientId` returns the row created the first time instead of a duplicate,
   * which makes `POST /shopping/lists/:id/items` idempotent.
   */
  clientId: idSchema.optional(),
});
export type CreateShoppingItem = z.infer<typeof createShoppingItemSchema>;

export const updateShoppingItemSchema = itemWritableFields.partial().extend({
  state: shoppingItemStateSchema.optional(),
  /** Moving an item between lists (продукты -> аптека). */
  listId: idSchema.optional(),
});
export type UpdateShoppingItem = z.infer<typeof updateShoppingItemSchema>;

/**
 * The one-tap action in the aisle. `bought: true` sets
 * `state='bought', bought_by_id=<caller>, bought_at=<occurredAt ?? now()>`;
 * `false` reverts to `needed` and clears both.
 */
export const toggleItemSchema = z.object({
  bought: z.boolean(),
  /**
   * When the tap actually happened. An offline queue replays minutes later, so
   * the client sends its own timestamp rather than letting the server invent one.
   */
  occurredAt: isoDateTimeSchema.optional(),
  /** Idempotency key for the replayed toggle. */
  clientId: idSchema.optional(),
});
export type ToggleItem = z.infer<typeof toggleItemSchema>;

/** One parsed line of the quick-entry box. */
export const bulkAddItemSchema = itemWritableFields.partial().extend({
  name: nonEmptyString(160),
  clientId: idSchema.optional(),
});
export type BulkAddItem = z.infer<typeof bulkAddItemSchema>;

/**
 * Quick entry, one item per line. Send **either** the raw `text` the user typed
 * (the server splits on newlines and commas and applies `product_catalog`
 * defaults) **or** an already-parsed `items` array — the client parses locally
 * while offline so it can render the optimistic rows immediately.
 */
export const bulkAddItemsSchema = z
  .object({
    text: z.string().trim().min(1).max(4000).optional(),
    items: z.array(bulkAddItemSchema).min(1).max(100).optional(),
  })
  .refine((v) => Boolean(v.text) !== Boolean(v.items), {
    message: 'Укажите либо text, либо items',
  });
export type BulkAddItems = z.infer<typeof bulkAddItemsSchema>;

export const shoppingItemResponseSchema = z.object({
  id: idSchema,
  listId: idSchema,
  name: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  category: z.string().nullable(),
  note: z.string().nullable(),
  requestedById: idSchema,
  state: shoppingItemStateSchema,
  boughtById: idSchema.nullable(),
  boughtAt: isoDateTimeSchema.nullable(),
  isUrgent: z.boolean(),
  sortOrder: z.number().int(),
  /** Echoed back so an offline client can reconcile its optimistic row. */
  clientId: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ShoppingItemResponse = z.infer<typeof shoppingItemResponseSchema>;

export const listShoppingItemsQuerySchema = cursorPaginationSchema.extend({
  state: z.array(shoppingItemStateSchema).optional(),
  category: z.string().max(64).optional(),
  /** Group the response by `category` for the aisle-ordered view. */
  groupByCategory: z.coerce.boolean().default(false),
});
export type ListShoppingItemsQuery = z.infer<typeof listShoppingItemsQuerySchema>;

export const shoppingItemListResponseSchema = paginatedSchema(shoppingItemResponseSchema);
export type ShoppingItemListResponse = z.infer<typeof shoppingItemListResponseSchema>;

/** Result of a bulk add: created rows plus the ones an idempotent replay matched. */
export const bulkAddItemsResponseSchema = z.object({
  created: z.array(shoppingItemResponseSchema),
  duplicates: z.array(shoppingItemResponseSchema).default([]),
});
export type BulkAddItemsResponse = z.infer<typeof bulkAddItemsResponseSchema>;

/** Clears the bought/cancelled tail of a list. */
export const clearBoughtItemsSchema = z.object({
  /** `true` deletes them, `false` (default) just returns how many would go. */
  confirm: z.boolean().default(false),
});
export type ClearBoughtItems = z.infer<typeof clearBoughtItemsSchema>;

export const reorderShoppingItemsSchema = z.object({
  ids: z.array(idSchema).min(1).max(500),
});
export type ReorderShoppingItems = z.infer<typeof reorderShoppingItemsSchema>;

/* -------------------------------------------------------------------------- */
/* Product catalog (learned from this family's own history)                    */
/* -------------------------------------------------------------------------- */

export const productSuggestionSchema = z.object({
  id: idSchema,
  name: z.string(),
  defaultCategory: z.string().nullable(),
  defaultUnit: z.string().nullable(),
  usageCount: z.number().int().min(0),
  lastUsedAt: isoDateTimeSchema.nullable(),
  isFavourite: z.boolean(),
});
export type ProductSuggestion = z.infer<typeof productSuggestionSchema>;

export const productSuggestQuerySchema = z.object({
  /** Prefix/substring match, case-insensitive. Empty => the top favourites. */
  q: z.string().trim().max(160).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type ProductSuggestQuery = z.infer<typeof productSuggestQuerySchema>;

export const updateProductSchema = z.object({
  defaultCategory: z.string().trim().max(64).nullish(),
  defaultUnit: z.string().trim().max(24).nullish(),
  isFavourite: z.boolean().optional(),
});
export type UpdateProduct = z.infer<typeof updateProductSchema>;
