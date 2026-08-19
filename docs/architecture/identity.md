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

### 1.1 OAuth — Google / Apple / Telegram

| Method | Path                       | Guard  | Purpose                                                                                                                                                                                                                                                          |
| ------ | -------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/auth/google/start`       | public | Build the OIDC authorization URL (code + PKCE), insert the `oauth_transactions` row, `302` to Google. `?intent=link` additionally requires a session.                                                                                                            |
| `GET`  | `/auth/google/callback`    | public | `?code&state`. Consume the transaction, exchange the code, verify the id_token, resolve or create the identity, issue the session.                                                                                                                               |
| `GET`  | `/auth/apple/start`        | public | Same, but `response_mode=form_post`, no PKCE (`code_verifier` stays NULL), client secret is an ES256 JWT minted at runtime from the `.p8`.                                                                                                                       |
| `POST` | `/auth/apple/callback`     | public | **Cross-site form POST.** `code`, `state`, `id_token`, and — on the first authorization only — the unsigned `user` JSON blob. Needs `@fastify/formbody`; CSRF origin checks must exempt this one route, which is safe because `state` is the anti-forgery token. |
| `GET`  | `/auth/telegram/start`     | public | OIDC at `https://oauth.telegram.org`, scopes `openid profile telegram:bot_access`.                                                                                                                                                                               |
| `GET`  | `/auth/telegram/callback`  | public | As Google. The bot-access grant is what lets us DM admins about pending signups.                                                                                                                                                                                 |
| `POST` | `/auth/telegram/widget`    | public | **Legacy fallback.** Hash-verified Login Widget payload (`telegramWidgetPayloadSchema`).                                                                                                                                                                         |
| `POST` | `/auth/telegram/init-data` | public | **Legacy fallback.** Mini App `initData`, verified raw (`telegramInitDataSchema`).                                                                                                                                                                               |

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

| Method   | Path                     | Guard               | Purpose                                                                                                                               |
| -------- | ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/members`               | `member:read`       | Roster. Callers with `member:update:any` get `memberListItemSchema` + `pendingCount`; everyone else gets `publicUserSchema` rows.     |
| `GET`    | `/members/:id`           | `member:read`       | One member, same two-serializer rule. `404` (not `403`) when out of read scope.                                                       |
| `PATCH`  | `/members/:id`           | `member:update:any` | Role, chore weight, permission overrides. Role changes additionally require `member:role:assign` and `canManageRole(actor, target)`.  |
| `POST`   | `/members/:id/approve`   | `member:approve`    | `UPDATE ... WHERE status = 'pending_approval'` — conditional, so two admins clicking at once yields one `200` and one `409 CONFLICT`. |
| `POST`   | `/members/:id/reject`    | `member:approve`    | Same conditional update to `rejected`, stores `rejected_reason`.                                                                      |
| `POST`   | `/members/:id/suspend`   | `member:update:any` | `active -> suspended`. Revokes every refresh family immediately.                                                                      |
| `POST`   | `/members/:id/reinstate` | `member:update:any` | `suspended -> active`. Does **not** restore sessions; the user logs in again.                                                         |
| `DELETE` | `/members/:id`           | `member:remove`     | Cascades identities and refresh tokens; `audit_log.actor_id` survives as NULL. `403 LAST_OWNER` for the last owner.                   |
| `GET`    | `/audit`                 | `audit:read`        | Cursor-paginated audit log.                                                                                                           |
| `GET`    | `/settings`              | `settings:read`     | The singleton `family_settings` row.                                                                                                  |
| `PATCH`  | `/settings`              | `settings:manage`   | Update it.                                                                                                                            |

Every route in 1.5 writes an `audit_log` row inside the same transaction as the
mutation. If the audit write fails, the mutation fails.

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
- Apple private-relay addresses (`is_private_email = true`) are never
  link-eligible and never treated as a contact address.
- Apple's name arrives **once**, unsigned, in the first callback's `user` field.
  Persist it to `provider_display_name` in the same transaction that creates the
  identity, or it is unrecoverable.
- `raw_profile` stores the leftover claims for debugging. **Strip every
  credential first** — no `access_token`, `refresh_token`, `id_token`, `code` or
  `client_secret` may be written.

## 5. Errors by route

Codes are from `@family/shared` (`ERROR_CODES`); the frontend maps the `code` to
Russian copy and never renders `message`.

| Route                                            | Codes                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`                            | `VALIDATION_ERROR`, `ALREADY_EXISTS`, `FORBIDDEN` (registration closed), `RATE_LIMITED`                                                                                                                                                                                                                                                                               |
| `POST /auth/login`                               | `VALIDATION_ERROR`, `INVALID_CREDENTIALS`, `ACCOUNT_PENDING_APPROVAL`, `ACCOUNT_REJECTED`, `ACCOUNT_SUSPENDED`, `RATE_LIMITED`                                                                                                                                                                                                                                        |
| `GET /auth/:p/start`                             | `BAD_REQUEST` (unknown provider / bad `redirect`), `UNAUTHENTICATED` (`intent=link` without a session), `SERVICE_UNAVAILABLE` (discovery down)                                                                                                                                                                                                                        |
| `*/callback`                                     | `BAD_REQUEST` (missing or expired `state`), `OAUTH_PROVIDER_ERROR` (provider returned `error`, token exchange or JWKS failure), `TOKEN_INVALID` (nonce/iss/aud mismatch), `IDENTITY_ALREADY_LINKED` (subject belongs to another user, or email-match refusal), `ACCOUNT_PENDING_APPROVAL`, `ACCOUNT_REJECTED`, `ACCOUNT_SUSPENDED`, `FORBIDDEN` (registration closed) |
| `POST /auth/telegram/widget` \| `/init-data`     | `VALIDATION_ERROR`, `TOKEN_INVALID` (bad HMAC or stale `auth_date`), plus the callback status codes                                                                                                                                                                                                                                                                   |
| `POST /auth/refresh`                             | `UNAUTHENTICATED` (no cookie), `TOKEN_EXPIRED`, `TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`, `ACCOUNT_PENDING_APPROVAL`, `ACCOUNT_REJECTED`, `ACCOUNT_SUSPENDED`                                                                                                                                                                                                          |
| `POST /auth/logout`                              | none — always `200`, even without a cookie                                                                                                                                                                                                                                                                                                                            |
| `GET /auth/status`                               | `NOT_FOUND` (unknown or expired ticket)                                                                                                                                                                                                                                                                                                                               |
| `POST /auth/password`                            | `VALIDATION_ERROR`, `INVALID_CREDENTIALS` (wrong `currentPassword`), `UNAUTHENTICATED`                                                                                                                                                                                                                                                                                |
| `GET /me`                                        | `UNAUTHENTICATED`, `TOKEN_EXPIRED`                                                                                                                                                                                                                                                                                                                                    |
| `PATCH /me`                                      | `VALIDATION_ERROR`, `FORBIDDEN`                                                                                                                                                                                                                                                                                                                                       |
| `GET /me/identities`                             | `UNAUTHENTICATED`, `FORBIDDEN`                                                                                                                                                                                                                                                                                                                                        |
| `DELETE /me/identities/:provider`                | `NOT_FOUND` (not linked), `LAST_LOGIN_METHOD`, `FORBIDDEN`                                                                                                                                                                                                                                                                                                            |
| `GET /members`, `GET /members/:id`               | `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND` (outside read scope — 404, never 403)                                                                                                                                                                                                                                                                                     |
| `PATCH /members/:id`                             | `VALIDATION_ERROR`, `FORBIDDEN` (target outranks actor), `NOT_FOUND`, `LAST_OWNER` (demoting the last owner)                                                                                                                                                                                                                                                          |
| `POST /members/:id/approve` \| `/reject`         | `CONFLICT` (already decided — the conditional-update loser), `NOT_FOUND`, `FORBIDDEN`                                                                                                                                                                                                                                                                                 |
| `POST /members/:id/suspend` \| `/reinstate`      | `CONFLICT`, `NOT_FOUND`, `FORBIDDEN`, `LAST_OWNER`                                                                                                                                                                                                                                                                                                                    |
| `DELETE /members/:id`                            | `NOT_FOUND`, `FORBIDDEN`, `LAST_OWNER`                                                                                                                                                                                                                                                                                                                                |
| `GET /audit`, `GET /settings`, `PATCH /settings` | `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`                                                                                                                                                                                                                                                                                                                    |

Every route may additionally return `VALIDATION_ERROR` from the zod schema,
`RATE_LIMITED`, and `INTERNAL_ERROR`.

## 6. Cookies and CSRF

- Refresh cookie: `__Host-rt; HttpOnly; Secure; SameSite=Lax; Path=/;
Max-Age=30d`. Server-set `HttpOnly` cookies are **not** subject to iOS's 7-day
  script-writable storage cap — that is the decisive reason for this design over
  a JS-held refresh token.
- Access token: HS256 JWT, 10 minutes, **JS memory only**. Never `localStorage`.
- CSRF: `SameSite=Lax` + POST-only refresh + `Origin` / `Sec-Fetch-Site` checks
  on every mutating request. Non-auth endpoints authenticate with the in-memory
  bearer token and are structurally CSRF-immune.
- `POST /auth/apple/callback` is the single exemption from the origin check —
  Apple posts it cross-site by design, and `state` is the anti-forgery token
  there.
