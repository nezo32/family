# iOS PWA & Web Push — binding implementation reference

Verified 2026‑08‑19 against WebKit blogs, MDN browser-compat-data and the npm
registry. Platform baseline: iOS/iPadOS 26.6, Safari 26.6.

Anything in this file marked **HARD RULE** is a platform constraint, not a
preference. Violating one produces a silent failure in production that is very
hard to diagnose.

## 1. The three gates for push on iOS

1. **HARD RULE — the PWA must be installed to the Home Screen.** In a normal
   Safari tab on iOS, `window.Notification` is **`undefined`**, not `denied`.
   Feature-detect with `'Notification' in window && 'PushManager' in window`,
   never with `Notification.permission !== 'denied'`.
   Minimum iOS 16.4. Manifest must have a non-default `display` — ship
   `"display": "standalone"` unconditionally.
2. **HARD RULE — user gesture.** `Notification.requestPermission()` must be
   called **synchronously inside the click handler**. WebKit's user-activation
   token does *not* survive an intervening `await`, so never `await fetch()` for
   the VAPID key first — read it from `import.meta.env.VITE_VAPID_PUBLIC_KEY` at
   build time. Safari also requires a live gesture for `pushManager.subscribe()`
   even when permission is already `granted`.
3. **HARD RULE — `userVisibleOnly: true`, and every push MUST show a
   notification** inside `event.waitUntil()`. After roughly **3** pushes where
   the service worker ran without showing anything, iOS **silently revokes the
   subscription**. There is no silent push on iOS.

## 2. `pushsubscriptionchange` does not exist on iOS

MDN BCD: `safari_ios: false`, `safari: false` (Chrome 138+ only). Combined with
gate 2, this means **there is no way to silently repair a subscription on iOS**.

**Required pattern — the foreground reconcile loop:**

- On every `visibilitychange -> visible`, call `registration.pushManager.getSubscription()`
  and `POST /api/notifications/subscriptions` (idempotent upsert keyed on
  `endpoint`). This refreshes `last_seen_at` and repairs rotations for free.
- If `getSubscription()` returns `null` while the server-side preference says
  push is enabled, render a re-enable card: **«Уведомления отключились — включить снова?»**
  A fresh user gesture is the only way back.
- Still register a `pushsubscriptionchange` handler; it is free and works on Chrome.

## 3. What `showNotification()` actually supports on iOS

| Option | iOS | Consequence |
|---|---|---|
| `title`, `body` | ✅ | the only two you may rely on |
| `data` | ⚠️ | works in practice; BCD says no. The declarative `navigate` field makes it moot |
| `icon`, `badge`, `image` | ❌ | iOS always shows the app icon |
| `tag`, `renotify` | ❌ | **no grouping and no replacement** — coalesce server-side |
| `actions` | ❌ | no lock-screen buttons; every notification is a single tap |
| `requireInteraction`, `vibrate`, `silent` | ❌ | |

**Design consequences.** Ten task updates = ten separate lock-screen
notifications. Deduplicate and coalesce in the backend (BullMQ `jobId` per
`(userId, entityId, type)` with a short delay, plus the web-push `topic` option
which the push service itself honours). Since every notification wears the app
icon, the notification **type must be legible from the title text**.

## 4. Declarative Web Push — send the hybrid payload

Shipped iOS/iPadOS 18.4+ and Safari 18.5+. It fixes the long-standing iOS bug
where `clients.openWindow(url)` from `notificationclick` either did nothing or
only opened the root URL, and it exempts the message from silent-push penalties.

Send **one payload that satisfies both worlds** — Safari renders it natively,
every other browser ignores `web_push` and falls through to the service worker:

```jsonc
{
  "web_push": 8030,
  "notification": {
    "title": "Ужин в 19:00",
    "body": "Сегодня твоя очередь готовить",
    "navigate": "https://family.example.com/tasks/42",  // REQUIRED
    "app_badge": 3,
    "mutable": true,   // let the SW customise; platform shows the fallback if it fails
    "dir": "ltr",
    "silent": false,
    "data": { "type": "task_reminder", "taskId": 42 }
  }
}
```

`title` and `navigate` are required for the declarative path. `mutable: true` is
strictly better than classic push: the SW still gets the `push` event, but if the
handler throws or times out the platform shows the notification anyway.

## 5. VAPID

- **HARD RULE — `VAPID_SUBJECT` must be a real, resolvable `mailto:` or
  `https://`.** `mailto:admin@localhost` returns `403 {"reason":"BadJwtToken"}`
  from Apple. So does a subject with spaces or angle brackets.
- Apple's endpoint is `https://web.push.apple.com/...`. No Apple Developer
  account, no certificate, no `gcm_sender_id` needed.
- **Payload limit:** RFC 8291 guarantees only 4096 octets; after headers, padding
  and the AEAD tag that is ≈3993 bytes of plaintext. **Budget ≤3000 bytes.**
  Never put domain data in the payload — send ids and let the app fetch.

### HTTP status handling — get this exactly right

| Status | Action |
|---|---|
| `404`, `410` | **Prune the row.** The subscription is dead. |
| `429` | Back off, honour `Retry-After`. **Never prune.** |
| `413` | Our payload bug. Log loudly. **Never prune.** |
| `400`, `401`, `403` | VAPID/JWT misconfiguration. **Never prune** — a bad deploy would otherwise wipe every subscription in the family. |
| network / `5xx` | Increment `failure_count`; prune only after ~10 consecutive failures. |

## 6. Storage & the 7-day ITP cap — the precise answer

- The 7-day cap applies to **script-writable storage**: IndexedDB, localStorage,
  sessionStorage, Cache API, service worker registrations, and cookies written
  via `document.cookie`.
- **Server-set `HttpOnly` cookies are NOT affected.** This is the decisive
  argument for the `__Host-rt` refresh-cookie design in D3.
- **Home-screen web apps have their own counter of days of use**, reset by every
  launch. WebKit: *"We do not expect the first-party in such a web application to
  have its website data deleted."* An actively used installed PWA keeps its data.
- Since Safari 17 the model is a quota system (per-origin up to 60% of disk),
  with **whole-origin LRU eviction** under pressure.
- Call `navigator.storage.persist()` on boot — WebKit grants it based on
  heuristics *"like whether the website is opened as a Home Screen Web App"*.
- **Never treat client storage as the source of truth.** Postgres is the truth;
  IndexedDB is a cache.

## 7. No Background Sync

`ServiceWorkerRegistration.sync` and `periodicSync` are both **unimplemented in
WebKit**. The only way to run code in the background on iOS is a `push` event.

Offline writes therefore flush on (a) `online` event and (b)
`visibilitychange -> visible`. Never promise the user background delivery.

## 8. State loss on backgrounding

iOS aggressively terminates backgrounded web apps. A PWA left in the background
comes back as a **cold start at `start_url`** — all React state, in-memory
caches, unsaved form input and scroll position are gone. There is no reliable
bfcache for standalone web apps.

- Persist on `pagehide` **and** `visibilitychange -> hidden`. `beforeunload` and
  `unload` are unreliable on iOS.
- Refetch on every `visibilitychange -> visible` — data behind a backgrounded PWA
  is arbitrarily stale. `refetchOnWindowFocus: true` with a short `staleTime`.
- Never implement a pull-to-refresh that calls `location.reload()`; in a PWA a
  reload is a cold start.

## 9. CSS rules that are not optional

```css
/* env(safe-area-inset-*) is 0 unless viewport-fit=cover is in the viewport meta. */
:root {
  --safe-t: max(env(safe-area-inset-top), 0px);
  --safe-b: max(env(safe-area-inset-bottom), 0px);
  --safe-l: max(env(safe-area-inset-left), 0px);
  --safe-r: max(env(safe-area-inset-right), 0px);
}

/* Never 100vh — on iOS it means the LARGE viewport. */
.app-shell { min-height: 100dvh; }

/* Document never scrolls; an inner pane does. overscroll-behavior alone does not
   stop document rubber-banding on iOS. */
html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
#root { height: 100dvh; display: grid; grid-template-rows: auto 1fr auto; overflow: hidden; }
.scroll-pane { overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain; }

/* HARD RULE: a focused input below 16px makes iOS zoom the viewport and never
   zoom back. maximum-scale / user-scalable are ignored by iOS. */
input, select, textarea, button { font-size: max(16px, 1rem); }

* { -webkit-tap-highlight-color: transparent; }
button, a, [role='button'] { touch-action: manipulation; }
```

The bottom tab bar must pad by `calc(var(--safe-b) + 8px)` — the home indicator
eats ~34px on Face ID devices.

## 10. index.html head essentials

- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- Ship **both** `mobile-web-app-capable` and `apple-mobile-web-app-capable`.
- `apple-mobile-web-app-status-bar-style: black-translucent` **only** together
  with `viewport-fit=cover` + safe-area padding, or the header hides behind the
  Dynamic Island.
- `apple-mobile-web-app-title` wins over the manifest `short_name` on iOS — keep
  it ≤12 characters («Семья»).
- `apple-touch-icon` must be a **180×180 opaque PNG with its own padding**. iOS
  ignores the manifest `icons` array and does not apply maskable safe zones;
  transparency renders as black.
- Two `theme-color` tags, one per `prefers-color-scheme`.

## 11. Manifest essentials

`id: '/'` — set once and **never change it**; it defaults to `start_url`, so
changing `start_url` later would create a *second* installed app.
`scope: '/'` is what keeps OAuth callbacks inside the installed app instead of
stranding the user in Safari. `display: 'standalone'` +
`display_override: ['standalone','minimal-ui','browser']`.
`launch_handler: { client_mode: ['navigate-existing','auto'] }` (Chromium).
`screenshots` with both `wide` and `narrow` form factors drive the rich install
dialog on Chromium; iOS ignores them but they cost nothing.

## 12. Service worker strategy

**`injectManifest`, not `generateSW`** — `generateSW` gives no way to add a
`push` handler, and the `importScripts()` workaround is discouraged by the
vite-pwa docs and breaks TypeScript/bundling. The cost is that precaching, the
navigation fallback and runtime routes must be hand-written.

**`registerType: 'prompt'`, not `'autoUpdate'`.** With `autoUpdate` the new SW
activates mid-session, which can 404 lazy-loaded chunks from the running bundle
and destroys unsaved form state. On iOS a surprise reload is a cold start. Show
a «Доступно обновление» toast and call `updateServiceWorker(true)` on accept.
Keep `clientsClaim()` (it only affects the first install, making offline work on
the first visit); the danger is only `clientsClaim` **combined with**
unconditional `skipWaiting`.

Runtime caching, in registration order (Workbox is first-match-wins):

1. **`NetworkOnly` for auth** — `/api/auth/*`, `/api/notifications/subscriptions*`.
   **HARD RULE: never cache an auth endpoint or a push endpoint.** Register these
   *before* the generic `/api/` rule.
2. `NavigationRoute` -> precached `index.html`, with a denylist for `/api/`,
   `/auth/`, `/docs`, `/uploads/` and anything that looks like a file.
3. **`NetworkFirst`** for API GETs, `networkTimeoutSeconds: 4`, `maxAgeSeconds`
   6h, `CacheableResponsePlugin({ statuses: [200] })`, `purgeOnQuotaError: true`.
4. **`StaleWhileRevalidate`** for slow-changing reference data (`/api/users`,
   `/api/family`, `/api/settings`).
5. **`CacheFirst`** for images and fonts, with expiration and `purgeOnQuotaError`.

Add a periodic update check (hourly `r.update()` behind a `cache: 'no-store'`
fetch of the SW URL) — an iOS PWA is often left open for days and would otherwise
never learn an update exists.

## 13. Install & permission UX funnel

There is **no `beforeinstallprompt` on iOS**, no install banner, and no way to
open the share sheet from JS. The funnel must be:

1. First visit in a Safari tab — say nothing about notifications.
2. After the user signs in and does one real action — soft "install" card, whose
   stated reason is *«уведомления работают только после установки»*.
3. First launch from the home icon — still say nothing.
4. When the user creates something with a due date or an assignee — a soft
   pre-prompt tied to that action: *«Напомнить тебе об этом?»*
5. Only that tap calls `Notification.requestPermission()`.

**Why the soft pre-prompt is mandatory:** the OS prompt can be shown **once
ever**. If denied, `Notification.permission` is permanently `'denied'` and the
only recovery is Settings → Уведомления → Семья, which no family member will
find. Your own dialog is retryable; the OS one is not.

Detection notes: iPadOS reports UA `Macintosh` since iPadOS 13, so combine it
with `navigator.maxTouchPoints > 1`. Non-Safari iOS browsers (Chrome, Firefox,
Yandex, DuckDuckGo) cannot add to the Home Screen — detect and tell the user to
open in Safari first.

## 14. Subscription storage

- Key on **`endpoint`, globally unique** (not `(user_id, endpoint)`). A reinstall
  yields a brand-new endpoint; the unique constraint plus an upsert that re-binds
  `user_id` correctly handles two family members sharing one tablet.
- **Treat `endpoint` as a secret** — it is a capability URL. Never return it to
  the client in a list response (return `id`, `deviceLabel`, `platform`), and
  never log it above debug level.
- Store the device's IANA timezone from
  `Intl.DateTimeFormat().resolvedOptions().timeZone` — quiet hours must be
  evaluated in the *recipient's* local time, not the server's.
- Prune anything not seen in 90 days.

## 15. Settings screen must include a test button

**«Отправить тестовое уведомление»** is the only way a family member can confirm
the whole chain works on iOS, and it is the single biggest support-ticket
deflector in the app.

## 16. Pre-launch device checklist

1. `VAPID_SUBJECT` is a real address on a resolvable domain.
2. Manifest served as `application/manifest+json`; `id` set and frozen.
3. In a Safari tab, `'Notification' in window === false` — the UI must not crash
   or show a dead "включить" button.
4. Installed and launched from the icon; `matchMedia('(display-mode: standalone)').matches === true`.
5. Permission prompt fires only from a real tap, with no `await` before it.
6. Push arrives with the app **fully swiped away**, and the tap lands on the
   correct deep URL.
7. Five pushes in a row still leave the subscription alive.
8. Badge sets and `setAppBadge(0)` clears rather than showing a dot.
9. Kill under memory pressure, return — state restores and data refetches.
10. Airplane mode: shell loads, cached data shows, auth endpoints fail rather
    than serving a cached session.
11. New deploy: «Доступно обновление» appears within the hour and reloads cleanly.
12. Focusing any input does not zoom the viewport.
13. Landscape on iPhone: no content under the notch.

## Open items to verify on a real device before shipping

- Whether `showNotification`'s `data` option is reliable on iOS (BCD says no,
  field reports say yes). The declarative `navigate` field makes this moot — which
  is exactly why the hybrid payload is mandatory.
- The exact iOS 26.6 share-sheet wording used in the Russian install instructions.
