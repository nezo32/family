import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Permission, ShoppingItemResponse, ShoppingListResponse } from '@family/shared';

/**
 * The offline contract, tested where it actually breaks.
 *
 * Everything here exercises the queue and the reconciliation directly rather
 * than through a rendered tree: these are the rules that decide whether a
 * family ends up with two litres of milk, and they must be readable as rules.
 *
 * `jsdom` has no IndexedDB, so `outbox.ts` falls back to its in-memory driver —
 * the same code path a private window or a blocked-storage device takes.
 */

/** `vi.hoisted` so the mock factories, which are hoisted too, can close over these. */
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('@/shared/api/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: { get: mocks.get, post: mocks.post, patch: mocks.patch, put: vi.fn(), del: mocks.del },
}));

vi.mock('@/shared/lib/toast', () => ({
  notify: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: mocks.notifyError,
    loading: vi.fn(),
    dismiss: vi.fn(),
    raw: {},
  },
}));

import { ApiError, NetworkError } from '@/shared/api/errors';
import { meKeys } from '@/shared/auth/use-me';
import { makeMe } from '@/test/me';
import { shoppingKeys } from './api';
import { optimisticItem, upsertItem, type ItemsCache } from './grouping';
import { createOutboxHandlers, useUpdateItem, useUpdateList } from './hooks';
import { ListCard } from './components/ListCard';
import { ItemRow } from './components/ItemRow';
import { SHOPPING_RU } from './locale';
import { parseQuickAddLine, parseQuickAddText } from '@family/shared';
import { OfflineBanner } from './components/OfflineBanner';
import * as outbox from './outbox';

const { patch, del, post, notifyError } = mocks;

const LIST_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';

function serverRow(overrides: Partial<ShoppingItemResponse> = {}): ShoppingItemResponse {
  return {
    id: 'server-1',
    listId: LIST_ID,
    name: 'Молоко',
    quantity: 2,
    unit: 'шт',
    category: 'молочное',
    note: null,
    requestedById: 'user-1',
    state: 'needed',
    boughtById: null,
    boughtAt: null,
    isUrgent: false,
    sortOrder: 0,
    clientId: CLIENT_ID,
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
    ...overrides,
  };
}

const itemDraft = {
  name: 'Молоко',
  quantity: 2,
  unit: 'шт',
  category: 'молочное',
  note: null,
  isUrgent: false,
};

let qc: QueryClient;

function cache(): ItemsCache | undefined {
  return qc.getQueryData<ItemsCache>(shoppingKeys.items(LIST_ID));
}

function seedOptimisticRow(clientId = CLIENT_ID): void {
  qc.setQueryData<ItemsCache>(shoppingKeys.items(LIST_ID), (current) =>
    upsertItem(
      current,
      optimisticItem({ listId: LIST_ID, clientId, requestedById: 'user-1', ...itemDraft }),
    ),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  post.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await outbox.clearOutbox();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('outbox — the offline contract', () => {
  it('dedupes a replayed clientId instead of queueing it twice', async () => {
    // The same intent delivered twice: a double tap, a re-render, a retry of
    // the enqueue itself. `clientId` is the identity, so the second one lands
    // on top of the first.
    await outbox.enqueueAdd({ listId: LIST_ID, clientId: CLIENT_ID, item: itemDraft });
    await outbox.enqueueAdd({ listId: LIST_ID, clientId: CLIENT_ID, item: itemDraft });

    expect(outbox.getOutboxState().pending).toBe(1);

    post.mockResolvedValue(serverRow());
    const result = await outbox.flushOutbox(createOutboxHandlers(qc));

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
    expect(outbox.getOutboxState().pending).toBe(0);
  });

  it('sends the moment of the tap as occurredAt, not the moment of the flush', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T18:42:00.000Z'));
    const tappedAt = new Date().toISOString();

    // In the aisle, no signal.
    await outbox.enqueueToggle({ listId: LIST_ID, itemId: 'server-1', bought: true });

    // Twenty-five minutes later, back on Wi-Fi at home.
    vi.setSystemTime(new Date('2026-08-19T19:07:00.000Z'));
    post.mockResolvedValue(serverRow({ state: 'bought', boughtAt: tappedAt }));

    await outbox.flushOutbox(createOutboxHandlers(qc));

    const [path, body] = post.mock.calls[0] as [string, { occurredAt: string; bought: boolean }];
    expect(path).toBe('/shopping/items/server-1/toggle');
    expect(body.bought).toBe(true);
    // The server resolves «куплено» vs «нужно» by comparing this against the
    // stored bought_at. Stamping it at flush time would silently reorder two
    // shoppers' taps.
    expect(body.occurredAt).toBe(tappedAt);
    expect(body.occurredAt).not.toBe('2026-08-19T19:07:00.000Z');
  });

  it('collapses repeated taps on one item into a single latest intent', async () => {
    await outbox.enqueueToggle({
      listId: LIST_ID,
      itemId: 'server-1',
      bought: true,
      occurredAt: '2026-08-19T18:42:00.000Z',
    });
    await outbox.enqueueToggle({
      listId: LIST_ID,
      itemId: 'server-1',
      bought: false,
      occurredAt: '2026-08-19T18:43:00.000Z',
    });

    expect(outbox.getOutboxState().pending).toBe(1);

    post.mockResolvedValue(serverRow());
    await outbox.flushOutbox(createOutboxHandlers(qc));

    const [, body] = post.mock.calls[0] as [string, { bought: boolean; occurredAt: string }];
    expect(body.bought).toBe(false);
    expect(body.occurredAt).toBe('2026-08-19T18:43:00.000Z');
  });

  it('reconciles a replayed insert onto the optimistic row instead of duplicating it', async () => {
    seedOptimisticRow();
    await outbox.enqueueAdd({ listId: LIST_ID, clientId: CLIENT_ID, item: itemDraft });

    // A previous delivery already reached the server: it answers 200 with the
    // row it created the first time. `api.post` resolves the body either way —
    // reconciliation keys on clientId, so 200 and 201 are the same operation.
    post.mockResolvedValue(serverRow({ id: 'server-1' }));

    await outbox.flushOutbox(createOutboxHandlers(qc));

    const items = cache()?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('server-1');
    expect(items[0]?.clientId).toBe(CLIENT_ID);
    expect(outbox.getOutboxState().pending).toBe(0);
  });

  it('reconciles both created[] and duplicates[] from a bulk replay', async () => {
    const otherClientId = '33333333-3333-4333-8333-333333333333';
    seedOptimisticRow();
    seedOptimisticRow(otherClientId);

    await outbox.enqueueAdd({ listId: LIST_ID, clientId: CLIENT_ID, item: itemDraft });
    await outbox.enqueueAdd({ listId: LIST_ID, clientId: otherClientId, item: itemDraft });

    post.mockResolvedValue({
      created: [serverRow({ id: 'server-2', clientId: otherClientId })],
      // Already accepted on an earlier delivery — not an error, same handling.
      duplicates: [serverRow({ id: 'server-1', clientId: CLIENT_ID })],
    });

    await outbox.flushOutbox(createOutboxHandlers(qc));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe(`/shopping/lists/${LIST_ID}/items/bulk`);

    const ids = (cache()?.items ?? []).map((row) => row.id).sort();
    expect(ids).toEqual(['server-1', 'server-2']);
  });

  it('rolls the optimistic row back when the server refuses it outright', async () => {
    seedOptimisticRow();
    await outbox.enqueueAdd({ listId: LIST_ID, clientId: CLIENT_ID, item: itemDraft });
    expect(cache()?.items).toHaveLength(1);

    post.mockRejectedValue(new ApiError({ code: 'VALIDATION_ERROR', status: 400 }));

    const result = await outbox.flushOutbox(createOutboxHandlers(qc));

    expect(result.dropped).toBe(1);
    // The row the user saw was never real; leaving it on a shared list would be
    // worse than the rollback.
    expect(cache()?.items).toHaveLength(0);
    expect(outbox.getOutboxState().pending).toBe(0);
    expect(notifyError).toHaveBeenCalled();
  });

  it('keeps the change queued when the request never left the device', async () => {
    seedOptimisticRow();
    await outbox.enqueueAdd({ listId: LIST_ID, clientId: CLIENT_ID, item: itemDraft });

    post.mockRejectedValue(new NetworkError(new Error('offline')));

    const result = await outbox.flushOutbox(createOutboxHandlers(qc));

    expect(result.dropped).toBe(0);
    expect(result.remaining).toBe(1);
    // Optimistic row stays: it is not wrong, just unsent.
    expect(cache()?.items).toHaveLength(1);
    expect(outbox.getOutboxState().pendingIds.has(CLIENT_ID)).toBe(true);
  });

  it('follows a queued toggle across to the server id of its own insert', async () => {
    // Offline: add «молоко», then immediately tick it. The toggle points at the
    // optimistic id, which the server has never heard of.
    await outbox.enqueueAdd({ listId: LIST_ID, clientId: CLIENT_ID, item: itemDraft });
    await outbox.enqueueToggle({ listId: LIST_ID, itemId: CLIENT_ID, bought: true });

    post.mockImplementation((path: string) => {
      if (path.endsWith('/items')) return Promise.resolve(serverRow({ id: 'server-1' }));
      return Promise.resolve(serverRow({ id: 'server-1', state: 'bought' }));
    });

    await outbox.flushOutbox(createOutboxHandlers(qc));

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[0]).toBe('/shopping/items/server-1/toggle');
    expect(outbox.getOutboxState().pending).toBe(0);
  });
});

describe('offline banner', () => {
  it('reports the real queue depth and disappears once it drains', async () => {
    await outbox.enqueueAdd({ listId: LIST_ID, clientId: CLIENT_ID, item: itemDraft });
    await outbox.enqueueToggle({ listId: LIST_ID, itemId: 'server-9', bought: true });

    const queued = outbox.getOutboxState();
    expect(queued.pending).toBe(2);

    const { rerender } = render(
      <OfflineBanner online pending={queued.pending} flushing={false} onRetry={() => undefined} />,
    );
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('2 изменения не отправлено');

    post.mockResolvedValue(serverRow());
    await outbox.flushOutbox(createOutboxHandlers(qc));

    const drained = outbox.getOutboxState();
    expect(drained.pending).toBe(0);

    // Online with an empty queue: no permanent status bar to learn to ignore.
    rerender(
      <OfflineBanner online pending={drained.pending} flushing={false} onRetry={() => undefined} />,
    );
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('explains itself when the device is offline', () => {
    render(<OfflineBanner online={false} pending={0} flushing={false} onRetry={() => undefined} />);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('Нет сети');
  });
});

describe('quick-add parsing', () => {
  it('splits a typed list into rows with quantity and unit', () => {
    const parsed = parseQuickAddText('2 кг картошки\nмолоко 3 шт\nхлеб');

    expect(parsed.map((item) => [item.name, item.quantity, item.unit])).toEqual([
      ['картошки', 2, 'кг'],
      ['молоко', 3, 'шт'],
      ['хлеб', null, null],
    ]);
  });

  it('does not mistake a fat percentage for a quantity', () => {
    const parsed = parseQuickAddLine('молоко 3,2%');
    expect(parsed?.name).toBe('молоко 3,2%');
    expect(parsed?.quantity).toBeNull();
  });

  /**
   * The client used to carry its own copy of the parser without the
   * `IRREGULAR_GENITIVES` table, so an offline add keyed «2 л молока» as
   * `молока` while the server keyed it `молоко` — two `product_catalog` rows
   * for one product, and the suffix rules mangled «огурцов» into `огурц` on top
   * of it. The parser is `@family/shared` now; these are the keys the server
   * has always produced, asserted from the client side.
   */
  it.each([
    ['2 л молока', 'молоко'],
    ['500 г масла', 'масло'],
    ['1 кг огурцов', 'огурец'],
    ['10 шт яиц', 'яйцо'],
    ['5 яблок', 'яблоко'],
    ['1 кг соли', 'соль'],
    ['1 кг моркови', 'морковь'],
    ['2 кг картошки', 'картошка'],
  ])('keys «%s» exactly as the server does (%s)', (input, key) => {
    expect(parseQuickAddLine(input)?.normalizedName).toBe(key);
  });
});


/* -------------------------------------------------------------------------- */
/* List management                                                            */
/* -------------------------------------------------------------------------- */

function listRow(overrides: Partial<ShoppingListResponse> = {}): ShoppingListResponse {
  return {
    id: LIST_ID,
    name: 'Продукты',
    icon: null,
    color: null,
    isArchived: false,
    sortOrder: 0,
    createdById: 'user-1',
    neededCount: 3,
    totalCount: 12,
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
    ...overrides,
  };
}

function cachedList(): ShoppingListResponse | undefined {
  return qc.getQueryData<ShoppingListResponse[]>(shoppingKeys.list(false))?.[0];
}

function renderCard(permissions: Permission[], list = listRow()) {
  // Seeding `['me']` rather than stubbing the endpoint keeps `useCan()` on its
  // real code path: the permission list still comes through the contract.
  qc.setQueryData(meKeys.detail(), makeMe({ permissions }));
  qc.setQueryData(shoppingKeys.list(false), [list]);

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ul>
          <ListCard list={list} to={`/shopping/${list.id}`} />
        </ul>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: SHOPPING_RU.listActions }));
}

describe('list management — who may touch a list at all', () => {
  /**
   * A child holds `shopping:read` and `shopping:write`: they may add
   * «мороженое» and tick it off. They may not archive or destroy the container
   * everybody else is writing into — and they must not be shown a greyed-out
   * «Удалить список» either, because a disabled control is an invitation to
   * wonder what you did wrong.
   */
  it('renders no management control at all for shopping:write without list:manage', () => {
    renderCard(['shopping:read', 'shopping:write']);

    expect(screen.queryByRole('button', { name: SHOPPING_RU.listActions })).toBeNull();
    expect(screen.queryByText(SHOPPING_RU.deleteList)).toBeNull();
    expect(screen.queryByText(SHOPPING_RU.archiveList)).toBeNull();
    // The list itself is still readable — this is about the container, not the
    // contents.
    expect(screen.getByText('Продукты')).toBeInTheDocument();
  });

  it('offers edit, archive and delete to a holder of shopping:list:manage', async () => {
    const user = userEvent.setup();
    renderCard(['shopping:read', 'shopping:write', 'shopping:list:manage']);

    await openMenu(user);

    expect(await screen.findByText(SHOPPING_RU.editList)).toBeInTheDocument();
    // Archive is the gentle option and comes first; delete sits below the
    // separator wearing the destructive colour.
    expect(screen.getByText(SHOPPING_RU.archiveList)).toBeInTheDocument();
    expect(screen.getByText(SHOPPING_RU.deleteList)).toBeInTheDocument();
  });

  it('offers «вернуть из архива» instead of «убрать в архив» on an archived list', async () => {
    const user = userEvent.setup();
    renderCard(['shopping:list:manage'], listRow({ isArchived: true }));

    await openMenu(user);

    expect(await screen.findByText(SHOPPING_RU.unarchiveList)).toBeInTheDocument();
    expect(screen.queryByText(SHOPPING_RU.archiveList)).toBeNull();
  });
});

describe('deleting a list', () => {
  /**
   * `DELETE /shopping/lists/:id` takes no `confirm` flag and answers
   * `{ ok: true }` — the server will not tell us, before or after, how much it
   * destroyed. So the count in the warning is the list's own `totalCount`, and
   * it has to be a real number: «вы уверены?» is not a question anybody can
   * answer.
   */
  it('says how many позиций go with the list', async () => {
    const user = userEvent.setup();
    renderCard(['shopping:list:manage'], listRow({ totalCount: 12 }));

    await openMenu(user);
    await user.click(await screen.findByText(SHOPPING_RU.deleteList));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Удалить «Продукты»?');
    expect(dialog).toHaveTextContent('В списке 12 позиций. Удалить вместе со списком?');
    // And it points at the reversible option while there is still time.
    expect(dialog).toHaveTextContent(SHOPPING_RU.deleteListArchiveHint);
  });

  it('agrees the count with the number, rather than always saying «позиций»', async () => {
    const user = userEvent.setup();
    renderCard(['shopping:list:manage'], listRow({ totalCount: 2 }));

    await openMenu(user);
    await user.click(await screen.findByText(SHOPPING_RU.deleteList));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('В списке 2 позиции.');
  });

  it('does not pretend an empty list is full of things', async () => {
    const user = userEvent.setup();
    renderCard(['shopping:list:manage'], listRow({ totalCount: 0, neededCount: 0 }));

    await openMenu(user);
    await user.click(await screen.findByText(SHOPPING_RU.deleteList));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Список пуст');
  });

  it('drops the list from the cache only after the server confirms it', async () => {
    const user = userEvent.setup();
    del.mockResolvedValue({ ok: true });
    renderCard(['shopping:list:manage']);

    await openMenu(user);
    await user.click(await screen.findByText(SHOPPING_RU.deleteList));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: SHOPPING_RU.deleteList,
      }),
    );

    await waitFor(() => {
      expect(del).toHaveBeenCalledWith(`/shopping/lists/${LIST_ID}`);
    });
    await waitFor(() => {
      expect(cachedList()).toBeUndefined();
    });
    // The items belonged to a list that no longer exists.
    expect(qc.getQueryData(shoppingKeys.items(LIST_ID))).toBeUndefined();
  });

  /**
   * The delete is deliberately **not** optimistic: a shared list is not a row
   * of «молоко» somebody can retype. So "rolling back" a failed delete means
   * the list was never taken away in the first place — the card is still there,
   * the cache still holds it, and the only thing that changed is a Russian
   * error toast mapped from the `ErrorCode`.
   */
  it('leaves the list exactly where it was when the delete fails', async () => {
    const user = userEvent.setup();
    del.mockRejectedValue(new ApiError({ code: 'FORBIDDEN', status: 403 }));
    renderCard(['shopping:list:manage']);

    await openMenu(user);
    await user.click(await screen.findByText(SHOPPING_RU.deleteList));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: SHOPPING_RU.deleteList,
      }),
    );

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    expect(cachedList()?.name).toBe('Продукты');
    expect(screen.getByText('Продукты')).toBeInTheDocument();
  });
});

describe('renaming a list', () => {
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  /**
   * Rename is the one list operation that *is* safe to do optimistically: every
   * field is reversible and the previous row is held for the rollback. The
   * assertion below is the whole contract — the new name is on screen before
   * the request lands, and the old one is back if it never does.
   */
  it('shows the new name immediately and puts the old one back when the patch fails', async () => {
    qc.setQueryData(shoppingKeys.list(false), [listRow()]);

    let reject: (error: unknown) => void = () => undefined;
    patch.mockReturnValue(
      new Promise((_resolve, rejectFn: (error: unknown) => void) => {
        reject = rejectFn;
      }),
    );

    const { result } = renderHook(() => useUpdateList(LIST_ID), { wrapper });

    act(() => {
      result.current.mutate({ name: 'Овощи' });
    });
    await waitFor(() => {
      expect(cachedList()?.name).toBe('Овощи');
    });

    act(() => {
      reject(new ApiError({ code: 'VALIDATION_ERROR', status: 400 }));
    });

    await waitFor(() => {
      expect(cachedList()?.name).toBe('Продукты');
    });
    expect(notifyError).toHaveBeenCalled();
  });

  it('archives by taking the card off the active list, not by labelling it', async () => {
    qc.setQueryData(shoppingKeys.list(false), [listRow()]);
    qc.setQueryData(shoppingKeys.list(true), [listRow()]);
    patch.mockResolvedValue(listRow({ isArchived: true }));

    const { result } = renderHook(() => useUpdateList(LIST_ID), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ isArchived: true });
    });

    // Gone from the query the overview reads…
    expect(qc.getQueryData<ShoppingListResponse[]>(shoppingKeys.list(false))).toEqual([]);
    // …and still present, flagged, in the one `ListPage` reads.
    expect(
      qc.getQueryData<ShoppingListResponse[]>(shoppingKeys.list(true))?.[0]?.isArchived,
    ).toBe(true);
  });
});


/* -------------------------------------------------------------------------- */
/* Editing one line                                                           */
/* -------------------------------------------------------------------------- */

describe('editing an item', () => {
  function hookWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  function renderRow(overrides: { shopMode?: boolean; canWrite?: boolean } = {}) {
    return render(
      <ul>
        <ItemRow
          item={serverRow()}
          pending={false}
          shopMode={overrides.shopMode ?? false}
          canWrite={overrides.canWrite ?? true}
          onToggle={() => undefined}
          onEdit={() => undefined}
          onDelete={() => undefined}
        />
      </ul>,
    );
  }

  /**
   * One 44px control on the far side, holding both actions — the same footprint
   * the bare delete button used to have. The «купил» target must not shrink to
   * make room for a correction nobody makes mid-aisle.
   */
  it('keeps edit and delete behind a single overflow control', async () => {
    const user = userEvent.setup();
    renderRow();

    // The row is still one big checkbox, and the menu has not eaten a second
    // slot next to it.
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    const triggers = screen.getAllByRole('button', { name: SHOPPING_RU.itemActions });
    expect(triggers).toHaveLength(1);

    await user.click(triggers[0]!);

    expect(await screen.findByText(SHOPPING_RU.editItem)).toBeInTheDocument();
    expect(screen.getByText(SHOPPING_RU.deleteItem)).toBeInTheDocument();
  });

  it('offers nothing but the tick in shop mode', () => {
    renderRow({ shopMode: true });

    expect(screen.queryByRole('button', { name: SHOPPING_RU.itemActions })).toBeNull();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('offers nothing at all to a reader without shopping:write', () => {
    renderRow({ canWrite: false });

    expect(screen.queryByRole('button', { name: SHOPPING_RU.itemActions })).toBeNull();
  });

  it('shows the corrected quantity at once and restores it when the patch fails', async () => {
    qc.setQueryData<ItemsCache>(shoppingKeys.items(LIST_ID), {
      items: [serverRow({ quantity: 2 })],
      nextCursor: null,
    });

    let reject: (error: unknown) => void = () => undefined;
    patch.mockReturnValue(
      new Promise((_resolve, rejectFn: (error: unknown) => void) => {
        reject = rejectFn;
      }),
    );

    const { result } = renderHook(() => useUpdateItem(LIST_ID), { wrapper: hookWrapper });

    act(() => {
      result.current.mutate({ itemId: 'server-1', body: { quantity: 3 } });
    });
    await waitFor(() => {
      expect(cache()?.items[0]?.quantity).toBe(3);
    });
    // A partial patch must not blank the fields it never mentioned.
    expect(cache()?.items[0]?.unit).toBe('шт');
    expect(cache()?.items[0]?.name).toBe('Молоко');

    act(() => {
      reject(new ApiError({ code: 'VALIDATION_ERROR', status: 400 }));
    });

    await waitFor(() => {
      expect(cache()?.items[0]?.quantity).toBe(2);
    });
    expect(notifyError).toHaveBeenCalled();
  });
});
