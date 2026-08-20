import type { EnableOutcome, PushFailure, PushPermission, PushReadiness } from './push';
import {
  isIos,
  isIosNonSafari,
  isStandalone,
  lastEnableOutcome,
  lastPushFailure,
  permissionState,
  registrationSnapshot,
  vapidPublicKey,
} from './push';
import { fetchSubscriptions } from '../api';

/**
 * Everything that has to be true before a push can arrive, read off the device
 * that is actually failing.
 *
 * ## Why this module exists
 *
 * Web Push on iOS fails in a way nobody outside the affected phone can see. The
 * app is installed or it is not; the permission is `default`, `granted` or
 * permanently `denied`; a service worker is registered at some scope or none;
 * the browser holds a `PushSubscription` or dropped it; the server has the row
 * or never received it. Any one of those being wrong produces the same visible
 * result — the notifications do not turn on — and none of them are observable
 * from a desktop browser, from CI, or from a log line.
 *
 * So the instrument goes on the device. `collectPushDiagnostics()` reads each
 * precondition separately and never throws: a probe that cannot answer reports
 * `'unknown'` rather than taking the screen down, because a diagnostics screen
 * that crashes on the one device that needs it is worse than none.
 *
 * ## What is deliberately *not* in here
 *
 * The push **endpoint** is a capability URL — anyone holding it can send this
 * phone a notification (research doc §14: never return it to the client, never
 * log it above debug). This output is designed to be copied into a chat window,
 * so the endpoint must not be in it. {@link subscriptionOrigin} and
 * {@link subscriptionFingerprint} carry what we actually need — which push
 * service issued it, and whether two readings are the same subscription —
 * without carrying the capability itself.
 */
export interface PushDiagnostics {
  /** When this snapshot was taken. */
  at: string;
  appVersion: string;

  /* --- gate 1: installed as an app? -------------------------------------- */
  standalone: boolean;
  displayMode: DisplayMode;
  ios: boolean;
  /** iOS Chrome/Firefox/Yandex — cannot add to the Home Screen at all. */
  iosNonSafari: boolean;

  /* --- gate 2: does the platform expose the APIs? ------------------------- */
  notificationApi: boolean;
  pushManagerApi: boolean;
  serviceWorkerApi: boolean;

  /* --- gate 3: permission ------------------------------------------------ */
  /**
   * **Not trustworthy on its own.** WebKit bug 320551: once the user turns
   * «Разрешить уведомления» off in iOS Settings, this reads `'default'` — the
   * same value as "never asked" — and the prompt never appears again. That is
   * why {@link lastAttempt} is collected alongside it.
   */
  permission: PushPermission;
  /**
   * How the last real attempt to subscribe ended, this session.
   *
   * The only way to tell "never asked" from "asked, and iOS silently refuses"
   * — the two states `permission: 'default'` collapses into one.
   */
  lastAttempt: EnableOutcome | null;

  /* --- gate 4: the service worker ---------------------------------------- */
  serviceWorker: ServiceWorkerHealth;
  serviceWorkerScope: string | null;
  /** `'pushManager' in registration` — absent on a registration iOS refused. */
  registrationHasPushManager: boolean;
  /**
   * Whether this page is being *controlled* by the worker.
   *
   * **Reported, never acted on.** On the first launch after an install
   * `navigator.serviceWorker.controller` is `null` until the worker claims the
   * page or the page reloads, while the registration is perfectly active and
   * `subscribe()` works fine. Anything that gates on this is dead on exactly
   * the launch a user first goes looking for notifications — the shape
   * Discourse chased for a week, and the shape that produced the bug this row
   * now exists to rule out.
   */
  serviceWorkerControlling: boolean;

  /**
   * The three worker slots, separately.
   *
   * {@link serviceWorker} collapses them into the first non-empty one, which
   * hides the state that matters most: an `installing` worker that never
   * becomes `active`, or a `waiting` one parked behind `registerType: 'prompt'`
   * while the page waits for a worker that will never take over.
   */
  serviceWorkerInstalling: boolean;
  serviceWorkerWaiting: boolean;
  serviceWorkerActive: boolean;
  /** `registration.active.state`: `activating`, `activated`, `redundant`. */
  serviceWorkerActiveState: string | null;
  /**
   * Whether `navigator.serviceWorker.ready` has actually settled.
   *
   * The one fact that separates "still starting" from "will never start": that
   * promise has no rejection path, so a worker that cannot install leaves it
   * pending for ever and every naive readiness check false for ever.
   */
  serviceWorkerReadyResolved: boolean;
  /** How long we have been waiting for an active worker, in milliseconds. */
  serviceWorkerWaitedMs: number | null;
  /** `starting` / `stalled` / `ready`, as the push module sees it. */
  serviceWorkerReadiness: PushReadiness;
  /** `onRegisterError`, verbatim, when `register()` itself failed. */
  serviceWorkerRegistrationError: string | null;

  /* --- gate 5: the subscription ------------------------------------------ */
  subscription: Tristate;
  /** Origin only, never the path. `https://web.push.apple.com` on iOS. */
  subscriptionOrigin: string | null;
  /** Short non-reversible digest, so two readings can be compared. */
  subscriptionFingerprint: string | null;

  /* --- gate 6: does the server know? ------------------------------------- */
  serverKnows: Tristate;
  /** How many devices the server has for this user; `null` if we could not ask. */
  serverDeviceCount: number | null;

  /* --- gate 7: is there a key to subscribe with? -------------------------- */
  vapidKey: 'present' | 'missing';

  /* --- the verbatim failure ---------------------------------------------- */
  lastError: PushFailure | null;

  /* --- context ----------------------------------------------------------- */
  timezone: string;
  userAgent: string;
  online: boolean;
}

export type DisplayMode = 'standalone' | 'minimal-ui' | 'fullscreen' | 'browser' | 'unknown';
export type ServiceWorkerHealth = 'none' | 'installing' | 'waiting' | 'active' | 'unknown';
/** `'unknown'` is a real answer here — the probe could not run, so do not guess. */
export type Tristate = 'yes' | 'no' | 'unknown';

/* -------------------------------------------------------------------------- */
/* probes                                                                      */
/* -------------------------------------------------------------------------- */

function displayMode(): DisplayMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'unknown';
  for (const mode of ['standalone', 'minimal-ui', 'fullscreen', 'browser'] as const) {
    try {
      if (window.matchMedia(`(display-mode: ${mode})`).matches) return mode;
    } catch {
      return 'unknown';
    }
  }
  // iOS honours `navigator.standalone` even where the media query does not
  // match, which is exactly the case this whole screen exists to disambiguate.
  return isStandalone() ? 'standalone' : 'unknown';
}

/**
 * FNV-1a over the endpoint, rendered base36 and clipped to eight characters.
 *
 * Enough to tell "the same subscription as yesterday" from "a new one", and far
 * too little to reconstruct a capability URL from.
 */
export function fingerprintEndpoint(endpoint: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < endpoint.length; i += 1) {
    h ^= endpoint.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 8);
}

function originOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

/**
 * The registration for our scope, *without* `navigator.serviceWorker.ready`.
 *
 * `ready` never settles when nothing is registered, which would hang this whole
 * collection on precisely the broken device it is meant to describe.
 * `getRegistration()` resolves to `undefined` instead, which is an answer.
 */
async function registrationForDiagnostics(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration('/')) ?? null;
  } catch {
    return null;
  }
}

function healthOf(registration: ServiceWorkerRegistration | null): ServiceWorkerHealth {
  if (!registration) return 'none';
  if (registration.active) return 'active';
  if (registration.waiting) return 'waiting';
  if (registration.installing) return 'installing';
  return 'unknown';
}

/* -------------------------------------------------------------------------- */
/* collection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Take one reading. Never throws, never hangs on a missing service worker.
 *
 * Must be called **outside** a user gesture: it awaits several things, and a
 * tap that also has to reach `pushManager.subscribe()` has only five seconds of
 * transient activation to spend.
 */
export async function collectPushDiagnostics(): Promise<PushDiagnostics> {
  const hasWindow = typeof window !== 'undefined';
  const hasNavigator = typeof navigator !== 'undefined';
  // Read from the push module rather than re-derived here: it holds the handle
  // the enable path would actually subscribe against, including the case where
  // `getRegistration()` below can see a registration that priming never got.
  const snapshot = registrationSnapshot();

  const diagnostics: PushDiagnostics = {
    at: new Date().toISOString(),
    appVersion: __APP_VERSION__,

    standalone: isStandalone(),
    displayMode: displayMode(),
    ios: isIos(),
    iosNonSafari: isIosNonSafari(),

    notificationApi: hasWindow && 'Notification' in window,
    pushManagerApi: hasWindow && 'PushManager' in window,
    serviceWorkerApi: hasNavigator && 'serviceWorker' in navigator,

    permission: permissionState(),
    lastAttempt: lastEnableOutcome(),

    serviceWorker: 'unknown',
    serviceWorkerScope: null,
    registrationHasPushManager: false,
    serviceWorkerControlling:
      hasNavigator &&
      'serviceWorker' in navigator &&
      navigator.serviceWorker.controller !== null &&
      navigator.serviceWorker.controller !== undefined,

    serviceWorkerInstalling: snapshot.installing,
    serviceWorkerWaiting: snapshot.waiting,
    serviceWorkerActive: snapshot.active,
    serviceWorkerActiveState: snapshot.activeState,
    serviceWorkerReadyResolved: snapshot.readyResolved,
    serviceWorkerWaitedMs: snapshot.waitedMs,
    serviceWorkerReadiness: snapshot.readiness,
    serviceWorkerRegistrationError: snapshot.error,

    subscription: 'unknown',
    subscriptionOrigin: null,
    subscriptionFingerprint: null,

    serverKnows: 'unknown',
    serverDeviceCount: null,

    vapidKey: vapidPublicKey() ? 'present' : 'missing',

    lastError: lastPushFailure(),

    timezone: resolveTimezone(),
    userAgent: hasNavigator ? navigator.userAgent : 'unknown',
    online: hasNavigator ? navigator.onLine !== false : true,
  };

  const registration = await registrationForDiagnostics();
  diagnostics.serviceWorker = healthOf(registration);
  diagnostics.serviceWorkerScope = registration?.scope ?? snapshot.scope;
  diagnostics.registrationHasPushManager = Boolean(registration && 'pushManager' in registration);
  if (registration) {
    // `getRegistration()` sees the browser's current truth; the snapshot sees
    // what the enable path is holding. When they disagree the fresher reading
    // is the one worth printing.
    diagnostics.serviceWorkerInstalling = registration.installing != null;
    diagnostics.serviceWorkerWaiting = registration.waiting != null;
    diagnostics.serviceWorkerActive = registration.active != null;
    diagnostics.serviceWorkerActiveState = registration.active?.state ?? null;
  }

  let endpoint: string | null = null;
  if (registration && diagnostics.registrationHasPushManager) {
    try {
      const subscription = await registration.pushManager.getSubscription();
      diagnostics.subscription = subscription ? 'yes' : 'no';
      endpoint = subscription?.endpoint ?? null;
    } catch {
      diagnostics.subscription = 'unknown';
    }
  } else if (registration) {
    diagnostics.subscription = 'no';
  }

  if (endpoint) {
    diagnostics.subscriptionOrigin = originOf(endpoint);
    diagnostics.subscriptionFingerprint = fingerprintEndpoint(endpoint);
  }

  // Ask the server whether it holds *this* endpoint. `isCurrent` is computed
  // server-side from the query parameter, so a `true` here means the row the
  // dispatcher would actually push to is the one this browser holds.
  try {
    const devices = await fetchSubscriptions(endpoint);
    diagnostics.serverDeviceCount = devices.length;
    if (!endpoint) diagnostics.serverKnows = 'unknown';
    else diagnostics.serverKnows = devices.some((device) => device.isCurrent) ? 'yes' : 'no';
  } catch {
    diagnostics.serverKnows = 'unknown';
    diagnostics.serverDeviceCount = null;
  }

  return diagnostics;
}

function resolveTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  } catch {
    return 'unknown';
  }
}

/* -------------------------------------------------------------------------- */
/* the verdict                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which precondition failed first, in the order the platform enforces them.
 *
 * The screen shows every line regardless, but a non-technical reader needs one
 * sentence at the top telling them which one is *the* problem — a wall of
 * fourteen green ticks and one red cross is still a wall.
 */
export type PushVerdict =
  | 'ok'
  | 'not-installed'
  | 'ios-non-safari'
  | 'unsupported'
  | 'denied'
  /** iOS reports `default` and will never prompt — WebKit bug 320551. */
  | 'blocked-in-settings'
  | 'not-asked'
  | 'no-service-worker'
  | 'sw-not-active'
  /** A registration exists, has had long enough, and still will not activate. */
  | 'sw-stalled'
  | 'no-subscription'
  | 'server-unaware'
  | 'misconfigured'
  | 'unknown';

export function pushVerdict(d: PushDiagnostics): PushVerdict {
  // Order matters: each gate is a precondition of the next, so the first
  // failing one is the only one worth acting on.
  if (d.iosNonSafari) return 'ios-non-safari';
  if (!d.notificationApi || !d.pushManagerApi || !d.serviceWorkerApi) {
    // On iOS the APIs are simply absent until the app is on the Home Screen —
    // that is "not installed", not "your phone cannot do this".
    return d.ios ? 'not-installed' : 'unsupported';
  }
  if (d.ios && !d.standalone) return 'not-installed';
  if (d.permission === 'denied') return 'denied';

  // Before believing `'default'`: a real attempt that came back
  // `blocked-in-settings` is the only evidence that separates "we have not
  // asked yet" from "iOS is refusing to ask on our behalf". `permission` alone
  // cannot tell them apart, and it is the likelier of the two for anyone who
  // has tried and failed before.
  if (d.lastAttempt === 'blocked-in-settings') return 'blocked-in-settings';

  if (d.vapidKey === 'missing') return 'misconfigured';
  if (d.serviceWorker === 'none') return 'no-service-worker';
  // "Still starting" and "stuck" need different sentences: one asks for a few
  // seconds of patience, the other has to stop asking for patience entirely,
  // because the user has already given it and it did not help.
  if (!d.serviceWorkerActive && d.serviceWorkerReadiness === 'stalled') return 'sw-stalled';
  if (d.serviceWorker === 'installing' || d.serviceWorker === 'waiting') return 'sw-not-active';
  if (d.permission === 'default') return 'not-asked';
  if (d.subscription === 'no') return 'no-subscription';
  if (d.subscription === 'yes' && d.serverKnows === 'no') return 'server-unaware';
  if (d.subscription === 'yes' && d.serverKnows === 'yes') return 'ok';
  return 'unknown';
}

/* -------------------------------------------------------------------------- */
/* the copyable report                                                         */
/* -------------------------------------------------------------------------- */

const YES_NO: Record<Tristate, string> = { yes: 'да', no: 'нет', unknown: 'не удалось проверить' };

function bool(value: boolean): string {
  return value ? 'да' : 'нет';
}

/**
 * The whole reading as one block of plain text.
 *
 * Russian labels because the person reading it off the phone is not an
 * engineer — but the values (`NotAllowedError`, a scope, an HTTP status) stay
 * verbatim, because the person receiving the paste *is*. A translated error
 * name is a lost error name.
 */
export function formatPushDiagnostics(d: PushDiagnostics): string {
  const lines: string[] = [
    'Диагностика уведомлений «Семья»',
    `Снято: ${d.at}`,
    `Версия приложения: ${d.appVersion}`,
    '',
    `Запущено как приложение: ${bool(d.standalone)} (display-mode: ${d.displayMode})`,
    `iOS: ${bool(d.ios)}${d.iosNonSafari ? ' (браузер не Safari)' : ''}`,
    `Notification API: ${bool(d.notificationApi)}`,
    `PushManager API: ${bool(d.pushManagerApi)}`,
    `Service Worker API: ${bool(d.serviceWorkerApi)}`,
    `Разрешение: ${d.permission}`,
    `Последняя попытка включить: ${d.lastAttempt ?? 'не было в этом сеансе'}`,
    `Service Worker: ${d.serviceWorker}${d.serviceWorkerScope ? ` (scope ${d.serviceWorkerScope})` : ''}`,
    `  installing/waiting/active: ${bool(d.serviceWorkerInstalling)}/${bool(d.serviceWorkerWaiting)}/${bool(d.serviceWorkerActive)}` +
      (d.serviceWorkerActiveState ? ` (active.state=${d.serviceWorkerActiveState})` : ''),
    `  serviceWorker.ready сработал: ${bool(d.serviceWorkerReadyResolved)}`,
    `  ждём активную службу: ${d.serviceWorkerWaitedMs === null ? '—' : `${String(d.serviceWorkerWaitedMs)} мс`} (${d.serviceWorkerReadiness})`,
    `  ошибка регистрации: ${d.serviceWorkerRegistrationError ?? 'нет'}`,
    `Страница под управлением SW (controller): ${bool(d.serviceWorkerControlling)}`,
    `pushManager у регистрации: ${bool(d.registrationHasPushManager)}`,
    `Подписка в браузере: ${YES_NO[d.subscription]}`,
    `Сервис подписки: ${d.subscriptionOrigin ?? '—'}`,
    `Отпечаток подписки: ${d.subscriptionFingerprint ?? '—'}`,
    `Сервер знает это устройство: ${YES_NO[d.serverKnows]}`,
    `Устройств на сервере: ${d.serverDeviceCount ?? '—'}`,
    `Ключ VAPID: ${d.vapidKey === 'present' ? 'есть' : 'нет'}`,
    `Сеть: ${d.online ? 'онлайн' : 'офлайн'}`,
    `Часовой пояс: ${d.timezone}`,
    `User-Agent: ${d.userAgent}`,
    '',
    `Итог: ${pushVerdict(d)}`,
  ];

  if (d.lastError) {
    lines.push(
      '',
      'Последняя ошибка:',
      `  этап: ${d.lastError.stage}`,
      `  ${d.lastError.name}: ${d.lastError.message}`,
    );
    if (d.lastError.status !== undefined) lines.push(`  HTTP ${String(d.lastError.status)}`);
    if (d.lastError.code !== undefined) lines.push(`  код: ${d.lastError.code}`);
    lines.push(`  когда: ${d.lastError.at}`);
  } else {
    lines.push('', 'Последняя ошибка: нет');
  }

  return lines.join('\n');
}
