import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { LinkedIdentityList, MeResponse } from '@family/shared';

import { InstallPrompt } from '@/features/auth/components/InstallPrompt';
import {
  INSTALL_DISMISSED_KEY,
  INSTALL_ENGAGEMENT_KEY,
  recordEngagement,
} from '@/features/auth/components/install';
import { parsePushPayload, notificationOptions, safeNavigatePath } from './push/payload';
import { ackKey, ackPath, postAck } from './push/ack-queue';
import {
  PUSH_STARTUP_GRACE_MS,
  enablePush,
  isPushReady,
  isPushSupported,
  permissionState,
  primeRegistration,
  pushAvailability,
  pushReadiness,
  reconcileSubscription,
  setPrimedRegistration,
  setPrimedVapidKeyForTests,
} from './push/push';
import {
  PUSH_PROMPT_DISMISSED_KEY,
  PUSH_PROMPT_SHOWN_KEY,
  dismissPushPrompt,
  shouldOfferPushPrompt,
} from './push/onboarding';
import { PushOnboarding } from './push/PushOnboarding';
import { SETTINGS_RU } from './locale';
import { canUnlink } from './api';
import AccountsPage from './pages/AccountsPage';
import ProfilePage from './pages/ProfilePage';

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
    // `active` is load-bearing, not decoration: `enablePush()` refuses to call
    // `subscribe()` without it, because WebKit throws `InvalidStateError`
    // against a worker that is only installing.
    active: {},
    waiting: null,
    installing: null,
    scope: `${ORIGIN}/`,
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
  it('reaches pushManager.subscribe() synchronously, and never calls requestPermission', () => {
    // The platform requirement is *transient activation*: five seconds from the
    // tap, and **consumed by the first caller**. `PushManager::subscribe` does
    // the prompting itself, so `subscribe()` must be the call that spends it.
    //
    // `Notification.requestPermission()` consumes the activation
    // unconditionally — before it even decides whether to prompt — so calling
    // it first leaves `subscribe()` with nothing and produces
    // `NotAllowedError: Push notification prompting can only be done from a
    // user gesture.` for what is really a Settings problem. This module used to
    // do exactly that; the assertion that it is *not* called is the point.
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'BJ_test_key');
    const requestPermission = stubNotification('default');
    const registration = stubServiceWorker(fakeSubscription());
    const subscribe = registration.pushManager.subscribe;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 'sub-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );

    const promise = enablePush();

    // No `await` yet — this must already have happened.
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }) as unknown as PushSubscriptionOptionsInit,
    );
    expect(requestPermission).not.toHaveBeenCalled();

    return promise.then((result) => {
      expect(result.outcome).toBe('enabled');
    });
  });

  it('never touches the push APIs when push is unsupported', () => {
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'Notification');
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'PushManager');

    return enablePush().then((result) => {
      expect(['unsupported', 'needs-install']).toContain(result.outcome);
    });
  });

  it('subscribes anyway when the worker is not active, and reports what WebKit said', () => {
    // The inversion. This used to refuse pre-emptively whenever
    // `registration.active` was null, on the theory that `subscribe()` would
    // only throw `InvalidStateError` anyway — but the readiness signal behind
    // it could be false *for ever* (`navigator.serviceWorker.ready` has no
    // rejection path), and the refusal we invented carried no error a user
    // could paste to anybody. WebKit's own sentence is greppable and
    // documented; ours was neither.
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'BJ_test_key');
    stubNotification('default');
    const thrown = new Error('Subscribing for push requires an active service worker');
    thrown.name = 'InvalidStateError';
    const subscribe = vi.fn(() => Promise.reject(thrown));
    setPrimedRegistration({
      active: null,
      waiting: null,
      installing: {},
      pushManager: { subscribe, getSubscription: vi.fn(() => Promise.resolve(null)) },
    } as unknown as ServiceWorkerRegistration);

    const promise = enablePush();

    // The attempt is made — synchronously, inside the tap's activation window.
    expect(subscribe).toHaveBeenCalledTimes(1);

    return promise.then((result) => {
      expect(result.outcome).toBe('not-ready');
      // Verbatim, and from the platform rather than from us.
      expect(result.error?.name).toBe('InvalidStateError');
      expect(result.error?.message).toBe('Subscribing for push requires an active service worker');
    });
  });

  it('reports a real absence of a registration instead of pretending to wait', () => {
    // The other half: nothing to call `subscribe()` on at all. Still an
    // attempt-shaped answer with a cause attached, never «подождите ещё».
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'BJ_test_key');
    stubNotification('default');
    ensureServiceWorker();
    setPrimedRegistration(null);

    return enablePush().then((result) => {
      expect(result.outcome).toBe('not-ready');
      expect(result.error?.message).toContain('No service worker registration');
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 2b. readiness — the signal that must not be derived from `controller`       */
/* -------------------------------------------------------------------------- */

describe('push readiness', () => {
  /**
   * A registration with an **active** worker that does *not* control this page.
   *
   * This is the literal state of a first launch after an install:
   * `navigator.serviceWorker.controller` is `null` until the worker claims the
   * page or the page reloads, while `subscribe()` would succeed. Every stub
   * here sets `controller: null` on purpose.
   */
  function stubUncontrolledButActive() {
    const registration = {
      active: { state: 'activated' },
      waiting: null,
      installing: null,
      scope: `${ORIGIN}/`,
      addEventListener: vi.fn(),
      pushManager: {
        getSubscription: vi.fn(() => Promise.resolve(null)),
        subscribe: vi.fn(() => Promise.resolve(fakeSubscription())),
      },
    } as unknown as ServiceWorkerRegistration;

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        // The correct primitive: resolves on an active *registration*,
        // regardless of whether this page is controlled.
        ready: Promise.resolve(registration),
        getRegistration: vi.fn(() => Promise.resolve(registration)),
        // The trap. Anything derived from this is false on a first launch.
        controller: null,
        addEventListener: vi.fn(),
      },
    });
    return registration;
  }

  it('is ready on a first launch, where the page is not yet controlled', async () => {
    // The regression test the fix exists for. Derive readiness from
    // `navigator.serviceWorker.controller` — directly, or via anything that
    // means "is this page controlled" — and this fails.
    setPrimedVapidKeyForTests('BJ_test_key');
    stubNotification('default');
    stubUncontrolledButActive();
    setPrimedRegistration(null);

    expect(navigator.serviceWorker.controller).toBeNull();

    await primeRegistration();

    expect(pushReadiness()).toBe('ready');
    expect(isPushReady()).toBe(true);
  });

  it('becomes ready when the VAPID key lands after the worker does', async () => {
    // The latch. `serviceWorker.ready` resolves in a tick on a warm start while
    // `GET /notifications/vapid-public-key` takes a round trip, so a readiness
    // value computed once — when the registration arrived — was false and
    // stayed false for the whole session, with the enable button dead behind
    // it. Readiness has to be re-read, not sampled.
    // The build-time variable must be genuinely empty here: this is the
    // deployment where the key is served by the API instead of baked in, which
    // is precisely the deployment that exposed the latch.
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '');
    setPrimedVapidKeyForTests('');
    stubNotification('default');
    stubUncontrolledButActive();
    setPrimedRegistration(null);

    await primeRegistration();
    expect(isPushReady()).toBe(false);

    setPrimedVapidKeyForTests('BJ_test_key');
    expect(isPushReady()).toBe(true);
  });

  it('does not resolve readiness from a pending `ready` promise', async () => {
    // The shape of the owner's phone: the worker never activates, so
    // `serviceWorker.ready` stays pending. `primeRegistration()` must still
    // settle — the previous version awaited it and hung for ever — and the
    // answer must be an honest "not ready", not an eternal "starting".
    setPrimedVapidKeyForTests('BJ_test_key');
    stubNotification('default');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: new Promise(() => undefined),
        getRegistration: vi.fn(() => Promise.resolve(undefined)),
        controller: null,
        addEventListener: vi.fn(),
      },
    });
    setPrimedRegistration(null);

    vi.useFakeTimers();
    try {
      const settled = primeRegistration();
      await vi.advanceTimersByTimeAsync(PUSH_STARTUP_GRACE_MS + 1_000);
      await expect(settled).resolves.toBeNull();
      expect(pushReadiness()).toBe('stalled');
      expect(isPushReady()).toBe(false);
    } finally {
      vi.useRealTimers();
      setPrimedRegistration(null);
    }
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

/* -------------------------------------------------------------------------- */
/* 6. the self-raised notification offer (research doc §13)                    */
/* -------------------------------------------------------------------------- */

/**
 * The funnel is the feature. Everything below tests a *refusal*, because the
 * failure this code exists to prevent is not "the card looked wrong" — it is
 * `Notification.requestPermission()` firing at a moment the user was not ready
 * for. That prompt can be shown **once, ever**; a «Не разрешать» leaves
 * `Notification.permission` permanently `'denied'` and the only way back is iOS
 * Settings, which no family member finds.
 */

const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';

function stubUserAgent(userAgent: string, maxTouchPoints = 5): void {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: userAgent });
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    configurable: true,
    value: maxTouchPoints,
  });
}

/** The real shape of a Safari tab on iOS: the API is *absent*, not `'denied'`. */
function removeNotificationApi(): void {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'Notification');
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'PushManager');
}

/**
 * Mirrors the pair of slots `AppShell` renders, because "show the install sheet
 * instead" is a statement about the two of them together: `PushOnboarding`
 * stands down where push cannot work, and the install card is what remains.
 */
function renderShellSlots() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <InstallPrompt />
        <PushOnboarding />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Walk past the "never on first paint" delay. */
function settle(): void {
  act(() => {
    vi.advanceTimersByTime(5000);
  });
}

describe('the notification offer in the app shell', () => {
  const originalUserAgent = window.navigator.userAgent;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.removeItem(INSTALL_ENGAGEMENT_KEY);
    window.localStorage.removeItem(INSTALL_DISMISSED_KEY);
    window.localStorage.removeItem(PUSH_PROMPT_DISMISSED_KEY);
    window.localStorage.removeItem(PUSH_PROMPT_SHOWN_KEY);
    setPrimedVapidKeyForTests(
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    );
    stubServiceWorker(fakeSubscription());
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    setPrimedVapidKeyForTests('');
    stubUserAgent(originalUserAgent, 0);
  });

  it('says nothing on first paint, before the user has done anything', () => {
    stubNotification('default');

    renderShellSlots();
    // The gate is checked on a timer, so "first paint" is genuinely first paint.
    expect(screen.queryByTestId('push-offer-card')).not.toBeInTheDocument();

    settle();
    expect(screen.queryByTestId('push-offer-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('install-card')).not.toBeInTheDocument();
  });

  it('says nothing once the OS prompt has already been answered', () => {
    // Two engagements: signed in, and did something real. The only thing left
    // standing between the user and the card is the permission state.
    recordEngagement();
    recordEngagement();

    stubNotification('granted');
    renderShellSlots();
    settle();
    expect(screen.queryByTestId('push-offer-card')).not.toBeInTheDocument();
    expect(shouldOfferPushPrompt({ engaged: true })).toBe(false);

    stubNotification('denied');
    // Nothing we can render brings a denied permission back; only iOS Settings.
    expect(shouldOfferPushPrompt({ engaged: true })).toBe(false);
  });

  it('honours a «Не сейчас» for a fortnight, then may ask once more', () => {
    recordEngagement();
    recordEngagement();
    stubNotification('default');

    expect(shouldOfferPushPrompt({ engaged: true })).toBe(true);
    dismissPushPrompt();

    renderShellSlots();
    settle();
    expect(screen.queryByTestId('push-offer-card')).not.toBeInTheDocument();

    expect(shouldOfferPushPrompt({ engaged: true })).toBe(false);
    expect(
      shouldOfferPushPrompt({ engaged: true, now: Date.now() + 15 * 24 * 60 * 60 * 1000 }),
    ).toBe(true);
  });

  it('offers the install sheet instead when `Notification` does not exist', () => {
    // iPhone Safari tab. `window.Notification` is undefined here, so push cannot
    // be turned on at all — asking about notifications would be a dead end, and
    // installing is the thing that unblocks it.
    stubUserAgent(IPHONE_SAFARI_UA);
    removeNotificationApi();
    recordEngagement();
    recordEngagement();

    expect(pushAvailability()).toBe('needs-install');

    renderShellSlots();
    settle();

    expect(screen.getByTestId('install-card')).toBeInTheDocument();
    expect(screen.queryByTestId('push-offer-card')).not.toBeInTheDocument();
    expect(shouldOfferPushPrompt({ engaged: true })).toBe(false);
  });

  it('reaches the OS prompt only through an explicit yes to our own dialog', async () => {
    // The OS prompt is now raised by `pushManager.subscribe()` itself —
    // `Notification.requestPermission()` is never called, because it would
    // consume the tap's transient activation before subscribe could. So
    // "spending the one-shot prompt" is measured on `subscribe`.
    const requestPermission = stubNotification('default');
    const registration = stubServiceWorker(fakeSubscription());
    const subscribe = registration.pushManager.subscribe;
    recordEngagement();
    recordEngagement();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    renderShellSlots();
    settle();

    const card = await screen.findByTestId('push-offer-card');
    expect(card).toBeInTheDocument();
    // Merely showing the card must not have spent the one-shot prompt.
    expect(subscribe).not.toHaveBeenCalled();

    // Tap 1: our card. Opens our dialog, and still spends nothing.
    await user.click(screen.getByRole('button', { name: SETTINGS_RU.push.offerAccept }));
    await screen.findByText(SETTINGS_RU.push.promptWarning);
    expect(subscribe).not.toHaveBeenCalled();

    // Tap 2: «Разрешить» in our dialog. Only now.
    await user.click(screen.getByRole('button', { name: SETTINGS_RU.push.promptAccept }));
    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledTimes(1);
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* the profile form                                                            */
/* -------------------------------------------------------------------------- */

function meResponse(): MeResponse {
  return {
    user: {
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Тест',
      avatarUrl: null,
      color: null,
      role: 'owner',
      status: 'active',
      email: 'test@example.com',
      birthDate: null,
      timezone: 'Europe/Moscow',
      locale: 'ru-RU',
    },
    permissions: ['profile:update:own'],
    family: { name: 'Наша семья', timezone: 'Europe/Moscow', weekStartsOn: 1, currency: 'RUB' },
    permissionsVersion: 'v1',
  };
}

describe('the profile form guards its required name', () => {
  /**
   * Clearing «Имя» used to leave «Сохранить» enabled and fire
   * `PATCH /api/me {"displayName":""}`, so the only thing telling a user the
   * field was required was a server 400 arriving as a toast — after the write
   * had already been attempted. The rule is `nonEmptyString(80)` in the shared
   * contract; the form must apply it before anything reaches the network.
   */
  function stubMe() {
    const calls: RequestInit[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') calls.push(init);
      return Promise.resolve(
        new Response(JSON.stringify(meResponse()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    return calls;
  }

  it('refuses an empty name in Russian and sends no request', async () => {
    const writes = stubMe();
    renderWithProviders(<ProfilePage />);

    const name = await screen.findByLabelText('Имя');
    await userEvent.clear(name);

    // The contract's own message, not a local paraphrase of it.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Поле не может быть пустым');
    });
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(writes).toHaveLength(0);
  });

  it('refuses a whitespace-only name, which trims to empty', async () => {
    const writes = stubMe();
    renderWithProviders(<ProfilePage />);

    const name = await screen.findByLabelText('Имя');
    await userEvent.clear(name);
    await userEvent.type(name, '   ');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Поле не может быть пустым');
    });
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    expect(writes).toHaveLength(0);
  });

  it('accepts a real name again once it is typed back', async () => {
    stubMe();
    renderWithProviders(<ProfilePage />);

    const name = await screen.findByLabelText('Имя');
    await userEvent.clear(name);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    await userEvent.type(name, 'Аня');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
  });
});
