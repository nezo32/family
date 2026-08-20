/// <reference lib="webworker" />
/**
 * Service worker — precache, navigation fallback and Web Push.
 *
 * Built with `strategies: 'injectManifest'` (D7): vite-plugin-pwa replaces
 * `self.__WB_MANIFEST` with the build's precache entries and otherwise leaves
 * this file alone.
 *
 * No Workbox runtime: `workbox-precaching` is not a declared dependency of this
 * package (only `workbox-window` is), and adding one is the lead's call. The
 * hand-rolled precache below is ~60 lines and does exactly what we need for a
 * single-page app.
 *
 * The push section at the bottom implements the three handlers the platform
 * gives us (`push`, `notificationclick`, `pushsubscriptionchange`) plus the D11
 * delivery acks. Read `docs/research/ios-pwa-push.md` before touching it — most
 * of the code there exists to satisfy a hard iOS constraint whose failure mode
 * is silent.
 *
 * **Imports are relative on purpose.** vite-plugin-pwa builds this file in a
 * separate child build; a relative specifier resolves there without depending on
 * whether the `@/` alias is inherited. The three modules it pulls in are pure
 * (no DOM, no React), so the SW bundle stays small.
 */

import {
  deliveryIdFromNotificationData,
  navigateFromNotificationData,
  notificationOptions,
  parsePushPayload,
} from './features/settings/push/payload';
import { ackDelivery } from './features/settings/push/ack-queue';
import { ACKS_PENDING, PUSH_NAVIGATE, TOKEN_REQUEST } from './features/settings/push/messages';

export {};

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string | null }>;
};

const MANIFEST = self.__WB_MANIFEST;

/** Bumping the suffix is unnecessary: the cache name is derived from the build. */
const CACHE_VERSION = MANIFEST.map((e) => e.revision ?? e.url).join('|');
const PRECACHE = `family-precache-${hash(CACHE_VERSION)}`;
const RUNTIME = 'family-runtime-v1';

/** Everything the app boots from, resolved against the SW scope. */
const PRECACHE_URLS = MANIFEST.map((entry) => new URL(entry.url, self.location.origin).href);

/** The SPA entry point every unmatched navigation falls back to. */
const NAVIGATION_FALLBACK = new URL('/index.html', self.location.origin).href;

/** Requests that must never be served from a cache. */
const NEVER_CACHE = [/^\/api\//, /^\/auth\//];

function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Precache the shell — **without** letting one bad entry brick the install.
 *
 * `cache.addAll()` is all-or-nothing: a single 404, an opaque redirect or a
 * storage quota refusal rejects the whole call, the `install` handler's
 * `waitUntil` rejects with it, and the worker is discarded. It never activates,
 * `navigator.serviceWorker.ready` never settles — that promise has no rejection
 * path — and the page has no way to find out. From the app's side this is
 * indistinguishable from "still installing", for ever, across restarts and
 * across a delete-and-reinstall, because the same asset fails again every time.
 *
 * Push cannot exist without an active worker, so the trade is not close: cache
 * what we can, let the rest fall through to the network, and only fail the
 * install if the navigation fallback itself is unobtainable — at which point
 * offline support genuinely cannot work and the failure is the honest answer.
 *
 * `cache: 'reload'` bypasses the HTTP cache so a stale CDN copy cannot poison
 * the precache on the very first install.
 */
async function precache(): Promise<void> {
  const cache = await caches.open(PRECACHE);

  const results = await Promise.allSettled(
    PRECACHE_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
  );

  const failed = PRECACHE_URLS.filter((_, index) => results[index]?.status === 'rejected');
  if (failed.length > 0) {
    // Visible over USB in Web Inspector, which is the only place anyone can
    // read it on the device where this matters.
    console.warn('[sw] precache skipped %d entr(y|ies)', failed.length, failed);
  }

  // The one entry that is not optional: without the shell there is nothing to
  // serve a navigation from when the network is gone.
  if (failed.includes(NAVIGATION_FALLBACK)) {
    throw new Error(`Precache failed for the navigation fallback ${NAVIGATION_FALLBACK}`);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

/**
 * Activate, and claim.
 *
 * `clients.claim()` is unconditional and is **not** gated behind
 * `skipWaiting()`: those are different mechanisms for different moments.
 * `skipWaiting` decides whether a *new* worker displaces a running one — under
 * `registerType: 'prompt'` that is the user's choice, made from the update
 * toast. `claim` only decides whether the worker that just activated takes over
 * the tabs already open, and on a first install there is no previous worker to
 * displace, so it runs immediately and unconditionally.
 *
 * It is also worth being clear about what claiming does *not* do for push.
 * `pushManager.subscribe()` needs an **active registration**, not a controlled
 * page — `navigator.serviceWorker.controller` stays `null` on the first launch
 * until this line lands, while `subscribe()` would already work. Nothing on the
 * page may wait for control.
 *
 * Every step is individually fault-tolerant for the reason `precache()` is: an
 * `activate` handler whose `waitUntil` rejects still leaves a worker in a state
 * nobody on the page can diagnose.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(
          names
            .filter((name) => name.startsWith('family-') && name !== PRECACHE && name !== RUNTIME)
            .map((name) => caches.delete(name)),
        );
      } catch {
        // A stale cache costs disk; a failed activation costs notifications.
      }

      try {
        if ('navigationPreload' in self.registration) {
          await self.registration.navigationPreload.enable();
        }
      } catch {
        // Absent on Safari, and purely an optimisation where it exists.
      }

      try {
        await self.clients.claim();
      } catch {
        // The page is served fine uncontrolled; it will be controlled on the
        // next navigation regardless.
      }
    })(),
  );
});

/**
 * `registerType: 'prompt'` means the page asks the user before we take over.
 * The shell posts `{ type: 'SKIP_WAITING' }` when they accept.
 */
self.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: string }).type === 'SKIP_WAITING'
  ) {
    void self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((re) => re.test(url.pathname))) return;

  // Navigations: network first (so a deploy is picked up), falling back to the
  // precached shell when offline. React Router owns routing from there.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const preloaded = (await event.preloadResponse) as Response | undefined;
          if (preloaded) return preloaded;
          return await fetch(request);
        } catch {
          const cache = await caches.open(PRECACHE);
          const cached = await cache.match(NAVIGATION_FALLBACK);
          return cached ?? new Response('Нет соединения', { status: 503, statusText: 'Offline' });
        }
      })(),
    );
    return;
  }

  // Hashed build assets: cache first, they are immutable by construction.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(RUNTIME);
        void cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});

/* ==========================================================================
 *                              WEB PUSH  (D10 / D11)
 * ==========================================================================
 *
 * Everything below is governed by `docs/research/ios-pwa-push.md`. The four
 * rules that shape the code:
 *
 *  1. **Every push must show a notification.** Not "should" — after ~3 pushes
 *     where the SW ran silently, iOS revokes the subscription with no signal to
 *     the user or to us. So `showNotification()` is unconditional, comes first,
 *     and a malformed payload degrades to generic copy instead of throwing.
 *  2. **The ack must never block or fail the notification** (D11). It runs
 *     after `showNotification()` resolves, it swallows every error, and a
 *     failure lands in IndexedDB for the app to flush on next foreground.
 *  3. **iOS ignores `icon`, `badge`, `actions`, `tag` and `renotify`.** We do
 *     not build behaviour on any of them; coalescing is the backend's job.
 *  4. **`client.navigate()` is unreliable in an installed iOS PWA.** We focus an
 *     existing client and `postMessage` a navigate instruction that React Router
 *     executes, and only fall back to `openWindow()` when nothing is open.
 */

/** Same-origin API base. `apiUrl()` in the app resolves to the same thing. */
const API_ORIGIN = self.location.origin;

/**
 * Borrow the in-memory access token from an open window.
 *
 * D3 keeps the access JWT out of every storage a service worker can read, and
 * the ack endpoints are guarded by `notification:manage:own`. When the app is
 * open we can ask it; when the app is swiped away — the normal case for a push —
 * we get `null` and the ack goes to the queue instead. The timeout is short and
 * absolute: an unanswered request must not delay the ack, let alone hold the
 * service worker alive.
 */
async function borrowAccessToken(timeoutMs = 400): Promise<string | null> {
  let clientList: readonly Client[];
  try {
    clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  } catch {
    return null;
  }
  const target = clientList.find((client) => client.url.startsWith(API_ORIGIN));
  if (!target) return null;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (token: string | null) => {
      if (settled) return;
      settled = true;
      resolve(token);
    };

    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      const token =
        typeof data === 'object' && data !== null ? (data as { token?: unknown }).token : null;
      done(typeof token === 'string' && token.length > 0 ? token : null);
    };

    try {
      target.postMessage({ type: TOKEN_REQUEST }, [channel.port2]);
    } catch {
      done(null);
      return;
    }
    setTimeout(() => {
      done(null);
    }, timeoutMs);
  });
}

/** Tell every open window that the ack queue has something in it. */
async function notifyAcksPending(): Promise<void> {
  try {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) client.postMessage({ type: ACKS_PENDING });
  } catch {
    // The page also flushes on every foreground; this is only a nudge.
  }
}

/**
 * Record a D11 receipt. Fire-and-forget by construction: it resolves, always.
 *
 * `occurredAt` is stamped by the *caller*, at the moment the event happened, and
 * travels with the queued ack — the server clamps it into `[sentAt - skew, now]`
 * so a replay hours later still reports the truth.
 */
async function ack(
  deliveryId: string | null,
  kind: 'delivered' | 'interacted',
  occurredAt: string,
): Promise<void> {
  if (!deliveryId) return;
  try {
    const token = await borrowAccessToken();
    await ackDelivery(deliveryId, kind, { apiBase: API_ORIGIN, token, occurredAt });
    if (!token) await notifyAcksPending();
  } catch {
    // Unreachable in practice — `ackDelivery` swallows its own failures — but an
    // ack is never allowed to reject into `waitUntil`.
  }
}

/**
 * The Badging API is unavailable in some browsers and inside some WebViews.
 * `0` clears rather than showing an empty dot, which is the whole reason for
 * the explicit branch.
 */
function applyAppBadge(count: number | null): void {
  if (count === null) return;
  const badging = navigator as Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count <= 0) {
      void badging.clearAppBadge?.().catch(() => undefined);
      return;
    }
    void badging.setAppBadge?.(count).catch(() => undefined);
  } catch {
    // Badging is cosmetic; never let it interfere with the notification.
  }
}

/* ------------------------------- push -------------------------------------- */

self.addEventListener('push', (event) => {
  // Stamped now, not when the ack finally goes out: this is the instant the
  // message actually reached the device (D11 `deliveredAt`).
  const occurredAt = new Date().toISOString();

  event.waitUntil(
    (async () => {
      // `data.text()` can itself throw on a malformed frame.
      let raw: string | null = null;
      try {
        raw = event.data ? event.data.text() : null;
      } catch {
        raw = null;
      }

      const push = parsePushPayload(raw, API_ORIGIN);

      // HARD RULE — this happens first and is never conditional.
      try {
        await self.registration.showNotification(push.title, notificationOptions(push));
      } catch {
        // Last-ditch: a plain title-only notification still counts as "shown"
        // and is what keeps the subscription alive.
        try {
          await self.registration.showNotification(push.title);
        } catch {
          // Nothing more we can do; do not let it reject `waitUntil`.
        }
      }

      applyAppBadge(push.appBadge);

      // Only now, and only ever after the notification is on screen.
      await ack(push.deliveryId, 'delivered', occurredAt);
    })(),
  );
});

/* --------------------------- notificationclick ------------------------------ */

self.addEventListener('notificationclick', (event) => {
  const occurredAt = new Date().toISOString();
  const data: unknown = event.notification.data;
  const url = navigateFromNotificationData(data, API_ORIGIN);
  const deliveryId = deliveryIdFromNotificationData(data);

  event.notification.close();

  event.waitUntil(
    (async () => {
      // The ack runs first so that a `focus()` that consumes the SW's remaining
      // lifetime cannot lose the receipt — it is durably queued either way.
      await ack(deliveryId, 'interacted', occurredAt);

      let clientList: readonly WindowClient[] = [];
      try {
        clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      } catch {
        clientList = [];
      }

      const existing =
        clientList.find((client) => client.url.startsWith(API_ORIGIN) && client.focused) ??
        clientList.find((client) => client.url.startsWith(API_ORIGIN));

      if (existing) {
        try {
          await existing.focus();
        } catch {
          // Focus can be refused; the postMessage below still routes the app.
        }
        // `client.navigate()` is unreliable in a standalone iOS PWA (it can
        // reload the app to `start_url`, or do nothing at all), so we hand the
        // path to React Router and let it do a client-side navigation.
        try {
          existing.postMessage({ type: PUSH_NAVIGATE, url, deliveryId });
          return;
        } catch {
          // Fall through to opening a window.
        }
      }

      try {
        await self.clients.openWindow(url);
      } catch {
        // Nothing left to try.
      }
    })(),
  );
});

/* ------------------------ pushsubscriptionchange ---------------------------- */

/**
 * Free on Chrome, absent on Safari.
 *
 * MDN BCD has `safari: false, safari_ios: false`, so on the platform that needs
 * it most this handler never runs. The real repair loop is the foreground
 * reconcile in `features/settings/push/push.ts`: on every
 * `visibilitychange -> visible` the app re-POSTs `getSubscription()`. This
 * handler is here because it costs nothing and fixes rotations silently for
 * everybody else.
 *
 * Resubscribing needs the same `applicationServerKey`; we take it from the old
 * subscription when the browser gives us one and fall back to the build-time
 * VAPID key. The POST needs a session, which the SW usually does not have — so a
 * failure here is expected and harmless: the next foreground reconcile fixes it.
 */
self.addEventListener('pushsubscriptionchange', ((event: Event) => {
  const change = event as Event & {
    oldSubscription?: PushSubscription | null;
    newSubscription?: PushSubscription | null;
    waitUntil: (promise: Promise<unknown>) => void;
  };

  change.waitUntil(
    (async () => {
      try {
        let subscription = change.newSubscription ?? null;

        if (!subscription) {
          const applicationServerKey =
            change.oldSubscription?.options.applicationServerKey ??
            urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY);
          if (!applicationServerKey) return;
          subscription = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey,
          });
        }

        const token = await borrowAccessToken();
        if (!token) return;

        await fetch(`${API_ORIGIN}/api/notifications/subscriptions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${token}`,
          },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({ ...subscription.toJSON(), isStandalone: true }),
        });
      } catch {
        // Expected without a session. The foreground reconcile is the real fix.
      }
    })(),
  );
}) as EventListener);

/**
 * base64url -> `Uint8Array`, the only form `applicationServerKey` accepts.
 *
 * Duplicated from `features/settings/push/push.ts` rather than imported: that
 * module reaches into `window` and must not be pulled into the service-worker
 * bundle.
 */
function urlBase64ToUint8Array(base64: string | undefined): Uint8Array<ArrayBuffer> | null {
  if (!base64) return null;
  try {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized);
    const output = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) output[i] = binary.charCodeAt(i);
    return output;
  } catch {
    return null;
  }
}
