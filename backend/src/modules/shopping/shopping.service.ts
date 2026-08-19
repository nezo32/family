import type {
  BulkAddItems,
  BulkAddItemsResponse,
  ClearBoughtItems,
  CreateShoppingItem,
  CreateShoppingList,
  ListShoppingItemsQuery,
  ListShoppingListsQuery,
  ProductSuggestion,
  ProductSuggestQuery,
  ReorderShoppingItems,
  ShoppingItemListResponse,
  ShoppingItemResponse,
  ShoppingListResponse,
  ToggleItem,
  UpdateProduct,
  UpdateShoppingItem,
  UpdateShoppingList,
} from '@family/shared';
import { catalogKeyFor, normalizeProductName, parseQuickAddText } from '@family/shared';

import type { Db, Executor } from '../../core/db.js';
import { assertFound, badRequest, internal, notFound } from '../../core/errors.js';
import { emit } from '../notifications/notifications.service.js';
import * as repo from './shopping.repository.js';
import type {
  NewShoppingItemRow,
  ProductCatalogRow,
  ShoppingItemRow,
  ShoppingListRow,
} from './shopping.schema.js';

/**
 * Shopping business rules. No HTTP knowledge (D8).
 *
 * Permissions are declared on the routes (`shopping:read` / `shopping:write`
 * for items — children hold both — and `shopping:list:manage` to create,
 * archive or delete a whole list). The service is single-tenant by
 * construction (D1): there is no visibility narrowing to apply, so a caller who
 * got past the guard may act on every list.
 *
 * The one thing this file exists to get right is **replay safety**. Every
 * mutation here is written on the assumption that it will arrive twice: once
 * optimistically from a phone in a shop basement, and again when the outbox
 * drains twenty minutes later.
 */

/* -------------------------------------------------------------------------- */
/* Pure helpers — no database, so they are unit-testable without Postgres      */
/* -------------------------------------------------------------------------- */

/**
 * How long after a purchase we still consider someone to be "in the shop".
 *
 * Long enough to cover a slow trip round a supermarket, short enough that
 * yesterday's shopper is not pinged about today's urgent item.
 */
export const ACTIVE_TRIP_WINDOW_MINUTES = 60;

export type ToggleAction = 'buy' | 'revert' | 'noop';

/**
 * Decides what a toggle should actually do — the heart of offline correctness.
 *
 * Three rules, in order:
 *
 * 1. **Idempotent.** Buying something already bought, or un-buying something
 *    that is not bought, changes nothing. An outbox that replays the same tap
 *    must not re-stamp `bought_at` with a later time or overwrite the buyer.
 * 2. **`bought` beats `needed` on a tie.** Two people in two aisles is the
 *    common case and "we already have it" is the safe resolution
 *    (`docs/architecture/household.md` §4.6).
 * 3. **Last write wins on state**, judged by the client's `occurredAt` rather
 *    than by packet arrival order — an un-tick that happened *before* the
 *    purchase it is racing is stale and loses.
 */
export function resolveToggle(
  current: { state: ShoppingItemRow['state']; boughtAt: Date | null },
  incoming: { bought: boolean; occurredAt: Date },
): ToggleAction {
  if (incoming.bought) {
    return current.state === 'bought' ? 'noop' : 'buy';
  }
  if (current.state !== 'bought') return 'noop';
  if (current.boughtAt && incoming.occurredAt.getTime() < current.boughtAt.getTime()) {
    // A stale un-tick from a queue that drained late. The purchase is newer.
    return 'noop';
  }
  return 'revert';
}

/** Is a purchase recent enough to mean "somebody is shopping right now"? */
export function isActiveTrip(lastBoughtAt: Date | null | undefined, now: Date): boolean {
  if (!lastBoughtAt) return false;
  const elapsedMinutes = (now.getTime() - lastBoughtAt.getTime()) / 60_000;
  return elapsedMinutes >= 0 && elapsedMinutes <= ACTIVE_TRIP_WINDOW_MINUTES;
}

type RankableSuggestion = Pick<
  ProductSuggestion,
  'name' | 'usageCount' | 'lastUsedAt' | 'isFavourite'
>;

/**
 * Re-ranks autocomplete candidates around what the user has typed so far.
 *
 * SQL orders by favourite / usage / recency, which is right for an empty box
 * but wrong once there is a prefix: after typing "мол" the family expects
 * «молоко» first, not the 40-times-bought «масло» that merely contains "мол"
 * nowhere. Match quality dominates; popularity breaks ties.
 */
export function rankSuggestions<T extends RankableSuggestion>(
  items: readonly T[],
  query: string,
  limit: number,
): T[] {
  const needle = normalizeProductName(query);

  const matchRank = (name: string): number => {
    if (needle.length === 0) return 0;
    const candidate = normalizeProductName(name);
    if (candidate === needle) return 0;
    if (candidate.startsWith(needle)) return 1;
    if (candidate.includes(` ${needle}`)) return 2;
    if (candidate.includes(needle)) return 3;
    return 4;
  };

  return [...items]
    .sort((a, b) => {
      const byMatch = matchRank(a.name) - matchRank(b.name);
      if (byMatch !== 0) return byMatch;
      if (a.isFavourite !== b.isFavourite) return a.isFavourite ? -1 : 1;
      if (a.usageCount !== b.usageCount) return b.usageCount - a.usageCount;
      const aUsed = a.lastUsedAt ?? '';
      const bUsed = b.lastUsedAt ?? '';
      if (aUsed !== bUsed) return bUsed.localeCompare(aUsed);
      return a.name.localeCompare(b.name, 'ru');
    })
    .slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Row -> wire mapping                                                         */
/* -------------------------------------------------------------------------- */

export function toListResponse(
  row: ShoppingListRow & { neededCount?: number; totalCount?: number },
): ShoppingListResponse {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    isArchived: row.isArchived,
    sortOrder: row.sortOrder,
    createdById: row.createdById,
    neededCount: row.neededCount ?? 0,
    totalCount: row.totalCount ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toItemResponse(row: ShoppingItemRow): ShoppingItemResponse {
  return {
    id: row.id,
    listId: row.listId,
    name: row.name,
    // `numeric` round-trips through the driver as a string; the wire contract
    // is a number. This is a count of stuff, never money (D6), so it is safe.
    quantity: row.quantity === null ? null : Number(row.quantity),
    unit: row.unit,
    category: row.category,
    note: row.note,
    requestedById: row.requestedById,
    state: row.state,
    boughtById: row.boughtById,
    boughtAt: row.boughtAt ? row.boughtAt.toISOString() : null,
    isUrgent: row.isUrgent,
    sortOrder: row.sortOrder,
    clientId: row.clientId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProductSuggestion(row: ProductCatalogRow): ProductSuggestion {
  return {
    id: row.id,
    name: row.name,
    defaultCategory: row.defaultCategory,
    defaultUnit: row.defaultUnit,
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    isFavourite: row.isFavourite,
  };
}

/* -------------------------------------------------------------------------- */
/* Cursors                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Item paging is keyset, and the codec lives with the ordering it encodes:
 * `repo.encodeItemCursor` / `repo.decodeItemCursor`, both built on
 * `core/pagination.ts`.
 *
 * It used to be an **offset**, on the argument that "the ordering is fully
 * deterministic, so an offset is stable between pages". The ordering is; the
 * rows are not. Anyone ticking an item off while you scroll moves it across the
 * `state <> 'needed'` boundary, every row after it shifts by one, and page two
 * skips whatever slid into the gap — or repeats a row, when an item is added.
 * Two phones on one list in a shop is what this feature is *for*, so that was
 * the normal case, not an edge case.
 *
 * A malformed or stale cursor no longer 400s either; it starts from the top,
 * like every other list endpoint (see `core/pagination.ts`).
 */

/* -------------------------------------------------------------------------- */
/* Notifications                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Who is acting. The display name travels with the id because notification
 * intents denormalise everything the renderer needs at *send* time — a deferred
 * delivery must not have to re-read a row that may since have changed (D10).
 */
export interface ShoppingActor {
  id: string;
  displayName: string;
}

export interface UrgentItemNotification {
  actorId: string;
  actorName: string;
  shopperId: string;
  listId: string;
  listName: string;
  itemId: string;
  itemName: string;
  quantity: number | null;
  unit: string | null;
}

/**
 * Hands a `shopping_urgent_item` event to the notification pipeline
 * (D10 — one pipeline, no bespoke channel per feature).
 *
 * **The audience is the one person standing in the shop.** This used to write
 * the intent row by hand and leave `audience` unset; the column defaults to
 * `{}`, which the fan-out reads as `{ everyone: true }`. The intended recipient
 * was recorded as `payload.recipientId`, a field nothing has ever read — so
 * «молоко срочно» fired a `high`-priority push, with its 30-minute D11
 * escalation ladder, at every member holding `shopping:read`.
 *
 * `emit` runs outside a transaction on purpose: the item is already committed
 * by the time we get here, and the dedupe key (`shopping_urgent_item:<itemId>`)
 * collapses a replayed offline mutation into a single intent and a single job.
 */
export async function emitUrgentItemIntent(db: Db, input: UrgentItemNotification): Promise<void> {
  await emit(db, {
    type: 'shopping_urgent_item',
    audience: { users: [input.shopperId] },
    actorId: input.actorId,
    entityType: 'shopping_item',
    entityId: input.itemId,
    payload: {
      listId: input.listId,
      listName: input.listName,
      itemId: input.itemId,
      itemName: input.itemName,
      quantity: input.quantity,
      unit: input.unit,
      actorName: input.actorName,
    },
    dedupeKey: `shopping_urgent_item:${input.itemId}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export interface ShoppingServiceDeps {
  /** Injectable clock so tests do not have to sleep. */
  now?: () => Date;
  /** Injectable notification sink; the default emits a `shopping_urgent_item` intent. */
  notifyUrgentItem?: (input: UrgentItemNotification) => Promise<void>;
}

/** A single item on its way into the database, with catalogue defaults resolved. */
interface ItemDraft {
  name: string;
  quantity: number | null;
  unit: string | null;
  category: string | null;
  note: string | null;
  isUrgent: boolean;
  sortOrder: number | undefined;
  clientId: string | null;
  /** `product_catalog` key derived from the name (and whether it carried a quantity). */
  catalogKey: string;
}

export class ShoppingService {
  constructor(
    private readonly db: Db,
    private readonly deps: ShoppingServiceDeps = {},
  ) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /* ------------------------------- lists -------------------------------- */

  async listLists(query: ListShoppingListsQuery): Promise<ShoppingListResponse[]> {
    const rows = await repo.findLists(this.db, { includeArchived: query.includeArchived });
    return rows.map(toListResponse);
  }

  async createList(actor: ShoppingActor, input: CreateShoppingList): Promise<ShoppingListResponse> {
    const sortOrder = input.sortOrder ?? (await repo.nextListSortOrder(this.db));
    const row = await repo.insertList(this.db, {
      name: input.name,
      icon: input.icon ?? null,
      color: input.color ?? null,
      sortOrder,
      createdById: actor.id,
    });
    return toListResponse(row);
  }

  async updateList(id: string, input: UpdateShoppingList): Promise<ShoppingListResponse> {
    const patch: Partial<ShoppingListRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.icon !== undefined) patch.icon = input.icon ?? null;
    if (input.color !== undefined) patch.color = input.color ?? null;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (input.isArchived !== undefined) patch.isArchived = input.isArchived;

    const updated = assertFound(await repo.updateListRow(this.db, id, patch), 'Shopping list');
    const withCounts = await repo.findListById(this.db, updated.id);
    return toListResponse(withCounts ?? updated);
  }

  async deleteList(id: string): Promise<void> {
    // Items go with it — `shopping_items.list_id` cascades.
    if (!(await repo.deleteListRow(this.db, id))) throw notFound('Shopping list');
  }

  /* ------------------------------- items -------------------------------- */

  async listItems(
    listId: string,
    query: ListShoppingItemsQuery,
  ): Promise<ShoppingItemListResponse> {
    await this.assertListExists(listId);

    const rows = await repo.findItems(this.db, listId, {
      states: query.state,
      category: query.category,
      groupByCategory: query.groupByCategory,
      // One extra row is the cheapest possible "is there a next page?".
      limit: query.limit + 1,
      cursor: repo.decodeItemCursor(query.cursor),
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toItemResponse),
      nextCursor: rows.length > query.limit && last ? repo.encodeItemCursor(last) : null,
    };
  }

  /**
   * Add one item. **Idempotent when the caller supplies a `clientId`.**
   *
   * Returns `created: false` for a replay so the route can answer `200` rather
   * than `201` and the client knows its optimistic row was already accepted.
   */
  async addItem(
    actor: ShoppingActor,
    listId: string,
    input: CreateShoppingItem,
  ): Promise<{ item: ShoppingItemResponse; created: boolean }> {
    await this.assertListExists(listId);
    const at = this.now();

    const outcome = await this.db.transaction(async (tx) => {
      const [draft] = await this.prepareDrafts(tx, listId, [
        {
          name: input.name,
          quantity: input.quantity ?? null,
          unit: input.unit ?? null,
          category: input.category ?? null,
          note: input.note ?? null,
          isUrgent: input.isUrgent,
          sortOrder: input.sortOrder,
          clientId: input.clientId ?? null,
        },
      ]);
      if (!draft) throw internal('prepareDrafts returned nothing for a single item');

      const [created] = await repo.insertItemsIdempotent(tx, [
        toInsertValues(draft, listId, actor.id),
      ]);

      if (created) {
        await this.learn(tx, created, draft.catalogKey, at);
        return { item: created, created: true };
      }

      // Nothing inserted => the partial unique index on `client_id` fired, so
      // this is a replay of a mutation we already accepted. Hand back the row
      // the first delivery created (household.md §4.4).
      const clientId = draft.clientId;
      if (!clientId) {
        throw internal('shopping_items insert was skipped without a clientId conflict');
      }
      const [existing] = await repo.findItemsByClientIds(tx, [clientId]);
      if (!existing) throw internal('clientId conflict resolved to no row');
      return { item: existing, created: false };
    });

    if (outcome.created && outcome.item.isUrgent) {
      await this.announceUrgentItem(actor, outcome.item, at);
    }

    return { item: toItemResponse(outcome.item), created: outcome.created };
  }

  /**
   * Quick entry: the whole list in one text box, or a client-parsed batch.
   *
   * Replays are handled exactly as in {@link addItem} — anything whose
   * `clientId` already exists comes back under `duplicates` instead of being
   * inserted a second time.
   */
  async bulkAdd(
    actor: ShoppingActor,
    listId: string,
    input: BulkAddItems,
  ): Promise<BulkAddItemsResponse> {
    await this.assertListExists(listId);
    const at = this.now();

    const requested = input.text
      ? parseQuickAddText(input.text, { limit: 100 }).map<Omit<ItemDraft, 'catalogKey'>>(
          (parsed) => ({
            name: parsed.name,
            quantity: parsed.quantity,
            unit: parsed.unit,
            category: null,
            note: null,
            isUrgent: parsed.isUrgent,
            sortOrder: undefined,
            clientId: null,
          }),
        )
      : (input.items ?? []).map<Omit<ItemDraft, 'catalogKey'>>((item) => ({
          name: item.name,
          quantity: item.quantity ?? null,
          unit: item.unit ?? null,
          category: item.category ?? null,
          note: item.note ?? null,
          isUrgent: item.isUrgent ?? false,
          sortOrder: item.sortOrder,
          clientId: item.clientId ?? null,
        }));

    if (requested.length === 0) {
      throw badRequest('Quick-add text contained no parseable items');
    }

    // `ON CONFLICT DO NOTHING` cannot arbitrate between two rows of the same
    // INSERT, so collapse repeated clientIds before they reach Postgres.
    const seen = new Set<string>();
    const candidates = requested.filter((draft) => {
      if (!draft.clientId) return true;
      if (seen.has(draft.clientId)) return false;
      seen.add(draft.clientId);
      return true;
    });

    const outcome = await this.db.transaction(async (tx) => {
      const drafts = await this.prepareDrafts(tx, listId, candidates);
      const created = await repo.insertItemsIdempotent(
        tx,
        drafts.map((draft) => toInsertValues(draft, listId, actor.id)),
      );

      const keyByClientId = new Map<string, string>(
        drafts.flatMap((d) => (d.clientId === null ? [] : [[d.clientId, d.catalogKey] as const])),
      );
      const keyForRow = (row: ShoppingItemRow): string =>
        (row.clientId === null ? undefined : keyByClientId.get(row.clientId)) ??
        catalogKeyFor(row.name, row.quantity !== null || row.unit !== null);

      for (const row of created) {
        await this.learn(tx, row, keyForRow(row), at);
      }

      const createdClientIds = new Set(
        created.map((row) => row.clientId).filter((id): id is string => id !== null),
      );
      const replayed = [...seen].filter((clientId) => !createdClientIds.has(clientId));
      const duplicates = await repo.findItemsByClientIds(tx, replayed);

      return { created, duplicates };
    });

    for (const row of outcome.created) {
      if (row.isUrgent) await this.announceUrgentItem(actor, row, at);
    }

    return {
      created: outcome.created.map(toItemResponse),
      duplicates: outcome.duplicates.map(toItemResponse),
    };
  }

  async updateItem(
    actor: ShoppingActor,
    id: string,
    input: UpdateShoppingItem,
  ): Promise<ShoppingItemResponse> {
    const existing = assertFound(await repo.findItemById(this.db, id), 'Shopping item');
    if (input.listId !== undefined && input.listId !== existing.listId) {
      await this.assertListExists(input.listId);
    }
    const at = this.now();

    const patch: Partial<NewShoppingItemRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.quantity !== undefined) {
      patch.quantity = input.quantity === null ? null : String(input.quantity);
    }
    if (input.unit !== undefined) patch.unit = input.unit ?? null;
    if (input.category !== undefined) patch.category = input.category ?? null;
    if (input.note !== undefined) patch.note = input.note ?? null;
    if (input.isUrgent !== undefined) patch.isUrgent = input.isUrgent;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (input.listId !== undefined) patch.listId = input.listId;

    if (input.state !== undefined && input.state !== existing.state) {
      patch.state = input.state;
      if (input.state === 'bought') {
        patch.boughtById = actor.id;
        patch.boughtAt = at;
      } else {
        patch.boughtById = null;
        patch.boughtAt = null;
      }
    }

    const updated = await this.db.transaction(async (tx) => {
      const row = assertFound(await repo.updateItemRow(tx, id, patch), 'Shopping item');
      // A rename teaches the catalogue a new product; everything else the user
      // corrects (unit, aisle) refines the one it already knows.
      if (patch.name !== undefined && patch.name !== existing.name) {
        await this.learn(tx, row, catalogKeyFor(row.name, row.quantity !== null || !!row.unit), at);
      }
      return row;
    });

    if (updated.isUrgent && !existing.isUrgent) {
      await this.announceUrgentItem(actor, updated, at);
    }

    return toItemResponse(updated);
  }

  /**
   * The one-tap aisle action.
   *
   * `clientId` on the request body is accepted and intentionally unused: the
   * `state` guard in {@link repo.markItemBought} already makes the write
   * idempotent, so a replayed toggle needs no separate dedupe key. `occurredAt`
   * *is* used — a tap queued in a basement must record when the tap happened,
   * not when the packet finally landed.
   */
  async toggleItem(
    actor: ShoppingActor,
    id: string,
    input: ToggleItem,
  ): Promise<ShoppingItemResponse> {
    const existing = assertFound(await repo.findItemById(this.db, id), 'Shopping item');
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : this.now();

    const action = resolveToggle(
      { state: existing.state, boughtAt: existing.boughtAt },
      { bought: input.bought, occurredAt },
    );
    if (action === 'noop') return toItemResponse(existing);

    if (action === 'revert') {
      const reverted = await repo.markItemNeeded(this.db, id);
      return toItemResponse(reverted ?? existing);
    }

    const bought = await this.db.transaction(async (tx) => {
      const row = await repo.markItemBought(tx, id, { userId: actor.id, occurredAt });
      if (!row) return undefined; // somebody else got there first — their write stands
      await this.learn(
        tx,
        row,
        catalogKeyFor(row.name, row.quantity !== null || !!row.unit),
        occurredAt,
      );
      return row;
    });

    if (bought) return toItemResponse(bought);
    return toItemResponse(assertFound(await repo.findItemById(this.db, id), 'Shopping item'));
  }

  async deleteItem(id: string): Promise<void> {
    if (!(await repo.deleteItemRow(this.db, id))) throw notFound('Shopping item');
  }

  /** Clears the bought/cancelled tail. Dry run unless `confirm` is set. */
  async clearBought(
    listId: string,
    input: ClearBoughtItems,
  ): Promise<{ matched: number; removed: number }> {
    await this.assertListExists(listId);
    const states = ['bought', 'cancelled'] as const;

    const matched = await repo.countItemsInStates(this.db, listId, states);
    if (!input.confirm) return { matched, removed: 0 };

    const removed = await repo.deleteItemsInStates(this.db, listId, states);
    return { matched, removed };
  }

  async reorderItems(listId: string, input: ReorderShoppingItems): Promise<{ updated: number }> {
    await this.assertListExists(listId);
    return { updated: await repo.applyItemOrder(this.db, listId, input.ids) };
  }

  /* ---------------------------- product catalogue ---------------------------- */

  async suggestProducts(query: ProductSuggestQuery): Promise<ProductSuggestion[]> {
    const needle = query.q ? normalizeProductName(query.q) : '';
    const rows = await repo.suggestProducts(this.db, {
      query: needle.length > 0 ? needle : undefined,
      // Over-fetch so `rankSuggestions` has candidates to promote.
      limit: Math.min(query.limit * 4, 100),
    });
    return rankSuggestions(rows.map(toProductSuggestion), needle, query.limit);
  }

  /** "Frequently bought" — the one-tap re-add strip. Learned from us, nobody else. */
  async frequentProducts(limit: number): Promise<ProductSuggestion[]> {
    const rows = await repo.findFrequentProducts(this.db, { limit });
    return rows.map(toProductSuggestion);
  }

  async updateProduct(id: string, input: UpdateProduct): Promise<ProductSuggestion> {
    const patch: Parameters<typeof repo.updateProductRow>[2] = {};
    if (input.defaultCategory !== undefined) patch.defaultCategory = input.defaultCategory ?? null;
    if (input.defaultUnit !== undefined) patch.defaultUnit = input.defaultUnit ?? null;
    if (input.isFavourite !== undefined) patch.isFavourite = input.isFavourite;

    const row = assertFound(await repo.updateProductRow(this.db, id, patch), 'Product');
    return toProductSuggestion(row);
  }

  /* -------------------------------- internals -------------------------------- */

  private async assertListExists(listId: string): Promise<void> {
    if (!(await repo.listExists(this.db, listId))) throw notFound('Shopping list');
  }

  /**
   * Resolves catalogue defaults and sort order for a batch of items in **two**
   * queries regardless of batch size — one to read the catalogue, one to read
   * the current tail of the list.
   */
  private async prepareDrafts(
    ex: Executor,
    listId: string,
    drafts: readonly Omit<ItemDraft, 'catalogKey'>[],
  ): Promise<ItemDraft[]> {
    const keyed = drafts.map((draft) => ({
      ...draft,
      catalogKey: catalogKeyFor(draft.name, draft.quantity !== null || draft.unit !== null),
    }));

    const products = await repo.findProductsByNames(ex, [
      ...new Set(keyed.map((d) => d.catalogKey)),
    ]);
    const byKey = new Map(products.map((p) => [normalizeProductName(p.name), p]));

    let nextOrder = await repo.nextItemSortOrder(ex, listId);

    return keyed.map((draft) => {
      const known = byKey.get(draft.catalogKey);
      const sortOrder = draft.sortOrder ?? nextOrder;
      if (draft.sortOrder === undefined) nextOrder += 1;
      return {
        ...draft,
        // The family's own history fills the blanks; an explicit value always wins.
        unit: draft.unit ?? known?.defaultUnit ?? null,
        category: draft.category ?? known?.defaultCategory ?? null,
        sortOrder,
      };
    });
  }

  /**
   * `product_catalog` learning (household.md §4).
   *
   * Called only on a *real* state change — a created row or an actual purchase
   * — so a replayed offline mutation cannot inflate `usage_count`. The category
   * written back is the one the family actually filed the item under, which is
   * how the aisle defaults get better over time without anyone maintaining them.
   */
  private async learn(
    ex: Executor,
    row: ShoppingItemRow,
    catalogKey: string,
    at: Date,
  ): Promise<void> {
    if (catalogKey.length === 0) return;
    await repo.touchProduct(ex, {
      name: catalogKey,
      category: row.category,
      unit: row.unit,
      at,
    });
  }

  /**
   * An urgent item added while somebody is mid-trip is the whole point of the
   * feature: «купи ещё хлеб!» has to reach the person standing in the shop.
   *
   * If nobody is shopping there is nothing time-critical to interrupt, and the
   * item will simply be on the list when they go — so we stay silent rather
   * than training the family to ignore notifications.
   */
  private async announceUrgentItem(
    actor: ShoppingActor,
    item: ShoppingItemRow,
    at: Date,
  ): Promise<void> {
    try {
      const since = new Date(at.getTime() - ACTIVE_TRIP_WINDOW_MINUTES * 60_000);
      const shopper = await repo.findActiveShopper(this.db, item.listId, {
        since,
        excludeUserId: actor.id,
      });
      if (!shopper || !isActiveTrip(shopper.boughtAt, at)) return;

      const list = await repo.findListById(this.db, item.listId);

      const notify =
        this.deps.notifyUrgentItem ?? ((input) => emitUrgentItemIntent(this.db, input));

      await notify({
        actorId: actor.id,
        actorName: actor.displayName,
        shopperId: shopper.userId,
        listId: item.listId,
        listName: list?.name ?? '',
        itemId: item.id,
        itemName: item.name,
        quantity: item.quantity === null ? null : Number(item.quantity),
        unit: item.unit,
      });
    } catch {
      // Best effort by design: a notification outage must never make an add
      // fail. The item is on the list, which is the part that matters.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function toInsertValues(draft: ItemDraft, listId: string, actorId: string): NewShoppingItemRow {
  return {
    listId,
    name: draft.name,
    quantity: draft.quantity === null ? null : String(draft.quantity),
    unit: draft.unit,
    category: draft.category,
    note: draft.note,
    requestedById: actorId,
    isUrgent: draft.isUrgent,
    sortOrder: draft.sortOrder ?? 0,
    clientId: draft.clientId,
  };
}
