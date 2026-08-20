# iOS PWA & Web Push — binding implementation reference

**Re-verified 2026‑08‑20.** Platform baseline: **iOS/iPadOS 26.6 (build 23G71), Safari 26.6**
— the version the owner's device actually reports.

Anything marked **HARD RULE** is a platform constraint, not a preference. Violating one
produces a silent failure in production that is very hard to diagnose.

## Sources and how much to trust them

| Tier             | Source                                                                                                                                                                                                                                                                                                                                                                                                                                   | Fetched    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Primary — code   | WebKit `main` branch: `Notification.cpp`, `PushManager.cpp`, `LocalDOMWindow.cpp`, `WebPushDaemonConstants.h`, `NotificationData.h`, `WebPushDaemon.mm`, `PushService.mm`, `NotificationJSONParser.cpp`                                                                                                                                                                                                                                  | 2026‑08‑20 |
| Primary — Apple  | WebKit blog: [Web Push for Web Apps on iOS/iPadOS](https://webkit.org/blog/13878/) (2023‑02‑16), [Meet Web Push](https://webkit.org/blog/12945/) (2022‑06‑07), [Meet Declarative Web Push](https://webkit.org/blog/16535/) (2025‑03‑27), [Safari 26.0](https://webkit.org/blog/17333/) (2025‑09‑15), [Safari 26.2](https://webkit.org/blog/17640/), [Safari 26.6](https://webkit.org/blog/18178/) (2026‑07‑27); WWDC22‑10098, WWDC25‑235 | 2026‑08‑20 |
| Primary — bugs   | bugs.webkit.org REST API (status verified live, not inferred)                                                                                                                                                                                                                                                                                                                                                                            | 2026‑08‑20 |
| Primary — compat | mdn/browser-compat-data `main`, caniuse `push-api`                                                                                                                                                                                                                                                                                                                                                                                       | 2026‑08‑20 |
| Secondary        | vendor docs (OneSignal, Progressier), Apple Developer Forums, Discourse Meta — labelled inline                                                                                                                                                                                                                                                                                                                                           | 2026‑08‑20 |

**Caveat on the code tier.** WebKit `main` is trunk; iOS 26.6 shipped from an earlier branch.
Trunk is the best available statement of the rules and of Apple's intent, and where a shipped
release note contradicts it that is called out below. Do not treat a trunk constant as proof of
the byte-for-byte behaviour of 26.6 — treat it as _far_ better evidence than a blog post from 2023.

---

## 0. What changed since the previous revision of this file

The previous revision was written against the iOS 16.4-era rules. Every claim was re-checked.

| Old claim                                                                                 | Verdict                                 | Now                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push requires Home Screen install; no push in a Safari tab                                | **STILL TRUE**                          | Confirmed through iOS 26.x. §1.                                                                                                                                                                                   |
| Manifest must have a non-default `display`                                                | **CHANGED**                             | No longer required on iOS 26+ — _installability has zero requirements_. Still required on iOS ≤ 18.x, so keep shipping it. §1.4.                                                                                  |
| `requestPermission()` must be **synchronous**; the call is **rejected** without a gesture | **CHANGED — both halves wrong**         | It needs _transient activation_, which lasts **5 s** and is **consumed once**. And it **never rejects** — it _resolves_ with `"denied"`. §3.                                                                      |
| A refusal leaves `Notification.permission === 'denied'` permanently                       | **CHANGED**                             | A refusal _in the prompt_ does. A revocation _in Settings_ leaves it reading **`'default'`** — open bug 320551, filed 2026‑07‑29. §3.4. This is the single most likely cause of "notifications will not turn on". |
| Safari needs a live gesture for `subscribe()` even when permission is `granted`           | **FALSE**                               | Source: the activation check runs **only** when permission is `default`. §3.3.                                                                                                                                    |
| `userVisibleOnly: true` mandatory                                                         | **STILL TRUE**                          | Hard-coded reject in `PushManager.cpp`. §5.                                                                                                                                                                       |
| ~3 pushes without a notification revokes the subscription                                 | **STILL TRUE, now exact**               | `maxSilentPushCount = 3`, timeout `30 s` per push. §5.                                                                                                                                                            |
| No `pushsubscriptionchange` on iOS                                                        | **STILL TRUE**                          | BCD `safari_ios: false` as of 2026‑08‑20. §6.                                                                                                                                                                     |
| Declarative Web Push `web_push: 8030` exists                                              | **STILL TRUE, payload shape corrected** | `app_badge` and `mutable` belong at the **outer** level, not inside `notification`. The old example in this file was wrong. §8.                                                                                   |
| `showNotification` `data` is unreliable ("BCD says no")                                   | **CHANGED**                             | BCD is internally inconsistent; `Notification.data` reads `16.4` ✅. §7.                                                                                                                                          |
| EU PWAs lost push under the DMA                                                           | **OBSOLETE / NEVER SHIPPED**            | Apple reversed that plan in March 2024. Still repeated in 2026 blog posts. Irrelevant to a Russian-locale household anyway.                                                                                       |

**Newly discovered, not in the previous revision:**

- iOS 26's **"Open as Web App" toggle** in the Add to Home Screen sheet. If off, the icon is a
  _bookmark_ and push can never work. New #1 failure mode. §1.2, §2.1.
- The **`requestPermission()`-then-`subscribe()` activation trap** — a source-level mechanism
  that produces a misleading "user gesture" error in exactly the broken state. §3.3.
- **`InvalidStateError: Subscribing for push requires an active service worker`** on first launch. §2.3.
- Open bug **319865** (2026‑07‑21): APNs returns 201, nothing is ever delivered. Unexplained. §2.10.
- Safari **26.2** moved where `mutable` is read from. §8.
- Web Inspector attachment **suppresses** the silent-push penalty — debugging hides the bug. §5.
- A Home Screen web app has its **own cookie jar**, separate from Safari. A user signed in in
  Safari is signed out in the web app, and never reaches the notifications toggle. §2.11.

---

## 1. The gates for push on iOS 26

1. **HARD RULE — it must be running as a Home Screen web app.** In a Safari tab on iOS,
   `window.Notification` is **`undefined`** (BCD: the constructor _"throws a `ReferenceError`
   exception, unless the page is a web app saved to the home screen"_). caniuse `push-api` still
   carries note #7, _"Requires website to first be added to the Home Screen"_, for every iOS
   version up to and including 26.5. Nothing in the Safari 26.0–26.6 release notes changes it.

   Feature-detect with `'Notification' in window && 'PushManager' in window`.
   **Never** with `Notification.permission !== 'denied'` — that throws in a tab.

2. **HARD RULE (NEW in iOS 26) — "Open as Web App" must have been left ON.**
   Safari 26.0 (2025‑09‑15): _"By default, every website added to the Home Screen opens as a web
   app. If the user prefers to add a bookmark for their browser, they can disable 'Open as Web
   App' when adding to Home Screen — even if the site is configured to be a web app."_

   Consequence: a user who flicked that toggle off has an icon that looks installed, opens in
   Safari's browser view, and can **never** receive push. There is no API to read the toggle;
   detect the _result_ with `matchMedia('(display-mode: standalone)').matches`.

3. **Minimum iOS 16.4** for push at all. Unchanged since 2023.

4. **Manifest `display`.** Safari 26.0: _"Giving users a web app experience simply no longer
   requires a manifest file… there are now zero requirements for 'installability' in Safari."_
   So on iOS 26 the `display` value no longer gates anything. On iOS ≤ 18.x it still does
   (BCD note: _"The app's manifest must have a non-default `display` value"_).
   **Ship `"display": "standalone"` unconditionally** — free on 26, load-bearing below it.

5. **Third-party browsers.** Chrome, Edge and others on iOS have been able to add web apps to the
   Home Screen since iOS 16.4, and push works in the resulting web app (secondary sources, 2023).
   They all run WebKit outside the EU, so the rules above are identical.
   _Unverified:_ whether the iOS 26 "Open as Web App" toggle appears in third-party share sheets.
   **Tell users to install from Safari** — it is the only path this file can vouch for.

---

## 2. Notifications will not turn on — what to check, in order

Ordered by likelihood for an installed family PWA on iOS 26.6. Each item states how to tell it
apart from the ones around it. Work down; do not skip.

### 2.1 It is not actually a web app — it is a bookmark or a tab

_Most likely of all on iOS 26, because the "Open as Web App" toggle is new and easy to miss._

- **Test:** `matchMedia('(display-mode: standalone)').matches`, `navigator.standalone`,
  `typeof Notification`.
- **Signature:** `standalone === false`, `typeof Notification === 'undefined'`. The enable button
  is dead — _nothing at all happens_: no prompt, no error, no console message.
- **Distinguish from 2.2:** in 2.2 `Notification` exists. If it is undefined you are not in a web
  app; stop here.
- **Fix:** delete the icon, re-add from **Safari** → Share → Add to Home Screen with
  **"Open as Web App" ON**, then launch from the icon.

### 2.2 The OS permission is off in Settings, but JS reports `'default'`

_Open WebKit bug [320551](https://bugs.webkit.org/show_bug.cgi?id=320551), status NEW, filed
2026‑07‑29, `rdar://184115018`. Filed against exactly this configuration: installed iOS web app,
`display: standalone`, current iOS._

The reporter's wording: after the user turns **Settings → Notifications → \[Web App\] → Allow
Notifications** OFF, `Notification.permission` returns **`"default"`** (expected `"denied"`) and
`navigator.permissions.query({name:'notifications'})` returns **`"prompt"`**. `requestPermission()`
then _shows no prompt_, and the permission can never be granted from inside the app.

- **Signature:** `Notification.permission === 'default'`, the enable button is live, tapping it
  produces **no visible prompt**, and the promise settles almost instantly.
- **Distinguish from 2.4 (lost gesture):** 2.4 logs a Security-level message to the Web Inspector
  console — _"Notification prompting can only be done from a user gesture."_ This one logs nothing.
- **Distinguish from 2.5 (real denial):** a real in-prompt denial reads `'denied'`.
- **Fix — this is the owner's Settings path:**
  **Настройки → Уведомления → \[название веб‑приложения\] → Разрешить уведомления → ВКЛ**
  (`Settings → Notifications → [web app] → Allow Notifications → ON`). The web app is listed
  there under its `apple-mobile-web-app-title` / manifest name, in the same alphabetical list as
  native apps. It appears **only after the permission prompt has been answered at least once** —
  if it is absent, the app has never prompted, so you are in 2.1 or 2.4, not here.
  While in there, also check **Lock Screen / Notification Center / Banners** and
  **Scheduled Summary** (2.9).
- **Nuclear fix:** delete the web app icon and re-add it. That destroys the container's storage
  and its permission, giving a genuine first-run prompt again — and logs the user out.

### 2.3 The service worker is not active yet

_Only bites on the very first launch after install — which is exactly when a user first tries to
enable notifications._

`PushManager.cpp` rejects with a literal string you can match on:

> `InvalidStateError: Subscribing for push requires an active service worker`

Well documented in the wild — Discourse hit precisely this
([meta.discourse.org 402645](https://meta.discourse.org/t/402645), 2025): the SW had installed and
activated but was not controlling the page, `navigator.serviceWorker.controller` was `null`, and
the UI reported success while no subscription existed.

- **Signature:** that exact `InvalidStateError`; or the UI says it worked but the server has no
  subscription row and `getSubscription()` returns `null`.
- **Fix:** `self.skipWaiting()` on `install` + `self.clients.claim()` on `activate`, and keep the
  enable button **disabled** until `(await navigator.serviceWorker.ready).active` is non-null —
  see 2.4 for why you must not await it _after_ the tap.

### 2.4 The transient activation was spent or expired

- **Signature:** `NotAllowedError` whose message is exactly
  _"Push notification prompting can only be done from a user gesture."_, plus a matching
  Security-level console message visible in Web Inspector over USB from a Mac.
- **Two ways to get here** (mechanism in §3.2–3.3):
  1. More than **5 seconds** of `await` between the tap and `subscribe()` — e.g. awaiting
     `navigator.serviceWorker.ready` on a cold start, or fetching the VAPID key over the network.
  2. **Calling `Notification.requestPermission()` first.** It consumes the activation
     unconditionally. If it then fails to actually prompt (the 2.2 state), the following
     `subscribe()` sees `permission === 'default'`, finds no activation left, and throws this
     error — _making a Settings problem look like a code problem._
- **Fix:** call `registration.pushManager.subscribe(...)` **directly** from the tap handler and
  let it do the prompting. Do not call `Notification.requestPermission()` at all.

### 2.5 The user genuinely tapped "Don't Allow"

- **Signature:** `Notification.permission === 'denied'`, and the prompt was actually seen.
- iOS shows the system prompt **once**. After a denial, `requestPermission()` returns without UI
  forever. Recovery is the Settings path in 2.2, or delete-and-re-add.
- **Distinguish from 2.2:** `'denied'` vs `'default'`.

### 2.6 The `subscribe()` options are malformed

Each rejects with a distinct, greppable message from `PushManager.cpp`:

| Message                                                      | Cause                                           |
| ------------------------------------------------------------ | ----------------------------------------------- |
| `Subscribing for push requires userVisibleOnly to be true`   | `userVisibleOnly` missing or false              |
| `Subscribing for push requires an applicationServerKey`      | VAPID key missing                               |
| `applicationServerKey is not properly base64url-encoded`     | key string mangled (`+/=` instead of `-_`)      |
| `applicationServerKey must contain a valid P‑256 public key` | wrong key, or the private key pasted by mistake |
| `Cannot request permission from cross-origin iframe`         | prompting from an iframe                        |

An empty `VITE_VAPID_PUBLIC_KEY` at build time lands in the second or third row. Check the built
bundle, not the `.env`.

### 2.7 Subscribe succeeded but the server never stored it

- **Signature:** client-side `getSubscription()` returns a subscription; the server has no row,
  so nothing is ever sent and the user reports "notifications don't work".
- Usually the `POST /api/notifications/subscriptions` failed (401 after a token refresh, or was
  swallowed by a `catch`), or a Workbox route cached or short-circuited it. See §16 rule 1.

### 2.8 The subscription was silently revoked

- **Signature:** `getSubscription()` returns `null` although the user enabled it days ago, and the
  server's stored endpoint now returns 404/410.
- Cause: three pushes that failed to show a notification within 30 s each — §5.
- **Distinguish from 2.2:** here `Notification.permission` is still `'granted'`.

### 2.9 It is delivered, and iOS is hiding it

All of this is on-device and invisible to your code. Check it before touching code — Apple
Developer Forums thread [770749](https://developer.apple.com/forums/thread/770749) is a long
debugging session that ended with _"turns out the testphone was set to 'Do not disturb'."_

- **Focus / Do Not Disturb / Режим сна** — silently suppresses.
- **Scheduled Summary (Сводка по расписанию)** — holds it for hours. Set to Off while testing.
- **Silent mode / ring switch** — no sound, easily mistaken for no delivery.
- **Low Power Mode** — turn it off while testing.
- **Per-app alert style** — Allow Notifications ON but Lock Screen / Banners / Notification Center
  all OFF delivers nothing visible.
- **iOS 26 notification summarisation / prioritisation** can fold it away.
- **Distinguish from a code problem:** call `registration.showNotification(...)` from a button
  inside the app, no push involved. If _that_ does not appear either, the problem is on this list.

### 2.10 Accepted by APNs, never delivered — open platform bug

[Bug 319865](https://bugs.webkit.org/show_bug.cgi?id=319865), status NEW, filed 2026‑07‑21,
`rdar://182849423`. The reporter: `web.push.apple.com` returns **HTTP 201 with a valid `apns-id`
every time**, the `push` event never fires in the SW, across two independent server
implementations, after ~40 h of elimination (fresh reinstall, verified VAPID, verified scope,
local `showNotification` working, a third-party push service delivering to the same device on the
same network).

Reported on iOS 18.7 by **one** reporter; **not confirmed on 26.6**; no Apple response yet.
Reach for this only after 2.1–2.9. Its signature is 201 + nothing, with local notifications working.

### 2.11 The odd ones

- **Insecure context.** `Notification.permission` returns `'denied'` outright on a non-secure
  context, and `requestPermission()` logs _"The Notification permission may only be requested in a
  secure context."_ Relevant if anyone tests over plain `http://` on the LAN.
- **Two copies of the app.** Adding the site twice gives two containers with independent
  permissions and storage. The user may be looking at the wrong icon.
- **Logged out inside the web app.** A Home Screen web app has its **own cookie jar, Web Storage
  and IndexedDB, not shared with Safari** (long-standing WebKit behaviour, documented since the
  iOS 14 era; no source indicates it changed — verify on device). Signed in in Safari ≠ signed in
  in the web app, and a signed-out user never reaches the notifications toggle.
- **The Simulator lies.** The iOS 16.4 Simulator returned `'denied'` unconditionally
  ([Apple Forums 725619](https://developer.apple.com/forums/thread/725619)). Only trust hardware.

---

## 3. The permission-request contract, exactly

Read from `Source/WebCore/Modules/notifications/Notification.cpp` and
`Source/WebCore/Modules/push-api/PushManager.cpp`, WebKit `main`, 2026‑08‑20.

### 3.1 `Notification.requestPermission()` never rejects

It **always resolves**. It resolves with `"denied"` — without ever showing a prompt — in four
cases, each with its own console message:

| Condition                           | Console message                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| no notification client              | _(none)_                                                                                                        |
| not a secure context                | `The Notification permission may only be requested in a secure context.`                                        |
| not same-origin as the top document | `…may only be requested in a browsing context with the same security origin as the top level browsing context.` |
| **no transient activation**         | `Notification prompting can only be done from a user gesture.`                                                  |

**HARD RULE — a resolved `"denied"` is not evidence of a user denial.** Distinguish by reading
`Notification.permission` immediately afterwards:

- `permission === 'denied'` → the OS really holds a denial.
- `permission === 'default'` → the request never reached the user. Either a gesture/context
  problem (console message present) **or** the Settings-revoked state of bug 320551 (no console
  message). Retryable in the first case; only Settings fixes the second.

### 3.2 Transient activation lasts 5 seconds and is consumed once

`LocalDOMWindow.cpp`: `static constexpr Seconds defaultTransientActivationDuration { 5_s };`
`consumeTransientActivation()` sets the timestamp to `-infinity`, so the _first_ consumer wins.

Corrected rule, replacing "must be synchronous":

- **You have 5 seconds from the tap.** An `await` is not fatal in itself — an `await` that _can_
  take longer than 5 s is. `navigator.serviceWorker.ready` on a cold start is exactly that.
- **Only one call may consume it.** Two activation-requiring calls per tap is one too many.
- **HARD RULE — resolve everything slow before the user can tap.** The VAPID key comes from
  `import.meta.env.VITE_VAPID_PUBLIC_KEY` at build time; the SW must already be active; the enable
  control stays disabled until both hold.

### 3.3 `pushManager.subscribe()` prompts by itself — prefer it

Order of checks in `PushManager::subscribe`:

1. `userVisibleOnly` truthy, else `NotAllowedError`.
2. `applicationServerKey` present and a valid P‑256 key.
3. An **active** service worker, else `InvalidStateError`.
4. Read permission:
   - `denied` → `NotAllowedError: User denied push permission`. **No activation needed.**
   - `granted` → subscribe. **No activation check at all** — the old claim that Safari demands a
     live gesture even when granted is **false**.
   - `default` → same-origin check, **then** `consumeTransientActivation()`, then prompt.

**HARD RULE — call `subscribe()` straight from the tap handler; do not call
`Notification.requestPermission()` first.** `requestPermission()` burns the activation
unconditionally, so if it fails to prompt, the follow-up `subscribe()` reports a gesture error for
what is really a Settings problem (2.2 + 2.4). One tap, one call, one activation consumed.

_This chain is inferred from source, not observed on a device. It is worth five minutes with Web
Inspector to confirm before building on it._

There is a site-specific escape hatch in WebKit —
`document.quirks().shouldAllowNotificationPermissionWithoutUserGesture()` — that waives the check
for a hard-coded list of sites. Not something you can opt into.

### 3.4 What `Notification.permission` reports in each state

| Real state                       | `Notification.permission`                | `permissions.query({name:'notifications'})` |
| -------------------------------- | ---------------------------------------- | ------------------------------------------- |
| Safari tab (not a web app)       | **throws** — `Notification` is undefined | throws / unsupported                        |
| never asked                      | `'default'`                              | `'prompt'`                                  |
| granted                          | `'granted'`                              | `'granted'`                                 |
| denied in the prompt             | `'denied'`                               | `'denied'`                                  |
| **turned off later in Settings** | **`'default'`** ← bug 320551             | **`'prompt'`**                              |
| non-secure context               | `'denied'`                               | —                                           |

`pushManager.permissionState()` maps `default → 'prompt'` in the same source file, so it inherits
the same bug and is not an independent second opinion.

A separate, older report has `Notification.permission` reading `'default'` in a window opened by
`clients.openWindow()` from `notificationclick` — a second route to the same wrong answer. Also
open and unfixed: [257889](https://bugs.webkit.org/show_bug.cgi?id=257889) _"Permissions API
reports wrong permissions for notifications"_ and
[248463](https://bugs.webkit.org/show_bug.cgi?id=248463) _"Safari Notification.permission can not
be reset"_.

**Do not drive irreversible UI off a single reading of `Notification.permission`.**

---

## 4. Re-prompting, and the only recovery paths

- iOS shows the system permission prompt **once per web app container**. After a denial there is
  no second prompt, from any API, ever.
- **Recovery path 1 — Settings.** `Настройки → Уведомления → [приложение] → Разрешить уведомления`.
  Toggling it off and on again is also the folk fix for a subscription that stopped working
  (Apple Developer Forums, iOS 18-era; secondary, but consistently reported).
- **Recovery path 2 — delete and re-add the icon.** This destroys the container: permission,
  cookies, IndexedDB, Cache Storage, the SW registration and the push subscription all go. It is
  the only guaranteed reset, and it logs the user out.
- **HARD RULE — your own soft pre-prompt is the only retryable dialog you get.** §17.

---

## 5. Silent push and revocation — the exact numbers

From `Source/WebKit/Shared/WebPushDaemonConstants.h`, `NotificationData.h`, `WebPushDaemon.mm`,
`PushService.mm` (WebKit `main`, 2026‑08‑20):

- **HARD RULE — `userVisibleOnly: true`.** Hard reject otherwise. No silent push on iOS, still.
- **You have 30 seconds.** `silentPushTimeoutForProduction = 30_s`, started when the daemon hands
  the message to the web app. Miss it and the origin's silent-push counter increments.
- **`maxSilentPushCount = 3`.** On reaching 3, `PushService` logs _"Removing all subscriptions
  associated with … since it processed N silent pushes"_ and removes **every** subscription for
  that app/origin. Not a warning, not one subscription — all of them.
- The counter is **per origin**, and nothing in the source resets it on success. Budget for zero.
- **Declarative pushes are exempt**, by construction: `WebPushDaemon.mm` — _"Declarative push
  messages can never result in a silent push timeout, so don't push them onto the
  `m_potentialSilentPushes` queue."_ True for `mutable: true` as well.
- **GOTCHA — Web Inspector suppresses the penalty.** _"showNotification not called in time … but
  not incrementing silent push count since it is being inspected."_ Your debugging session will
  not reproduce the revocation you are debugging.

Practical consequence: `event.waitUntil()` must reach `showNotification()` first. Never `await` a
network call before it. Show something immediately and refine later if you must.

---

## 6. `pushsubscriptionchange` still does not exist on iOS

BCD, 2026‑08‑20: `safari_ios: false`, `safari: 16`, `chrome: 138`, `firefox: 44 (partial)`.
Unchanged. Combined with §3, **there is no way to silently repair a subscription on iOS.**

**Required pattern — the foreground reconcile loop:**

- On every `visibilitychange -> visible`, call `registration.pushManager.getSubscription()` and
  `POST /api/notifications/subscriptions` (idempotent upsert keyed on `endpoint`). Refreshes
  `last_seen_at` and repairs rotations for free.
- If `getSubscription()` returns `null` while the server-side preference says push is enabled,
  render a re-enable card: **«Уведомления отключились — включить снова?»** A fresh user gesture is
  the only way back.
- Still register a `pushsubscriptionchange` handler — free, and it works on Chrome 138+.

Related open bugs, both NEW and unresolved as of 2026‑08‑20:
[284111](https://bugs.webkit.org/show_bug.cgi?id=284111) _"Web Push subscription endpoint
'forgotten'"_ and [273063](https://bugs.webkit.org/show_bug.cgi?id=273063) _"webPush subscription
becomes invalid for few users"_. Subscriptions do evaporate for reasons nobody has pinned down;
the reconcile loop is the only defence.

---

## 7. What `showNotification()` supports on iOS

BCD, 2026‑08‑20. Two rows changed from the previous revision.

| Option                          | iOS                | Consequence                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`, `body`                 | ✅                 | the only two you may rely on                                                                                                                                                                                                                |
| `data`                          | ✅ **(corrected)** | `Notification.data` reads `safari_ios: 16.4`. BCD's `showNotification.options_data_parameter` says `false` — the two entries contradict each other; field reports and the declarative parser (which explicitly carries `data`) side with ✅ |
| `icon`                          | ❌                 | _"can be set, but has no effect"_ — [webkit.org/b/280162](https://webkit.org/b/280162). iOS always shows the app icon                                                                                                                       |
| `badge`                         | ❌                 | [webkit.org/b/280160](https://webkit.org/b/280160)                                                                                                                                                                                          |
| `image`                         | ❌                 |                                                                                                                                                                                                                                             |
| `tag`, `renotify`               | ❌                 | _"can be set, but has no effect"_ — [webkit.org/b/258922](https://webkit.org/b/258922). **No grouping and no replacement** — coalesce server-side                                                                                           |
| `actions`                       | ❌                 | no lock-screen buttons; every notification is a single tap                                                                                                                                                                                  |
| `requireInteraction`, `vibrate` | ❌                 |                                                                                                                                                                                                                                             |
| `silent`                        | ❌ on iOS          | `safari: 16.6`, `safari_ios: false`                                                                                                                                                                                                         |
| `lang`                          | ❌                 |                                                                                                                                                                                                                                             |
| `navigate`                      | ✅ 18.4+           | declarative payloads only                                                                                                                                                                                                                   |

**Design consequences.** Ten task updates = ten separate lock-screen notifications. Deduplicate
and coalesce in the backend (BullMQ `jobId` per `(userId, entityId, type)` with a short delay,
plus the web-push `topic` option, which the push service itself honours). Since every notification
wears the app icon, the notification **type must be legible from the title text**.

---

## 8. Declarative Web Push — corrected payload shape

Shipped iOS/iPadOS **18.4**+, macOS Safari **18.5**+. **Optional**, not required, not superseded;
classic push still works everywhere. Two reasons to use it: it fixes the long-standing iOS bug
where `clients.openWindow(url)` from `notificationclick` did nothing or only opened the root URL,
and it **exempts the message from the silent-push penalty** (§5).

Exact contract, read from `NotificationJSONParser.cpp` (WebKit `main`, 2026‑08‑20):

- Top level: **`web_push` must be the integer `8030`** (Integer or Double; the _string_ `"8030"`
  fails the check and the message falls back to classic push), plus a `notification` object.
- **`mutable` and `app_badge` live at the TOP level, not inside `notification`.**
  Safari 26.2 release notes: _"Fixed reading the `mutable` field from the outer object instead of
  as a child of `notification`."_ The parser still accepts `mutable` inside `notification` as a
  deprecated fallback ([webkit.org/b/297389](https://webkit.org/b/297389) tracks its removal);
  **`app_badge` has no such fallback and is read only from the outer object** — the previous
  revision of this file put it inside `notification`, where it is silently ignored.
- Inside `notification`, **required**: `navigate` (must parse as a valid URL) and a **non-empty**
  `title`. Either missing → `SyntaxError` and the message is dropped with nothing shown.
- Inside `notification`, optional: `dir`, `lang`, `body`, `tag`, `icon`, `silent`, `data`.
  The parser _accepts_ `tag` and `icon` even though iOS ignores them at display time (§7).

```jsonc
{
  "web_push": 8030, // integer, exactly 8030 — not the string "8030"
  "mutable": true, // OUTER — corrected
  "app_badge": 3, // OUTER — corrected; number or numeric string
  "notification": {
    "title": "Ужин в 19:00", // REQUIRED, non-empty
    "navigate": "https://family.example.com/tasks/42", // REQUIRED, valid URL
    "body": "Сегодня твоя очередь готовить",
    "dir": "ltr",
    "silent": false,
    "data": { "type": "task_reminder", "taskId": 42 },
  },
}
```

**Send this one payload to everyone.** Safari renders it natively; every other browser ignores
`web_push` and falls through to the service worker's `push` handler.

`mutable: true` is strictly better than classic push: the SW still gets the `push` event, and if
the handler throws or times out the platform shows the declarative notification anyway. With
`mutable` absent or false, the daemon displays the notification directly **without launching the
web app or running the service worker at all** — cheapest and most reliable, but your SW never
sees the message.

_Unverified:_ whether `window.pushManager` (subscribing with no service worker, per WWDC25‑235)
works on iOS 26.6. Keep subscribing through `registration.pushManager`.

---

## 9. VAPID

- **HARD RULE — `VAPID_SUBJECT` must be a real, resolvable `mailto:` or `https://`.**
  `mailto:admin@localhost` returns `403 {"reason":"BadJwtToken"}` from Apple. So does a subject
  with spaces or angle brackets.
- Apple's endpoint is `https://web.push.apple.com/…`. No Apple Developer account, no certificate,
  no `gcm_sender_id`.
- **Payload limit:** RFC 8291 guarantees only 4096 octets; after headers, padding and the AEAD tag
  that is ≈3993 bytes of plaintext. **Budget ≤3000 bytes.** Never put domain data in the payload —
  send ids and let the app fetch.

### HTTP status handling — get this exactly right

| Status              | Action                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `404`, `410`        | **Prune the row.** The subscription is dead.                                                                      |
| `429`               | Back off, honour `Retry-After`. **Never prune.**                                                                  |
| `413`               | Our payload bug. Log loudly. **Never prune.**                                                                     |
| `400`, `401`, `403` | VAPID/JWT misconfiguration. **Never prune** — a bad deploy would otherwise wipe every subscription in the family. |
| network / `5xx`     | Increment `failure_count`; prune only after ~10 consecutive failures.                                             |

**`201` does not mean delivered.** It means APNs accepted the message. See 2.10.

---

## 10. Storage & the 7-day ITP cap

_Carried over from the previous revision; not re-verified in this pass, except the cookie-jar
point, which §2.11 now makes load-bearing._

- The 7-day cap applies to **script-writable storage**: IndexedDB, localStorage, sessionStorage,
  Cache API, service worker registrations, and cookies written via `document.cookie`.
- **Server-set `HttpOnly` cookies are NOT affected.** This is the decisive argument for the
  `__Host-rt` refresh-cookie design in D3.
- **Home-screen web apps have their own counter of days of use**, reset by every launch. WebKit:
  _"We do not expect the first-party in such a web application to have its website data deleted."_
- Since Safari 17 the model is a quota system (per-origin up to 60% of disk), with **whole-origin
  LRU eviction** under pressure.
- Call `navigator.storage.persist()` on boot — WebKit grants it on heuristics _"like whether the
  website is opened as a Home Screen Web App"_.
- A Home Screen web app's cookies and storage are **separate from Safari's** (2.11).
- **Never treat client storage as the source of truth.** Postgres is the truth; IndexedDB is a cache.

## 11. No Background Sync

`ServiceWorkerRegistration.sync` and `periodicSync` are both **unimplemented in WebKit**
(BCD, 2026‑08‑20). The only way to run code in the background on iOS is a `push` event — and that
code has 30 seconds and must end in a notification (§5).

Offline writes flush on (a) `online` and (b) `visibilitychange -> visible`. Never promise the user
background delivery.

## 12. State loss on backgrounding

_Carried over; not re-verified._ iOS aggressively terminates backgrounded web apps. A PWA left in
the background comes back as a **cold start at `start_url`** — React state, in-memory caches,
unsaved form input and scroll position are gone. There is no reliable bfcache for standalone web apps.

- Persist on `pagehide` **and** `visibilitychange -> hidden`. `beforeunload`/`unload` are unreliable.
- Refetch on every `visibilitychange -> visible`. `refetchOnWindowFocus: true`, short `staleTime`.
- Never implement a pull-to-refresh that calls `location.reload()` — in a PWA a reload is a cold start.
- **This is why §3.2 matters:** a cold start means the service worker may not be active when the
  user taps, and `serviceWorker.ready` may not resolve inside the 5-second window.

## 13. CSS rules that are not optional

_Carried over; not re-verified._

```css
/* env(safe-area-inset-*) is 0 unless viewport-fit=cover is in the viewport meta. */
:root {
  --safe-t: max(env(safe-area-inset-top), 0px);
  --safe-b: max(env(safe-area-inset-bottom), 0px);
  --safe-l: max(env(safe-area-inset-left), 0px);
  --safe-r: max(env(safe-area-inset-right), 0px);
}

/* Never 100vh — on iOS it means the LARGE viewport. */
.app-shell {
  min-height: 100dvh;
}

/* Document never scrolls; an inner pane does. overscroll-behavior alone does not
   stop document rubber-banding on iOS. */
html,
body {
  height: 100%;
  overflow: hidden;
  overscroll-behavior: none;
}
#root {
  height: 100dvh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  overflow: hidden;
}
.scroll-pane {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
}

/* HARD RULE: a focused input below 16px makes iOS zoom the viewport and never
   zoom back. maximum-scale / user-scalable are ignored by iOS. */
input,
select,
textarea,
button {
  font-size: max(16px, 1rem);
}

* {
  -webkit-tap-highlight-color: transparent;
}
button,
a,
[role='button'] {
  touch-action: manipulation;
}
```

The bottom tab bar must pad by `calc(var(--safe-b) + 8px)` — the home indicator eats ~34px on
Face ID devices.

## 14. index.html head essentials

_Carried over; not re-verified, except that a manifest is no longer required for installability
on iOS 26 (§1.4)._

- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- Ship **both** `mobile-web-app-capable` and `apple-mobile-web-app-capable`.
- `apple-mobile-web-app-status-bar-style: black-translucent` **only** together with
  `viewport-fit=cover` + safe-area padding, or the header hides behind the Dynamic Island.
- `apple-mobile-web-app-title` wins over the manifest `short_name` on iOS — keep it ≤12 characters
  («Семья»). **This is also the name the user must look for in Settings → Уведомления** (2.2).
- `apple-touch-icon` must be a **180×180 opaque PNG with its own padding**. iOS ignores the
  manifest `icons` array and does not apply maskable safe zones; transparency renders as black.
  (Safari 26.0 also accepts an SVG site icon and rasterises it — new, untested here.)
- Two `theme-color` tags, one per `prefers-color-scheme`.

## 15. Manifest essentials

`id: '/'` — set once and **never change it**; it defaults to `start_url`, so changing `start_url`
later would create a _second_ installed app with its own permission state (2.11).
`scope: '/'` keeps OAuth callbacks inside the installed app instead of stranding the user in
Safari — and a user stranded in Safari cannot enable notifications.
**`display: 'standalone'` + `display_override: ['standalone','minimal-ui','browser']`.** Still ship
it: required on iOS ≤ 18.x, harmless on 26.
`launch_handler: { client_mode: ['navigate-existing','auto'] }` (Chromium).
`screenshots` with both `wide` and `narrow` form factors drive the rich install dialog on Chromium;
iOS ignores them but they cost nothing.

**Service worker scope must cover `start_url`.** A SW registered at `/sw.js` with default scope `/`
is fine; one registered under `/static/` never controls the app and §2.3 follows.

## 16. Service worker strategy

_Carried over; not re-verified, except the `clientsClaim` note, which §2.3 now makes load-bearing._

**`injectManifest`, not `generateSW`** — `generateSW` gives no way to add a `push` handler, and the
`importScripts()` workaround is discouraged by the vite-pwa docs and breaks TypeScript/bundling.
The cost is that precaching, the navigation fallback and runtime routes must be hand-written.

**`registerType: 'prompt'`, not `'autoUpdate'`.** With `autoUpdate` the new SW activates
mid-session, which can 404 lazy-loaded chunks from the running bundle and destroys unsaved form
state. On iOS a surprise reload is a cold start. Show a «Доступно обновление» toast and call
`updateServiceWorker(true)` on accept. **Keep `clientsClaim()`** — §2.3 depends on it; the danger
is only `clientsClaim` combined with unconditional `skipWaiting` mid-session.

Runtime caching, in registration order (Workbox is first-match-wins):

1. **`NetworkOnly` for auth** — `/api/auth/*`, `/api/notifications/subscriptions*`.
   **HARD RULE: never cache an auth endpoint or a push endpoint.** Register these _before_ the
   generic `/api/` rule — a cached `subscriptions` POST is failure mode 2.7.
2. `NavigationRoute` → precached `index.html`, with a denylist for `/api/`, `/auth/`, `/docs`,
   `/uploads/` and anything that looks like a file.
3. **`NetworkFirst`** for API GETs, `networkTimeoutSeconds: 4`, `maxAgeSeconds` 6h,
   `CacheableResponsePlugin({ statuses: [200] })`, `purgeOnQuotaError: true`.
4. **`StaleWhileRevalidate`** for slow-changing reference data (`/api/users`, `/api/family`,
   `/api/settings`).
5. **`CacheFirst`** for images and fonts, with expiration and `purgeOnQuotaError`.

Add a periodic update check (hourly `r.update()` behind a `cache: 'no-store'` fetch of the SW URL)
— an iOS PWA is often left open for days and would otherwise never learn an update exists.

Safari 26.0 added **automatic inspection and pausing of service workers** (Develop → Inspect Apps
and Devices → the web app → _Automatically Inspect New Service Workers_). This is the only
practical way to watch a `push` event fire on device — but remember §5: inspecting suppresses the
silent-push penalty.

## 17. Install & permission UX funnel

There is **no `beforeinstallprompt` on iOS**, no install banner, and no way to open the share sheet
from JS ([bug 198673](https://bugs.webkit.org/show_bug.cgi?id=198673) — still NEW). The funnel must be:

1. First visit in a Safari tab — say nothing about notifications.
2. After the user signs in and does one real action — soft "install" card, whose stated reason is
   _«уведомления работают только после установки»_. **Now also say: не выключайте «Открыть как
   веб‑приложение»** (§1.2) — this is the new #1 failure.
3. First launch from the home icon — still say nothing. Register the SW and wait for it to be
   active (§3.2).
4. When the user creates something with a due date or an assignee — a soft pre-prompt tied to that
   action: _«Напомнить тебе об этом?»_
5. Only that tap calls `pushManager.subscribe()` — **not** `Notification.requestPermission()` (§3.3).

**Why the soft pre-prompt is mandatory:** the OS prompt can be shown **once ever**. Your own dialog
is retryable; the OS one is not (§4).

**And handle the `'default'`-but-actually-off state (2.2).** If a subscribe attempt from a real
gesture returns without a prompt and `Notification.permission` is still `'default'`, do **not**
re-show the soft prompt — show the Settings instructions instead. Otherwise the user loops forever.

Detection notes: iPadOS reports UA `Macintosh` since iPadOS 13 — combine with
`navigator.maxTouchPoints > 1`. Safari 26.0 warns that its UA string will keep changing and
recommends feature detection over UA sniffing.

## 18. Subscription storage

- Key on **`endpoint`, globally unique** (not `(user_id, endpoint)`). A reinstall yields a
  brand-new endpoint; the unique constraint plus an upsert that re-binds `user_id` correctly
  handles two family members sharing one tablet.
- **Treat `endpoint` as a secret** — it is a capability URL. Never return it to the client in a
  list response (return `id`, `deviceLabel`, `platform`), and never log it above debug level.
- Store the device's IANA timezone from `Intl.DateTimeFormat().resolvedOptions().timeZone` — quiet
  hours must be evaluated in the _recipient's_ local time, not the server's.
- Prune anything not seen in 90 days.

## 19. Settings screen must include a test button

**«Отправить тестовое уведомление»** is the only way a family member can confirm the whole chain
works on iOS, and it is the single biggest support-ticket deflector in the app.

Ship a **second, local** button too — one that calls `registration.showNotification()` directly
with no push involved. It is the test that splits §2.9 (iOS is hiding it) from everything else, and
it costs four lines.

## 20. Pre-launch device checklist

1. `VAPID_SUBJECT` is a real address on a resolvable domain.
2. Manifest served as `application/manifest+json`; `id` set and frozen; `display: standalone`.
3. In a Safari tab, `'Notification' in window === false` — the UI must not crash or show a dead
   "включить" button.
4. Installed **with "Open as Web App" ON**, launched from the icon;
   `matchMedia('(display-mode: standalone)').matches === true`.
5. On the **very first launch**, the enable button is disabled until the SW is active, then works
   at the first tap — no `InvalidStateError` (2.3).
6. The enable tap calls `subscribe()` directly, with no `await` that can exceed 5 s before it (3.2).
7. Deny the prompt once: the UI reads `'denied'`, offers the Settings path, and does not loop.
8. Turn the permission off in Settings and relaunch: the UI copes with `permission === 'default'`
   and does **not** re-show a soft prompt that can never succeed (2.2 / bug 320551).
9. Turn it back on in Settings: the app recovers and re-subscribes on the next tap.
10. Push arrives with the app **fully swiped away**, and the tap lands on the correct deep URL.
11. Five pushes in a row still leave the subscription alive — and one deliberately mishandled push,
    three times, kills it exactly as §5 says. **Test this with Web Inspector detached.**
12. Badge sets from the outer `app_badge` and `setAppBadge(0)` clears rather than showing a dot.
13. Kill under memory pressure, return — state restores and data refetches.
14. Airplane mode: shell loads, cached data shows, auth endpoints fail rather than serving a cached
    session.
15. New deploy: «Доступно обновление» appears within the hour and reloads cleanly.
16. Focusing any input does not zoom the viewport. Landscape on iPhone: no content under the notch.

## 21. Still unverified — do not build load-bearing logic on these

- **The `requestPermission()`-burns-the-activation chain (3.3).** Read from source, not observed on
  a device. Five minutes with Web Inspector over USB settles it.
- **Whether a fresh in-prompt "Don't Allow" really yields `'denied'` on 26.6.** Bug 320551 covers
  only the Settings-revocation case; the direct-denial case is assumed, not confirmed.
- **Whether the silent-push counter ever resets** after a successful notification. Nothing in the
  source suggests it does; budget for zero.
- **`window.pushManager`** (service-worker-free subscribing) on iOS 26.6.
- **Whether third-party iOS browsers show the "Open as Web App" toggle**, and whether their Home
  Screen web apps get push on 26.x.
- **Bug 319865** (201-accepted, never delivered): one reporter, iOS 18.7, no Apple response.
  Unknown whether it affects 26.6.
- **iCloud Private Relay and push.** No source found suggesting it interferes; APNs delivery does
  not traverse the browser's connection. Treated as a non-issue until evidence appears.
- **The exact iOS 26.6 share-sheet wording** for the Russian install instructions, and the exact
  Russian label of the "Open as Web App" toggle.
