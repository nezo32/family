import type { PushSubscriptionRequest, PushSubscriptionSummary } from '@family/shared';
import { api } from '@/shared/api/client';
import { readQueuedAcks, removeAcks, ackPath, type QueuedAck } from './ack-queue';

/**
 * Client-side Web Push: subscribe, unsubscribe, and the foreground reconcile
 * loop that is the only repair mechanism iOS gives us.
 *
 * Read `docs/research/ios-pwa-push.md` before changing anything here. The rules
 * this module exists to enforce, in the order they bite:
 *
 * 1. **Feature-detect, never introspect.** In a normal Safari tab on iOS
 *    `window.Notification` is `undefined`, not `denied` — touching
 *    `Notification.permission` throws a `ReferenceError` and takes the settings
 *    screen down with it.
 * 2. **`Notification.requestPermission()` must run synchronously inside the
 *    click handler.** WebKit's user-activation token does not survive an
 *    `await`, so `enablePush()` is deliberately **not** an `async function`: the
 *    permission call is the first statement, the awaiting happens in a helper.
 *    The VAPID key is read from `import.meta.env` at build time for exactly this
 *    reason — fetching it first would spend the gesture.
 * 3. **The OS prompt can be shown once, ever.** A soft pre-prompt
 *    (`PushPrompt.tsx`) must gate this call; if the user says "не сейчас" there
 *    we can ask again tomorrow, and if they say "Не разрешать" to the OS the
 *    only way back is iOS Settings.
 * 4. **`pushsubscriptionchange` does not exist on iOS.** `reconcileSubscription()`
 *    on every `visibilitychange -> visible` is the whole repair loop: it
 *    re-POSTs the live subscription (idempotent upsert, refreshes `lastSeenAt`,
 *    fixes rotations) and reports `missing` when the browser dropped it, which
 *    is what raises «Уведомления отключились — включить снова?».
 */

/* -------------------------------------------------------------------------- */
/* capability detection                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The only safe check. All three are required, and on iOS in a Safari tab the
 * first two are simply absent — which is a *capability* answer, not a *denied*
 * answer, and the UI must say so.
 */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'PushManager' in window &&
    'serviceWorker' in navigator
  );
}

/** True when the page runs as an installed app rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const displayMode =
    typeof window.matchMedia === 'function' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches);
  return iosStandalone || displayMode;
}

/**
 * iPadOS reports a `Macintosh` UA since iPadOS 13, so the platform test has to
 * be combined with a touch-point count (research doc §13).
 */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return true;
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/**
 * Non-Safari browsers on iOS cannot add to the Home Screen at all, so telling
 * their users to "нажмите Поделиться" is a dead end — they must be sent to
 * Safari first.
 */
export function isIosNonSafari(): boolean {
  if (!isIos()) return false;
  return /CriOS|FxiOS|EdgiOS|YaBrowser|DuckDuckGo|OPiOS/.test(navigator.userAgent);
}

export type PushAvailability =
  /** The browser has no Web Push at all (desktop Firefox with it disabled, old iOS). */
  | 'unsupported'
  /** iOS in a Safari tab: push exists, but only for an installed app. */
  | 'needs-install'
  /** Everything is in place; the permission state decides what to show. */
  | 'available';

export function pushAvailability(): PushAvailability {
  if (isPushSupported()) return 'available';
  // On iOS the absence of `Notification` is nearly always "not installed yet",
  // and that is a fixable, explainable state rather than a dead end.
  if (isIos()) return 'needs-install';
  return 'unsupported';
}

export type PushPermission = 'unsupported' | 'default' | 'granted' | 'denied';

/** Never reads `Notification.permission` without the guard. */
export function permissionState(): PushPermission {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

/* -------------------------------------------------------------------------- */
/* VAPID                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The application server key, read from the build.
 *
 * HARD RULE: never fetch `GET /api/notifications/vapid-public-key` inside the
 * click handler. The round trip spends the user-activation token and
 * `pushManager.subscribe()` then fails on Safari with a bare `NotAllowedError`.
 *
 * A plain function rather than a module-level const only so tests can vary it;
 * `import.meta.env` is inlined at build time, so this stays a synchronous
 * property read with no I/O of any kind.
 */
export function vapidPublicKey(): string {
  return import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '';
}

/** base64url → `Uint8Array`, the only form `applicationServerKey` accepts. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) view[i] = binary.charCodeAt(i);
  return view;
}

/* -------------------------------------------------------------------------- */
/* the registration, primed ahead of the gesture                               */
/* -------------------------------------------------------------------------- */

let primedRegistration: ServiceWorkerRegistration | null = null;

/**
 * Warm the service-worker registration **before** the button becomes clickable.
 *
 * `navigator.serviceWorker.ready` is a promise, and awaiting it inside the click
 * handler would burn the gesture just as surely as a fetch would. Calling this
 * from an effect on mount means the handler can reach the registration
 * synchronously.
 */
export async function primeRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (primedRegistration) return primedRegistration;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    primedRegistration = await navigator.serviceWorker.ready;
    return primedRegistration;
  } catch {
    return null;
  }
}

/** Test seam and reset hook; also lets the dev server re-prime after an update. */
export function setPrimedRegistration(registration: ServiceWorkerRegistration | null): void {
  primedRegistration = registration;
}

async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  return primedRegistration ?? (await primeRegistration());
}

/* -------------------------------------------------------------------------- */
/* device label                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A human-readable name for the "мои устройства" list. Best-effort and purely
 * cosmetic — the server also stores the user agent, and the user can rename it.
 */
export function deviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Устройство';
  const ua = navigator.userAgent;
  const platform = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : 'Устройство';
  return isStandalone() ? `${platform} (приложение)` : platform;
}

/* -------------------------------------------------------------------------- */
/* server calls                                                                */
/* -------------------------------------------------------------------------- */

function toRequestBody(subscription: PushSubscription): PushSubscriptionRequest {
  const json = subscription.toJSON();
  return {
    endpoint: json.endpoint ?? subscription.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? '',
      auth: json.keys?.auth ?? '',
    },
    expirationTime: json.expirationTime ?? null,
    deviceLabel: deviceLabel(),
    isStandalone: isStandalone(),
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent.slice(0, 512),
  };
}

/**
 * `POST /api/notifications/subscriptions` — an **upsert keyed on `endpoint`**.
 *
 * Safe to call on every foreground: that is exactly what refreshes
 * `lastSeenAt` and re-binds a rotated endpoint without any user involvement.
 */
export function postSubscription(subscription: PushSubscription): Promise<PushSubscriptionSummary> {
  return api.post<PushSubscriptionSummary>(
    '/notifications/subscriptions',
    toRequestBody(subscription),
  );
}

export function deleteSubscription(endpoint: string): Promise<void> {
  return api.del<void>('/notifications/subscriptions', { body: { endpoint } });
}

/**
 * This browser's push endpoint, or `null`.
 *
 * Used to (a) let the server mark the matching device row `isCurrent` and (b)
 * unsubscribe this device by endpoint. Never logged and never rendered — an
 * endpoint is a capability URL (research doc §14).
 */
export async function currentEndpoint(): Promise<string | null> {
  if (!isPushSupported()) return null;
  const registration = await currentRegistration();
  if (!registration) return null;
  try {
    const subscription = await registration.pushManager.getSubscription();
    return subscription?.endpoint ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* enable — the gesture-critical path                                          */
/* -------------------------------------------------------------------------- */

export type EnableOutcome =
  'enabled' | 'denied' | 'dismissed' | 'unsupported' | 'needs-install' | 'misconfigured' | 'failed';

export interface EnableResult {
  outcome: EnableOutcome;
  subscription?: PushSubscriptionSummary;
}

/**
 * Turn push on for this device.
 *
 * **Do not make this `async`, and do not add anything before the
 * `Notification.requestPermission()` line.** The synchronous call is what keeps
 * the WebKit user-activation token alive; an `await` — any await, including one
 * that resolves immediately — invalidates it and Safari rejects both the
 * permission prompt and the subsequent `subscribe()`.
 *
 * The function still returns a promise, so callers can `await` it; the awaiting
 * happens inside `completeSubscribe`, after the gesture has been spent.
 */
export function enablePush(): Promise<EnableResult> {
  if (!isPushSupported()) {
    return Promise.resolve({ outcome: isIos() ? 'needs-install' : 'unsupported' });
  }
  if (!vapidPublicKey()) {
    // A build without the key can never subscribe; say so rather than firing the
    // one-shot OS prompt and then failing.
    return Promise.resolve({ outcome: 'misconfigured' });
  }

  // ---- the gesture-critical line. Nothing may precede it. ------------------
  const permission = Notification.requestPermission();

  return completeSubscribe(permission);
}

async function completeSubscribe(
  permissionPromise: Promise<NotificationPermission>,
): Promise<EnableResult> {
  let permission: NotificationPermission;
  try {
    permission = await permissionPromise;
  } catch {
    return { outcome: 'failed' };
  }

  if (permission === 'denied') return { outcome: 'denied' };
  if (permission !== 'granted') return { outcome: 'dismissed' };

  const registration = await currentRegistration();
  if (!registration) return { outcome: 'failed' };

  try {
    // Reuse an existing subscription rather than churning the endpoint: a new
    // endpoint means a new row and a stale one the dispatcher keeps trying.
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        // HARD RULE: there is no silent push on iOS. `false` is not an option.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey()),
      }));

    const summary = await postSubscription(subscription);
    return { outcome: 'enabled', subscription: summary };
  } catch {
    return { outcome: 'failed' };
  }
}

/* -------------------------------------------------------------------------- */
/* disable                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Unsubscribe this device.
 *
 * The server row is deleted **first**: if `unsubscribe()` succeeds and the
 * DELETE then fails, the dispatcher keeps pushing at a dead endpoint until the
 * 410 sweep notices. The reverse ordering is merely a no-op re-POST away from
 * being correct.
 */
export async function disablePush(): Promise<boolean> {
  const registration = await currentRegistration();
  if (!registration) return false;
  try {
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;
    await deleteSubscription(subscription.endpoint).catch(() => undefined);
    await subscription.unsubscribe();
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* the reconcile loop — the only repair path on iOS                            */
/* -------------------------------------------------------------------------- */

export type ReconcileOutcome =
  /** A live subscription was found and re-POSTed (idempotent upsert). */
  | 'reposted'
  /** The browser has no subscription. If the server thinks push is on → banner. */
  | 'missing'
  /** Permission was revoked or never granted; nothing to reconcile. */
  | 'not-permitted'
  /** No Web Push in this browser / not installed. */
  | 'unsupported'
  /** Network or server failure; try again on the next foreground. */
  | 'failed';

/**
 * Re-POST whatever subscription the browser currently holds.
 *
 * This runs on **every** `visibilitychange -> visible`, and it is deliberately
 * cheap and idempotent: the endpoint is the unique key, so the server upsert
 * refreshes `lastSeenAt`, re-binds a rotated endpoint to this user, and revives
 * a row an over-eager prune had expired — all without a user gesture, which is
 * the only kind of repair iOS permits.
 */
export async function reconcileSubscription(): Promise<ReconcileOutcome> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission !== 'granted') return 'not-permitted';

  const registration = await currentRegistration();
  if (!registration) return 'unsupported';

  let subscription: PushSubscription | null;
  try {
    subscription = await registration.pushManager.getSubscription();
  } catch {
    return 'failed';
  }

  // The state that has no silent fix: permission is still granted, but the
  // subscription is gone. Only a fresh gesture can create a new one.
  if (!subscription) return 'missing';

  try {
    await postSubscription(subscription);
    return 'reposted';
  } catch {
    return 'failed';
  }
}

/**
 * Install the foreground reconcile loop. Returns an unsubscribe function.
 *
 * `visibilitychange` rather than `focus`: an installed iOS PWA is cold-started
 * from the background often enough that `focus` alone misses most resumes.
 */
export function installReconcileLoop(
  onOutcome: (outcome: ReconcileOutcome) => void,
  options: { immediate?: boolean } = {},
): () => void {
  if (typeof document === 'undefined') return () => undefined;

  let disposed = false;
  const run = () => {
    void reconcileSubscription().then((outcome) => {
      if (!disposed) onOutcome(outcome);
    });
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') run();
  };

  document.addEventListener('visibilitychange', onVisibility);
  if (options.immediate !== false && document.visibilityState === 'visible') run();

  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/* -------------------------------------------------------------------------- */
/* D11 — flushing the service worker's ack queue                               */
/* -------------------------------------------------------------------------- */

/**
 * Send every ack the service worker could not deliver itself.
 *
 * The SW has no access token (D3 keeps it in page memory), so a push that
 * arrives with the app closed always leaves its `delivered` receipt in
 * IndexedDB. This is the other half of that contract, and it runs on every app
 * foreground.
 *
 * Failures are kept for the next attempt; a permanent rejection (404 on a
 * pruned delivery, 403) drops the row so the queue cannot wedge. Nothing here
 * throws — a receipt is diagnostics, and diagnostics never break a screen.
 */
export async function flushAckQueue(): Promise<number> {
  let queued: QueuedAck[];
  try {
    queued = await readQueuedAcks();
  } catch {
    return 0;
  }
  if (queued.length === 0) return 0;

  const settled: string[] = [];
  for (const ack of queued) {
    try {
      await api.post(ackPath(ack.deliveryId, ack.kind), { occurredAt: ack.occurredAt });
      settled.push(ack.key);
    } catch (error) {
      // Only a retryable failure keeps its place in the queue.
      if (!isRetryableAckError(error)) settled.push(ack.key);
    }
  }

  await removeAcks(settled);
  return settled.length;
}

function isRetryableAckError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (typeof status !== 'number') return true; // network / unknown → retry
  return status >= 500;
}
