import { act, render, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesResponse, RevisionMap } from '@family/shared';
import { clearAccessToken, setAccessToken } from '@/shared/api/token-store';
import { registerSyncActivitySource } from './activity';
import { useChangeFeed } from './use-change-feed';

/**
 * The change feed as it actually behaves, against a real `QueryClient`.
 *
 * The interesting half of this file is the second `describe`. Everything else
 * is scaffolding for it.
 */

const ITEMS_KEY = ['shopping', 'items', 'L1'] as const;

interface Item {
  id: string;
  name: string;
  bought: boolean;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The counters the next `GET /api/changes` will answer with. */
let nextRev: RevisionMap = {};
let failWith: number | null = null;
let fetchCount = 0;

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/api/changes')) {
        return Promise.resolve(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'no' } }));
      }
      fetchCount += 1;
      if (failWith !== null) {
        return Promise.resolve(
          jsonResponse(failWith, { error: { code: 'INTERNAL', message: 'boom' } }),
        );
      }
      return Promise.resolve(jsonResponse(200, { rev: nextRev } satisfies ChangesResponse));
    }),
  );
}

function makeClient(retry: number | false = false): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry, retryDelay: 0, gcTime: 5 * 60_000 },
      mutations: { retry: false },
    },
  });
}

function Feed(): null {
  useChangeFeed();
  return null;
}

/**
 * Wait until the hook has actually *seen* a response.
 *
 * Two traps, and both of them silently turn this file into a test of nothing:
 *
 * - `fetchCount` counts requests **issued**, not answered, and
 *   `refetchQueries` defaults to `cancelRefetch: true` — so provoking the next
 *   poll while the first is still in flight throws the first answer away, and
 *   the baseline the diff is supposed to compare against never exists.
 * - A response that lands outside `act()` leaves React's update queued; a later
 *   `act()` then renders only the newest cache value, skipping the intermediate
 *   counters entirely.
 *
 * So: wait for the value to be in the cache, then flush React.
 */
async function settled(client: QueryClient, rev: RevisionMap): Promise<void> {
  await waitFor(() => {
    expect(client.getQueryData<ChangesResponse>(['changes'])?.rev).toEqual(rev);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** Provoke one more poll and let the hook see the answer. */
async function tick(client: QueryClient, rev: RevisionMap): Promise<void> {
  await act(async () => {
    await client.refetchQueries({ queryKey: ['changes'] });
  });
  await settled(client, rev);
}

beforeEach(() => {
  nextRev = {};
  failWith = null;
  fetchCount = 0;
  setAccessToken('access-token');
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearAccessToken();
});

describe('a change tick invalidates the domains that moved', () => {
  it('invalidates the keys of the changed domain and nothing else', async () => {
    const client = makeClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    nextRev = { shopping: 1, tasks: 7 };
    render(
      <QueryClientProvider client={client}>
        <Feed />
      </QueryClientProvider>,
    );

    // The first response is a baseline: it must invalidate nothing at all.
    await settled(client, { shopping: 1, tasks: 7 });
    expect(invalidate).not.toHaveBeenCalled();

    nextRev = { shopping: 2, tasks: 7 };
    await tick(client, nextRev);

    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toEqual([['shopping'], ['dashboard']]);
    for (const call of invalidate.mock.calls) {
      // `active` only: an unmounted query is marked stale and refreshes on
      // mount, so nothing is fetched that nobody is looking at.
      expect(call[0]?.refetchType).toBe('active');
    }
  });

  it('does not invalidate a domain that merely disappeared', async () => {
    const client = makeClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    nextRev = { shopping: 4, goals: 2 };
    render(
      <QueryClientProvider client={client}>
        <Feed />
      </QueryClientProvider>,
    );
    await settled(client, { shopping: 4, goals: 2 });

    // The caller lost `goal:read` — the server stops sending the number.
    nextRev = { shopping: 4 };
    await tick(client, nextRev);

    expect(invalidate).not.toHaveBeenCalled();
  });
});

/**
 * **The named regression test** (D12, `sync.md` §8.2).
 *
 * An invalidation landing while an optimistic write is in flight refetches the
 * server's pre-mutation state and flashes the user's tick back off. On the
 * shopping list — the screen polling fastest — that is the most visible bug the
 * feed could introduce. If someone later "simplifies" `flush()` by dropping the
 * `isMutating()` guard, this is what stops them.
 */
describe('a change tick does not revert an in-flight optimistic update', () => {
  it('holds the invalidation until the mutation settles', async () => {
    const client = makeClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    client.setQueryData<Item[]>([...ITEMS_KEY], [{ id: 'i1', name: 'Молоко', bought: false }]);

    /**
     * Every value the item cache holds from the tap onwards, so a flicker
     * cannot hide between two assertions.
     */
    const boughtHistory: boolean[] = [];
    let recording = false;
    client.getQueryCache().subscribe(() => {
      if (!recording) return;
      const bought = client.getQueryData<Item[]>([...ITEMS_KEY])?.[0]?.bought;
      if (bought !== undefined) boughtHistory.push(bought);
    });

    let resolveToggle: (() => void) | undefined;
    const toggled = new Promise<void>((resolve) => {
      resolveToggle = resolve;
    });

    let toggle: (() => void) | undefined;

    function ToggleProbe(): null {
      const qc = useQueryClient();
      const mutation = useMutation({
        mutationFn: () => toggled,
        onMutate: () => {
          qc.setQueryData<Item[]>([...ITEMS_KEY], (items) =>
            (items ?? []).map((item) => ({ ...item, bought: true })),
          );
        },
      });
      toggle = () => {
        mutation.mutate();
      };
      return null;
    }

    nextRev = { shopping: 1 };
    render(
      <QueryClientProvider client={client}>
        <Feed />
        <ToggleProbe />
      </QueryClientProvider>,
    );
    await settled(client, { shopping: 1 });

    // 1. The user ticks «молоко». The optimistic value is in the cache and the
    //    request has not answered yet.
    recording = true;
    act(() => {
      toggle?.();
    });
    expect(client.getQueryData<Item[]>([...ITEMS_KEY])?.[0]?.bought).toBe(true);
    expect(client.isMutating()).toBe(1);

    // 2. Somebody else's write lands and the feed sees `shopping` move.
    nextRev = { shopping: 2 };
    await tick(client, nextRev);

    // Nothing may be invalidated: a refetch here answers with the server's
    // pre-tick state and turns the checkbox back off under the user's finger.
    expect(invalidate).not.toHaveBeenCalled();
    expect(client.getQueryData<Item[]>([...ITEMS_KEY])?.[0]?.bought).toBe(true);

    // 3. The mutation settles — and the held invalidation lands immediately,
    //    without waiting for the next poll.
    await act(async () => {
      resolveToggle?.();
      await toggled;
    });

    await waitFor(() => {
      expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(['shopping']);
    });
    expect(client.getQueryData<Item[]>([...ITEMS_KEY])?.[0]?.bought).toBe(true);
    // …and it was never anything else in between.
    expect(boughtHistory.length).toBeGreaterThan(0);
    expect(boughtHistory.every(Boolean)).toBe(true);
  });

  it('holds it for the shopping outbox too, which is not a mutation at all', async () => {
    // The outbox is a durable IndexedDB queue, so `isMutating()` is blind to
    // it. `providers.tsx` registers it as an activity source; this is the
    // behaviour that registration buys.
    const client = makeClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    let busy = true;
    let notify: (() => void) | undefined;
    const unregister = registerSyncActivitySource({
      subscribe: (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
      isBusy: () => busy,
    });

    try {
      nextRev = { shopping: 1 };
      render(
        <QueryClientProvider client={client}>
          <Feed />
        </QueryClientProvider>,
      );
      await settled(client, { shopping: 1 });

      nextRev = { shopping: 2 };
      await tick(client, nextRev);
      expect(invalidate).not.toHaveBeenCalled();

      // The queue drains and says so.
      await act(async () => {
        busy = false;
        notify?.();
        await Promise.resolve();
      });

      expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(['shopping']);
    } finally {
      unregister();
    }
  });
});

describe('degraded mode', () => {
  it('backs the poll off to a minute when the route is missing entirely', async () => {
    // The half-landed-deploy case: `/api/changes` 404s, and a 404 is never
    // retried, so the failure only shows up one fetch at a time. Three of them
    // and the feed steps out of the way instead of costing the family four
    // failing requests a minute forever.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const client = makeClient();
    failWith = 404;
    render(
      <QueryClientProvider client={client}>
        <Feed />
      </QueryClientProvider>,
    );

    // 0 s, 15 s, 30 s — the third failure latches degraded mode, so the next
    // poll is scheduled a minute out rather than fifteen seconds out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
    });
    const duringBackoff = fetchCount;
    expect(duringBackoff).toBeGreaterThanOrEqual(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
    });
    // Without the backoff this window alone would have added three more.
    expect(fetchCount - duringBackoff).toBeLessThanOrEqual(1);
  });

  it('falls back to a blanket refresh after three failures, and stops on success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Two retries, matching the app's own `shouldRetry`, so one failed fetch
    // reaches three attempts.
    const client = makeClient(2);
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    failWith = 500;
    render(
      <QueryClientProvider client={client}>
        <Feed />
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => {
      expect(fetchCount).toBeGreaterThanOrEqual(3);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    const blanket = invalidate.mock.calls.filter((call) => call[0]?.queryKey === undefined);
    expect(blanket.length).toBeGreaterThan(0);
    expect(blanket[0]?.[0]?.refetchType).toBe('active');

    // The feed recovers; the fallback must stop, or the app quietly refetches
    // everything once a minute forever.
    failWith = null;
    nextRev = { shopping: 1 };
    await tick(client, nextRev);

    const before = invalidate.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    const after = invalidate.mock.calls.filter((call) => call[0]?.queryKey === undefined).length;
    expect(after).toBe(blanket.length);
    expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(before);
  });
});
