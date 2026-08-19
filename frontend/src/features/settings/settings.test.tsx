import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { LinkedIdentityList } from '@family/shared';

import { parsePushPayload, notificationOptions, safeNavigatePath } from './push/payload';
import { ackKey, ackPath, postAck } from './push/ack-queue';
import {
  enablePush,
  isPushSupported,
  permissionState,
  pushAvailability,
  reconcileSubscription,
  setPrimedRegistration,
} from './push/push';
import { canUnlink } from './api';
import AccountsPage from './pages/AccountsPage';

/**
 * The tests that matter for this feature are not "does the switch flip" — they
 * are the four platform rules whose violation fails **silently in production**
 * on exactly one device family:
 *
 *  1. feature detection must not crash where `Notification` is `undefined`;
 *  2. `Notification.requestPermission()` must not be preceded by an `await`;
 *  3. the foreground reconcile loop must re-POST a live subscription and report
 *     `missing` when the browser dropped one;
 *  4. the push payload parser must never throw, whatever arrives.
 *
 * Plus the one UX rule with a support cost attached: `LAST_LOGIN_METHOD` is
 * explained before it is attempted, never surfaced as an error afterwards.
 */

const ORIGIN = 'https://family.example.com';

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** jsdom has no `navigator.serviceWorker`; `isPushSupported()` requires one. */
function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { ready: new Promise(() => undefined), addEventListener: vi.fn() },
      configurable: true,
    });
  }
}

function stubNotification(permission: NotificationPermission, request?: () => Promise<string>) {
  ensureServiceWorker();
  const requestPermission = vi.fn(request ?? (() => Promise.resolve(permission)));
  const NotificationStub = function NotificationStub() {
    /* constructor never used in these tests */
  } as unknown as typeof Notification;
  Object.defineProperty(NotificationStub, 'permission', { value: permission, configurable: true });
  Object.defineProperty(NotificationStub, 'requestPermission', {
    value: requestPermission,
    configurable: true,
  });
  vi.stubGlobal('Notification', NotificationStub);
  vi.stubGlobal('PushManager', function PushManagerStub() {});
  return requestPermission;
}

function stubServiceWorker(subscription: unknown) {
  const registration = {
    pushManager: {
      getSubscription: vi.fn(() => Promise.resolve(subscription)),
      subscribe: vi.fn(() => Promise.resolve(subscription)),
    },
  } as unknown as ServiceWorkerRegistration;
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { ready: Promise.resolve(registration), addEventListener: vi.fn() },
    configurable: true,
  });
  setPrimedRegistration(registration);
  return registration;
}

function fakeSubscription(endpoint = `${ORIGIN}/push/abc`) {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' }, expirationTime: null }),
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  } as unknown as PushSubscription;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setPrimedRegistration(null);
});

/* -------------------------------------------------------------------------- */
/* 1. feature detection                                                        */
/* -------------------------------------------------------------------------- */

describe('push feature detection', () => {
  it('does not crash when `Notification` is undefined (iOS Safari tab)', () => {
    // This is the real shape of a non-installed iOS PWA: `window.Notification`
    // is absent, NOT `'denied'`. Reading `Notification.permission` here throws a
    // ReferenceError and takes the whole settings screen down.
    vi.stubGlobal('Notification', undefined);
    vi.stubGlobal('PushManager', undefined);
    // `stubGlobal(undefined)` leaves the key present, so delete it outright.
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'Notification');
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'PushManager');

    expect(() => isPushSupported()).not.toThrow();
    expect(isPushSupported()).toBe(false);
    expect(() => permissionState()).not.toThrow();
    expect(permissionState()).toBe('unsupported');
    expect(['unsupported', 'needs-install']).toContain(pushAvailability());
  });

  it('reports the real permission once the API exists', () => {
    stubNotification('denied');
    expect(isPushSupported()).toBe(true);
    expect(permissionState()).toBe('denied');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. the user gesture                                                         */
/* -------------------------------------------------------------------------- */

describe('permission request', () => {
  it('calls requestPermission synchronously, with no await before it', () => {
    // WebKit's user-activation token does not survive an intervening `await`.
    // If anything is awaited before `requestPermission()`, the call lands in a
    // later microtask and Safari silently refuses both the prompt and
    // `subscribe()`. Asserting *synchronously* after the call is what pins that.
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'BJ_test_key');
    const requestPermission = stubNotification('default', () => Promise.resolve('default'));
    stubServiceWorker(fakeSubscription());

    const promise = enablePush();

    // No `await` yet — this must already have happened.
    expect(requestPermission).toHaveBeenCalledTimes(1);

    return promise.then((result) => {
      // 'default' means the user dismissed rather than granted.
      expect(result.outcome).toBe('dismissed');
    });
  });

  it('never fires the one-shot OS prompt when push is unsupported', () => {
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'Notification');
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'PushManager');

    return enablePush().then((result) => {
      expect(['unsupported', 'needs-install']).toContain(result.outcome);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 3. the reconcile loop                                                       */
/* -------------------------------------------------------------------------- */

describe('foreground reconcile', () => {
  beforeEach(() => {
    stubNotification('granted');
  });

  it('re-posts an existing subscription (idempotent upsert)', async () => {
    stubServiceWorker(fakeSubscription());
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'sub-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(reconcileSubscription()).resolves.toBe('reposted');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/notifications/subscriptions');
    expect(init.method).toBe('POST');
  });

  it('reports `missing` when the browser dropped the subscription', async () => {
    // Permission is still granted but `getSubscription()` returns null — the
    // exact state iOS leaves behind, and the one that has no silent repair
    // because `pushsubscriptionchange` never fires there. This is what raises
    // «Уведомления отключились — включить снова?».
    stubServiceWorker(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(reconcileSubscription()).resolves.toBe('missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when permission was never granted', async () => {
    stubNotification('default');
    stubServiceWorker(fakeSubscription());
    await expect(reconcileSubscription()).resolves.toBe('not-permitted');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. the service-worker payload parser                                        */
/* -------------------------------------------------------------------------- */

describe('push payload parser', () => {
  it('unwraps the hybrid Declarative Web Push envelope', () => {
    const raw = JSON.stringify({
      web_push: 8030,
      notification: {
        title: 'Ужин в 19:00',
        body: 'Сегодня твоя очередь готовить',
        navigate: `${ORIGIN}/tasks/42`,
        app_badge: 3,
        mutable: true,
        data: { type: 'task_reminder', deliveryId: 'del-1' },
      },
    });

    const parsed = parsePushPayload(raw, ORIGIN);

    expect(parsed.declarative).toBe(true);
    expect(parsed.fallback).toBe(false);
    expect(parsed.title).toBe('Ужин в 19:00');
    expect(parsed.navigate).toBe('/tasks/42');
    expect(parsed.appBadge).toBe(3);
    expect(parsed.deliveryId).toBe('del-1');
  });

  it('reads a plain (non-declarative) payload', () => {
    const parsed = parsePushPayload(
      JSON.stringify({ title: 'Задача просрочена', body: 'Вынести мусор', link: '/tasks/7' }),
      ORIGIN,
    );
    expect(parsed.declarative).toBe(false);
    expect(parsed.title).toBe('Задача просрочена');
    expect(parsed.navigate).toBe('/tasks/7');
    expect(parsed.deliveryId).toBeNull();
  });

  it('never throws, whatever arrives, and always yields a showable title', () => {
    // Every one of these has been seen in the wild. Any throw here means the
    // `push` handler rejects, no notification is shown, and three of those cost
    // us the subscription on iOS.
    const inputs: (string | null | undefined)[] = [
      null,
      undefined,
      '',
      '   ',
      '{not json',
      '[]',
      'null',
      '{}',
      '{"web_push":8030}',
      '{"web_push":8030,"notification":null}',
      '{"web_push":8030,"notification":{"navigate":"javascript:alert(1)"}}',
      '<!doctype html><html><body>502 Bad Gateway</body></html>',
      JSON.stringify({ title: 'x', navigate: 'https://evil.example/steal' }),
      JSON.stringify({ title: 'x', navigate: '//evil.example' }),
    ];

    for (const input of inputs) {
      const parsed = parsePushPayload(input, ORIGIN);
      expect(parsed.title.length).toBeGreaterThan(0);
      expect(parsed.navigate.startsWith('/')).toBe(true);
      expect(parsed.navigate.startsWith('//')).toBe(false);
      // The options object must be constructible too — it is what the SW passes
      // straight into `showNotification`.
      expect(() => notificationOptions(parsed)).not.toThrow();
    }
  });

  it('confines navigation to this origin', () => {
    expect(safeNavigatePath('https://evil.example/x', ORIGIN)).toBe('/');
    expect(safeNavigatePath('//evil.example/x', ORIGIN)).toBe('/');
    expect(safeNavigatePath('/tasks/1?x=2', ORIGIN)).toBe('/tasks/1?x=2');
    expect(safeNavigatePath(`${ORIGIN}/goals/9`, ORIGIN)).toBe('/goals/9');
    expect(safeNavigatePath(undefined, ORIGIN)).toBe('/');
  });

  it('does not build options that depend on iOS-ignored fields', () => {
    const parsed = parsePushPayload(JSON.stringify({ title: 'a', body: 'b' }), ORIGIN);
    const options = notificationOptions(parsed) as Record<string, unknown>;
    // iOS ignores all of these; behaviour must never be built on them.
    expect(options.actions).toBeUndefined();
    expect(options.icon).toBeUndefined();
    expect(options.renotify).toBeUndefined();
    expect(options.requireInteraction).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 4b. the D11 ack contract                                                    */
/* -------------------------------------------------------------------------- */

describe('delivery ack contract (D11)', () => {
  it('targets the two documented endpoints', () => {
    expect(ackPath('del-1', 'delivered')).toBe('/notifications/deliveries/del-1/delivered');
    expect(ackPath('del-1', 'interacted')).toBe('/notifications/deliveries/del-1/interacted');
    // Replaying the same receipt must collapse to one queue row.
    expect(ackKey('del-1', 'delivered')).toBe(ackKey('del-1', 'delivered'));
    expect(ackKey('del-1', 'delivered')).not.toBe(ackKey('del-1', 'interacted'));
  });

  it('never throws and never posts without a token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const ack = {
      key: ackKey('del-1', 'delivered'),
      deliveryId: 'del-1',
      kind: 'delivered' as const,
      occurredAt: '2026-08-19T10:00:00.000Z',
      queuedAt: '2026-08-19T10:00:00.000Z',
    };

    // No window open → no borrowed token → queue it rather than burn a 401.
    await expect(postAck(ack, { apiBase: ORIGIN, token: null })).resolves.toEqual({
      ok: false,
      retryable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // A hard failure resolves rather than rejecting: an ack that throws inside
    // `event.waitUntil()` fails the push, and three of those cost the
    // subscription on iOS.
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
    await expect(postAck(ack, { apiBase: ORIGIN, token: 't' })).resolves.toEqual({
      ok: false,
      retryable: true,
    });

    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 200 })));
    const result = await postAck(ack, { apiBase: ORIGIN, token: 't' });
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${ORIGIN}/api/notifications/deliveries/del-1/delivered`);
    expect(init.method).toBe('POST');
    // `occurredAt` travels with the ack; the server clamps it.
    expect(JSON.parse(String(init.body)) as unknown).toEqual({
      occurredAt: '2026-08-19T10:00:00.000Z',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 5. unbinding the last login method                                          */
/* -------------------------------------------------------------------------- */

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/settings/accounts']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function identitiesResponse(providers: string[]): LinkedIdentityList {
  return {
    items: providers.map((provider, index) => ({
      provider: provider as LinkedIdentityList['items'][number]['provider'],
      providerUsername: null,
      providerEmail: `me@example.com`,
      linkedAt: '2026-01-01T10:00:00.000Z',
      isPrimary: index === 0,
    })),
    available: [],
  };
}

describe('unbinding the last login method', () => {
  beforeEach(() => {
    stubNotification('granted');
  });

  it('is explained before it is attempted, and the button is not offered', async () => {
    // The server answers `403 LAST_LOGIN_METHOD`, but a user who gets that far
    // has already been told "нет" by a screen that looked like it would work.
    // The explanation has to arrive first.
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(identitiesResponse(['google'])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<AccountsPage />);

    await waitFor(() => {
      expect(screen.getByText('Это единственный способ войти')).toBeInTheDocument();
    });
    expect(screen.getByText(/Сначала добавьте второй способ входа/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отвязать' })).not.toBeInTheDocument();

    // And no DELETE was ever issued.
    for (const call of fetchMock.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(init.method).not.toBe('DELETE');
    }
  });

  it('offers unbinding once a second method exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(identitiesResponse(['google', 'telegram'])), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );

    renderWithProviders(<AccountsPage />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Отвязать' })).toHaveLength(2);
    });
    expect(screen.queryByText('Это единственный способ войти')).not.toBeInTheDocument();

    // The confirmation still names the consequence before anything is sent.
    await userEvent.click(screen.getAllByRole('button', { name: 'Отвязать' })[0]!);
    await waitFor(() => {
      expect(screen.getByText(/больше не получится/)).toBeInTheDocument();
    });
  });

  it('canUnlink() mirrors the server guard', () => {
    expect(canUnlink(identitiesResponse([]))).toBe(false);
    expect(canUnlink(identitiesResponse(['google']))).toBe(false);
    expect(canUnlink(identitiesResponse(['google', 'telegram']))).toBe(true);
    expect(canUnlink(undefined)).toBe(false);
  });
});
