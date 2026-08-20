import type { PushSubscriptionRequest, PushSubscriptionSummary } from '@family/shared';
import { api } from '@/shared/api/client';
import { isApiError } from '@/shared/api/errors';
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
 * 2. **`pushManager.subscribe()` is called straight from the tap, and
 *    `Notification.requestPermission()` is never called at all.** The platform
 *    requirement is *transient activation*: five seconds from the tap, consumed
 *    by the first caller. `subscribe()` raises the OS prompt itself;
 *    `requestPermission()` would consume the activation first and leave
 *    `subscribe()` to fail with a gesture error that has nothing to do with the
 *    gesture. See {@link enablePush} for the full mechanism.
 * 3. **The OS prompt can be shown once, ever.** A soft pre-prompt
 *    (`PushPrompt.tsx`) must gate this call; if the user says "не сейчас" there
 *    we can ask again tomorrow, and if they say "Не разрешать" to the OS the
 *    only way back is iOS Settings.
 * 3a. **`Notification.permission` is not a reliable reading on iOS.** WebKit bug
 *    320551: switching notifications off in iOS Settings leaves it reporting
 *    `'default'` — the same value as "never asked" — while the prompt never
 *    appears again. `'blocked-in-settings'` is the outcome that names it, and
 *    only a real subscribe attempt can tell the two states apart.
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
 * The application server key.
 *
 * HARD RULE: never fetch `GET /api/notifications/vapid-public-key` inside the
 * click handler. The round trip spends the user-activation token and
 * `pushManager.subscribe()` then fails on Safari with a bare `NotAllowedError`.
 * This getter is therefore always synchronous, with no I/O of any kind.
 *
 * Two sources, in order:
 *  1. the build-time variable, inlined by Vite;
 *  2. a value primed at boot by {@link primeVapidKey}, well outside any gesture.
 *
 * The second exists because the first silently fails in exactly the situation
 * you cannot test locally: a CI build where the variable was never configured
 * produces an empty string, and every attempt to enable notifications then dies
 * with a generic error. The key is public and the server already serves it, so
 * depending solely on a build argument bought nothing.
 */
let primedKey = '';

export function vapidPublicKey(): string {
  return import.meta.env.VITE_VAPID_PUBLIC_KEY || primedKey || '';
}

/**
 * Fetch and cache the server's public key. Call once at startup — never from a
 * click handler, for the reason above. Failure is silent: the app simply falls
 * back to reporting `misconfigured` when somebody tries to subscribe.
 */
export async function primeVapidKey(): Promise<void> {
  if (import.meta.env.VITE_VAPID_PUBLIC_KEY || primedKey) return;
  try {
    const response = await fetch('/api/notifications/vapid-public-key');
    if (!response.ok) return;
    const body = (await response.json()) as { publicKey?: unknown };
    if (typeof body.publicKey === 'string' && body.publicKey) primedKey = body.publicKey;
  } catch {
    // Offline or the endpoint is unavailable. Nothing to do; `enablePush()`
    // reports `misconfigured` rather than burning the one-shot OS prompt.
  }
}

/** Test seam. */
export function setPrimedVapidKeyForTests(key: string): void {
  primedKey = key;
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
/* the last failure, kept verbatim                                             */
/* -------------------------------------------------------------------------- */

/**
 * Why the last attempt to turn push on failed — **unparaphrased**.
 *
 * This exists because the bug that produced it could only ever be reproduced on
 * one person's phone. Every catch in this module used to swallow its error and
 * return a bare `'failed'`, which reached the user as «Не удалось включить
 * уведомления» and told nobody anything. A `NotAllowedError` (gesture lost), an
 * `AbortError` (push service refused the key) and a `403` from our own API are
 * three completely different bugs that all looked identical from the outside.
 *
 * `name` and `message` are copied straight off the thrown value. Do not
 * translate them here — `PushDiagnosticsCard` renders them as-is, on purpose,
 * so the owner can read them back to us.
 */
export interface PushFailure {
  /** Which step threw. Also the key for the Russian explanation. */
  stage: 'permission' | 'registration' | 'subscribe' | 'server' | 'unsubscribe';
  /** `error.name`, verbatim (`NotAllowedError`, `AbortError`, `ApiError`, …). */
  name: string;
  /** `error.message`, verbatim. Never translated, never truncated to a phrase. */
  message: string;
  /** HTTP status, when the failure came from our API. */
  status?: number;
  /** Machine-readable `ErrorCode`, when the failure came from our API. */
  code?: string;
  /** ISO timestamp, so a stale error is visibly stale. */
  at: string;
}

let lastFailure: PushFailure | null = null;

/** The last recorded failure, or `null` if the last attempt succeeded. */
export function lastPushFailure(): PushFailure | null {
  return lastFailure;
}

export function clearPushFailure(): void {
  lastFailure = null;
}

/** Normalise any thrown value into a {@link PushFailure} and store it. */
export function recordPushFailure(stage: PushFailure['stage'], error: unknown): PushFailure {
  const failure: PushFailure = {
    stage,
    name: 'Error',
    message: String(error),
    at: new Date().toISOString(),
  };

  if (isApiError(error)) {
    failure.name = 'ApiError';
    failure.message = error.message;
    failure.status = error.status;
    failure.code = error.code;
  } else if (error instanceof Error) {
    failure.name = error.name || 'Error';
    failure.message = error.message || String(error);
  }

  lastFailure = failure;
  return failure;
}

/** `recordPushFailure` + the matching {@link EnableResult}, in one expression. */
function fail(outcome: EnableOutcome, stage: PushFailure['stage'], error: unknown): EnableResult {
  return { outcome, error: recordPushFailure(stage, error) };
}

/* -------------------------------------------------------------------------- */
/* enable — the activation-critical path                                       */
/* -------------------------------------------------------------------------- */

export type EnableOutcome =
  /** Subscribed, and the server has the row. */
  | 'enabled'
  /** The user really tapped «Не разрешать» in the OS prompt. Permanent. */
  | 'denied'
  /**
   * iOS says `default` but will never prompt — WebKit bug 320551.
   *
   * The user turned **Настройки → Уведомления → Семья → Разрешить уведомления**
   * off at some point. `Notification.permission` then reports `'default'`, not
   * `'denied'`, so the app believes it may still ask; the prompt never appears.
   * This is the state that reads as "notifications will not turn on".
   */
  | 'blocked-in-settings'
  /** Chromium only: the prompt was dismissed rather than answered. Retryable. */
  | 'dismissed'
  /** No Web Push in this browser at all. */
  | 'unsupported'
  /** iOS outside a Home Screen web app: push exists, but not here. */
  | 'needs-install'
  /** No usable VAPID application server key — a deployment fault. */
  | 'misconfigured'
  /** No **active** service worker yet, so `subscribe()` would `InvalidStateError`. */
  | 'not-ready'
  /** WebKit reported no transient activation. See {@link enablePush}. */
  | 'gesture-lost'
  /** `pushManager.subscribe()` threw something we could not attribute. */
  | 'subscribe-rejected'
  /** We got a subscription; `POST /notifications/subscriptions` refused it. */
  | 'server-rejected'
  /** Anything else. `EnableResult.error` still carries it verbatim. */
  | 'failed';

export interface EnableResult {
  outcome: EnableOutcome;
  subscription?: PushSubscriptionSummary;
  /** The verbatim cause, when there was one. Also stored in {@link lastPushFailure}. */
  error?: PushFailure;
}

/**
 * The outcome of the last {@link enablePush} call in this session.
 *
 * Needed by two callers that must not loop: the soft pre-prompt has to stand
 * down once we know iOS will never show the OS prompt (`blocked-in-settings`),
 * and the diagnostics screen has to report that state rather than the
 * `'default'` permission that hides it.
 */
let lastOutcome: EnableOutcome | null = null;

export function lastEnableOutcome(): EnableOutcome | null {
  return lastOutcome;
}

export function clearEnableOutcome(): void {
  lastOutcome = null;
}

/**
 * True when a tap could actually succeed: an **active** service worker and a
 * key to subscribe with.
 *
 * `PushManager::subscribe` throws `InvalidStateError: Subscribing for push
 * requires an active service worker` if the worker is merely installing, which
 * is the state a user meets on the very first launch after adding the app to
 * the Home Screen — exactly when they first go looking for notifications. The
 * enable control stays disabled until this is true, because the alternative is
 * awaiting `navigator.serviceWorker.ready` *inside* the tap, and on a cold
 * start that await can outlast the five-second activation window.
 */
export function isPushReady(): boolean {
  if (!isPushSupported()) return false;
  if (!vapidPublicKey()) return false;
  return primedRegistration?.active != null;
}

/**
 * Turn push on for this device.
 *
 * **Call this straight from the tap handler, and do not put an `await` in
 * front of it.** What the platform requires is *transient activation*, and the
 * WebKit rules that govern it are narrow enough to be worth stating exactly
 * (`LocalDOMWindow.cpp`, `PushManager.cpp`; see `docs/research/ios-pwa-push.md`
 * §3):
 *
 * - Activation lasts **5 seconds** from the tap and is **consumed once** — the
 *   first caller wins. An `await` is not fatal in itself; an `await` that can
 *   outlast five seconds is. That is why the VAPID key and the service-worker
 *   registration are both resolved before the button is even enabled.
 * - **`subscribe()` prompts by itself.** `PushManager::subscribe` consumes the
 *   activation and shows the OS prompt when permission is `default`, and skips
 *   the activation check entirely when it is already `granted`.
 * - **Therefore `Notification.requestPermission()` must not be called at all.**
 *   It consumes the activation *unconditionally*, before it decides whether to
 *   prompt. In the bug-320551 state below it consumes it, returns without
 *   prompting, and the follow-up `subscribe()` then finds nothing left and
 *   throws `NotAllowedError: Push notification prompting can only be done from
 *   a user gesture.` — dressing a Settings problem up as a code problem, and
 *   sending whoever debugs it on a long hunt through the click handler.
 *
 *   This module used to do exactly that. One tap, one call, one activation.
 *
 * The function is deliberately **not** `async`: it returns a promise, but every
 * statement up to and including `pushManager.subscribe()` runs synchronously
 * inside the handler.
 */
export function enablePush(): Promise<EnableResult> {
  if (!isPushSupported()) {
    return Promise.resolve(finish({ outcome: isIos() ? 'needs-install' : 'unsupported' }));
  }

  const key = vapidPublicKey();
  if (!key) {
    return Promise.resolve(
      finish(fail('misconfigured', 'subscribe', new Error('applicationServerKey is empty'))),
    );
  }

  // Must already be primed *and* active — see `isPushReady`. Reading the cached
  // value is synchronous; awaiting `serviceWorker.ready` here would not be.
  const registration = primedRegistration;
  if (!registration?.active) {
    return Promise.resolve(
      finish(
        fail(
          'not-ready',
          'registration',
          new Error('Subscribing for push requires an active service worker'),
        ),
      ),
    );
  }

  let applicationServerKey: Uint8Array<ArrayBuffer>;
  try {
    applicationServerKey = urlBase64ToUint8Array(key);
  } catch (error) {
    return Promise.resolve(finish(fail('misconfigured', 'subscribe', error)));
  }

  // ---- the activation-critical line. Exactly one call may consume it. ------
  const subscribing = registration.pushManager.subscribe({
    // HARD RULE: `PushManager.cpp` hard-rejects anything else. No silent push.
    userVisibleOnly: true,
    applicationServerKey,
  });

  return completeSubscribe(subscribing, registration).then(finish);
}

/** Record the outcome for {@link lastEnableOutcome} and pass it through. */
function finish(result: EnableResult): EnableResult {
  lastOutcome = result.outcome;
  return result;
}

async function completeSubscribe(
  subscribing: Promise<PushSubscription>,
  registration: ServiceWorkerRegistration,
): Promise<EnableResult> {
  let subscription: PushSubscription;
  try {
    subscription = await subscribing;
  } catch (error) {
    const rotated = await resubscribeAfterKeyChange(error, registration);
    if (!rotated) return classifySubscribeFailure(error);
    subscription = rotated;
  }

  try {
    const summary = await postSubscription(subscription);
    clearPushFailure();
    return { outcome: 'enabled', subscription: summary };
  } catch (error) {
    // The subscription exists in the browser but the server has no row, so
    // nothing will ever be delivered and nothing on the device says so.
    return fail('server-rejected', 'server', error);
  }
}

/**
 * Recover from a rotated VAPID key.
 *
 * `subscribe()` throws `InvalidStateError` when a subscription already exists
 * under a *different* `applicationServerKey`. That can only happen once the
 * user has already granted permission — and `PushManager::subscribe` skips the
 * activation check entirely when permission is `granted`, so dropping the stale
 * subscription and retrying is safe even though the gesture is long gone.
 *
 * Returns `null` when this was not that failure, leaving the original error to
 * be classified normally.
 */
async function resubscribeAfterKeyChange(
  error: unknown,
  registration: ServiceWorkerRegistration,
): Promise<PushSubscription | null> {
  if (!(error instanceof Error) || error.name !== 'InvalidStateError') return null;
  if (/active service worker/i.test(error.message)) return null;
  if (permissionState() !== 'granted') return null;

  try {
    const existing = await registration.pushManager.getSubscription();
    if (!existing) return null;
    await deleteSubscription(existing.endpoint).catch(() => undefined);
    await existing.unsubscribe();
    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey()),
    });
  } catch {
    return null;
  }
}

/**
 * Name the failure from what WebKit actually threw.
 *
 * Every branch here corresponds to a distinct, greppable message in
 * `PushManager.cpp`, and they are genuinely different bugs with genuinely
 * different remedies. Collapsing them into one «Не удалось включить
 * уведомления» is what made this undiagnosable in the first place.
 */
function classifySubscribeFailure(error: unknown): EnableResult {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const permission = permissionState();

  // §2.3 — first launch after install; the worker is installing, not active.
  if (name === 'InvalidStateError' || /active service worker/i.test(message)) {
    return fail('not-ready', 'registration', error);
  }

  // §2.6 — our own configuration, not the user's device.
  if (/applicationServerKey|userVisibleOnly|base64url|P-?256/i.test(message)) {
    return fail('misconfigured', 'subscribe', error);
  }

  if (name === 'NotAllowedError') {
    // §2.4 — the activation was spent or expired. With `requestPermission()`
    // gone from this path, seeing this means a genuinely slow tap-to-subscribe,
    // not the self-inflicted version.
    if (/user gesture/i.test(message)) return fail('gesture-lost', 'permission', error);

    if (permission === 'denied') return fail('denied', 'permission', error);

    if (permission === 'default') {
      // The deceptive state. On iOS, `default` after a real tap that produced
      // no prompt is WebKit bug 320551: Allow Notifications is off in the
      // system settings, and no amount of asking will ever change that.
      // Chromium reaches the same shape when the user simply dismisses the
      // prompt, which *is* retryable — so the platform decides the reading.
      if (isIos()) return fail('blocked-in-settings', 'permission', error);
      clearPushFailure();
      return { outcome: 'dismissed' };
    }
  }

  if (permission === 'denied') return fail('denied', 'permission', error);
  return fail('subscribe-rejected', 'subscribe', error);
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
  if (!registration) {
    recordPushFailure('registration', new Error('navigator.serviceWorker.ready'));
    return false;
  }
  try {
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;
    await deleteSubscription(subscription.endpoint).catch(() => undefined);
    await subscription.unsubscribe();
    return true;
  } catch (error) {
    recordPushFailure('unsubscribe', error);
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
  } catch (error) {
    recordPushFailure('subscribe', error);
    return 'failed';
  }

  // The state that has no silent fix: permission is still granted, but the
  // subscription is gone. Only a fresh gesture can create a new one.
  if (!subscription) return 'missing';

  try {
    await postSubscription(subscription);
    return 'reposted';
  } catch (error) {
    // Worth recording even though this path is silent: a reconcile that has
    // been 403ing on every foreground for a week is invisible until somebody
    // reads it off the diagnostics screen.
    recordPushFailure('server', error);
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
