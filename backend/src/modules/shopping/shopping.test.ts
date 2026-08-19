import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '../../core/db.js';
import { users } from '../identity/users.schema.js';
import {
  ACTIVE_TRIP_WINDOW_MINUTES,
  isActiveTrip,
  rankSuggestions,
  resolveToggle,
  toItemResponse,
  toListResponse,
  ShoppingService,
  type ShoppingActor,
  type UrgentItemNotification,
} from './shopping.service.js';
import { productCatalog, shoppingItems, shoppingLists } from './shopping.schema.js';
import type { ShoppingItemRow, ShoppingListRow } from './shopping.schema.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const T0 = new Date('2026-08-19T12:00:00.000Z');

function itemRow(overrides: Partial<ShoppingItemRow> = {}): ShoppingItemRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    listId: '00000000-0000-4000-8000-0000000000aa',
    name: 'Молоко',
    quantity: '2.000',
    unit: 'л',
    category: 'молочное',
    note: null,
    requestedById: '00000000-0000-4000-8000-0000000000bb',
    state: 'needed',
    boughtById: null,
    boughtAt: null,
    isUrgent: false,
    sortOrder: 0,
    clientId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function listRow(overrides: Partial<ShoppingListRow> = {}): ShoppingListRow {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    name: 'Продукты',
    icon: null,
    color: null,
    isArchived: false,
    sortOrder: 0,
    createdById: '00000000-0000-4000-8000-0000000000bb',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Offline correctness — pure, so it runs everywhere                           */
/* -------------------------------------------------------------------------- */

describe('resolveToggle', () => {
  it('buys an item that is still needed', () => {
    expect(
      resolveToggle({ state: 'needed', boughtAt: null }, { bought: true, occurredAt: T0 }),
    ).toBe('buy');
  });

  it('is a no-op when the same purchase is replayed', () => {
    // The offline outbox delivers the same tap twice, ten minutes apart.
    const replayedAt = new Date(T0.getTime() + 10 * 60_000);
    expect(
      resolveToggle({ state: 'bought', boughtAt: T0 }, { bought: true, occurredAt: replayedAt }),
    ).toBe('noop');
  });

  it('reverts a purchase when the un-tick is the newer event', () => {
    const later = new Date(T0.getTime() + 60_000);
    expect(
      resolveToggle({ state: 'bought', boughtAt: T0 }, { bought: false, occurredAt: later }),
    ).toBe('revert');
  });

  it('keeps `bought` when a stale un-tick arrives after the purchase', () => {
    // Two people, two aisles: an un-tick that *happened* before the purchase
    // must not undo it, however late its packet lands. bought > needed.
    const earlier = new Date(T0.getTime() - 60_000);
    expect(
      resolveToggle({ state: 'bought', boughtAt: T0 }, { bought: false, occurredAt: earlier }),
    ).toBe('noop');
  });

  it('keeps `bought` on an exact timestamp tie', () => {
    expect(
      resolveToggle({ state: 'bought', boughtAt: T0 }, { bought: false, occurredAt: T0 }),
    ).toBe('revert');
  });

  it('is a no-op when un-ticking something that is not bought', () => {
    expect(
      resolveToggle({ state: 'needed', boughtAt: null }, { bought: false, occurredAt: T0 }),
    ).toBe('noop');
  });

  it('buys a cancelled item rather than ignoring it', () => {
    expect(
      resolveToggle({ state: 'cancelled', boughtAt: null }, { bought: true, occurredAt: T0 }),
    ).toBe('buy');
  });

  it('converges no matter how many times the queue replays a tap', () => {
    let state: ShoppingItemRow['state'] = 'needed';
    let boughtAt: Date | null = null;
    for (let i = 0; i < 5; i += 1) {
      const action = resolveToggle({ state, boughtAt }, { bought: true, occurredAt: T0 });
      if (action === 'buy') {
        state = 'bought';
        boughtAt = T0;
      }
      // Every replay after the first must decide to do nothing at all.
      if (i > 0) expect(action).toBe('noop');
    }
    expect({ state, boughtAt }).toEqual({ state: 'bought', boughtAt: T0 });
  });
});

describe('isActiveTrip', () => {
  it('treats a purchase inside the window as somebody shopping now', () => {
    expect(isActiveTrip(new Date(T0.getTime() - 5 * 60_000), T0)).toBe(true);
  });

  it('treats an older purchase as a finished trip', () => {
    const stale = new Date(T0.getTime() - (ACTIVE_TRIP_WINDOW_MINUTES + 1) * 60_000);
    expect(isActiveTrip(stale, T0)).toBe(false);
  });

  it('never fires without a purchase', () => {
    expect(isActiveTrip(null, T0)).toBe(false);
    expect(isActiveTrip(undefined, T0)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Suggestion ranking                                                          */
/* -------------------------------------------------------------------------- */

interface Suggestion {
  name: string;
  usageCount: number;
  lastUsedAt: string | null;
  isFavourite: boolean;
}

const suggestion = (
  name: string,
  usageCount: number,
  extra: Partial<Suggestion> = {},
): Suggestion => ({
  name,
  usageCount,
  lastUsedAt: null,
  isFavourite: false,
  ...extra,
});

describe('rankSuggestions', () => {
  it('ranks by usage when nothing has been typed yet', () => {
    const ranked = rankSuggestions(
      [suggestion('хлеб', 3), suggestion('молоко', 40), suggestion('сыр', 12)],
      '',
      10,
    );
    expect(ranked.map((s) => s.name)).toEqual(['молоко', 'сыр', 'хлеб']);
  });

  it('puts match quality ahead of popularity', () => {
    // «масло» is bought far more often, but the user typed a «мол» prefix.
    const ranked = rankSuggestions([suggestion('масло', 90), suggestion('молоко', 5)], 'мол', 10);
    expect(ranked[0]?.name).toBe('молоко');
  });

  it('prefers an exact match, then a prefix, then a substring', () => {
    const ranked = rankSuggestions(
      [suggestion('сгущённое молоко', 50), suggestion('молоко козье', 1), suggestion('молоко', 1)],
      'молоко',
      10,
    );
    expect(ranked.map((s) => s.name)).toEqual(['молоко', 'молоко козье', 'сгущённое молоко']);
  });

  it('hoists favourites above equally-matching products', () => {
    const ranked = rankSuggestions(
      [suggestion('молоко', 40), suggestion('молочный шоколад', 1, { isFavourite: true })],
      'мол',
      10,
    );
    expect(ranked[0]?.name).toBe('молочный шоколад');
  });

  it('breaks a usage tie with the most recently used', () => {
    const ranked = rankSuggestions(
      [
        suggestion('сыр', 5, { lastUsedAt: '2026-01-01T00:00:00.000Z' }),
        suggestion('сок', 5, { lastUsedAt: '2026-08-01T00:00:00.000Z' }),
      ],
      '',
      10,
    );
    expect(ranked[0]?.name).toBe('сок');
  });

  it('honours the limit', () => {
    const ranked = rankSuggestions(
      [suggestion('a', 1), suggestion('b', 2), suggestion('c', 3)],
      '',
      2,
    );
    expect(ranked).toHaveLength(2);
  });

  it('folds ё and case, so «мёд» is found by typing «Мед»', () => {
    const ranked = rankSuggestions([suggestion('сыр', 90), suggestion('мёд', 1)], 'Мед', 10);
    expect(ranked[0]?.name).toBe('мёд');
  });
});

/* -------------------------------------------------------------------------- */
/* Wire mapping                                                                */
/* -------------------------------------------------------------------------- */

describe('response mapping', () => {
  it('turns the numeric quantity string into a number', () => {
    // `numeric` comes back from the driver as a string; the contract says number.
    expect(toItemResponse(itemRow({ quantity: '1.500' })).quantity).toBe(1.5);
    expect(toItemResponse(itemRow({ quantity: null })).quantity).toBeNull();
  });

  it('serialises timestamps as ISO instants and echoes the clientId back', () => {
    const clientId = randomUUID();
    const response = toItemResponse(itemRow({ clientId, boughtAt: T0, state: 'bought' }));
    expect(response.boughtAt).toBe('2026-08-19T12:00:00.000Z');
    expect(response.createdAt).toBe('2026-08-19T12:00:00.000Z');
    // The offline client reconciles its optimistic row by this field.
    expect(response.clientId).toBe(clientId);
  });

  it('defaults list counters to zero for a freshly created list', () => {
    expect(toListResponse(listRow())).toMatchObject({ neededCount: 0, totalCount: 0 });
  });
});

/* -------------------------------------------------------------------------- */
/* Integration — needs a migrated Postgres                                     */
/* -------------------------------------------------------------------------- */

/**
 * Run with `TEST_DATABASE_URL=postgres://… pnpm --filter @family/backend test`
 * against a database that has the migrations applied. Skipped otherwise so
 * `pnpm test` stays runnable without Docker.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('ShoppingService against Postgres', () => {
  let db: Db;
  let close: () => Promise<void>;
  let service: ShoppingService;
  let actor: ShoppingActor;
  let shopper: ShoppingActor;
  let listId: string;
  const notified: UrgentItemNotification[] = [];

  beforeAll(async () => {
    const { createDbClient } = await import('../../core/db.js');
    const created = createDbClient(TEST_DATABASE_URL);
    db = created.db;
    close = async () => {
      await created.sql.end({ timeout: 5 });
    };

    const [requester] = await db
      .insert(users)
      .values({ displayName: 'Тест-родитель', role: 'adult', status: 'active' })
      .returning();
    const [buyer] = await db
      .insert(users)
      .values({ displayName: 'Тест-покупатель', role: 'adult', status: 'active' })
      .returning();
    if (!requester || !buyer) throw new Error('could not seed test users');

    actor = { id: requester.id, displayName: requester.displayName };
    shopper = { id: buyer.id, displayName: buyer.displayName };

    service = new ShoppingService(db, {
      now: () => new Date(),
      notifyUrgentItem: async (input) => {
        // Keep the notification pipeline out of the test — we only care that
        // the service decided to raise one.
        notified.push(input);
      },
    });

    const list = await service.createList(actor, { name: `Тест ${randomUUID()}` });
    listId = list.id;
  });

  afterAll(async () => {
    if (!TEST_DATABASE_URL) return;
    // Clean up by *owner*, not by the one shared list id: individual tests
    // create their own lists to stay isolated, and a teardown that only knows
    // about `listId` leaves rows behind that then block the user delete with a
    // foreign-key violation — a failure that looks nothing like its cause.
    const testUserIds = [actor.id, shopper.id];
    await db.delete(shoppingItems).where(inArray(shoppingItems.requestedById, testUserIds));
    await db.delete(shoppingItems).where(eq(shoppingItems.listId, listId));
    await db.delete(shoppingLists).where(inArray(shoppingLists.createdById, testUserIds));
    await db.delete(productCatalog).where(sql`${productCatalog.name} like 'тест-%'`);
    await db.delete(users).where(eq(users.id, actor.id));
    await db.delete(users).where(eq(users.id, shopper.id));
    await close();
  });

  it('creates exactly one row when the same clientId is replayed', async () => {
    const clientId = randomUUID();
    const body = { name: 'тест-молоко', quantity: 2, unit: 'л', isUrgent: false, clientId };

    const first = await service.addItem(actor, listId, body);
    const second = await service.addItem(actor, listId, body);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);

    const rows = await db.select().from(shoppingItems).where(eq(shoppingItems.clientId, clientId));
    expect(rows).toHaveLength(1);
  });

  it('does not double-count the catalogue when a create is replayed', async () => {
    const clientId = randomUUID();
    const body = { name: 'тест-гречка', isUrgent: false, clientId };

    await service.addItem(actor, listId, body);
    await service.addItem(actor, listId, body);

    const [product] = await db
      .select()
      .from(productCatalog)
      .where(eq(productCatalog.name, 'тест-гречка'));
    expect(product?.usageCount).toBe(1);
  });

  it('reports replayed rows as duplicates in a bulk add', async () => {
    const clientId = randomUUID();
    const items = [{ name: 'тест-хлеб', isUrgent: false, clientId }];

    const first = await service.bulkAdd(actor, listId, { items });
    const second = await service.bulkAdd(actor, listId, { items });

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.duplicates.map((i) => i.id)).toEqual([first.created[0]?.id]);
  });

  it('keeps the original bought_at when a toggle is replayed', async () => {
    const { item } = await service.addItem(actor, listId, {
      name: 'тест-сыр',
      isUrgent: false,
      clientId: randomUUID(),
    });

    const tappedAt = new Date();
    const first = await service.toggleItem(shopper, item.id, {
      bought: true,
      occurredAt: tappedAt.toISOString(),
    });
    const replay = await service.toggleItem(shopper, item.id, {
      bought: true,
      occurredAt: new Date(tappedAt.getTime() + 20 * 60_000).toISOString(),
    });

    expect(first.state).toBe('bought');
    expect(replay.state).toBe('bought');
    expect(replay.boughtAt).toBe(first.boughtAt);
    expect(replay.boughtById).toBe(shopper.id);
  });

  it('learns the category the family filed a product under and reuses it', async () => {
    await service.addItem(actor, listId, {
      name: 'тест-кефир',
      category: 'молочное',
      isUrgent: false,
      clientId: randomUUID(),
    });

    // Second add supplies no category — the catalogue fills it in.
    const { item } = await service.addItem(actor, listId, {
      name: 'тест-кефир',
      isUrgent: false,
      clientId: randomUUID(),
    });

    expect(item.category).toBe('молочное');
  });

  it('ranks suggestions by how often the family actually buys a thing', async () => {
    for (let i = 0; i < 3; i += 1) {
      await service.addItem(actor, listId, {
        name: 'тест-масло',
        isUrgent: false,
        clientId: randomUUID(),
      });
    }
    await service.addItem(actor, listId, {
      name: 'тест-макароны',
      isUrgent: false,
      clientId: randomUUID(),
    });

    const suggestions = await service.suggestProducts({ q: 'тест-ма', limit: 10 });
    expect(suggestions[0]?.name).toBe('тест-масло');
    expect(suggestions[0]?.usageCount).toBe(3);
  });

  it('raises an urgent-item notification only while somebody is shopping', async () => {
    notified.length = 0;

    // Its own list, deliberately. The premise below is "nobody has bought
    // anything here recently", and an earlier test in this file buys an item on
    // the shared `listId` -- so on the shared list this passed in isolation and
    // failed in file order, which is the worst way for a test to be wrong.
    const ownList = await service.createList(actor, { name: `Тест-срочное ${randomUUID()}` });

    const quiet = await service.addItem(actor, ownList.id, {
      name: 'тест-соль',
      isUrgent: true,
      clientId: randomUUID(),
    });
    expect(notified).toHaveLength(0);

    // Now somebody ticks something off: the trip is live.
    await service.toggleItem(shopper, quiet.item.id, { bought: true });

    await service.addItem(actor, ownList.id, {
      name: 'тест-перец',
      isUrgent: true,
      clientId: randomUUID(),
    });

    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ shopperId: shopper.id, itemName: 'тест-перец' });
  });

  it('returns items in store-walk order, uncategorised last', async () => {
    const page = await service.listItems(listId, { groupByCategory: true, limit: 50 });

    // Uncategorised items sink to the end, and named aisles never interleave:
    // each category appears as one contiguous run.
    const keys = page.items.map((i) => i.category ?? '￿');
    expect([...keys]).toEqual([...keys].sort());
  });

  it('clears the bought tail only when confirmed', async () => {
    const dryRun = await service.clearBought(listId, { confirm: false });
    expect(dryRun.removed).toBe(0);
    expect(dryRun.matched).toBeGreaterThan(0);

    const cleared = await service.clearBought(listId, { confirm: true });
    expect(cleared.removed).toBe(dryRun.matched);

    const remaining = await db
      .select()
      .from(shoppingItems)
      .where(and(eq(shoppingItems.listId, listId), eq(shoppingItems.state, 'bought')));
    expect(remaining).toHaveLength(0);
  });
});
