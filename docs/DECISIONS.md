# Ratified Architecture Decisions

> **Every agent working on this repo MUST read this file first.** These decisions are
> final. Do not re-litigate them; if you believe one is wrong, raise it and stop.

## D1 — Single tenant. No `households`, no `members` table.

This app serves **one family**. There is no `household_id` on any table and no
`members` table separate from `users`. Membership attributes (role, status,
birth date, timezone, rotation weight, permission overrides) live directly on
`users`. Family-wide configuration lives in a **singleton** `family_settings` row.

_Rationale:_ multi-tenancy would put an extra predicate on every query and an
extra join on every read for a capability that will never be used. A second
family gets a second container.

## D2 — Recurrence: hybrid (rule + materialized rolling window)

- Series tables (`task_series`, `event_series`) store the **rule**.
- Occurrence tables (`task_occurrences`, `event_occurrences`) store **materialized
  instances** for a rolling **90-day** horizon, extended by a nightly BullMQ job
  and eagerly on every series write.
- Per-occurrence state (done / skipped / assignee / comments) has to live
  somewhere; that place is the occurrence row.

### Time model — the most important rule in this document

- Series store `dtstart_local` as a **floating local wall-clock string**
  (`2026-09-07T09:00:00`, no offset, no `Z`) plus a `timezone` IANA id.
- Series store `rrule` as the RRULE line **without** DTSTART
  (`FREQ=WEEKLY;BYDAY=MO`).
- Occurrences store `occurrence_key` — the originating floating local datetime.
  This is the **immutable identity** of an instance; moving an occurrence
  changes its timestamps, never its key.
- Occurrences store the resolved UTC instant in `timestamptz` columns, plus
  denormalized `local_date` / `starts_local` for calendar-grid queries.
- Durations are **wall clock**: `zdt.add({ minutes })`, never `instant + n*60000`.

"Every Monday at 09:00" is a statement about the wall clock, not an instant.
Never anchor a rule to a UTC instant. Never hardcode `+03:00` for Moscow — the
tzdb has Moscow at UTC+4 for 2011–2014, Russian time law has changed three times
in a decade, and family members travel.

### Library

`rrule-temporal@^2.2.0` + `temporal-polyfill@^1.0.4` (Node 24 has no unflagged
`Temporal`; it ships unflagged only in Node 26). **Not** `rrule@2.8.1` —
unmaintained since 2023 with known TZID bugs. **Not** `rrule-rust` — native
binaries complicate Docker for perf we do not need at family scale.

All library calls go through **one adapter module**, `src/core/recurrence/engine.ts`.
Nothing else imports the library.

DST disambiguation: `disambiguation: 'compatible'` (spring-forward gap pushes
forward, fall-back overlap picks the earlier instance). Matches Google Calendar.
Write a test for each.

## D3 — Auth

### Libraries

`openid-client@^6` + `jose@^6`. **Do not use** `arctic` (deprecated July 2026),
`jsonwebtoken` (alg-confusion footguns), or `passport-*`.

### Providers

| Provider | Flow                                                                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google   | OIDC authorization code + PKCE. `client_secret` is **still required** alongside PKCE for a Web client. Accept **both** `https://accounts.google.com` and `accounts.google.com` as `iss`.                                                                                            |
| Telegram | **OIDC at `https://oauth.telegram.org`** (the hash-based Login Widget is legacy/archived). Scopes `openid profile telegram:bot_access`. The bot-access scope is how we DM admins about pending signups. Legacy widget + Mini App `initData` verifiers are implemented as fallbacks. |

**Sign in with Apple is deliberately not supported.** It requires a paid Apple
Developer membership, and the family does not need a third provider. Do not
reintroduce it without asking. (This is unrelated to the iOS PWA support in
`docs/research/ios-pwa-push.md`, which stays — that is Safari and Apple's push
service, not Apple as an identity provider.)

### The OAuth transaction store — non-negotiable

`state -> { nonce, code_verifier, intent, link_user_id, redirect_after }` lives in
a **Postgres table with a 10-minute TTL, deleted on use**. Not in a cookie.

_Why:_ the callback often arrives **cross-site** (Telegram's widget and Mini App
flows POST from another origin), and `SameSite=Lax` cookies are not sent on a
cross-site POST — so a cookie-based state store fails in production only, for
one provider only. The server-side store also fixes the same class of bug for
the installed iOS PWA, where the OAuth round trip leaves the standalone app.

### Identity model

- `users` (nullable `email` — Telegram gives no email, ever) + `user_identities`
  (`provider`, `provider_user_id`, ...).
- The join key is **always `(provider, provider_sub)`**. Email is never a key.
- `UNIQUE (provider, provider_user_id)` and `UNIQUE (user_id, provider)`.
- **Never auto-link on email match.** Even when both sides are verified, show
  "sign in with your existing method, then link from Settings". Addresses from any provider-issued relay
  service are never eligible for linking.
- Linking provider B requires an authenticated session and `intent='link'` in
  the transaction row.
- Unbind is guarded by `SELECT ... FOR UPDATE` + a last-login-method check.

### Sessions

- Access token: **HS256 JWT, 10 minutes, in JS memory only.** Never
  `localStorage` (XSS-readable and subject to iOS's 7-day script-writable
  storage cap).
- Refresh token: **opaque 32 random bytes, SHA-256 hashed at rest**, in
  `__Host-rt; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30d`.
  Server-set `HttpOnly` cookies are **not** subject to the iOS 7-day cap — this
  is the decisive argument for this design.
- **Rotation on every use** with **token-family reuse detection** (a replayed
  revoked token revokes the whole family and alerts admins).
- A **20-second grace window** on concurrent refresh is mandatory: React 19
  StrictMode, multiple PWA tabs and iOS resume all fire simultaneous refreshes,
  and without the window they nuke the family and log everyone out at random.
- CSRF: `SameSite=Lax` + POST-only refresh + `Sec-Fetch-Site`/`Origin` checks on
  every mutating request. All non-auth endpoints use the in-memory bearer token
  and are structurally CSRF-immune.

### Admin-approval registration

Status enum: `pending_approval | active | rejected | suspended`.

- A `pending_approval` user gets **no session at all** — not a limited one, not a
  scoped one. `/auth/pending` is a fully unauthenticated page.
- `status` is re-checked on **every refresh** and embedded in the access JWT, so
  a suspension takes effect within 10 minutes at worst.
- Any status change away from `active` immediately revokes every refresh family.
- Approval uses a conditional update (`WHERE status = 'pending_approval'`) so two
  admins clicking at once produces one winner and one `409`.

## D4 — RBAC

Fixed role enum + a **code-side matrix** + per-user `permission_grants` /
`permission_denies` `text[]` overrides. Denies always win.

Roles: `owner > admin > adult > teen > child > guest`.

- The catalog, the `Permission` type, `effectivePermissions()` and `resolveScope()`
  live in `@family/shared`.
- `GET /api/me` returns the **effective permission list**. The frontend never
  re-derives the matrix and never branches on `role ===` for access decisions
  (role is for display copy only).
- Backend guards: `app.requirePermission(p)`, `app.requireAny(...)`,
  `app.requireScoped(base)` — the last resolves `own` vs `any` and stashes it on
  the request for row-level narrowing.
- **404, not 403**, for resources outside the caller's read scope. 403 is only
  for "you may read it but may not do that to it".
- **Deny by default**: a route without a guard must declare `config: { public: true }`,
  and boot asserts that every registered route has one or the other.
- Children have **zero** `finance:*` / `goal:*` permissions. Teens get read-only.

## D5 — Chore fairness, without a score

**There is no points system, and there must not be one again.**

The original design scored people: a `points_ledger`, per-chore point values,
on-time bonuses, cover bonuses, swap sweeteners, streaks, and a balance you
could read off your own profile. It was removed in full. The reasoning, because
this is the part that matters and the part a future change will be tempted to
undo:

> A number attached to a person that goes up when they do chores turns
> cooperation into competition. Between siblings it does it fast. A child who
> sees «13 очков» next to their name and «31 очко» next to their brother's has
> learned they are losing at being part of their own family, and the app taught
> them that. A streak adds a second failure mode: it punishes one missed
> Tuesday with the loss of something they built over a month, which is a
> gambling mechanic pointed at a nine-year-old.

The scheduling problem the score was solving is real, though — without some
signal, "who gets the next chore" collapses to whoever sorts first, and the
person who does the most work keeps being asked to do more. So the _mechanism_
survived and its _currency_ changed.

`weighted_balance` by default: assign to the eligible member with the lowest
`(completed + committed) / weight` debt over a 28-day window, tie-broken
deterministically (longest since last assignment -> rotation position -> id).
Never random — re-running the materializer must reproduce the same schedule.

- **`completed` is a count of chores**, read straight off `task_occurrences`
  (`status = 'done'`, grouped by `completed_by_id`), and `committed` is a count
  of the still-scheduled ones. Every chore counts as exactly one — no per-chore
  weighting, so the family never has to argue about whether the bins beat the
  dishes.
- **It is a scheduling input, and now not a display at all.** Nothing in the
  app shows a person a running total of anything they have done, and nothing
  shows the family how the week's work split either. The last surface — a
  family-level load bar in the side column of Задачи and Семья, alphabetical,
  with no per-person numbers — was removed too, at the owner's request: «так же
  убери "нагрузку" - это не нужно». It had already been trimmed twice (the
  per-person totals, then the bar stamped down the roster), and a screen-reader
  audit had caught its `aria-label` reading «40 % (своя доля 33 %)» aloud while
  the sighted design showed no numbers at all. A distribution of housework is
  still a distribution of housework; the family talks about that at the table,
  not through a bar chart. It was not in fact the last: two further surfaces
  survived precisely because that word was believed — the `fairness` object on
  `GET /dashboard/today` (per-person `doneCount` and `sharePercent`, on the wire
  on every home-screen load) and the digest's `load` section («Вы закрыли N
  дел», «Вся семья за неделю — N дел», pushed to a phone once a week) — and both
  are now gone too, so read any inventory here as what was known when it was
  written and go looking anyway.

  Concretely, and this is the line a future change is most likely to cross:
  `debt` may be **computed and ordered by**, and it may be **explained for one
  pick** through `GET /chores/rotations/:id/preview` ("why did I get the bins
  again?"), which is auditability rather than display. It may not be totalled
  per person, drawn, narrated, or turned back into a family-wide read model.
  `GET /chores/fairness` and its `FairnessSummaryResponse` contract were deleted
  when the bar went; do not resurrect them.

- **Idempotency comes free.** An occurrence can be `done` once, so a double tap
  or an offline replay cannot inflate anybody's share. The ledger needed a
  partial unique index to promise that; counting rows just is the promise.
- A chore counts for **whoever actually did it**, not whoever was assigned. That
  is what makes the loop self-correcting: covering for your brother means the
  rotation asks less of you next week — payment in time off rather than in a
  score.
- Assignment is written **once at materialization and frozen**. Never recomputed
  on read; reshuffling next week's chores destroys trust instantly.
- **Kudos stayed.** A thank-you addressed to one person for one thing is not a
  score: nothing accumulates, nothing is totalled per person, and the unique
  index makes a repeated emoji a no-op rather than a tally. If kudos ever grow
  a per-person count, they have become the thing this decision removed.
- Swaps carry **no sweetener**. «Дам тебе 5 баллов» is a bribe denominated in
  the currency we deleted; asking is the whole mechanism.

## D6 — Money

All monetary amounts are **integer minor units** (копейки) in `bigint`
columns. Never floats. Contributions to a goal are **append-only transactions**;
the balance is a `SUM`.

## D7 — Frontend

- Vite 6 + React 19 + TS, Tailwind v4 + shadcn/ui, TanStack Query, React Router 7.
- `vite-plugin-pwa` with **`injectManifest`** (we need a custom push handler).
- **All user-facing text is Russian.** Each feature owns its strings in
  `features/<domain>/locale.ts`; only genuinely cross-cutting terms go in
  `shared/lib/i18n.ts`. Never render a server `message` field to the user — map
  the error `code` to a Russian string.
- Feature-sliced layout: `features/<domain>/{api,hooks,components,pages,locale}`.
- `useCan()` reads the permission list from `/api/me`. On a 403, invalidate
  `['me']` so a stale permission set self-heals.
- Mobile-first: bottom tab bar on phones, sidebar on desktop. Safe-area insets,
  `dvh` not `vh`, 16px minimum font on inputs to stop iOS zoom-on-focus.

## D8 — Backend layering

```
src/modules/<domain>/
  <domain>.schema.ts      drizzle tables (this module owns them)
  <domain>.contract.ts    zod request/response schemas
  <domain>.repository.ts  data access — no HTTP knowledge
  <domain>.service.ts     business rules — no HTTP knowledge
  <domain>.routes.ts      fastify plugin — thin
  <domain>.test.ts
```

A module never imports another module's **repository**. Cross-module needs go
through the other module's **service**, or through a domain event on the bus.

## D9 — Scope for v1

**Ship:** auth + approval + RBAC · tasks/chores with rotation & fairness ·
events calendar · moneybox goals · shopping lists · notifications with
preferences & quiet hours · Today dashboard · weekly digest · family wall
(announcements + kudos) · activity log · ICS calendar feed · backup/export.

**Deferred (v1.1+):** meal planning & recipes, shared expenses & subscriptions,
kids' allowance payouts, home maintenance & meters, health/medications, vault.

**Explicitly rejected:** own chat/messenger, pantry stock tracking, background
geolocation, photo gallery, banking integrations, document scans, SMTP/SMS,
custom role builder, multi-tenancy, CRDTs, heavy gamification, paid AI APIs.

## D10 — Notifications

One pipeline: `notification_intents` -> delivery rules (channel, quiet hours,
escalation) -> `notification_deliveries` log. Channels: **Web Push (VAPID)** and
**Telegram bot**. No email, no SMS.

- Quiet hours **defer** delivery to the end of the window; they never drop it.
- Push subscriptions are per-device rows; a `410`/`404` from the push service
  prunes the row.
- iOS requires the PWA to be **installed to the Home Screen** before
  `Notification.requestPermission()` works, and the call must come from a user
  gesture. Ask at a meaningful moment, never on first load.

## D11 — Notifications must be _confirmed received_, not merely sent

A `201` from a push service means "accepted for delivery" — nothing more. It does
not mean the message reached the device, and it certainly does not mean a human
saw it. For a family app where a missed "дать лекарство в 20:00" or "забрать
Лизу из школы" has real consequences, tracking `sent` is not enough.

Every delivery therefore carries four distinct timestamps, and they must never
be collapsed into one another:

| Column           | Meaning                                                                  | Written by                                           |
| ---------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `sentAt`         | We handed it to the push service / Telegram and it accepted.             | The dispatcher                                       |
| `deliveredAt`    | It **arrived on the device**.                                            | The service worker's `push` handler, via an ack call |
| `interactedAt`   | The user **tapped the notification**.                                    | The service worker's `notificationclick` handler     |
| `acknowledgedAt` | The user explicitly **confirmed the underlying action** ("Подтвердить"). | The app, for `high`/`critical` intents only          |

`deliveryStatus` gains `delivered`, `interacted` and `acknowledged` alongside the
existing values, and only ever moves forward.

### How each signal is obtained

- **Device receipt.** The service worker already receives the `push` event
  (this is why the Declarative Web Push payload sets `mutable: true` — see
  `docs/research/ios-pwa-push.md`). After `showNotification` resolves, it POSTs
  an ack for that `deliveryId`. The ack is fire-and-forget and **must never
  block or fail the notification** — showing the notification is the one thing
  iOS requires, and an ack failure must not cost us the subscription. If the ack
  request fails, queue it in IndexedDB and flush on the next app foreground.
- **Telegram** gives a genuinely better signal than Web Push: `sendMessage`
  returns a `message_id` on real delivery, and a blocked user returns `403`
  (which sets `canDm = false` rather than retrying forever). Treat a successful
  `sendMessage` as `deliveredAt`.
- **In-app** open of the notification centre or the linked entity sets
  `interactedAt` for the matching delivery.

### The enforcement loop — this is the point of the whole decision

A dispatcher sweep looks for deliveries that were `sent` but never became
`delivered` (or, for `critical`, never `acknowledged`) within a per-priority
deadline, and escalates:

1. **Re-deliver** on the same channel once, in case the device was simply off.
2. **Fall back to another channel** for that user — Web Push failed, so try the
   Telegram bot.
3. **Escalate to another person** per `escalationPolicies` — if the assigned
   parent has not acknowledged a `critical` reminder, tell the other adult.
4. **Surface it in the UI**: the sender sees «Не доставлено» next to the item,
   so a human can act rather than assuming it landed.

Escalation deadlines by priority: `critical` 10 min, `high` 30 min, `normal` no
escalation (the weekly digest catches it), `low` never.

### Guardrails

- Escalation must be **idempotent and capped** — at most one escalation chain
  per intent, recorded on the intent, so a retried sweep cannot spam the family.
- A user whose device is legitimately offline overnight must not trigger a 03:00
  escalation: the sweep respects quiet hours exactly as the original delivery
  did, and defers rather than escalating inside them.
- Never escalate a `low`/`normal` notification. The cure would be worse than the
  disease, and notification fatigue is the failure mode that kills these apps.

### Subscription health

Because iOS never fires `pushsubscriptionchange`, a subscription that stops
delivering is otherwise invisible. A subscription with no `deliveredAt` across
its last N sends is marked unhealthy, and the app shows the user
«Уведомления отключились — включить снова?» on next open. This closes the loop
that would otherwise let a family member silently stop receiving everything.

## D12 — Keeping the screen in sync: a family-wide revision poll, not a socket

Two people stand in the kitchen with the shopping list open. One of them ticks
«молоко». On the other phone the item stays unticked until somebody switches
apps and comes back, because nothing told that phone anything happened. That is
the whole problem this decision solves, and it is worth being precise about how
small it is: **six users, one family, one screen where the answer is measured in
seconds**, and a handful of others where a minute is fine.

Everything below follows from taking that scale seriously. The instinct is to
reach for a realtime transport, and a realtime transport is buildable here — but
at six users it costs more to build, secure and keep alive than the latency it
buys is worth, and every option that holds a connection open collides with two
things this app has already decided: an access token that expires every ten
minutes behind a refresh endpoint that revokes a whole token family on replay
(D3), and iOS's habit of destroying a backgrounded PWA outright.

### The obvious answer is impossible, and the next person must know why

We already ship Web Push (D10). The tempting move is to send a silent push and
have the service worker invalidate the query cache — no polling, no connection,
zero idle cost.

**On iOS you cannot do this, and it is not a preference.** Subscriptions are
created with `userVisibleOnly: true`; every `push` event must call
`showNotification()` inside `event.waitUntil()`; and after roughly three pushes
where the handler ran without showing anything, iOS **silently revokes the
subscription** — `docs/research/ios-pwa-push.md` §1, gate 3. That claim was
re-verified against current public sources while writing this entry and has not
changed. Repurposing push as a sync channel therefore does not merely fail; it
destroys the notification subscription that D10 and D11 depend on, and
`pushsubscriptionchange` does not exist on iOS (§2), so it cannot be repaired
silently — only by a fresh user gesture that a family member will never think to
give.

The neighbouring escape hatches are closed too. `periodicSync` and Background
Sync are unimplemented in WebKit (§7), so there is no way to wake and reconcile
in the background either. And even where a push _is_ legitimate, one shopping
tick would cost the family one lock-screen notification with no `tag` grouping
(§3) — which is precisely the failure mode `docs/architecture/notifications.md`
calls the thing that kills these apps.

Push stays what it is: a way to interrupt a person about something that matters.
It is not a data channel. **Do not propose silent push again.**

### What the existing defaults already give us, and where they run out

`shared/api/query-client.ts` already sets `staleTime: 30s`,
`refetchOnWindowFocus: true`, `refetchOnReconnect: true`, `refetchOnMount: true`
and `gcTime: 30 min`, and the reasoning written into that file is right: on a
phone, focus _is_ the moment the data is stalest, and coming back from the app
switcher to a cached render that revalidates behind it is the correct behaviour
for most screens. Approving a member, adding an event, contributing to a goal,
posting on the wall — all of these are seen by somebody who _opens_ the app, and
opening the app is a focus event. None of those screens need anything more.

It runs out in exactly one situation, and it is the situation named first:
**two clients foregrounded at the same time on the same screen.** Nobody
switches windows, so no focus event ever fires, and the second phone stays wrong
for as long as it is held. That is the shopping list in a shop, and to a lesser
degree the tasks screen on a Saturday clean-up. No amount of `staleTime` tuning
reaches it, because staleness only causes a refetch when something _asks_, and a
screen that is already mounted and already fetched never asks again.

So the gap is narrow and specific: a foregrounded client needs a way to learn
that something changed, without holding a connection open and without waking a
sleeping phone.

### The decision

**One tiny endpoint returning per-domain revision counters, polled by a single
TanStack Query query while the document is visible, whose result invalidates the
matching query keys.**

```
GET /api/changes  ->  { "rev": { "tasks": 128, "shopping": 4471, "goals": 12, … } }
```

Counters live in one Redis hash, incremented by a Fastify `onResponse` hook on
every successful non-GET request under `/api`, mapped by route prefix to a
domain. The client remembers the last map it saw; any domain whose number
**differs** — up or down — has its query keys invalidated with
`refetchType: 'active'`. One request every 15 seconds while the app is visible,
5 seconds while a shopping list is on screen, and none at all while it is not.

Why this shape and not a smaller or a bigger one:

- **It reuses the authenticated `api` client verbatim**, so a 401 mid-poll goes
  through the single-flight refresh in `shared/api/refresh.ts` that already
  exists and is already tested. No second auth surface, no token in a
  querystring, and structurally no way to produce the reconnect storm that would
  race D3's rotation. This is the strongest single argument against every
  connection-based option below.
- **Resume is free and exact.** `refetchOnWindowFocus` on the `['changes']`
  query means a phone returning from an hour in the background asks "what
  moved?" within a beat of becoming visible and invalidates only those domains —
  strictly better than the blanket refetch-everything that a very short
  `staleTime` would produce, and it needs no `Last-Event-ID`, no server-side
  replay buffer and no catch-up protocol, because a counter _is_ the catch-up.
- **It is one request covering every screen at once**, including the
  notification bell and the Today dashboard, instead of one interval per query
  each pulling a full list payload. The response is roughly 120 bytes.
- **Nothing is fetched that nobody is looking at.** `refetchType: 'active'`
  marks unmounted queries stale without fetching them; they refresh on mount.
- **Zero infrastructure.** No Caddy change, no new dependency, no new Redis
  connection, no pub/sub, no long-lived connections against the VDI. Redis is
  already a hard dependency (rate limiting, BullMQ), so this adds nothing new
  that can be down.
- **It does not replace the floor, it sits on it.** Focus and reconnect
  refetching stay exactly as they are. If the change feed breaks entirely the
  app degrades to today's behaviour, not to nothing.

Battery and data are the reason for a visibility gate rather than a cleverer
interval: locking an iPhone fires `visibilitychange → hidden`, so a phone in a
pocket polls zero times. The 5-second rate exists only while a human is looking
at a shopping list, which is the one place it earns its cost. Worst case with
every family member holding a phone with the app open is under 40 requests a
minute against a per-user rate limit of 300.

### What was rejected

**Server-Sent Events.** The closest call, and the one to revisit if the
requirement changes. Caddy is already prepared for it (`flush_interval -1` on
`/api/*`) and the document CSP's `connect-src 'self'` already permits it. It was
rejected on the sum of four costs, none fatal alone. `EventSource` cannot send
an `Authorization` header and `core/plugins/auth.ts` reads only
`Authorization: Bearer`, so it needs either a token in the querystring — which
lands in Caddy's JSON access log — or a single-use ticket endpoint, a new auth
surface to design, secure and test. Reconnection after every iOS backgrounding
races `/api/auth/refresh`, and D3's reuse detection turns a bad race into
"everybody is logged out", which has already bitten the test suite once. A
connection killed by backgrounding needs a catch-up on resume regardless, which
is either a server-side event buffer keyed by `Last-Event-ID` or a plain
refetch — and if it is a plain refetch, the poll was already doing that. And all
of it buys roughly 5 seconds → 0.5 seconds on **one** screen. Six idle
connections would not trouble the VDI; the machinery around them is the cost.
_Revisit if_ a genuinely sub-second surface appears (shared presence, a live
timer), or the family grows past roughly fifteen people so the aggregate poll
rate begins to matter.

**WebSockets.** Everything SSE costs, plus framing, ping/pong liveness, a
subprotocol and `@fastify/websocket`, in exchange for a client→server channel we
have no use for — every write is already a REST mutation with optimistic
rollback. For a one-way "domain X changed" signal it buys nothing over SSE, and
SSE already lost.

**Postgres `LISTEN/NOTIFY`.** The right fan-out primitive _if_ there were a
transport worth feeding, and it would need a dedicated connection held outside
the Drizzle pool. With no socket to feed it solves a problem we do not have.
Redis pub/sub would be equally reasonable and equally unnecessary.

**A global short `refetchInterval` on every query.** N requests per interval per
mounted screen, each returning a full list payload whether or not anything
changed, and it keeps polling domains the user cannot even see. The revision
poll is the same idea with the payload taken out.

**Per-query `refetchInterval` on the shopping list only, with no new endpoint.**
Honestly close, and it needs no backend work at all — this is the fallback if
the endpoint below turns out to be a mistake. Rejected because it fixes only the
screens somebody remembers to configure, missing the bell, the dashboard and
every screen not yet written, and because it refetches the whole list every tick
even when nothing moved.

**A `/api/changes?since=<cursor>` change log.** A cursor implies a durable
append-only log that must be written on every mutation, indexed, and trimmed
forever. The client does not need to know _what_ changed, only _whether_ — and a
counter answers that with no storage, no trimming and no per-handler writes.

**CRDTs / local-first replication.** Already rejected in D9, and correctly: the
shopping outbox in `features/shopping/outbox.ts` gives us offline writes without
a replication protocol.

**`BroadcastChannel` as the mechanism.** Same-device only, so it cannot address
the two-phones case at all. It stays worth about twenty lines later as a
cross-tab accelerator; see the companion note.

### Latency targets, per screen

These drive the two interval constants and nothing else. Where the target is
"focus", that is a deliberate statement that the screen does not deserve a
timer.

| Surface                            | Query key root                | Target                                       | Delivered by                                                    |
| ---------------------------------- | ----------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| Shopping list items                | `['shopping','items',listId]` | **≤ 6 s**, both phones foreground            | 5 s poll while a list page is mounted                           |
| Shopping lists index               | `['shopping']`                | ≤ 20 s                                       | 15 s poll                                                       |
| Tasks / chores done state          | `['tasks']`                   | ≤ 20 s                                       | 15 s poll                                                       |
| Today dashboard                    | `['dashboard']`               | ≤ 20 s                                       | 15 s poll, fanned in from five domains                          |
| Calendar                           | `['calendar']`                | ≤ 20 s                                       | 15 s poll                                                       |
| Goal balance                       | `['goals']`                   | ≤ 60 s required, ≤ 20 s delivered            | 15 s poll                                                       |
| Wall, kudos, polls                 | `['wall']`                    | ≤ 20 s                                       | 15 s poll                                                       |
| Roster, pending approvals          | `['members']`                 | ≤ 20 s                                       | 15 s poll                                                       |
| Own effective permissions          | `['me']`                      | affordances ≤ 20 s                           | 15 s poll, via `members`                                        |
| Notification bell unread           | `['notifications']`           | ≤ 20 s                                       | 15 s poll + an explicit bump from the dispatcher                |
| Sign-in methods, push devices      | `['settings']`                | focus only                                   | existing defaults — you change these on the device in your hand |
| Anything at all while backgrounded | —                             | **no target**; correct within ~1 s of resume | focus refetch of `['changes']`                                  |

Permission _enforcement_ is untouched by any of this: `resolveAuth` re-reads the
`users` row on every request, so a suspension or a role change binds
immediately. The `['me']` invalidation above only repairs the client's affordance
layer, which would otherwise lag by up to ten minutes.

### The rule that protects optimistic updates

Optimistic writes are everywhere in this app — `useOptimisticOccurrence` in
tasks, the wall's comment and reaction patches, and the shopping outbox, which
is not even a `useMutation`. An invalidation landing mid-flight refetches the
server's _pre-mutation_ state and flashes the user's tick back off before the
response arrives and turns it on again. On the shopping list, which is the one
screen polling fastest, that flicker would be the most visible bug in the app.

**Therefore: the change feed never invalidates while any mutation is in flight.**
Affected domains are held in a pending set and flushed when the mutation cache
reports idle, or on the next poll tick. Nothing is lost — the set is additive —
and the delay is bounded by one interval, which is invisible beside the
mutation's own `onSettled` invalidation that was going to reconcile anyway. This
is the one behaviour that gets a named regression test.

Offline is protected from the other side: `['changes']` is the one query in the
app that runs with `networkMode: 'online'` rather than the global
`offlineFirst`, so it pauses while the browser believes it is offline and
resumes on reconnect, instead of firing failing requests every 15 seconds
alongside a shopping outbox that is busy queueing writes.

### Build detail

`docs/architecture/sync.md` — exact files, the route-prefix→domain map, the
query-key map, the failure-mode table, the open questions and the test plan.
Build from that, not from this entry.

## D13 — Стена is a feed. The "board" direction is superseded.

**This entry reverses a decision taken hours earlier, deliberately, and records
why — so that a future reader does not repair it back.**

Стена was rebuilt as a _board_: twelve notes on one surface, ordered by meaning
(open questions -> pinned -> what happened), a quiet «Что было раньше» tail, and
no composer anywhere on screen. The principle was the README's line —
_announcements, comments on anything, kudos and polls; deliberately not a chat,
Telegram already exists_ — made structural.

The owner has asked for the opposite shape:

> «она должна быть как у VK или instagram, не делить явно на секции и тп»

That is their call. Стена becomes **one continuous stream of cards with no
section headers**. The full specification is `docs/design/DESIGN.md` §D7; build
from that, not from this entry.

### What is superseded

- The board's _ordering_ — «open questions -> pinned -> what happened» — is gone.
  Below the head, the stream is `createdAt` descending and nothing else.
- The explicit sections «Решаем вместе» / «Закреплено» / «На доске» are gone as
  **headers**. Their content is now pinned cards at the top of the same surface,
  labelled in words on their own eyebrow line rather than by a heading above a
  group.
- «Что было раньше» as a tail is gone. A feed has no tail; §D7.11 gives it a
  floor instead.

### What is not superseded, because it was protecting something real

Three of the board's refusals answered failures that a feed makes _more_
available, not fewer. Each is carried across as a mechanic:

1. **An unbounded feed creates obligation.** A family of six must not feel behind
   on their own kitchen wall. So: the feed **ends, visibly** («Это всё, что
   было»), auto-load is bounded to four pages before it asks, and there is **no
   unread badge on the «Стена» tab, ever**.
2. **Recency buries the thing that needs answering.** So: an unanswered poll and
   a live pin never enter the chronological body at all — they float in a head
   that does not move as the feed grows — and consecutive activity lines
   («Лиза полила цветы») coalesce into one digest card instead of competing with
   an announcement one at a time.
3. **A composer on screen invites chat.** So: the compose affordance is a
   **`<button>` at the top of a newest-first stream, not a field at the bottom**.
   It cannot receive text and never raises the keyboard; it opens the same one
   door, whose verb is «Повесить». The `locale.ts` vocabulary rule stands —
   «Лента», «Опубликовать», «Отправить» are still not this screen's words.

### The scoreboard constraint tightened rather than relaxed

D5 is unchanged and this redesign strengthens one part of it. On a board, a
per-note reaction **count** was defensible — it belonged to a note, not a person.
In a feed, cards by different authors are adjacent in one column with the count
at a fixed position on every card, which is a comparison the reader performs for
free. So reactions render as **the emoji plus the discs of the people who used
it — no digit, in the drawn text, in a `title`, or in an `aria-label`**. Six
people is what makes faces fit; that is the test for which social-feed
conventions are cargo here. Kudos still grow no visible count anywhere.

### «Очистить доску» is a horizon, not a delete

`family_settings` gains `wall_cleared_at`; the feed returns only rows created
after it. Nothing is deleted — comments, reactions and kudos stay attached to
their rows. Live pins clear; **open polls stay**, because a clear must not
silently cancel a question nobody has answered. Gated on `settings:manage`
(the horizon is a family setting, D1), confirmed in a dialog that names what
stays, undoable for 6 seconds, and it writes one system post — «Доску очистили
20 августа» — which becomes the feed's visible floor.

### For the implementer: the README needs one line changed

`README.md`'s feature table still reads:

> **Лента** — Announcements, comments on anything, kudos and polls. Deliberately
> not a chat — Telegram already exists.

That clause is now half-wrong and half-load-bearing. The shape is a feed; the
refusal of a message box is intact. **Do not delete the line — revise it**, and
keep the second half. Something in the shape of: «Общая лента: объявления,
комментарии к чему угодно, спасибо и опросы. Без счётчиков и без поля для
сообщений — это не мессенджер.» It is flagged here rather than edited because
the README is not this pass's file.
