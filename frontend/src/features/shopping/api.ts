import type {
  BulkAddItems,
  BulkAddItemsResponse,
  CreateShoppingItem,
  CreateShoppingList,
  ProductSuggestion,
  ShoppingItemListResponse,
  ShoppingItemResponse,
  ShoppingListResponse,
  ToggleItem,
  UpdateShoppingItem,
  UpdateShoppingList,
} from '@family/shared';
import { api } from '@/shared/api/client';

/**
 * Typed fetchers for `/api/shopping`, mirroring the route table in
 * `docs/architecture/household.md` §1.
 *
 * Everything goes through `shared/api/client` — base URL, bearer token, the
 * 401 refresh-and-retry, and `ApiError`/`NetworkError` typing come from there.
 * The distinction between those two error classes is what the outbox uses to
 * decide "roll this back" versus "we are just offline".
 *
 * One thing worth stating because its absence looks like an omission: the
 * create-item call does **not** branch on `201` vs `200`. The server answers
 * `201` the first time and `200` for a replayed `clientId`, and returns the row
 * either way — and since reconciliation is keyed on `clientId`, "created" and
 * "already accepted" are literally the same operation on the cache: swap the
 * optimistic row for the returned one, drop the outbox entry. Reading the
 * status would only let us do the same thing twice.
 */

/* -------------------------------------------------------------------------- */
/* query keys                                                                 */
/* -------------------------------------------------------------------------- */

export const shoppingKeys = {
  all: ['shopping'] as const,
  lists: () => [...shoppingKeys.all, 'lists'] as const,
  list: (includeArchived: boolean) => [...shoppingKeys.lists(), { includeArchived }] as const,
  items: (listId: string) => [...shoppingKeys.all, 'items', listId] as const,
  products: () => [...shoppingKeys.all, 'products'] as const,
  frequent: (limit: number) => [...shoppingKeys.products(), 'frequent', limit] as const,
  suggest: (q: string) => [...shoppingKeys.products(), 'suggest', q] as const,
};

/* -------------------------------------------------------------------------- */
/* lists                                                                      */
/* -------------------------------------------------------------------------- */

interface ItemsEnvelope {
  items: ShoppingListResponse[];
}

export async function fetchLists(includeArchived = false): Promise<ShoppingListResponse[]> {
  const data = await api.get<ItemsEnvelope>('/shopping/lists', {
    query: { includeArchived },
  });
  return data.items;
}

export function createList(body: CreateShoppingList): Promise<ShoppingListResponse> {
  return api.post<ShoppingListResponse>('/shopping/lists', body);
}

export function updateList(
  listId: string,
  body: UpdateShoppingList,
): Promise<ShoppingListResponse> {
  return api.patch<ShoppingListResponse>(`/shopping/lists/${listId}`, body);
}

export function deleteList(listId: string): Promise<{ ok: true }> {
  return api.del<{ ok: true }>(`/shopping/lists/${listId}`);
}

/* -------------------------------------------------------------------------- */
/* items                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `groupByCategory` asks the server for aisle order. The client still sorts
 * (see `grouping.ts`): the server orders categories alphabetically because it
 * has no opinion about shop layout, and an optimistic row added offline has
 * never been near the server at all.
 */
export function fetchItems(listId: string): Promise<ShoppingItemListResponse> {
  return api.get<ShoppingItemListResponse>(`/shopping/lists/${listId}/items`, {
    query: { groupByCategory: true, limit: 200 },
  });
}

/** Idempotent on `clientId`. `201` first time, `200` on replay — same handling. */
export function createItem(
  listId: string,
  body: CreateShoppingItem,
): Promise<ShoppingItemResponse> {
  return api.post<ShoppingItemResponse>(`/shopping/lists/${listId}/items`, body);
}

/** Quick entry. `{ created[], duplicates[] }` — both are reconciled the same way. */
export function bulkAddItems(listId: string, body: BulkAddItems): Promise<BulkAddItemsResponse> {
  return api.post<BulkAddItemsResponse>(`/shopping/lists/${listId}/items/bulk`, body);
}

export function updateItem(
  itemId: string,
  body: UpdateShoppingItem,
): Promise<ShoppingItemResponse> {
  return api.patch<ShoppingItemResponse>(`/shopping/items/${itemId}`, body);
}

/**
 * The one-tap action in the aisle.
 *
 * `occurredAt` is the moment of the tap, supplied by the caller — never
 * defaulted here, because this function is called from the outbox flush, which
 * may be running twenty minutes and one train journey later.
 */
export function toggleItem(itemId: string, body: ToggleItem): Promise<ShoppingItemResponse> {
  return api.post<ShoppingItemResponse>(`/shopping/items/${itemId}/toggle`, body);
}

export function deleteItem(itemId: string): Promise<{ ok: true }> {
  return api.del<{ ok: true }>(`/shopping/items/${itemId}`);
}

export interface ClearBoughtResult {
  matched: number;
  removed: number;
}

export function clearBought(listId: string, confirm: boolean): Promise<ClearBoughtResult> {
  return api.post<ClearBoughtResult>(`/shopping/lists/${listId}/clear-bought`, { confirm });
}

/* -------------------------------------------------------------------------- */
/* product catalogue — the family's own history, no external database          */
/* -------------------------------------------------------------------------- */

interface ProductsEnvelope {
  items: ProductSuggestion[];
}

/** The one-tap «часто покупаем» strip. */
export async function fetchFrequentProducts(limit = 12): Promise<ProductSuggestion[]> {
  const data = await api.get<ProductsEnvelope>('/shopping/products/frequent', { query: { limit } });
  return data.items;
}

/** Autocomplete. Empty `q` returns the family's favourites. */
export async function fetchProductSuggestions(q: string, limit = 8): Promise<ProductSuggestion[]> {
  const data = await api.get<ProductsEnvelope>('/shopping/products/suggest', {
    query: { q, limit },
  });
  return data.items;
}
