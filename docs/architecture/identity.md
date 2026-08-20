# Identity & Access — design note

Implements D1 (single tenant), D3 (auth) and D4 (RBAC). Read those first; this
document only says _how_, never _whether_.

Owned files:

- `backend/src/modules/identity/identity.schema.ts` — `user_identities`,
  `oauth_transactions`, `refresh_tokens`, `family_settings`, `audit_log`
- `backend/src/modules/identity/users.schema.ts` — `users` (owned by the lead)
- `packages/shared/src/contracts/auth.ts`, `.../contracts/users.ts`

---

## 1. Route table

All paths are under `/api`. The **Guard** column is what the route declares; per
D4 a route with no guard must declare `config: { public: true }` and boot asserts
one or the other is present.

`session` = a valid access token whose `status` claim is `active`.

### 1.1 OAuth — Google / Telegram

| Method | Path                       | Guard  | Purpose                                                                                                                                               |
| ------ | -------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/auth/google/start`       | public | Build the OIDC authorization URL (code + PKCE), insert the `oauth_transactions` row, `302` to Google. `?intent=link` additionally requires a session. |
| `GET`  | `/auth/google/callback`    | public | `?code&state`. Consume the transaction, exchange the code, verify the id_token, resolve or create the identity, issue the session.                    |
| `GET`  | `/auth/telegram/start`     | public | OIDC at `https://oauth.telegram.org`, scopes `openid profile telegram:bot_access`.                                                                    |
| `GET`  | `/auth/telegram/callback`  | public | As Google. The bot-access grant is what lets us DM admins about pending signups.                                                                      |
| `POST` | `/auth/telegram/widget`    | public | **Legacy fallback.** Hash-verified Login Widget payload (`telegramWidgetPayloadSchema`).                                                              |
| `POST` | `/auth/telegram/init-data` | public | **Legacy fallback.** Mini App `initData`, verified raw (`telegramInitDataSchema`).                                                                    |

`intent=link` on any `/start` requires a session and `identity:manage:own`; the
caller's id is written to `oauth_transactions.link_user_id` and the callback
attaches the identity instead of creating a session.

### 1.2 Password

| Method | Path             | Guard                          | Purpose                                                                                                                                                                                                                                                                           |
| ------ | ---------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/auth/register` | public                         | `registerRequestSchema`. Creates a `pending_approval` user + a `password` identity row. **Returns no session** — returns `authOutcome.pending` with a status ticket. `409 ALREADY_EXISTS` on a taken email; rejected outright when `family_settings.allow_registration` is false. |
| `POST` | `/auth/login`    | public                         | `loginRequestSchema`. argon2id verify, constant-time even for unknown emails. Rate-limited per IP **and** per email.                                                                                                                                                              |
| `POST` | `/auth/password` | session + `profile:update:own` | Set or change the password. Requires `currentPassword` unless the account has none yet. Revokes every _other_ refresh family on success.                                                                                                                                          |

### 1.3 Session lifecycle

| Method   | Path                       | Guard       | Purpose                                                                                                                                            |
| -------- | -------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/auth/refresh`            | cookie only | Rotate `__Host-rt`, re-read `status` from the DB, mint a new access token. POST-only + `Origin`/`Sec-Fetch-Site` check.                            |
| `POST`   | `/auth/logout`             | cookie only | Revoke this family (`revoked_reason = 'logout'`), clear the cookie. `allDevices: true` revokes every family of the user. Idempotent: always `200`. |
| `GET`    | `/auth/status`             | public      | `?ticket=...`. Backs the pending / rejected / suspended screens. Returns `accountStatusResponseSchema`.                                            |
| `GET`    | `/auth/sessions`           | session     | Active-session list (`activeSessionSchema`) for the security screen.                                                                               |
| `DELETE` | `/auth/sessions/:familyId` | session     | Revoke one other device.                                                                                                                           |

### 1.4 Self & identities

| Method   | Path                       | Guard                 | Purpose                                                                                                                                        |
| -------- | -------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/me`                      | session               | `meResponseSchema` — profile, **effective** permission list, family context, `permissionsVersion`. The only source of client-side authz state. |
| `PATCH`  | `/me`                      | `profile:update:own`  | `updateProfileRequestSchema`. Cannot touch role/status/overrides — `.strict()` makes an attempt a `400`.                                       |
| `GET`    | `/me/identities`           | `identity:manage:own` | `linkedIdentityListSchema` — linked providers plus the ones still available.                                                                   |
| `DELETE` | `/me/identities/:provider` | `identity:manage:own` | Unlink. `SELECT ... FOR UPDATE` on the user row, then a login-method count; `403 LAST_LOGIN_METHOD` if this is the last one.                   |

Linking has no dedicated endpoint: it is `GET /auth/:provider/start?intent=link`
followed by the normal callback.

### 1.5 Member administration

| Method   | Path                     | Guard               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/members`               | `member:read`       | Roster. Callers with `member:update:any` get `memberListItemSchema` + `pendingCount`; everyone else gets `publicUserSchema` rows. **`rejected` is subtracted by default**, for everyone: `?includeRejected=true` or an explicit `?status=rejected` opts an admin back in, and a non-admin asking for either gets the subtraction rather than a `403` — for `status=rejected` that is an empty list, per D4. See §1.6. |
| `GET`    | `/members/:id`           | `member:read`       | One member, same two-serializer rule. `404` (not `403`) when out of read scope.                                                                                                                                                                                                                                                                                                                                       |
| `PATCH`  | `/members/:id`           | `member:update:any` | Role, chore weight, permission overrides. Role changes additionally require `member:role:assign` and `canManageRole(actor, target)`.                                                                                                                                                                                                                                                                                  |
| `POST`   | `/members/:id/approve`   | `member:approve`    | `UPDATE ... WHERE status = 'pending_approval'` — conditional, so two admins clicking at once yields one `200` and one `409 CONFLICT`.                                                                                                                                                                                                                                                                                 |
| `POST`   | `/members/:id/reject`    | `member:approve`    | Same conditional update to `rejected`, stores `rejected_reason` — **and releases every sign-in key the applicant held** in the same transaction: all `user_identities` rows, `email`, `email_verified`, `password_hash`. The `users` row itself survives as a **tombstone**. Read §1.6 before changing this.                                                                                                          |
| `POST`   | `/members/:id/suspend`   | `member:update:any` | `active -> suspended`. Revokes every refresh family immediately. **Releases nothing** — §1.6.                                                                                                                                                                                                                                                                                                                         |
| `POST`   | `/members/:id/reinstate` | `member:update:any` | `suspended -> active`. Registered under `/reactivate` as well. Does **not** restore sessions; the user logs in again.                                                                                                                                                                                                                                                                                                 |
| `DELETE` | `/members/:id`           | `member:remove`     | **Designed, not implemented — no such route is registered.** Would cascade identities and refresh tokens, leave `audit_log.actor_id` NULL, and refuse the last owner with `403 LAST_OWNER`. The `member:remove` permission does exist in the catalog and gates UI today, so its presence is not evidence the endpoint is there. §1.6 explains what its absence costs.                                                 |
| `GET`    | `/audit`                 | `audit:read`        | Cursor-paginated audit log.                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET`    | `/settings`              | `settings:read`     | The singleton `family_settings` row.                                                                                                                                                                                                                                                                                                                                                                                  |
| `PATCH`  | `/settings`              | `settings:manage`   | Update it.                                                                                                                                                                                                                                                                                                                                                                                                            |

Every route in 1.5 writes an `audit_log` row inside the same transaction as the
mutation. If the audit write fails, the mutation fails.

### 1.6 Rejection releases the applicant's keys; suspension does not

#### What reject releases

`POST /members/:id/reject` does four things in one transaction: the conditional
status change, a revoke of every refresh family, the audit write, and the
release. Released is every credential-shaped key the applicant held, so the
provider account is free the instant the transaction commits:

- **all `user_identities` rows** — the `UNIQUE (provider, provider_user_id)`
  binding;
- **`email` / `email_verified`** — `users_email_lower_uq`, the `ALREADY_EXISTS`
  check in `POST /auth/register`, and `decideLinkOutcome`'s email-collision
  refusal all key off the address;
- **`password_hash`** — a `password` identity row without one is not a login.

The reason is a real incident, not a hypothetical. The owner signed in from the
wrong account by accident, declined the join request it raised, and then could
never link that Telegram account to their real profile: the subject was bound
to a row no human would ever use again, and there is no un-reject transition to
free it. Google and password signups have the same shape through `users.email`.
**A declined request must not cost the person their identity.**

What was released is written into the `member:reject` audit entry **first** —
providers, subject ids, usernames, the address, whether a password existed — so
«кто это вообще был» survives the release. `audit_log.target_id` is a loose
pointer rather than a foreign key, and it keeps pointing at the tombstone.

The operation is idempotent and safe for the same person twice: their second
signup resolves to no existing subject, so it creates a **new** `users` row, and
a second rejection releases that row and collides with nothing.

#### Why a tombstone and not a `DELETE`

**Read this before deleting rejected rows.** They look like litter — a status
nobody can log in as, on a user with no email, no password and no identities.
Removing them is not a cleanup; it re-opens a privilege-escalation path.

1. The rejected row is the record that somebody asked to join and was told no.
   The admin queue shows what was declined, which an admin who declined by
   accident needs.
2. `audit_log.target_id` stays resolvable only because the row is still there,
   and deleting the user would also cascade into `refresh_tokens` and any
   `notification_intents` aimed at them.
3. **The decisive one: `isBootstrapSignup`'s no-address branch is
   `existingUserCount === 0`.** With no `BOOTSTRAP_OWNER_EMAIL` configured — the
   local-dev configuration — an empty `users` table means _first user wins_, and
   the next signup to arrive is an auto-approved `owner`. A `users` table that a
   spree of rejections could empty is a table where that branch comes back to
   life. The tombstone cannot be emptied that way, because the row still counts.

#### Suspension is deliberately the other answer

`POST /members/:id/suspend` releases nothing at all. `reinstate` / `reactivate`
exists, so a suspension is a pause rather than a decision: the person must be
able to sign back in with **the same provider account they always used**.
Releasing their identity would silently turn reinstatement into a
re-registration — a new `users` row in `pending_approval`, none of their
history attached.

The consequence is known and accepted: **a member who is suspended and never
reinstated holds their provider account indefinitely.** Nothing frees the
`(provider, provider_user_id)` binding or the address, so that Google or
Telegram account can never join this family under a different profile.

The honest lever for "this person is not coming back" is `DELETE
/members/:id` — which §1.5 describes and which **is not implemented**, so today
there is no lever at all. Do not fake one out of the reject path: rejection
fires `WHERE status = 'pending_approval'`, and widening that predicate would let
a moderation button turn an active member with real history into a tombstone.

---

## 2. Refresh rotation state machine

One **family** = one login session on one device. Every row in `refresh_tokens`
is one generation of that family's chain.

```
                    login / oauth callback
                              |
                              v
                 ┌───────────────────────────┐
                 │  ISSUED                   │   used_at    = NULL
                 │  gen = 0, new family_id   │   revoked_at = NULL
                 └───────────┬───────────────┘
                             │  POST /auth/refresh
                             v
                  ┌──────────────────────┐
                  │ lookup sha256(raw)   │──── no row ──> 401 TOKEN_INVALID
                  └──────────┬───────────┘
                             │
              ┌──────────────┴───────────────┐
              │                              │
        used_at IS NULL              used_at IS NOT NULL
              │                              │
              v                    ┌─────────┴──────────┐
    ┌────────────────────┐         │                    │
    │ ROTATE (one tx)    │   now - used_at ≤ 20s   now - used_at > 20s
    │ mark used+revoked  │         │                    │
    │  reason='rotated'  │         v                    v
    │ insert gen+1, same │  ┌──────────────┐   ┌──────────────────────┐
    │  family_id         │  │ GRACE        │   │ REUSE DETECTED       │
    └─────────┬──────────┘  │ replay the   │   │ revoke whole family  │
              │             │ successor    │   │ reason='reuse'       │
              v             │ (do NOT      │   │ notify admins        │
      new __Host-rt         │  rotate)     │   │ 401 REFRESH_TOKEN_   │
      + access JWT          └──────┬───────┘   │      REUSED          │
                                   │           └──────────────────────┘
                                   v
                          same cookie/JWT as
                          the concurrent caller
```

Invariants:

- **Only the hash is stored.** `token_hash = sha256(raw 32 random bytes)`, hex.
  A database dump yields no usable session.
- **Rotation is one transaction.** `UPDATE ... SET used_at = now(), revoked_at =
now(), revoked_reason = 'rotated' WHERE id = $1 AND used_at IS NULL` — the
  `used_at IS NULL` predicate is the concurrency guard; zero rows updated means
  another request won the race, so fall into the grace branch.
- **The 20-second grace window is mandatory** (D3). React 19 StrictMode,
  multiple installed-PWA tabs and iOS resume all fire simultaneous refreshes.
  Without the window they trip reuse detection and log the whole family out at
  random. Within the window, return the _successor_ row's token — do not mint a
  third generation, or a refresh storm becomes an unbounded chain.
- **Reuse revokes the family, never just the token.** A leaked cookie replayed
  after the window means the attacker and the user both hold live tokens; only
  killing the family evicts both. Emit an `audit_log` row and a push/Telegram
  alert to admins.
- **Expiry:** the family does not slide indefinitely — each generation inherits
  the family's original `expires_at` (30 days), so a compromised session cannot
  be renewed forever.
- **Cleanup job** (BullMQ, nightly): `DELETE FROM refresh_tokens WHERE expires_at
< now()`, using `refresh_tokens_expires_at_idx`. `oauth_transactions` gets the
  same treatment on a 10-minute cadence, though the happy path already deletes
  each row on use.
- `prev_token_id` is a plain uuid, deliberately **not** a foreign key, so the
  cleanup job can prune old generations without cascading into the live head.

## 3. Account-status gate

Statuses: `pending_approval | active | rejected | suspended`.

1. **No session below `active`.** A `pending_approval` user gets no token at
   all — not a limited one, not a scoped one. `register` and the OAuth callbacks
   return `authOutcome.pending` with a short-lived opaque **ticket**;
   `GET /auth/status?ticket=` is fully unauthenticated and drives the waiting
   screen. The ticket carries no authority beyond reading one status.
2. **Re-checked on every refresh.** `status` is re-read from the row on each
   rotation and embedded in the access JWT, so a suspension takes effect within
   one access-token lifetime — 10 minutes at worst.
3. **Any move away from `active` revokes every refresh family** with
   `revoked_reason = 'status_change'`, in the same transaction as the status
   update. The 10-minute window above is therefore a ceiling on the _access_
   token only; the session cannot be renewed at all.
4. **Approval is a conditional update.** `WHERE status = 'pending_approval'`
   gives one winner and one `409` when two admins click simultaneously.
5. **`allow_registration = false`** rejects unknown subjects at the callback,
   before any row is written — no orphan `pending_approval` users accumulate.

Guard order on every authenticated request: authenticate -> status gate ->
permission guard. The status gate runs first so a suspended admin gets
`ACCOUNT_SUSPENDED`, not `FORBIDDEN`.

## 4. Identity resolution rules

- The join key is **always `(provider, provider_user_id)`**. Email is never a
  key, in either direction.
- **Never auto-link on email match**, even when both sides are verified. The
  callback for an unknown subject whose email matches an existing user returns
  `409 IDENTITY_ALREADY_LINKED` with copy that says "sign in with your existing
  method, then link from Settings".
- `raw_profile` stores the leftover claims for debugging. **Strip every
  credential first** — no `access_token`, `refresh_token`, `id_token`, `code` or
  `client_secret` may be written.

## 5. Errors by route

Codes are from `@family/shared` (`ERROR_CODES`); the frontend maps the `code` to
Russian copy and never renders `message`.

| Route                                            | Codes                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`                            | `VALIDATION_ERROR`, `ALREADY_EXISTS`, `FORBIDDEN` (registration closed), `RATE_LIMITED`                                                                                                                                                                                                                                                         |
| `POST /auth/login`                               | `VALIDATION_ERROR`, `INVALID_CREDENTIALS`, `ACCOUNT_PENDING_APPROVAL`, `ACCOUNT_REJECTED`, `ACCOUNT_SUSPENDED`, `RATE_LIMITED`                                                                                                                                                                                                                  |
| `GET /auth/:p/start`                             | `BAD_REQUEST` (unknown provider / bad `redirect`), `UNAUTHENTICATED` (`intent=link` without a session), `SERVICE_UNAVAILABLE` (discovery down)                                                                                                                                                                                                  |
| `*/callback`                                     | **None on the wire — see §6.** The same failures (`BAD_REQUEST`, `OAUTH_PROVIDER_ERROR`, `TOKEN_INVALID`, `IDENTITY_ALREADY_LINKED`, `ACCOUNT_*`, `FORBIDDEN`) still happen; each becomes a `302` to `/login?error=<code>` or `/settings/accounts?error=<code>`, because the callback is a browser navigation and can never render an envelope. |
| `POST /auth/telegram/widget` \| `/init-data`     | `VALIDATION_ERROR`, `TOKEN_INVALID` (bad HMAC or stale `auth_date`), plus the callback status codes                                                                                                                                                                                                                                             |
| `POST /auth/refresh`                             | `UNAUTHENTICATED` (no cookie), `TOKEN_EXPIRED`, `TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`, `ACCOUNT_PENDING_APPROVAL`, `ACCOUNT_REJECTED`, `ACCOUNT_SUSPENDED`                                                                                                                                                                                    |
| `POST /auth/logout`                              | none — always `200`, even without a cookie                                                                                                                                                                                                                                                                                                      |
| `GET /auth/status`                               | `NOT_FOUND` (unknown or expired ticket)                                                                                                                                                                                                                                                                                                         |
| `POST /auth/password`                            | `VALIDATION_ERROR`, `INVALID_CREDENTIALS` (wrong `currentPassword`), `UNAUTHENTICATED`                                                                                                                                                                                                                                                          |
| `GET /me`                                        | `UNAUTHENTICATED`, `TOKEN_EXPIRED`                                                                                                                                                                                                                                                                                                              |
| `PATCH /me`                                      | `VALIDATION_ERROR`, `FORBIDDEN`                                                                                                                                                                                                                                                                                                                 |
| `GET /me/identities`                             | `UNAUTHENTICATED`, `FORBIDDEN`                                                                                                                                                                                                                                                                                                                  |
| `DELETE /me/identities/:provider`                | `NOT_FOUND` (not linked), `LAST_LOGIN_METHOD`, `FORBIDDEN`                                                                                                                                                                                                                                                                                      |
| `GET /members`, `GET /members/:id`               | `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND` (outside read scope — 404, never 403)                                                                                                                                                                                                                                                               |
| `PATCH /members/:id`                             | `VALIDATION_ERROR`, `FORBIDDEN` (target outranks actor), `NOT_FOUND`, `LAST_OWNER` (demoting the last owner)                                                                                                                                                                                                                                    |
| `POST /members/:id/approve` \| `/reject`         | `CONFLICT` (already decided — the conditional-update loser), `NOT_FOUND`, `FORBIDDEN`                                                                                                                                                                                                                                                           |
| `POST /members/:id/suspend` \| `/reinstate`      | `CONFLICT`, `NOT_FOUND`, `FORBIDDEN`, `LAST_OWNER`                                                                                                                                                                                                                                                                                              |
| `DELETE /members/:id`                            | _(designed, not implemented — §1.5)_ `NOT_FOUND`, `FORBIDDEN`, `LAST_OWNER`                                                                                                                                                                                                                                                                     |
| `GET /audit`, `GET /settings`, `PATCH /settings` | `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`                                                                                                                                                                                                                                                                                              |

Every route may additionally return `VALIDATION_ERROR` from the zod schema,
`RATE_LIMITED`, and `INTERNAL_ERROR`.

## 6. A callback is a screen, not an API response

`GET /auth/:provider/callback` is only ever reached as a **top-level browser
navigation**. Throwing out of it puts the JSON error envelope in the address
bar — English, developer-facing, with no way back into the app — which is the
defect that made `/auth/:provider/start` redirect to `/login?error=<code>`. The
callback now does the same, for every failure it has.

Where it lands is decided by the flow:

| Flow           | Landing              | Carries                        |
| -------------- | -------------------- | ------------------------------ |
| `intent=login` | `/login`             | `?error=<ErrorCode>&provider=` |
| `intent=link`  | `/settings/accounts` | `?error=<ErrorCode>&provider=` |

The intent comes from the consumed transaction row. When there is no row — the
case below — it comes from a one-character **flow marker** prefixed to `state`
(`l.` / `k.`, `transactions.ts :: generateState`). The marker is deliberately
non-authoritative: 256 bits of entropy still follow it, nothing but the choice
of landing page depends on it, and a forged `k.` buys an attacker a redirect to
a screen behind the session guard.

### A replayed state is not an error

One authorization can produce two callbacks — a duplicated navigation, not an
attack (`frontend/src/sw.ts` documents the mechanism that caused it here). The
first redeems the `state` and does the work; the second finds it spent. Its
`400` is the first one's _success_, seen from the losing side, and showing it as
a failure to somebody whose link just worked is simply wrong.

So an unknown state redirects with **`?oauth=replayed`** instead of `?error=`,
and the landing pages treat it as neutral. What it deliberately does **not** do
is claim success:

- Delete-on-read is the replay guard (D3), so "already consumed" and "never
  existed" are the same observation by construction. A recently-consumed set
  would tell them apart, at the price of keeping the state D3 deletes — and it
  would only change the wording, never the outcome.
- The **page** settles it instead, authoritatively: Способы входа has already
  fetched `GET /me/identities`, so it says «Telegram привязан» only when the
  provider really is in the list, and otherwise says only that the link is spent.
  `/login` needs no copy at all in the good case — `RedirectIfAuthenticated`
  takes a visitor who now has a session into the app before the screen paints.
- Nothing is issued on that path. An unknown state costs its sender one redirect.

Expired states, provider mismatches, refused token exchanges and
`IDENTITY_ALREADY_LINKED` stay real failures — they just arrive as a screen with
Russian copy keyed off the `ErrorCode` rather than as JSON.

## 7. Cookies and CSRF

- Refresh cookie: `__Host-rt; HttpOnly; Secure; SameSite=Lax; Path=/;
Max-Age=30d`. Server-set `HttpOnly` cookies are **not** subject to iOS's 7-day
  script-writable storage cap — that is the decisive reason for this design over
  a JS-held refresh token.
- Access token: HS256 JWT, 10 minutes, **JS memory only**. Never `localStorage`.
- CSRF: `SameSite=Lax` + POST-only refresh + `Origin` / `Sec-Fetch-Site` checks
  on every mutating request. Non-auth endpoints authenticate with the in-memory
  bearer token and are structurally CSRF-immune.
- The Telegram widget / Mini App fallbacks (`POST /auth/telegram/widget`,
  `POST /auth/telegram/init-data`) are the only exemptions from the origin
  check — they arrive cross-site by design and carry no ambient authority at
  all, being authenticated solely by the HMAC over their payload.
