import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../../db/base.js';
import { users } from '../identity/users.schema.js';

/**
 * Shopping lists.
 *
 * Single tenant (D1): no `household_id`. Every list belongs to the one family;
 * `created_by_id` is authorship, not ownership, and never narrows visibility.
 *
 * Nothing here holds money: prices are explicitly out of scope for v1 (shared
 * expenses are deferred, D9). If a price column is ever added it must use
 * `money()` — integer minor units, never `numeric` (D6).
 */

export const shoppingItemState = pgEnum('shopping_item_state', ['needed', 'bought', 'cancelled']);

/** Multiple named lists: продукты, хозтовары, аптека, «в отпуск», … */
export const shoppingLists = pgTable(
  'shopping_lists',
  {
    id: primaryId(),

    name: text().notNull(),
    /** Lucide icon name, resolved on the client. */
    icon: text(),
    /** Hex accent for the list chip. */
    color: text(),

    isArchived: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),

    createdById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    ...timestamps(),
  },
  (t) => [
    index('shopping_lists_active_idx')
      .on(t.sortOrder, t.name)
      .where(sql`${t.isArchived} = false`),
  ],
);

export const shoppingItems = pgTable(
  'shopping_items',
  {
    id: primaryId(),

    listId: uuid()
      .notNull()
      .references(() => shoppingLists.id, { onDelete: 'cascade' }),

    name: text().notNull(),

    /**
     * Free-form amount ("1.5"). NOT money — a quantity of stuff, so `numeric`
     * is correct here and `money()` would be wrong. Nullable because "молоко"
     * with no number is the common case.
     */
    quantity: numeric({ precision: 10, scale: 3 }),
    /** шт, кг, л, упак — free text so the family invents its own. */
    unit: text(),
    /** Store-aisle grouping ("молочное", "бытовая химия"), seeded from `product_catalog`. */
    category: text(),

    note: text(),

    requestedById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    state: shoppingItemState().notNull().default('needed'),

    boughtById: uuid().references(() => users.id, { onDelete: 'set null' }),
    boughtAt: timestamp({ withTimezone: true }),

    isUrgent: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),

    /**
     * Offline-first de-duplication key (D7: this is an installed PWA and the
     * shop is exactly where the signal dies).
     *
     * The client generates a UUID **before** the optimistic insert and replays
     * the queued mutation on reconnect; the partial unique index below turns a
     * double-send into a `23505` that the service converts into "return the
     * existing row" — i.e. the create endpoint is idempotent. NULL for items
     * created server-side or from a client that did not supply one, which is
     * why the index is partial.
     */
    clientId: text(),

    ...timestamps(),
  },
  (t) => [
    index('shopping_items_list_state_idx').on(t.listId, t.state),
    /**
     * The active-list view: everything still to buy, urgent first. Partial so
     * the index stays tiny while bought history accumulates behind it.
     */
    index('shopping_items_active_idx')
      .on(t.listId, t.isUrgent.desc(), t.sortOrder, t.createdAt)
      .where(sql`${t.state} = 'needed'`),
    index('shopping_items_bought_idx')
      .on(t.boughtAt.desc())
      .where(sql`${t.state} = 'bought'`),
    uniqueIndex('shopping_items_client_id_uq')
      .on(t.clientId)
      .where(sql`${t.clientId} is not null`),
  ],
);

/**
 * The family's own product memory. Autocomplete, default unit and default aisle
 * come from what this family actually buys — there is **no external product
 * database** (D9 rejects banking/third-party integrations; an imported catalog
 * would be 100k rows of noise for a household that buys ~200 distinct things).
 *
 * Maintained by the shopping service on every item create/buy: upsert by
 * `lower(name)`, `usage_count = usage_count + 1`, `last_used_at = now()`.
 */
export const productCatalog = pgTable(
  'product_catalog',
  {
    id: primaryId(),

    /** Unique case-insensitively — "Молоко" and "молоко" are one product. */
    name: text().notNull(),

    defaultCategory: text(),
    defaultUnit: text(),

    usageCount: integer().notNull().default(0),
    lastUsedAt: timestamp({ withTimezone: true }),

    /** Pinned to the top of quick-add regardless of `usage_count`. */
    isFavourite: boolean().notNull().default(false),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex('product_catalog_name_lower_uq').on(sql`lower(${t.name})`),
    /** Suggestion ranking: favourites, then most used, then most recent. */
    index('product_catalog_suggest_idx').on(
      t.isFavourite.desc(),
      t.usageCount.desc(),
      t.lastUsedAt.desc(),
    ),
  ],
);

export type ShoppingListRow = typeof shoppingLists.$inferSelect;
export type NewShoppingListRow = typeof shoppingLists.$inferInsert;
export type ShoppingItemRow = typeof shoppingItems.$inferSelect;
export type NewShoppingItemRow = typeof shoppingItems.$inferInsert;
export type ProductCatalogRow = typeof productCatalog.$inferSelect;
export type NewProductCatalogRow = typeof productCatalog.$inferInsert;
