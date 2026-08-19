import { and, asc, desc, eq, getTableColumns, gte, ilike, inArray, ne, or, sql } from 'drizzle-orm';

import type { Executor } from '../../core/db.js';
import {
  productCatalog,
  shoppingItems,
  shoppingLists,
  type NewShoppingItemRow,
  type NewShoppingListRow,
  type ProductCatalogRow,
  type ShoppingItemRow,
  type ShoppingListRow,
} from './shopping.schema.js';

/**
 * Shopping data access. No HTTP, no business rules (D8).
 *
 * Every function takes an {@link Executor} first, so the service can run any of
 * them inside a transaction — which the idempotent create path needs, because
 * "insert the item and bump the catalogue" has to be one atomic step or a
 * replayed offline mutation can double-count a product.
 *
 * Two things this file is deliberately careful about:
 *
 * - **No N+1.** List counters come back from one grouped join, not one COUNT
 *   per list; reordering is one UPDATE with a CASE, not one per id.
 * - **The partial unique index on `client_id` is load-bearing.** Inserts use
 *   `ON CONFLICT DO NOTHING` so a replayed offline write is a no-op the service
 *   can turn into "here is the row you already created".
 */

export type ShoppingItemState = ShoppingItemRow['state'];

/* -------------------------------------------------------------------------- */
/* Lists                                                                       */
/* -------------------------------------------------------------------------- */

export interface ShoppingListWithCounts extends ShoppingListRow {
  neededCount: number;
  totalCount: number;
}

/**
 * Every list plus its counters in one query.
 *
 * `count(item.id)` (not `count(*)`) so the LEFT JOIN's null row on an empty
 * list counts as zero rather than one.
 */
export async function findLists(
  ex: Executor,
  options: { includeArchived: boolean },
): Promise<ShoppingListWithCounts[]> {
  const rows = await ex
    .select({
      ...getTableColumns(shoppingLists),
      neededCount:
        sql<number>`count(${shoppingItems.id}) filter (where ${shoppingItems.state} = 'needed')`.mapWith(
          Number,
        ),
      totalCount: sql<number>`count(${shoppingItems.id})`.mapWith(Number),
    })
    .from(shoppingLists)
    .leftJoin(shoppingItems, eq(shoppingItems.listId, shoppingLists.id))
    .where(options.includeArchived ? undefined : eq(shoppingLists.isArchived, false))
    .groupBy(shoppingLists.id)
    .orderBy(asc(shoppingLists.isArchived), asc(shoppingLists.sortOrder), asc(shoppingLists.name));

  return rows;
}

export async function findListById(
  ex: Executor,
  id: string,
): Promise<ShoppingListWithCounts | undefined> {
  const [row] = await ex
    .select({
      ...getTableColumns(shoppingLists),
      neededCount:
        sql<number>`count(${shoppingItems.id}) filter (where ${shoppingItems.state} = 'needed')`.mapWith(
          Number,
        ),
      totalCount: sql<number>`count(${shoppingItems.id})`.mapWith(Number),
    })
    .from(shoppingLists)
    .leftJoin(shoppingItems, eq(shoppingItems.listId, shoppingLists.id))
    .where(eq(shoppingLists.id, id))
    .groupBy(shoppingLists.id)
    .limit(1);

  return row;
}

/** Existence check for the hot paths that only need "is this list real?". */
export async function listExists(ex: Executor, id: string): Promise<boolean> {
  const [row] = await ex
    .select({ id: shoppingLists.id })
    .from(shoppingLists)
    .where(eq(shoppingLists.id, id))
    .limit(1);
  return row !== undefined;
}

export async function insertList(
  ex: Executor,
  values: NewShoppingListRow,
): Promise<ShoppingListRow> {
  const [row] = await ex.insert(shoppingLists).values(values).returning();
  if (!row) throw new Error('insert into shopping_lists returned no row');
  return row;
}

export async function updateListRow(
  ex: Executor,
  id: string,
  patch: Partial<NewShoppingListRow>,
): Promise<ShoppingListRow | undefined> {
  const [row] = await ex
    .update(shoppingLists)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(shoppingLists.id, id))
    .returning();
  return row;
}

/** Items cascade at the FK level, so one DELETE is enough. */
export async function deleteListRow(ex: Executor, id: string): Promise<boolean> {
  const rows = await ex
    .delete(shoppingLists)
    .where(eq(shoppingLists.id, id))
    .returning({ id: shoppingLists.id });
  return rows.length > 0;
}

export async function nextListSortOrder(ex: Executor): Promise<number> {
  const [row] = await ex
    .select({
      next: sql<number>`coalesce(max(${shoppingLists.sortOrder}), -1) + 1`.mapWith(Number),
    })
    .from(shoppingLists);
  return row?.next ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

export interface FindItemsOptions {
  states?: readonly ShoppingItemState[];
  category?: string;
  /**
   * Store-walk ordering: items grouped by aisle, uncategorised last. The client
   * renders the groups; the server decides the order so the web app, the
   * digest and the Telegram bot all walk the shop the same way.
   */
  groupByCategory: boolean;
  limit: number;
  offset: number;
}

export async function findItems(
  ex: Executor,
  listId: string,
  options: FindItemsOptions,
): Promise<ShoppingItemRow[]> {
  const conditions = [eq(shoppingItems.listId, listId)];
  if (options.states && options.states.length > 0) {
    conditions.push(inArray(shoppingItems.state, [...options.states]));
  }
  if (options.category !== undefined) {
    conditions.push(eq(shoppingItems.category, options.category));
  }

  // Still-needed first, then urgent, then the manual order — the shape of the
  // aisle view. `id` closes the ordering so keyset paging stays stable.
  const tail = [
    sql`${shoppingItems.state} <> 'needed'`,
    desc(shoppingItems.isUrgent),
    asc(shoppingItems.sortOrder),
    asc(shoppingItems.createdAt),
    asc(shoppingItems.id),
  ];

  const orderBy = options.groupByCategory
    ? [sql`${shoppingItems.category} is null`, asc(shoppingItems.category), ...tail]
    : tail;

  return ex
    .select()
    .from(shoppingItems)
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(options.limit)
    .offset(options.offset);
}

export async function findItemById(ex: Executor, id: string): Promise<ShoppingItemRow | undefined> {
  const [row] = await ex.select().from(shoppingItems).where(eq(shoppingItems.id, id)).limit(1);
  return row;
}

export async function findItemsByClientIds(
  ex: Executor,
  clientIds: readonly string[],
): Promise<ShoppingItemRow[]> {
  if (clientIds.length === 0) return [];
  return ex
    .select()
    .from(shoppingItems)
    .where(inArray(shoppingItems.clientId, [...clientIds]));
}

/**
 * The offline-sync primitive.
 *
 * `ON CONFLICT DO NOTHING` with no explicit target lets Postgres arbitrate on
 * whichever unique index the row violates — here that can only be the partial
 * `shopping_items_client_id_uq`. Rows returned were created by *this* call;
 * anything missing was already there, and the service looks it up by
 * `client_id` and returns it with `200`.
 */
export async function insertItemsIdempotent(
  ex: Executor,
  values: readonly NewShoppingItemRow[],
): Promise<ShoppingItemRow[]> {
  if (values.length === 0) return [];
  return ex
    .insert(shoppingItems)
    .values([...values])
    .onConflictDoNothing()
    .returning();
}

export async function updateItemRow(
  ex: Executor,
  id: string,
  patch: Partial<NewShoppingItemRow>,
): Promise<ShoppingItemRow | undefined> {
  const [row] = await ex
    .update(shoppingItems)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(shoppingItems.id, id))
    .returning();
  return row;
}

/**
 * Flip an item to `bought`, but only if it is not already.
 *
 * The `state <> 'bought'` predicate is what makes a replayed toggle a no-op:
 * the second delivery of the same tap updates zero rows and therefore cannot
 * overwrite `bought_by_id` / `bought_at` with a later timestamp.
 */
export async function markItemBought(
  ex: Executor,
  id: string,
  by: { userId: string; occurredAt: Date },
): Promise<ShoppingItemRow | undefined> {
  const [row] = await ex
    .update(shoppingItems)
    .set({
      state: 'bought',
      boughtById: by.userId,
      boughtAt: by.occurredAt,
      updatedAt: new Date(),
    })
    .where(and(eq(shoppingItems.id, id), ne(shoppingItems.state, 'bought')))
    .returning();
  return row;
}

/** The mirror image: revert to `needed`, but only from `bought`. */
export async function markItemNeeded(
  ex: Executor,
  id: string,
): Promise<ShoppingItemRow | undefined> {
  const [row] = await ex
    .update(shoppingItems)
    .set({ state: 'needed', boughtById: null, boughtAt: null, updatedAt: new Date() })
    .where(and(eq(shoppingItems.id, id), eq(shoppingItems.state, 'bought')))
    .returning();
  return row;
}

export async function deleteItemRow(ex: Executor, id: string): Promise<boolean> {
  const rows = await ex
    .delete(shoppingItems)
    .where(eq(shoppingItems.id, id))
    .returning({ id: shoppingItems.id });
  return rows.length > 0;
}

export async function countItemsInStates(
  ex: Executor,
  listId: string,
  states: readonly ShoppingItemState[],
): Promise<number> {
  const [row] = await ex
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(shoppingItems)
    .where(and(eq(shoppingItems.listId, listId), inArray(shoppingItems.state, [...states])));
  return row?.total ?? 0;
}

export async function deleteItemsInStates(
  ex: Executor,
  listId: string,
  states: readonly ShoppingItemState[],
): Promise<number> {
  const rows = await ex
    .delete(shoppingItems)
    .where(and(eq(shoppingItems.listId, listId), inArray(shoppingItems.state, [...states])))
    .returning({ id: shoppingItems.id });
  return rows.length;
}

export async function nextItemSortOrder(ex: Executor, listId: string): Promise<number> {
  const [row] = await ex
    .select({
      next: sql<number>`coalesce(max(${shoppingItems.sortOrder}), -1) + 1`.mapWith(Number),
    })
    .from(shoppingItems)
    .where(eq(shoppingItems.listId, listId));
  return row?.next ?? 0;
}

/**
 * Apply a whole ordering in one statement.
 *
 * A loop of UPDATEs would be N round trips and would leave the list visibly
 * half-reordered to a second reader mid-flight; a single CASE is atomic.
 */
export async function applyItemOrder(
  ex: Executor,
  listId: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;

  const branches = sql.join(
    ids.map((id, index) => sql`when ${shoppingItems.id} = ${id} then ${index}`),
    sql` `,
  );

  const rows = await ex
    .update(shoppingItems)
    .set({
      sortOrder: sql`case ${branches} else ${shoppingItems.sortOrder} end`,
      updatedAt: new Date(),
    })
    .where(and(eq(shoppingItems.listId, listId), inArray(shoppingItems.id, [...ids])))
    .returning({ id: shoppingItems.id });

  return rows.length;
}

/**
 * "Is somebody in the shop right now?"
 *
 * There is no presence system and there should not be one; a member who ticked
 * something off this list in the last few minutes is standing in the shop, and
 * that is the only signal an urgent-item notification needs (D10 — one pipeline,
 * no new tables for a heuristic).
 */
export async function findActiveShopper(
  ex: Executor,
  listId: string,
  options: { since: Date; excludeUserId: string },
): Promise<{ userId: string; boughtAt: Date } | undefined> {
  const [row] = await ex
    .select({ userId: shoppingItems.boughtById, boughtAt: shoppingItems.boughtAt })
    .from(shoppingItems)
    .where(
      and(
        eq(shoppingItems.listId, listId),
        eq(shoppingItems.state, 'bought'),
        gte(shoppingItems.boughtAt, options.since),
        ne(shoppingItems.boughtById, options.excludeUserId),
      ),
    )
    .orderBy(desc(shoppingItems.boughtAt))
    .limit(1);

  if (!row?.userId || !row.boughtAt) return undefined;
  return { userId: row.userId, boughtAt: row.boughtAt };
}

/* -------------------------------------------------------------------------- */
/* Product catalogue                                                           */
/* -------------------------------------------------------------------------- */

/** `product_catalog` is unique on `lower(name)`, so every lookup goes through it. */
function byNormalizedName(name: string) {
  return sql`lower(${productCatalog.name}) = ${name}`;
}

export async function findProductsByNames(
  ex: Executor,
  names: readonly string[],
): Promise<ProductCatalogRow[]> {
  if (names.length === 0) return [];
  return ex
    .select()
    .from(productCatalog)
    .where(inArray(sql`lower(${productCatalog.name})`, [...names]));
}

export async function findProductById(
  ex: Executor,
  id: string,
): Promise<ProductCatalogRow | undefined> {
  const [row] = await ex.select().from(productCatalog).where(eq(productCatalog.id, id)).limit(1);
  return row;
}

export interface TouchProductInput {
  /** Already normalised by `catalogKeyFor` — this is the unique key. */
  name: string;
  /** The aisle the family actually filed it under. `null` leaves the default alone. */
  category: string | null;
  unit: string | null;
  at: Date;
}

/**
 * Learn from an add or a purchase: bump `usage_count`, refresh `last_used_at`,
 * and remember the category and unit the family chose this time.
 *
 * UPDATE-then-INSERT rather than a single `ON CONFLICT DO UPDATE` because the
 * unique index is on the expression `lower(name)`, and Postgres will only infer
 * an expression index as the conflict arbiter from a matching expression, which
 * Drizzle's typed `target` cannot express. The retry covers the one race that
 * matters: two members adding the same brand-new product at the same instant.
 */
export async function touchProduct(
  ex: Executor,
  input: TouchProductInput,
): Promise<ProductCatalogRow> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [updated] = await ex
      .update(productCatalog)
      .set({
        usageCount: sql`${productCatalog.usageCount} + 1`,
        lastUsedAt: input.at,
        updatedAt: input.at,
        ...(input.category === null ? {} : { defaultCategory: input.category }),
        ...(input.unit === null ? {} : { defaultUnit: input.unit }),
      })
      .where(byNormalizedName(input.name))
      .returning();
    if (updated) return updated;

    const [inserted] = await ex
      .insert(productCatalog)
      .values({
        name: input.name,
        defaultCategory: input.category,
        defaultUnit: input.unit,
        usageCount: 1,
        lastUsedAt: input.at,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    // Lost the race — the row exists now; loop once more and take the UPDATE path.
  }

  throw new Error(`could not upsert product_catalog row for "${input.name}"`);
}

export async function updateProductRow(
  ex: Executor,
  id: string,
  patch: {
    defaultCategory?: string | null;
    defaultUnit?: string | null;
    isFavourite?: boolean;
  },
): Promise<ProductCatalogRow | undefined> {
  const [row] = await ex
    .update(productCatalog)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(productCatalog.id, id))
    .returning();
  return row;
}

/** `%` and `_` are wildcards in LIKE; a product called "100% сок" must not become one. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Autocomplete candidates, ordered the way the index is
 * (`is_favourite`, `usage_count`, `last_used_at`).
 *
 * Over-fetches on purpose: the service re-ranks exact/prefix/substring matches
 * in {@link ../shopping.service.js rankSuggestions}, which needs more than
 * `limit` candidates to have anything to rank.
 */
export async function suggestProducts(
  ex: Executor,
  options: { query?: string; limit: number },
): Promise<ProductCatalogRow[]> {
  const trimmed = options.query?.trim();
  const where =
    trimmed && trimmed.length > 0
      ? ilike(productCatalog.name, `%${escapeLike(trimmed)}%`)
      : undefined;

  return ex
    .select()
    .from(productCatalog)
    .where(where)
    .orderBy(
      desc(productCatalog.isFavourite),
      desc(productCatalog.usageCount),
      sql`${productCatalog.lastUsedAt} desc nulls last`,
      asc(productCatalog.name),
    )
    .limit(options.limit);
}

/**
 * "Frequently bought" — the one-tap re-add strip above the quick-add box.
 *
 * Favourites are *not* hoisted here: this list answers "what do we always buy",
 * and a pinned favourite would displace the honest answer.
 */
export async function findFrequentProducts(
  ex: Executor,
  options: { limit: number; since?: Date },
): Promise<ProductCatalogRow[]> {
  const where = options.since
    ? or(gte(productCatalog.lastUsedAt, options.since), eq(productCatalog.isFavourite, true))
    : undefined;

  return ex
    .select()
    .from(productCatalog)
    .where(where)
    .orderBy(
      desc(productCatalog.usageCount),
      sql`${productCatalog.lastUsedAt} desc nulls last`,
      asc(productCatalog.name),
    )
    .limit(options.limit);
}
