# Ratified Architecture Decisions

> **Every agent working on this repo MUST read this file first.** These decisions are
> final. Do not re-litigate them; if you believe one is wrong, raise it and stop.

## D1 — Single tenant. No `households`, no `members` table.

This app serves **one family**. There is no `household_id` on any table and no
`members` table separate from `users`. Membership attributes (role, status,
birth date, timezone, rotation weight, permission overrides) live directly on
`users`. Family-wide configuration lives in a **singleton** `family_settings` row.

*Rationale:* multi-tenancy would put an extra predicate on every query and an
extra join on every read for a capability that will never be used. A second
family gets a second container.

## D2 — Recurrence: hybrid (rule + materialized rolling window)

- Series tables (`task_series`, `event_series`) store the **rule**.
- Occurrence tables (`task_occurrences`, `event_occurrences`) store **materialized
  instances** for a rolling **90-day** horizon, extended by a nightly BullMQ job
  and eagerly on every series write.
- Per-occurrence state (done / skipped / assignee / points / comments) has to
  live somewhere; that place is the occurrence row.

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

| Provider | Flow |
|---|---|
| Google | OIDC authorization code + PKCE. `client_secret` is **still required** alongside PKCE for a Web client. Accept **both** `https://accounts.google.com` and `accounts.google.com` as `iss`. |
| Apple | OIDC authorization code, `response_mode=form_post`. Client secret is an **ES256 JWT generated at runtime** from the `.p8` (Apple caps `exp` at 15 777 000 s). Name/email arrive **only on first authorization**, in the unsigned `user` POST field — persist immediately or lose them forever. |
| Telegram | **OIDC at `https://oauth.telegram.org`** (the hash-based Login Widget is legacy/archived). Scopes `openid profile telegram:bot_access`. The bot-access scope is how we DM admins about pending signups. Legacy widget + Mini App `initData` verifiers are implemented as fallbacks. |

### The OAuth transaction store — non-negotiable

`state -> { nonce, code_verifier, intent, link_user_id, redirect_after }` lives in
a **Postgres table with a 10-minute TTL, deleted on use**. Not in a cookie.

*Why:* Apple's `form_post` callback is a **cross-site POST**, and `SameSite=Lax`
cookies are not sent on cross-site POSTs. A cookie-based state store fails for
Apple only, only in production. The server-side store also fixes the same class
of bug for the installed iOS PWA.

### Identity model

- `users` (nullable `email` — Telegram gives no email, ever) + `user_identities`
  (`provider`, `provider_user_id`, ...).
- The join key is **always `(provider, provider_sub)`**. Email is never a key.
- `UNIQUE (provider, provider_user_id)` and `UNIQUE (user_id, provider)`.
- **Never auto-link on email match.** Even when both sides are verified, show
  "sign in with your existing method, then link from Settings". Apple private
  relay addresses are never eligible for linking.
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

## D5 — Chore fairness

`weighted_balance` by default: assign to the eligible member with the lowest
`(earned + committed) / weight` debt over a 28-day window, tie-broken
deterministically (longest since last assignment -> rotation position -> id).
Never random — re-running the materializer must reproduce the same schedule.

- Assignment is written **once at materialization and frozen**. Never recomputed
  on read; reshuffling next week's chores destroys trust instantly.
- Points accrue to **whoever actually did it**, not whoever was assigned. That is
  what makes the fairness loop self-correcting.
- `points_ledger` is **append-only**; balances are `SUM(delta)`. Never a cached
  balance column.
- Surface load as a neutral "this week's load" bar, never a sibling leaderboard.

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
