import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import type {
  BulkAddItem,
  CreateShoppingList,
  ProductSuggestion,
  ShoppingItemResponse,
  ShoppingListResponse,
  UpdateShoppingItem,
  UpdateShoppingList,
} from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { notify } from '@/shared/lib/toast';
import { ROUTES } from '@/shared/lib/routes';
import {
  bulkAddItems,
  clearBought,
  createItem,
  createList,
  deleteItem,
  deleteList,
  fetchFrequentProducts,
  fetchItems,
  fetchLists,
  fetchProductSuggestions,
  shoppingKeys,
  toggleItem,
  updateItem,
  updateList,
} from './api';
import {
  EMPTY_ITEMS,
  optimisticItem,
  removeItem,
  toggledItem,
  upsertItem,
  type ItemDraft,
  type ItemsCache,
} from './grouping';
import { SHOPPING_RU } from './locale';
import { normalizeProductName } from '@family/shared';
import {
  enqueueAdd,
  enqueueToggle,
  flushOutbox,
  getOutboxState,
  newClientId,
  remapItemId,
  startOutboxAutoFlush,
  subscribeOutbox,
  type OutboxAddEntry,
  type OutboxEntry,
  type OutboxHandlers,
  type OutboxState,
} from './outbox';

/**
 * Query wrappers and the bridge between the outbox and the Query cache.
 *
 * The shape of every write on this screen is the same three steps, in this
 * order and no other:
 *
 * 1. mint a `clientId` — **before** anything is rendered or stored;
 * 2. put the row in the cache optimistically, so the finger-lift is instant;
 * 3. put the intent in the durable outbox and kick a flush.
 *
 * Step 3 is not conditional on being online. A mutation that goes straight to
 * the network on a good connection and through a queue on a bad one has two
 * code paths, and the rare one is the one that matters — so there is one path,
 * and a good connection just means the queue drains in 40 ms.
 */

/* -------------------------------------------------------------------------- */
/* Outbox <-> Query cache                                                     */
/* -------------------------------------------------------------------------- */

function itemsKey(listId: string) {
  return shoppingKeys.items(listId);
}

/**
 * Swap an optimistic row for the row the server returned.
 *
 * Called identically for `201 Created` and for `200 Already accepted` — see the
 * note in `api.ts`. `upsertItem` matches on `clientId`, so a replay lands on
 * the same row instead of appending a duplicate, and the list stops flickering
 * once the ids agree.
 */
async function applyServerRow(
  qc: QueryClient,
  optimisticId: string,
  row: ShoppingItemResponse,
  fromListId: string,
): Promise<void> {
  qc.setQueryData<ItemsCache>(itemsKey(row.listId), (cache) => upsertItem(cache, row));

  // Someone moved the item to another list between the tap and the flush.
  if (fromListId !== row.listId) {
    qc.setQueryData<ItemsCache>(itemsKey(fromListId), (cache) => removeItem(cache, optimisticId));
  }

  // The counters on the lists screen are now stale, but refetching them from
  // inside a flush would fight the connection we are already struggling with.
  void qc.invalidateQueries({ queryKey: shoppingKeys.lists(), refetchType: 'none' });

  // The row has a real id now; any toggle still queued against the optimistic
  // one has to follow it.
  await remapItemId(optimisticId, row.id);
}

function bodyOf(entry: OutboxAddEntry): BulkAddItem {
  return {
    clientId: entry.clientId,
    name: entry.item.name,
    quantity: entry.item.quantity,
    unit: entry.item.unit,
    category: entry.item.category,
    note: entry.item.note,
    isUrgent: entry.item.isUrgent,
  };
}

/**
 * The handlers the outbox drains through. A plain function, not a hook, so the
 * whole sync path can be tested against a bare `QueryClient`.
 */
export function createOutboxHandlers(qc: QueryClient): OutboxHandlers {
  return {
    perform: async (entry: OutboxEntry) => {
      if (entry.kind === 'add') {
        const row = await createItem(entry.listId, {
          ...bodyOf(entry),
          isUrgent: entry.item.isUrgent,
        });
        await applyServerRow(qc, entry.clientId, row, entry.listId);
        return;
      }

      const row = await toggleItem(entry.itemId, {
        bought: entry.bought,
        // The moment of the tap, carried from the queue. Never `new Date()`
        // here: this line runs at flush time, which may be a train ride later,
        // and the server resolves «куплено» vs «нужно» by comparing this
        // against the stored `bought_at`.
        occurredAt: entry.occurredAt,
        clientId: entry.clientId,
      });
      await applyServerRow(qc, entry.itemId, row, entry.listId);
    },

    performBatch: async (entries: OutboxAddEntry[]) => {
      const first = entries[0];
      if (first === undefined) return;
      const response = await bulkAddItems(first.listId, { items: entries.map(bodyOf) });
      // `duplicates` are rows an earlier delivery already created. They are not
      // an error and not a special case — same reconciliation as `created`.
      for (const row of [...response.created, ...response.duplicates]) {
        await applyServerRow(qc, row.clientId ?? row.id, row, first.listId);
      }
    },

    onDrop: (entry: OutboxEntry, error: unknown) => {
      if (entry.kind === 'add') {
        // The row the user saw was never real. Take it back rather than leave a
        // ghost on a list other people are reading.
        qc.setQueryData<ItemsCache>(itemsKey(entry.listId), (cache) =>
          removeItem(cache, entry.clientId),
        );
      } else {
        void qc.invalidateQueries({ queryKey: itemsKey(entry.listId) });
      }
      notify.error(error, SHOPPING_RU.syncFailed);
    },
  };
}

function useOutboxHandlers(): OutboxHandlers {
  const qc = useQueryClient();
  return useMemo(() => createOutboxHandlers(qc), [qc]);
}

/* -------------------------------------------------------------------------- */
/* Connectivity & queue state                                                 */
/* -------------------------------------------------------------------------- */

function subscribeOnline(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/**
 * `navigator.onLine` only ever tells the truth about `false`-to-`true`
 * transitions, and lies cheerfully behind captive portals. It is used here for
 * copy ("нет сети") and never to decide whether to attempt a request — the
 * queue finds that out by trying.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

export interface ShoppingSync extends OutboxState {
  online: boolean;
  /** Manual «отправить сейчас». */
  flushNow: () => void;
}

/**
 * Mount once per shopping screen: starts the auto-flush listeners and exposes
 * the queue depth for the offline banner.
 *
 * → For the lead: this belongs one level up, in the app shell, so a queued
 *   change flushes even when the user reopens the PWA on the Сегодня tab.
 *   `app/` is not this agent's to edit; `startOutboxAutoFlush(handlers)` is the
 *   only call that needs moving.
 */
export function useShoppingSync(): ShoppingSync {
  const handlers = useOutboxHandlers();
  const state = useSyncExternalStore(subscribeOutbox, getOutboxState, getOutboxState);
  const online = useOnline();

  useEffect(() => startOutboxAutoFlush(handlers), [handlers]);

  const flushNow = useCallback(() => {
    void flushOutbox(handlers).catch(() => undefined);
  }, [handlers]);

  return { ...state, online, flushNow };
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export function useShoppingLists(includeArchived = false) {
  return useQuery({
    queryKey: shoppingKeys.list(includeArchived),
    queryFn: () => fetchLists(includeArchived),
    // `includeArchived` is part of the key, so «Показать архив» asks a new
    // query and the lists would blank out to a skeleton while it answers.
    // Same reason as `useGoals`, and as `useShoppingItems` below.
    placeholderData: keepPreviousData,
  });
}

export function useShoppingItems(listId: string | null) {
  return useQuery({
    queryKey: itemsKey(listId ?? ''),
    queryFn: () => fetchItems(listId ?? ''),
    enabled: listId !== null,
    // The aisle view is the screen people stare at while walking; an empty
    // frame between cache and network is worse than a slightly stale list.
    placeholderData: (previous: ItemsCache | undefined) => previous,
  });
}

export function useFrequentProducts(limit = 12) {
  return useQuery({
    queryKey: shoppingKeys.frequent(limit),
    queryFn: () => fetchFrequentProducts(limit),
    // The family's habits do not change between two trips to the shop.
    staleTime: 10 * 60_000,
  });
}

export function useProductSuggestions(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: shoppingKeys.suggest(trimmed.toLowerCase()),
    queryFn: () => fetchProductSuggestions(trimmed),
    enabled: trimmed.length >= 2,
    staleTime: 60_000,
  });
}

/**
 * Frequent products, indexed by their normalised name.
 *
 * This is the offline half of «часто покупаем»: with no signal the server
 * cannot fill in a default unit or aisle, so we use whatever the last
 * successful fetch cached. A miss costs one uncategorised row.
 */
export function useCatalogueIndex(): ReadonlyMap<
  string,
  { defaultUnit: string | null; defaultCategory: string | null }
> {
  const { data } = useFrequentProducts();
  return useMemo(() => {
    const index = new Map<string, { defaultUnit: string | null; defaultCategory: string | null }>();
    for (const product of data ?? []) {
      index.set(normalizeProductName(product.name), {
        defaultUnit: product.defaultUnit,
        defaultCategory: product.defaultCategory,
      });
    }
    return index;
  }, [data]);
}

/* -------------------------------------------------------------------------- */
/* Offline-first writes                                                       */
/* -------------------------------------------------------------------------- */

export type AddItemsFn = (drafts: readonly ItemDraft[]) => Promise<void>;

/** Quick add. One `clientId` per line, minted before the row is rendered. */
export function useAddItems(listId: string): AddItemsFn {
  const qc = useQueryClient();
  const handlers = useOutboxHandlers();
  const { userId } = useCan();

  return useCallback(
    async (drafts) => {
      const cache = qc.getQueryData<ItemsCache>(itemsKey(listId)) ?? EMPTY_ITEMS;
      let sortOrder = cache.items.length;

      for (const draft of drafts) {
        // (1) The client id exists before the row does. This is the whole
        //     dedupe story — mint it at flush time instead and a retry adds a
        //     second «молоко».
        const clientId = newClientId();

        // (2) Instant feedback, from a row that is honestly marked unsent
        //     until the outbox says otherwise.
        qc.setQueryData<ItemsCache>(itemsKey(listId), (current) =>
          upsertItem(
            current,
            optimisticItem({
              listId,
              clientId,
              requestedById: userId ?? '',
              sortOrder: sortOrder++,
              ...draft,
            }),
          ),
        );

        // (3) Durable intent.
        await enqueueAdd({ listId, clientId, item: draft });
      }

      void flushOutbox(handlers).catch(() => undefined);
    },
    [qc, handlers, listId, userId],
  );
}

export type ToggleItemFn = (item: ShoppingItemResponse, bought: boolean) => void;

/**
 * The aisle one-tap.
 *
 * `occurredAt` is stamped here, in the event handler, and carried through the
 * queue untouched. That timestamp is the conflict resolution for the whole
 * feature: two people in two aisles tick the same item, the queue replays in
 * whatever order the connections allow, and the server keeps the purchase
 * because a `needed` older than the stored `bought_at` is discarded.
 */
export function useToggleItem(listId: string): ToggleItemFn {
  const qc = useQueryClient();
  const handlers = useOutboxHandlers();
  const { userId } = useCan();

  return useCallback(
    (item, bought) => {
      const occurredAt = new Date().toISOString();

      qc.setQueryData<ItemsCache>(itemsKey(listId), (current) =>
        upsertItem(current, toggledItem(item, bought, occurredAt, userId)),
      );

      void enqueueToggle({ listId, itemId: item.id, bought, occurredAt })
        .then(() => flushOutbox(handlers))
        .catch(() => undefined);
    },
    [qc, handlers, listId, userId],
  );
}

/* -------------------------------------------------------------------------- */
/* Online-only writes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * List management is deliberately **not** queued. Creating, deleting or
 * clearing a list is a rare, deliberate act that nobody performs in a shop
 * basement, and a queued "delete list" replayed an hour later — after someone
 * else has refilled it — destroys work. Items are cheap and idempotent;
 * containers are not.
 */
export function useCreateList(): UseMutationResult<
  ShoppingListResponse,
  unknown,
  CreateShoppingList
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateShoppingList) => createList(body),
    onSuccess: () => {
      notify.success(SHOPPING_RU.listCreated);
      void qc.invalidateQueries({ queryKey: shoppingKeys.lists() });
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

/* --- the lists cache, which is more than one query ------------------------ */

/**
 * Every cached `lists` query, with the `includeArchived` its key was built for.
 *
 * There are two of them in a normal session: the overview asks for
 * `includeArchived: false`, `ListPage` asks for `true` so that opening an
 * archived list still shows its name. A rename that patched only the query the
 * current screen happens to read would leave the other one printing the old
 * name until something refetched it, which on a warm cache is "never".
 */
function listsQueries(qc: QueryClient): { key: readonly unknown[]; includeArchived: boolean }[] {
  return qc
    .getQueryCache()
    .findAll({ queryKey: shoppingKeys.lists() })
    .map((query) => {
      const last = query.queryKey.at(-1);
      const includeArchived =
        typeof last === 'object' && last !== null && 'includeArchived' in last
          ? Boolean((last as { includeArchived: unknown }).includeArchived)
          : false;
      return { key: query.queryKey, includeArchived };
    });
}

type ListsSnapshot = readonly (readonly [readonly unknown[], ShoppingListResponse[] | undefined])[];

function snapshotLists(qc: QueryClient): ListsSnapshot {
  return listsQueries(qc).map(
    ({ key }) => [key, qc.getQueryData<ShoppingListResponse[]>(key)] as const,
  );
}

function restoreLists(qc: QueryClient, snapshot: ListsSnapshot | undefined): void {
  for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
}

/**
 * Apply a patch to one row without letting `undefined` through.
 *
 * `UpdateShoppingList` is a partial with nullable members, so a plain
 * `{ ...list, ...patch }` writes `icon: undefined` over a perfectly good icon
 * the moment somebody renames a list without touching the icon field.
 */
function mergeList(list: ShoppingListResponse, patch: UpdateShoppingList): ShoppingListResponse {
  return {
    ...list,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.icon !== undefined && { icon: patch.icon ?? null }),
    ...(patch.color !== undefined && { color: patch.color ?? null }),
    ...(patch.isArchived !== undefined && { isArchived: patch.isArchived }),
    ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
  };
}

/**
 * Rename, recolour, archive, unarchive — one `PATCH`, applied optimistically.
 *
 * Optimistic is safe here in the way it is not for a delete: every field is
 * reversible, the previous value is held for the rollback, and the worst
 * failure case is a name that flickers back to what it was under an error
 * toast. Archiving is included on purpose — the card leaving the screen the
 * instant you tap «Убрать в архив» is the whole point of choosing archive over
 * delete, and a round-trip's worth of hesitation there makes the gentle option
 * feel like the slow one.
 *
 * A list that is archived vanishes from the `includeArchived: false` query
 * rather than sitting there wearing an «В архиве» label, which is what a plain
 * field patch would have left behind.
 */
export function useUpdateList(
  listId: string,
): UseMutationResult<ShoppingListResponse, unknown, UpdateShoppingList, ListsSnapshot> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateShoppingList) => updateList(listId, body),
    onMutate: async (body) => {
      // An in-flight refetch that resolves after this write would undo it.
      await qc.cancelQueries({ queryKey: shoppingKeys.lists() });
      const previous = snapshotLists(qc);

      for (const { key, includeArchived } of listsQueries(qc)) {
        qc.setQueryData<ShoppingListResponse[]>(key, (lists) => {
          if (lists === undefined) return lists;
          const next = lists.map((list) => (list.id === listId ? mergeList(list, body) : list));
          return includeArchived ? next : next.filter((list) => !list.isArchived);
        });
      }

      return previous;
    },
    onError: (error, _body, previous) => {
      restoreLists(qc, previous);
      notify.error(error);
    },
    onSuccess: (row) => {
      for (const { key, includeArchived } of listsQueries(qc)) {
        qc.setQueryData<ShoppingListResponse[]>(key, (lists) => {
          if (lists === undefined) return lists;
          const next = lists.map((list) => (list.id === row.id ? row : list));
          return includeArchived ? next : next.filter((list) => !list.isArchived);
        });
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: shoppingKeys.lists() });
    },
  });
}

/**
 * Delete a list and everything on it.
 *
 * **Not optimistic, deliberately.** Every other write on this screen takes the
 * row away first and apologises later, because the worst case is one line of
 * «молоко» that has to be retyped. Here the worst case is a shared list the
 * whole family was adding to, and there is no undo on the server — so the card
 * stays exactly where it is until the API has confirmed the deletion. A failed
 * delete therefore leaves the screen untouched; the only thing the user sees is
 * the mapped Russian error.
 *
 * The confirmation is entirely the client's job. `DELETE /shopping/lists/:id`
 * has no `confirm` flag (that is `clear-bought`) and returns `{ ok: true }`
 * rather than a count, so the "и 12 позиций вместе с ним" warning is built from
 * the list's own `totalCount` before the request goes out.
 */
export function useDeleteList(listId: string): UseMutationResult<{ ok: true }, unknown, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => deleteList(listId),
    onSuccess: () => {
      for (const { key } of listsQueries(qc)) {
        qc.setQueryData<ShoppingListResponse[]>(key, (lists) =>
          lists?.filter((list) => list.id !== listId),
        );
      }
      // The items are gone server-side (`list_id` cascades); keeping their
      // cache entry would let a stale `/shopping/:listId` render a full list.
      qc.removeQueries({ queryKey: shoppingKeys.items(listId) });
      notify.success(SHOPPING_RU.listDeleted);
      void qc.invalidateQueries({ queryKey: shoppingKeys.lists() });
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

export function useClearBought(listId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => clearBought(listId, true),
    onSuccess: () => {
      notify.success(SHOPPING_RU.cleared);
      void qc.invalidateQueries({ queryKey: itemsKey(listId) });
      void qc.invalidateQueries({ queryKey: shoppingKeys.lists() });
    },
    onError: (error) => {
      notify.error(error);
    },
  });
}

export function useDeleteItem(listId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => deleteItem(itemId),
    onMutate: (itemId: string) => {
      const previous = qc.getQueryData<ItemsCache>(itemsKey(listId));
      qc.setQueryData<ItemsCache>(itemsKey(listId), (cache) => removeItem(cache, itemId));
      return { previous };
    },
    onError: (error, _itemId, context) => {
      if (context?.previous) qc.setQueryData(itemsKey(listId), context.previous);
      notify.error(error);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: shoppingKeys.lists() });
    },
  });
}

/**
 * Edit one line: name, quantity, unit, отдел, note, urgency.
 *
 * ## Why this is not queued like an add or a toggle
 *
 * Adds and toggles go through the outbox because they happen *in the shop*,
 * where the signal dies — and because both are idempotent on a `clientId`, so a
 * replay is harmless. An edit is neither. It is a correction made at the
 * kitchen table («три килограмма, не два»), and replaying a stale field patch
 * over somebody else's later correction is exactly the silent data loss the
 * queue exists to avoid. `PATCH /shopping/items/:id` is last-write-wins with no
 * idempotency key, so it stays on the online path and fails loudly.
 *
 * Optimistic with a rollback, like {@link useDeleteItem}: the row is the thing
 * the user is looking at, and a corrected quantity that appears half a second
 * later reads as a dropped tap.
 */
export function useUpdateItem(
  listId: string,
): UseMutationResult<
  ShoppingItemResponse,
  unknown,
  { itemId: string; body: UpdateShoppingItem },
  { previous: ItemsCache | undefined }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: UpdateShoppingItem }) =>
      updateItem(itemId, body),
    onMutate: ({ itemId, body }) => {
      const previous = qc.getQueryData<ItemsCache>(itemsKey(listId));
      const current = previous?.items.find((row) => row.id === itemId);
      if (current !== undefined) {
        qc.setQueryData<ItemsCache>(itemsKey(listId), (cache) =>
          upsertItem(cache, mergeItem(current, body)),
        );
      }
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) qc.setQueryData(itemsKey(listId), context.previous);
      notify.error(error);
    },
    onSuccess: (row) => {
      // The server may have filled in a category from `product_catalog`, so the
      // row it returns wins over the one we guessed.
      qc.setQueryData<ItemsCache>(itemsKey(row.listId), (cache) => upsertItem(cache, row));
      notify.success(SHOPPING_RU.itemUpdated);
      void qc.invalidateQueries({ queryKey: shoppingKeys.lists() });
    },
  });
}

/**
 * Same `undefined`-safety as {@link mergeList}: a partial patch must not blank
 * the fields it does not mention.
 */
function mergeItem(item: ShoppingItemResponse, patch: UpdateShoppingItem): ShoppingItemResponse {
  return {
    ...item,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.quantity !== undefined && { quantity: patch.quantity ?? null }),
    ...(patch.unit !== undefined && { unit: patch.unit ?? null }),
    ...(patch.category !== undefined && { category: patch.category ?? null }),
    ...(patch.note !== undefined && { note: patch.note ?? null }),
    ...(patch.isUrgent !== undefined && { isUrgent: patch.isUrgent }),
  };
}

/* -------------------------------------------------------------------------- */
/* Navigation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which list is open.
 *
 * Reads `:listId` first and falls back to `?list=`. See {@link shoppingListPath}
 * for why both exist.
 */
export function useActiveListId(): string | null {
  const params = useParams();
  const [search] = useSearchParams();
  return params.listId ?? search.get('list');
}

/**
 * Deep link to one list.
 *
 * → For the lead: the route contract in `app/router.tsx` registers `/shopping`
 *   with a single `index` child, so `/shopping/:listId` currently falls through
 *   to the 404 route, and this agent may not edit the shell. `ListPage` already
 *   default-exports a no-props component and already reads `useParams().listId`,
 *   so the hookup is one entry —
 *   `{ path: ':listId', lazy: page(() => import('@/features/shopping/pages/ListPage')) }`
 *   alongside the existing index child — plus changing the template below to
 *   `` `${ROUTES.shopping}/${listId}` ``. Until then the query parameter is the
 *   only deep link that resolves, and it is a real, shareable URL.
 */
export function shoppingListPath(listId: string): string {
  // The `/shopping/:listId` child route is registered, so use the real path.
  // `useActiveListId` still reads `?list=` as a fallback, which keeps any link
  // already shared in the family chat working.
  return `${ROUTES.shopping}/${encodeURIComponent(listId)}`;
}

/* -------------------------------------------------------------------------- */
/* «Я в магазине»                                                             */
/* -------------------------------------------------------------------------- */

const SHOP_MODE_KEY = 'family.shopping.shopMode';

/**
 * Shop mode survives a reload because iOS kills a backgrounded PWA and brings
 * it back as a cold start at `start_url` (`ios-pwa-push.md` §8) — walking out
 * of the freezer aisle to find the small-text layout back would be maddening.
 * This is a display preference, not a credential, so `localStorage` is fine
 * (the D3 ban is about tokens).
 */
export function useShopMode(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOP_MODE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const set = useCallback((next: boolean) => {
    setEnabled(next);
    try {
      localStorage.setItem(SHOP_MODE_KEY, next ? '1' : '0');
    } catch {
      // Private mode, quota, a locked-down WebView — the mode still works, it
      // just will not be remembered.
    }
  }, []);

  return [enabled, set];
}

/**
 * Keep the screen awake while shopping.
 *
 * Entirely best-effort: `navigator.wakeLock` does not exist in every browser we
 * ship to, the promise rejects whenever the document is not visible, and the
 * lock is released by the platform on every tab switch — so it is re-acquired
 * on `visibilitychange`. Every failure is swallowed: a dimming screen is a
 * minor annoyance, an error toast about it is a bug.
 */
export function useWakeLock(enabled: boolean): void {
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const wakeLock = navigator.wakeLock;
    if (!wakeLock) return; // Feature-detect and degrade in silence.

    let cancelled = false;

    const acquire = (): void => {
      if (cancelled || document.visibilityState !== 'visible' || sentinel.current) return;
      wakeLock.request('screen').then(
        (lock) => {
          if (cancelled) {
            void lock.release().catch(() => undefined);
            return;
          }
          sentinel.current = lock;
          lock.addEventListener('release', () => {
            sentinel.current = null;
          });
        },
        () => undefined,
      );
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const lock = sentinel.current;
      sentinel.current = null;
      void lock?.release().catch(() => undefined);
    };
  }, [enabled]);
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** Products the family buys most, minus what is already on this list. */
export function useFrequentSuggestions(
  items: readonly ShoppingItemResponse[],
): ProductSuggestion[] {
  const { data } = useFrequentProducts();
  return useMemo(() => {
    const present = new Set(
      items.filter((i) => i.state === 'needed').map((i) => normalizeProductName(i.name)),
    );
    return (data ?? []).filter((product) => !present.has(normalizeProductName(product.name)));
  }, [data, items]);
}
