import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The service worker's `fetch` handler, and the one rule that turned out to
 * matter: **an in-scope navigation must always be answered.**
 *
 * With navigation preload enabled (`activate`), the browser sends the
 * navigation request *before* this handler runs. Returning without calling
 * `respondWith()` does not cancel that request — it makes the browser send a
 * second one and use that instead, and the first response is thrown away.
 *
 * `/api/**` was excluded from the handler entirely, which is how a Telegram
 * link produced two `GET /api/auth/telegram/callback` requests: the discarded
 * first one redeemed the one-time `state` and attached the identity, and the
 * one the user saw found the state spent and answered `400 BAD_REQUEST`.
 *
 * These tests pin the shape rather than the browser: exactly one network
 * request per navigation, no cached shell served for an API path, and the SW
 * still keeps its hands off ordinary API `fetch()` calls.
 */

interface FakeFetchEvent {
  request: Request;
  preloadResponse: Promise<Response | undefined>;
  respondWith: ReturnType<typeof vi.fn>;
}

let fetchHandler: (event: FakeFetchEvent) => void;
let origin: string;

beforeAll(async () => {
  const scope = globalThis as unknown as Record<string, unknown>;
  // Replaced by vite-plugin-pwa at build time; the module reads it eagerly.
  scope['__WB_MANIFEST'] = [{ url: '/index.html', revision: 'test' }];

  const handlers = new Map<string, (event: never) => void>();
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: never) => {
    handlers.set(type, listener as unknown as (event: never) => void);
  }) as typeof window.addEventListener);

  await import('./sw');

  const handler = handlers.get('fetch');
  if (!handler) throw new Error('the service worker registered no fetch handler');
  fetchHandler = handler as unknown as (event: FakeFetchEvent) => void;
  origin = window.location.origin;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function navigationTo(path: string): Request {
  // jsdom's `Request` has no `mode: 'navigate'` (the constructor forbids it),
  // so the property is defined directly — the handler only ever reads it.
  const request = new Request(new URL(path, origin).href);
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
}

async function run(request: Request, preload: Response | undefined): Promise<Response> {
  const event: FakeFetchEvent = {
    request,
    preloadResponse: Promise.resolve(preload),
    respondWith: vi.fn(),
  };
  fetchHandler(event);
  expect(
    event.respondWith,
    `no response was produced for ${request.url} — the browser would request it again`,
  ).toHaveBeenCalledTimes(1);
  return (await event.respondWith.mock.calls[0]?.[0]) as Response;
}

describe('service worker — one navigation, one request', () => {
  /**
   * The regression. The callback is a top-level navigation to an API path, so
   * it hits both branches: it must be answered, and it must be answered from
   * the network rather than from anything cached.
   */
  it('answers an /api/ navigation from the preload instead of leaving it to a second fetch', async () => {
    const networkFetch = vi.fn();
    vi.stubGlobal('fetch', networkFetch);

    const preloaded = new Response(null, { status: 302, headers: { location: '/settings' } });
    const response = await run(
      navigationTo('/api/auth/telegram/callback?code=abc&state=k.xyz'),
      preloaded,
    );

    expect(response).toBe(preloaded);
    // The whole point: the preload was consumed, so nothing asked the server a
    // second time and no state was redeemed twice.
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it('falls back to its own fetch only when there is no preload to use', async () => {
    const fromNetwork = new Response('ok');
    const networkFetch = vi.fn(() => Promise.resolve(fromNetwork));
    vi.stubGlobal('fetch', networkFetch);

    const response = await run(
      navigationTo('/api/auth/google/callback?code=a&state=l.b'),
      undefined,
    );

    expect(response).toBe(fromNetwork);
    expect(networkFetch).toHaveBeenCalledTimes(1);
  });

  it('serves the app shell for an ordinary navigation that is offline', async () => {
    const shell = new Response('<!doctype html>');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    vi.stubGlobal('caches', {
      open: () => Promise.resolve({ match: () => Promise.resolve(shell) }),
      match: () => Promise.resolve(undefined),
    });

    expect(await run(navigationTo('/tasks'), undefined)).toBe(shell);
  });

  /**
   * Answering `/api/auth/...` with `index.html` would hand the browser a 200
   * page for a request that never reached the server. An honest 503 is the only
   * correct offline answer for an API navigation.
   */
  it('never answers an /api/ navigation with the cached shell', async () => {
    const shell = new Response('<!doctype html>');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    vi.stubGlobal('caches', {
      open: () => Promise.resolve({ match: () => Promise.resolve(shell) }),
      match: () => Promise.resolve(undefined),
    });

    const response = await run(
      navigationTo('/api/auth/telegram/callback?code=a&state=k.b'),
      undefined,
    );

    expect(response).not.toBe(shell);
    expect(response.status).toBe(503);
  });

  /**
   * The SW must still stay entirely out of the app's own API calls: those carry
   * the in-memory bearer token, are never navigations, and are never cached.
   */
  it('leaves an ordinary API fetch alone', () => {
    const event: FakeFetchEvent = {
      request: new Request(new URL('/api/me', origin).href),
      preloadResponse: Promise.resolve(undefined),
      respondWith: vi.fn(),
    };
    fetchHandler(event);
    expect(event.respondWith).not.toHaveBeenCalled();
  });
});
