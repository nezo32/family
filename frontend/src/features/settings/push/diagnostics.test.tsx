import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { SETTINGS_RU } from '../locale';
import {
  collectPushDiagnostics,
  fingerprintEndpoint,
  formatPushDiagnostics,
  pushVerdict,
  type PushDiagnostics,
} from './diagnostics';
import { PushDiagnosticsCard } from './PushDiagnosticsCard';
import { PushSection } from './PushPrompt';
import {
  clearEnableOutcome,
  clearPushFailure,
  recordPushFailure,
  setPrimedRegistration,
  setPrimedVapidKeyForTests,
} from './push';

/**
 * Two things are pinned here, and they are the two that cost us a production
 * bug each.
 *
 * 1. **The click handler reaches `Notification.requestPermission()` without
 *    crossing a microtask boundary.** `settings.test.tsx` already pins
 *    `enablePush()` itself, but that is not where the regression lives — the
 *    danger is somebody making `usePush().enable` or an `onClick` `async`, and
 *    a unit test of the module below would still pass. So this one drives the
 *    real button through the real dialog and asserts on ordering.
 *
 * 2. **Every diagnostics branch renders**, including the states we cannot
 *    reach on any machine we own: `denied`, a missing service worker, a
 *    subscription the server has never heard of, and an environment with no
 *    push APIs at all.
 */

const APPLE_ENDPOINT = 'https://web.push.apple.com/QABC123secretcapabilityurl';
const VAPID =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

/* -------------------------------------------------------------------------- */
/* environment stubs                                                           */
/* -------------------------------------------------------------------------- */

function stubNotification(permission: NotificationPermission, onRequest?: () => void) {
  const requestPermission = vi.fn(() => {
    onRequest?.();
    return Promise.resolve(permission);
  });
  const Stub = function NotificationStub() {
    /* never constructed */
  } as unknown as typeof Notification;
  Object.defineProperty(Stub, 'permission', { value: permission, configurable: true });
  Object.defineProperty(Stub, 'requestPermission', {
    value: requestPermission,
    configurable: true,
  });
  vi.stubGlobal('Notification', Stub);
  vi.stubGlobal('PushManager', function PushManagerStub() {});
  return requestPermission;
}

function removePushApis(): void {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'Notification');
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'PushManager');
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'serviceWorker');
}

function fakeSubscription(endpoint = APPLE_ENDPOINT) {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' }, expirationTime: null }),
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  } as unknown as PushSubscription;
}

/**
 * A registration stub with `getRegistration` as well as `ready`.
 *
 * `collectPushDiagnostics()` deliberately does **not** use
 * `navigator.serviceWorker.ready` — that promise never settles when nothing is
 * registered, which would hang the diagnostics on exactly the broken device
 * they exist to describe.
 */
function stubServiceWorker(
  options: {
    subscription?: PushSubscription | null;
    registration?: 'none' | 'active' | 'installing';
    /** What `pushManager.subscribe()` does. Defaults to handing back a subscription. */
    onSubscribe?: () => Promise<PushSubscription>;
  } = {},
) {
  const { subscription = null, registration = 'active', onSubscribe } = options;

  const value =
    registration === 'none'
      ? null
      : ({
          scope: 'https://nezo.su/',
          // `active` is what `subscribe()` requires; `installing` is the first
          // launch after an install, where WebKit throws `InvalidStateError`.
          active: registration === 'active' ? {} : null,
          waiting: null,
          installing: registration === 'installing' ? {} : null,
          pushManager: {
            getSubscription: vi.fn(() => Promise.resolve(subscription)),
            subscribe: vi.fn(
              onSubscribe ?? (() => Promise.resolve(subscription ?? fakeSubscription())),
            ),
          },
        } as unknown as ServiceWorkerRegistration);

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: value ? Promise.resolve(value) : new Promise(() => undefined),
      getRegistration: vi.fn(() => Promise.resolve(value ?? undefined)),
      controller: value ? {} : null,
      addEventListener: vi.fn(),
    },
  });
  setPrimedRegistration(value);
  return value;
}

/** The shape WebKit throws. `name` is what the classifier keys on. */
function domError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** `GET /notifications/subscriptions` answering with the given device rows. */
function stubDeviceList(devices: Array<{ isCurrent: boolean }>) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(devices), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function baseDiagnostics(overrides: Partial<PushDiagnostics> = {}): PushDiagnostics {
  return {
    at: '2026-08-20T10:00:00.000Z',
    appVersion: '1.2.3',
    standalone: true,
    displayMode: 'standalone',
    ios: true,
    iosNonSafari: false,
    notificationApi: true,
    pushManagerApi: true,
    serviceWorkerApi: true,
    permission: 'granted',
    lastAttempt: null,
    serviceWorker: 'active',
    serviceWorkerScope: 'https://nezo.su/',
    registrationHasPushManager: true,
    // `false` on purpose, and every assertion below still expects `ok`: an
    // uncontrolled page with an active worker is the normal first launch after
    // an install, and no verdict may treat it as a fault.
    serviceWorkerControlling: false,
    serviceWorkerInstalling: false,
    serviceWorkerWaiting: false,
    serviceWorkerActive: true,
    serviceWorkerActiveState: 'activated',
    serviceWorkerReadyResolved: true,
    serviceWorkerWaitedMs: 120,
    serviceWorkerReadiness: 'ready',
    serviceWorkerRegistrationError: null,
    subscription: 'yes',
    subscriptionOrigin: 'https://web.push.apple.com',
    subscriptionFingerprint: 'abc12345',
    serverKnows: 'yes',
    serverDeviceCount: 1,
    vapidKey: 'present',
    lastError: null,
    timezone: 'Europe/Moscow',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X)',
    online: true,
    ...overrides,
  };
}

function renderCard() {
  return render(<PushDiagnosticsCard />);
}

/** iPadOS reports `Macintosh`, so the platform test needs the touch-point count too. */
function stubUserAgent(userAgent: string, maxTouchPoints = 5): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: maxTouchPoints });
}

const ORIGINAL_UA = navigator.userAgent;

beforeEach(() => {
  clearPushFailure();
  clearEnableOutcome();
  setPrimedVapidKeyForTests(VAPID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearPushFailure();
  clearEnableOutcome();
  setPrimedRegistration(null);
  setPrimedVapidKeyForTests('');
  stubUserAgent(ORIGINAL_UA, 0);
});

/* -------------------------------------------------------------------------- */
/* 1. the user gesture, driven through the actual button                       */
/* -------------------------------------------------------------------------- */

describe('the permission request survives the click handler', () => {
  function renderSection() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PushSection />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('reaches subscribe() before any queued microtask runs, and never asks for permission', async () => {
    // The pin, and it pins two separate things.
    //
    // **Ordering.** A microtask is queued *before* the click. If anything on the
    // path from `onClick` to `pushManager.subscribe()` awaits — a fetch, a
    // dynamic import, an already-resolved promise, an `async` handler — control
    // returns to the event loop, that microtask runs first, and `sawMicrotask`
    // is true when subscribe lands. WebKit's transient activation is a
    // five-second budget rather than a strict same-tick rule, but nothing on
    // this path has any business yielding, and ordering is the only proxy jsdom
    // can give us.
    //
    // **Who consumes the activation.** `Notification.requestPermission()`
    // consumes it unconditionally, before deciding whether to prompt, leaving
    // `subscribe()` to fail with a gesture error that has nothing to do with
    // the gesture. `subscribe()` prompts perfectly well on its own, so it must
    // be the only caller. This module used to get that wrong.
    let microtaskRan = false;
    let sawMicrotask: boolean | null = null;

    const requestPermission = stubNotification('default');
    const registration = stubServiceWorker({
      onSubscribe: () => {
        sawMicrotask = microtaskRan;
        return Promise.resolve(fakeSubscription());
      },
    });
    stubDeviceList([]);

    renderSection();

    // The soft pre-prompt first — the OS prompt is one-shot and never the
    // user's first surprise.
    fireEvent.click(await screen.findByRole('button', { name: SETTINGS_RU.push.enable }));
    const allow = await screen.findByRole('button', { name: SETTINGS_RU.push.promptAccept });

    queueMicrotask(() => {
      microtaskRan = true;
    });
    fireEvent.click(allow);

    expect(registration?.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(sawMicrotask).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();

    // Let the rest of `enablePush()` settle inside `act`, so the state updates
    // it schedules do not land after the test has finished.
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('subscribes with userVisibleOnly, which WebKit hard-rejects otherwise', async () => {
    stubNotification('granted');
    const registration = stubServiceWorker({});
    stubDeviceList([]);

    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: SETTINGS_RU.push.enable }));

    await waitFor(() => {
      expect(registration?.pushManager.subscribe).toHaveBeenCalledTimes(1);
    });
    const [options] = (registration?.pushManager.subscribe as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown as [PushSubscriptionOptionsInit];
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey).toBeInstanceOf(Uint8Array);

    await act(async () => {
      await Promise.resolve();
    });
  });

  it('says why it failed instead of going quiet', async () => {
    // A real denial. The section leads with the recovery card rather than an
    // enable button that cannot work.
    stubNotification('denied');
    stubServiceWorker({ subscription: null });
    stubDeviceList([]);

    renderSection();

    expect(await screen.findByText(SETTINGS_RU.push.deniedTitle)).toBeInTheDocument();
    expect(screen.getByText(SETTINGS_RU.push.deniedSteps[0] ?? '')).toBeInTheDocument();
  });

  it('names the Settings-revoked state rather than showing nothing', async () => {
    // WebKit bug 320551, and the likeliest cause of "notifications will not
    // turn on": iOS reports `permission: 'default'`, so the app believes it may
    // ask, and the prompt never appears. Before this, the user got silence.
    stubUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15');
    stubNotification('default');
    stubServiceWorker({
      onSubscribe: () => Promise.reject(domError('NotAllowedError', 'User denied push permission')),
    });
    stubDeviceList([]);

    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: SETTINGS_RU.push.enable }));
    fireEvent.click(await screen.findByRole('button', { name: SETTINGS_RU.push.promptAccept }));

    const failure = await screen.findByTestId('push-failure');
    expect(failure).toHaveAttribute('data-outcome', 'blocked-in-settings');
    expect(
      screen.getByText(SETTINGS_RU.push.failureTitle['blocked-in-settings']),
    ).toBeInTheDocument();
    // The remedy names the actual iOS Settings path.
    expect(screen.getByText(/Настройки.*Уведомления.*Семья/)).toBeInTheDocument();
  });

  it('keeps the enable control live while the worker is still installing', async () => {
    // The inversion, driven through the real UI. This control used to be
    // `disabled` until `navigator.serviceWorker.ready` resolved — and that
    // promise stays pending for ever when a worker cannot install, so the
    // "temporary" gate was permanent on the one device that hit it. The tap
    // now goes through and the platform decides.
    stubNotification('default');
    const registration = stubServiceWorker({ registration: 'installing' });
    stubDeviceList([]);

    renderSection();

    const enable = await screen.findByRole('button', { name: SETTINGS_RU.push.enable });
    expect(enable).toBeEnabled();

    // And it says why the worker is not ready, next to a button that works,
    // rather than in place of one.
    expect(screen.getByTestId('push-worker-state')).toHaveAttribute('data-stalled', 'false');

    fireEvent.click(enable);
    fireEvent.click(await screen.findByRole('button', { name: SETTINGS_RU.push.promptAccept }));

    expect(registration?.pushManager.subscribe).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
    });
  });

  it('routes a service-worker failure to the diagnostics instead of to a retry', async () => {
    // The advice the old copy gave — wait, then close and reopen the app — is
    // the advice the owner had already exhausted. Whatever else this says, it
    // must offer the one thing that actually moves the problem forward.
    stubNotification('default');
    stubServiceWorker({
      registration: 'installing',
      onSubscribe: () =>
        Promise.reject(
          domError('InvalidStateError', 'Subscribing for push requires an active service worker'),
        ),
    });
    stubDeviceList([]);

    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: SETTINGS_RU.push.enable }));
    fireEvent.click(await screen.findByRole('button', { name: SETTINGS_RU.push.promptAccept }));

    const failure = await screen.findByTestId('push-failure');
    expect(failure).toHaveAttribute('data-outcome', 'not-ready');
    // WebKit's sentence, not ours.
    expect(
      screen.getByText(/InvalidStateError: Subscribing for push requires an active service worker/),
    ).toBeInTheDocument();
    // Never «закройте приложение и откройте заново» again.
    expect(SETTINGS_RU.push.failureHint['not-ready']).not.toMatch(/закройте приложение/i);
    expect(screen.getAllByTestId('push-open-diagnostics').length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. the verdict                                                              */
/* -------------------------------------------------------------------------- */

describe('pushVerdict', () => {
  it('reports the first shut gate, in platform order', () => {
    expect(pushVerdict(baseDiagnostics())).toBe('ok');

    // A Safari tab on iOS: the APIs are absent, which is "not installed", not
    // "your phone cannot do this".
    expect(
      pushVerdict(
        baseDiagnostics({
          notificationApi: false,
          pushManagerApi: false,
          standalone: false,
          displayMode: 'browser',
        }),
      ),
    ).toBe('not-installed');

    // Installed, APIs present, but the one-shot prompt was already spent.
    expect(pushVerdict(baseDiagnostics({ permission: 'denied' }))).toBe('denied');

    // Never asked yet.
    expect(pushVerdict(baseDiagnostics({ permission: 'default', subscription: 'no' }))).toBe(
      'not-asked',
    );

    // Granted, but the browser dropped the subscription — no silent repair on
    // iOS, only a fresh gesture.
    expect(pushVerdict(baseDiagnostics({ subscription: 'no' }))).toBe('no-subscription');

    // The browser has one and the server does not know it.
    expect(pushVerdict(baseDiagnostics({ serverKnows: 'no' }))).toBe('server-unaware');

    expect(pushVerdict(baseDiagnostics({ vapidKey: 'missing' }))).toBe('misconfigured');
    expect(pushVerdict(baseDiagnostics({ serviceWorker: 'none' }))).toBe('no-service-worker');
    expect(pushVerdict(baseDiagnostics({ iosNonSafari: true }))).toBe('ios-non-safari');

    // Not iOS and no APIs at all — a desktop browser with push switched off.
    expect(
      pushVerdict(baseDiagnostics({ ios: false, notificationApi: false, pushManagerApi: false })),
    ).toBe('unsupported');
  });

  it('trusts a real attempt over the permission reading', () => {
    // The whole point. `permission: 'default'` here means "iOS refused to
    // prompt", not "we have not asked" — only `lastAttempt` knows the
    // difference, and reading `permission` alone sends the user round the loop
    // of tapping a button that can never work.
    expect(
      pushVerdict(
        baseDiagnostics({
          permission: 'default',
          subscription: 'no',
          lastAttempt: 'blocked-in-settings',
        }),
      ),
    ).toBe('blocked-in-settings');

    // Without that evidence the same reading is genuinely ambiguous, and
    // «ещё не спрашивали» is the honest answer.
    expect(pushVerdict(baseDiagnostics({ permission: 'default', subscription: 'no' }))).toBe(
      'not-asked',
    );
  });

  it('separates "still starting" from "never registered" from "stuck"', () => {
    const starting = {
      serviceWorkerActive: false,
      serviceWorkerReadyResolved: false,
      serviceWorkerReadiness: 'starting',
    } as const;

    expect(pushVerdict(baseDiagnostics({ serviceWorker: 'installing', ...starting }))).toBe(
      'sw-not-active',
    );
    expect(pushVerdict(baseDiagnostics({ serviceWorker: 'waiting', ...starting }))).toBe(
      'sw-not-active',
    );
    expect(pushVerdict(baseDiagnostics({ serviceWorker: 'none', ...starting }))).toBe(
      'no-service-worker',
    );

    // The state the old copy could not name, and told the user to wait through.
    // `serviceWorker.ready` never settles when a worker cannot install, so
    // "подождите ещё несколько секунд" was advice with no end to it.
    expect(
      pushVerdict(
        baseDiagnostics({
          serviceWorker: 'installing',
          serviceWorkerActive: false,
          serviceWorkerReadyResolved: false,
          serviceWorkerReadiness: 'stalled',
          serviceWorkerWaitedMs: 45_000,
        }),
      ),
    ).toBe('sw-stalled');
  });

  it('never reports a fault merely because the page is uncontrolled', () => {
    // The regression this whole change exists for. On the first launch after an
    // install `navigator.serviceWorker.controller` is `null` while the
    // registration is active and `subscribe()` works. A verdict — or a gate —
    // derived from `controller` is false exactly when a user first goes looking
    // for notifications.
    expect(pushVerdict(baseDiagnostics({ serviceWorkerControlling: false }))).toBe('ok');
  });

  it('does not call a denied permission "not installed" once the app is standalone', () => {
    // Ordering regression guard: `denied` is only reachable *after* the install
    // gate, and mixing the two produces install instructions for somebody who
    // has already installed.
    const d = baseDiagnostics({ permission: 'denied', standalone: true });
    expect(pushVerdict(d)).toBe('denied');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. the copyable report                                                      */
/* -------------------------------------------------------------------------- */

describe('formatPushDiagnostics', () => {
  it('carries the error verbatim', () => {
    const text = formatPushDiagnostics(
      baseDiagnostics({
        lastError: {
          stage: 'subscribe',
          name: 'NotAllowedError',
          message: 'User denied permission to use the Push API.',
          at: '2026-08-20T09:59:00.000Z',
        },
      }),
    );

    // Untranslated and unparaphrased — this is the only evidence we get from a
    // device we cannot touch.
    expect(text).toContain('NotAllowedError');
    expect(text).toContain('User denied permission to use the Push API.');
    expect(text).toContain('этап: subscribe');
  });

  it('includes the HTTP status and code when the server refused', () => {
    const text = formatPushDiagnostics(
      baseDiagnostics({
        lastError: {
          stage: 'server',
          name: 'ApiError',
          message: 'HTTP 403',
          status: 403,
          code: 'FORBIDDEN',
          at: '2026-08-20T09:59:00.000Z',
        },
      }),
    );
    expect(text).toContain('HTTP 403');
    expect(text).toContain('код: FORBIDDEN');
  });

  it('never leaks the push endpoint', () => {
    // The endpoint is a capability URL (research doc §14) and this text is
    // designed to be pasted into a chat window. The origin and a digest are
    // everything we need and everything we may include.
    const text = formatPushDiagnostics(
      baseDiagnostics({
        subscriptionOrigin: 'https://web.push.apple.com',
        subscriptionFingerprint: fingerprintEndpoint(APPLE_ENDPOINT),
      }),
    );

    expect(text).toContain('https://web.push.apple.com');
    expect(text).not.toContain('QABC123secretcapabilityurl');
    expect(text).not.toContain(APPLE_ENDPOINT);
  });

  it('fingerprints stably and differently per endpoint', () => {
    expect(fingerprintEndpoint(APPLE_ENDPOINT)).toBe(fingerprintEndpoint(APPLE_ENDPOINT));
    expect(fingerprintEndpoint(APPLE_ENDPOINT)).not.toBe(fingerprintEndpoint(`${APPLE_ENDPOINT}x`));
  });
});

/* -------------------------------------------------------------------------- */
/* 4. collection against mocked device states                                  */
/* -------------------------------------------------------------------------- */

describe('collectPushDiagnostics', () => {
  it('reads a healthy installed device', async () => {
    stubNotification('granted');
    stubServiceWorker({ subscription: fakeSubscription() });
    stubDeviceList([{ isCurrent: true }]);

    const d = await collectPushDiagnostics();

    expect(d.permission).toBe('granted');
    expect(d.serviceWorker).toBe('active');
    expect(d.serviceWorkerActive).toBe(true);
    expect(d.serviceWorkerInstalling).toBe(false);
    expect(d.registrationHasPushManager).toBe(true);
    expect(d.subscription).toBe('yes');
    expect(d.subscriptionOrigin).toBe('https://web.push.apple.com');
    expect(d.serverKnows).toBe('yes');
    expect(pushVerdict(d)).toBe('ok');
  });

  it('reports `no` when the server has never seen this endpoint', async () => {
    stubNotification('granted');
    stubServiceWorker({ subscription: fakeSubscription() });
    stubDeviceList([{ isCurrent: false }]);

    const d = await collectPushDiagnostics();
    expect(d.serverKnows).toBe('no');
    expect(pushVerdict(d)).toBe('server-unaware');
  });

  it('does not hang when no service worker is registered', async () => {
    // `navigator.serviceWorker.ready` never settles here. Using it would hang
    // the collection on precisely the device that needs describing.
    stubNotification('granted');
    stubServiceWorker({ registration: 'none' });
    stubDeviceList([]);

    const d = await collectPushDiagnostics();
    expect(d.serviceWorker).toBe('none');
    expect(d.subscription).toBe('unknown');
    expect(pushVerdict(d)).toBe('no-service-worker');
  });

  it('degrades rather than throwing where the APIs are absent', async () => {
    // Headless Playwright, a plain browser tab, jsdom. Not a fault — a finding.
    removePushApis();
    stubDeviceList([]);

    const d = await collectPushDiagnostics();
    expect(d.notificationApi).toBe(false);
    expect(d.pushManagerApi).toBe(false);
    expect(d.serviceWorkerApi).toBe(false);
    expect(d.permission).toBe('unsupported');
    expect(d.serviceWorker).toBe('none');
  });

  it('answers `unknown` rather than `no` when the server call fails', async () => {
    // A network failure must not be reported as "the server does not know this
    // device" — that sends the user to unsubscribe and re-subscribe for nothing.
    stubNotification('granted');
    stubServiceWorker({ subscription: fakeSubscription() });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );

    const d = await collectPushDiagnostics();
    expect(d.subscription).toBe('yes');
    expect(d.serverKnows).toBe('unknown');
    expect(d.serverDeviceCount).toBeNull();
  });

  it('picks up the last recorded failure verbatim', async () => {
    stubNotification('granted');
    stubServiceWorker({ subscription: fakeSubscription() });
    stubDeviceList([{ isCurrent: true }]);

    const thrown = new Error('Registration failed - push service error');
    thrown.name = 'AbortError';
    recordPushFailure('subscribe', thrown);

    const d = await collectPushDiagnostics();
    expect(d.lastError?.name).toBe('AbortError');
    expect(d.lastError?.message).toBe('Registration failed - push service error');
    expect(d.lastError?.stage).toBe('subscribe');
  });
});

/* -------------------------------------------------------------------------- */
/* 5. the screen itself                                                        */
/* -------------------------------------------------------------------------- */

describe('PushDiagnosticsCard', () => {
  it('names the denied state and spells out the iOS reset path', async () => {
    // The state no code change can repair. The screen has to say so and say
    // where the switch is, or the family member simply gives up.
    stubNotification('denied');
    stubServiceWorker({ subscription: null });
    stubDeviceList([]);

    renderCard();

    const T = SETTINGS_RU.diagnostics;
    expect(await screen.findByText(T.verdictTitle.denied)).toBeInTheDocument();
    expect(screen.getByText(T.resetTitle)).toBeInTheDocument();
    expect(screen.getByText(T.resetSteps[0] ?? '')).toBeInTheDocument();
    // Auto-expanded, because the verdict is not «Всё в порядке».
    expect(screen.getByText(T.rows.permission)).toBeInTheDocument();
    expect(screen.getByText(T.permissionValue.denied)).toBeInTheDocument();
  });

  it('shows the verbatim error, not a paraphrase', async () => {
    stubNotification('granted');
    stubServiceWorker({ subscription: null });
    stubDeviceList([]);

    const thrown = new Error('The operation is not allowed');
    thrown.name = 'NotAllowedError';
    recordPushFailure('subscribe', thrown);

    renderCard();

    expect(
      await screen.findByText(/NotAllowedError: The operation is not allowed/),
    ).toBeInTheDocument();
  });

  it('explains itself in a browser tab instead of breaking', async () => {
    // This is the Playwright / desktop case. The APIs are simply not there and
    // the card must survive it — a diagnostics screen that crashes on the one
    // device that needs it is worse than none.
    removePushApis();
    stubDeviceList([]);

    renderCard();

    const T = SETTINGS_RU.diagnostics;
    expect(await screen.findByText(T.degradedNote)).toBeInTheDocument();
    expect(screen.getByTestId('push-diagnostics-verdict')).toBeInTheDocument();
  });

  it('copies the whole report in one tap', async () => {
    stubNotification('granted');
    stubServiceWorker({ subscription: fakeSubscription() });
    stubDeviceList([{ isCurrent: true }]);

    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    renderCard();

    fireEvent.click(await screen.findByTestId('push-diagnostics-copy'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const [text] = writeText.mock.calls[0] as unknown as [string];
    expect(text).toContain('Диагностика уведомлений');
    expect(text).toContain('Разрешение: granted');
    // Still no capability URL, even on the path built for pasting elsewhere.
    expect(text).not.toContain('QABC123secretcapabilityurl');
  });

  it('stays collapsed when everything is in order', async () => {
    stubNotification('granted');
    stubServiceWorker({ subscription: fakeSubscription() });
    stubDeviceList([{ isCurrent: true }]);

    renderCard();

    const T = SETTINGS_RU.diagnostics;
    expect(await screen.findByText(T.verdictTitle.ok)).toBeInTheDocument();
    expect(screen.queryByText(T.rows.userAgent)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: new RegExp(T.show) }));
    expect(screen.getByText(T.rows.userAgent)).toBeInTheDocument();
  });
});
