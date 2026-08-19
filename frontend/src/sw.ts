/// <reference lib="webworker" />
/**
 * Service worker — precache + navigation fallback skeleton.
 *
 * Built with `strategies: 'injectManifest'` (D7): vite-plugin-pwa replaces
 * `self.__WB_MANIFEST` with the build's precache entries and otherwise leaves
 * this file alone.
 *
 * Deliberately dependency-free: `workbox-precaching` is not a declared
 * dependency of this package (only `workbox-window` is), and adding one is the
 * lead's call. The hand-rolled precache below is ~60 lines and does exactly
 * what we need for a single-page app.
 *
 * Push notification handling is NOT implemented here — see the TODO(push)
 * section at the bottom. A later agent owns it.
 */

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

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      // `reload` bypasses the HTTP cache so a stale CDN copy can't poison the
      // precache on the very first install.
      await cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('family-') && name !== PRECACHE && name !== RUNTIME)
          .map((name) => caches.delete(name)),
      );
      if ('navigationPreload' in self.registration) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
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

/* -------------------------------------------------------------------------
 * TODO(push) — owned by the notifications agent, do not implement here yet.
 *
 * Required handlers:
 *   self.addEventListener('push', ...)            decode the VAPID payload,
 *                                                 respect quiet hours already
 *                                                 applied server-side (D10),
 *                                                 call showNotification() with
 *                                                 Russian title/body, tag by
 *                                                 intent id so repeats collapse
 *   self.addEventListener('notificationclick',..) focus an existing client or
 *                                                 openWindow() the deep link
 *   self.addEventListener('notificationclose',..) optional delivery telemetry
 *   self.addEventListener('pushsubscriptionchange', ...) re-register the device
 *                                                 against POST /api/push/subscriptions
 *
 * Notes for whoever picks this up:
 *  - iOS only delivers push to a PWA installed to the Home Screen, and only
 *    after Notification.requestPermission() was called from a user gesture.
 *  - A push event MUST show a notification on every delivery or Chrome will
 *    eventually revoke the permission.
 * ---------------------------------------------------------------------- */
