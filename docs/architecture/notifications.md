# Notifications — pipeline design

Implements **D10**. Read `docs/DECISIONS.md` first; this note explains _how_ the
ratified decisions are built, not whether they are right.

Owned files:

- `backend/src/modules/notifications/notifications.schema.ts` — tables & enums
- `packages/shared/src/contracts/notifications.ts` — zod contracts, RU catalog,
  default preference matrix

> **The stake.** Notifications are the feature most likely to make the family
> abandon the app. One push at 03:00 and a parent turns notifications off
> forever — and they never turn them back on. Every rule below exists to make
> that impossible: quiet hours _defer_ rather than drop, dedupe keys make a
> retried job silent, and a per-user hourly cap bounds the worst case even when
> a feature misbehaves.

---

## 1. The pipeline

```
domain event  (task assigned, goal reached, member registered, cron tick)
      │
      │  producers call notifications.service.emit(intent)
      ▼
notification_intents            ← one row per event, deduped on dedupe_key
      │
      │  fan-out worker
      ├── recipients   = audience rule ∩ RBAC read scope ∩ status = 'active'
      ├── preference   = stored notification_preferences row
      │                  ?? DEFAULT_NOTIFICATION_PREFERENCES[type] (+ role override)
      ├── channels     = enabled prefs ∩ channels the user actually has
      │                  (live push_subscriptions row / telegram_links.can_dm)
      └── timing       = quiet_hours window → send now | scheduled_for = window end
      ▼
notification_deliveries         ← one row per (intent × user × channel × device)
      │
      │  BullMQ
      ▼
dispatcher worker → web-push adapter | telegram adapter | in-app (no-op, row is the delivery)
```

Producers never think about channels, devices, timezones or preferences. They
write one intent and return. Everything downstream is the notifications module's
problem, which is what keeps the fan-out rules in exactly one place.

### Emitting an intent

Cross-module calls go through the **service**, never the repository (D8):

```ts
await notifications.emit(db, {
  type: 'task_assigned',
  actorId: ctx.userId,
  entityType: 'task_occurrence',
  entityId: occurrence.id,
  priority: 'normal',
  dedupeKey: `task_assigned:${occurrence.id}:${occurrence.assigneeId}`,
  payload: { title: occurrence.title, dueAt: occurrence.startsAt, assigneeId: … },
  audience: { users: [occurrence.assigneeId] },
});
```

`emit` runs inside the caller's transaction: the intent row and the domain write
commit together, so a rolled-back task never produces a notification, and a
committed one always does. The BullMQ job is enqueued **after** commit (an
`after-commit` hook on the unit of work) — enqueuing inside the transaction is
the classic way to have a worker read a row that does not exist yet.

`payload` is **denormalized on purpose**. A deferred delivery may fire eight
hours after the event; by then the task may have been renamed or deleted. The
message is rendered from the payload, not from a fresh read.

---

## 2. Why intents and deliveries are two tables

|             | `notification_intents` | `notification_deliveries`                    |
| ----------- | ---------------------- | -------------------------------------------- |
| Cardinality | one per event          | one per recipient × channel × device         |
| Meaning     | _what happened_        | _who was told, how, when, whether it worked_ |
| Idempotency | `dedupe_key` unique    | retried in place (`attempt`, `last_error`)   |
| Lifetime    | keep for history/debug | trimmed by the cleanup job                   |

Reasons they are not one table:

1. **Idempotency has one natural home.** "Do not tell the family twice about the
   same thing" is a statement about the _event_. With a single table the dedupe
   key would have to include the recipient and the channel, and a fan-out that
   grew a new recipient would double-notify everyone else.
2. **Fan-out is not knowable at emit time.** Recipients depend on the RBAC
   matrix and per-user preferences, both of which can change between emit and
   send. Splitting lets fan-out be a separate, retryable step.
3. **Retry granularity.** A push to Аня's iPhone can fail while the same intent
   succeeds on her laptop and in Telegram. Attempt counters and errors belong to
   the individual attempt, not to the event.
4. **The in-app inbox is a delivery view.** The bell renders
   `deliveries WHERE user_id = ? AND channel = 'in_app'` ordered by
   `created_at desc` — exactly the `(user_id, status, created_at desc)` index.
   `read_at` is per-user state and could not live on a shared intent row.
5. **Deferral is per recipient.** Two people have different quiet hours and
   different timezones. `scheduled_for` is therefore a delivery column.

The obvious alternative — a single denormalized `notifications` table — collapses
the moment two family members have different quiet hours, which is the normal
case (a child sleeps at 21:00, an adult at 00:30).

---

## 3. Fan-out rules

1. **Audience** comes from the intent's producer: explicit user ids, a role
   (`'adults'`, `'admins'`), or `'everyone'`.
2. **Permission filter.** A recipient who cannot read the underlying entity is
   dropped — a child never gets `member_pending_approval`, and a teen never gets
   a `goal_contribution` for a goal they cannot see. This filter runs against the
   RBAC catalog in `@family/shared`, so it cannot drift from the API guards. The
   role overrides in `NOTIFICATION_PREFERENCE_ROLE_OVERRIDES` are _UI defaults_
   only; this step is the enforcement.
3. **Status filter.** Only `status = 'active'` users. A `pending_approval` or
   `suspended` user gets nothing.
4. **Self-suppression.** The actor is never notified about their own action,
   except for `system_alert` and the explicit test push.
5. **Preference resolution.** `notification_preferences` is sparse: an absent row
   means "use `defaultNotificationPreference(type, role)`". This is what lets us
   add a notification type without backfilling a row per user, and lets a changed
   default reach the people who never opened the settings screen.
6. **Channel availability.** `push` requires a `push_subscriptions` row with
   `expired_at IS NULL`; `telegram` requires `telegram_links.can_dm`. An enabled
   preference with no available channel produces a `suppressed` delivery — a
   record, so the UI can honestly say "push включён, но ни одного устройства не
   подписано".
7. **In-app is always written**, regardless of preferences and quiet hours. It is
   the durable record; suppressing it would lose information.

---

## 4. Quiet hours

Windows live in `quiet_hours`: `day_of_week` (NULL = every day) plus
`starts_at`/`ends_at` as floating local `HH:mm`. A window with
`ends_at <= starts_at` wraps past midnight (`22:00 → 07:00`), which is the
common case.

Resolution follows the D2 time model — the window is wall clock in the
recipient's timezone (`users.timezone`, falling back to
`family_settings.timezone`), converted to a UTC instant with Temporal at
evaluation time. Never hardcode an offset; a family member in another timezone
must get _their_ quiet hours, not Moscow's.

```
now inside a window?
  no  → status = 'pending', dispatch immediately
  yes and priority = 'critical' → dispatch anyway (system alerts only)
  yes and mode = 'defer'        → status = 'scheduled',
                                  scheduled_for = end of the window (UTC instant)
  yes and mode = 'silence'      → push/telegram rows = 'suppressed';
                                  the in-app row is still written
```

**Quiet hours never drop a notification.** `defer` is the default and the only
mode that is offered prominently; `silence` exists for the user who would rather
miss the ping than get it late, and even then the inbox row is written.

Overlapping windows compose: a delivery is quiet if it falls inside _any_ window,
and the deferral target is the end of the **latest** window it is currently
inside, so `22:00–07:00` plus `13:00–15:00` does not release a message into a
second quiet window.

Deferred deliveries collapse: when the dispatcher wakes at the end of a window
and finds several deferred rows for one user, it sends a **single summary push**
("3 новых уведомления") and leaves the individual rows in the inbox. Seven
notifications firing simultaneously at 07:00 is its own kind of 03:00 push.

---

## 5. BullMQ topology

Redis is already a dependency (`ioredis`, `bullmq`). Three queues, one worker
process (`backend/src/worker.ts`), started separately from the API so a wedged
push never blocks HTTP.

| Queue           | Job name              | Trigger                       | What it does                                                                            |
| --------------- | --------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `notifications` | `fanout`              | after an intent commits       | intent → delivery rows (§3, §4)                                                         |
| `notifications` | `dispatch`            | after fan-out, and by `sweep` | sends one delivery row via its channel adapter                                          |
| `notifications` | `sweep`               | repeatable, every 60 s        | picks up `status='scheduled' AND scheduled_for <= now()` and enqueues `dispatch`        |
| `notifications` | `escalate`            | repeatable, every 5 min       | evaluates `escalation_policies` (§7)                                                    |
| `notifications` | `digest`              | repeatable, every 15 min      | finds due `digest_subscriptions` rows, builds and emits the weekly digest intent        |
| `maintenance`   | `subscription-health` | repeatable, daily 04:00       | silent ping to every push subscription (§6)                                             |
| `maintenance`   | `cleanup`             | repeatable, daily 04:30       | prunes expired subscriptions, deliveries older than 90 days, intents with no deliveries |
| `maintenance`   | `vapid-check`         | on boot                       | fails fast if the VAPID keypair is missing or malformed                                 |

Job options:

- `dispatch`: `attempts: 5`, `backoff: { type: 'exponential', delay: 30_000 }`
  → roughly 30 s / 1 m / 2 m / 4 m. `removeOnComplete: 1000`,
  `removeOnFail: 5000`.
- `jobId` is the **delivery id** for `dispatch` and the **intent id** for
  `fanout`. BullMQ deduplicates on `jobId`, which makes a double enqueue free.
- Repeatable jobs use a fixed `jobId` so a redeploy does not stack duplicates.
- Concurrency 5. Family scale; the point is ordering sanity, not throughput.
- A `410`/`404` is a **permanent** failure: the adapter prunes the subscription
  and marks the delivery `failed` without consuming retries. Only 5xx and network
  errors retry.
- Once `attempt` exceeds `NOTIFICATION_LIMITS.maxDeliveryAttempts`, the row goes
  to `failed` with `last_error` set. `last_error` is diagnostics only and is
  never rendered to a user (D7: map codes, never show server strings).

**Rate limiting.** Before dispatching a `push` row the worker counts the user's
pushes in the trailing hour. Over `maxPushPerUserPerHour` (6) or
`maxPushPerTypePerHour` (3), the row is deferred by 15 minutes and folded into
the next summary push instead. `critical` bypasses both caps — and `system_alert`
is the only type that is `critical` by default.

---

## 6. Web Push specifics

**VAPID.** One keypair for the deployment, generated by
`backend/scripts/generate-vapid.ts` into `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
/ `VAPID_SUBJECT` (a `mailto:` or `https:` URL). The public key is served from
`GET /api/notifications/vapid-public-key` because the client needs it as
`applicationServerKey` before it can call `subscribe()`. **Rotating the keypair
invalidates every existing subscription** — treat it as a migration, not a config
tweak.

**Payload size.** The encrypted payload ceiling is 4096 bytes and browsers differ
in how much padding they add. Budget `NOTIFICATION_LIMITS.pushPayloadBudgetBytes`
(3072). Push carries `{ id, type, title, body, link, tag }` only — never a full
entity. If the rendered body exceeds the budget, truncate the body, keep the
deep link, and let the app fetch the rest when the user taps.

**Pruning (D10).** A `410 Gone` or `404 Not Found` from the push service means
the subscription is dead forever. Stamp `expired_at`, stop dispatching to it,
and let the cleanup job delete the row. Any other error increments
`failure_count`; past 10 consecutive failures the row is expired as well.
Success resets `failure_count` to 0 and stamps `last_success_at`.

**`pushsubscriptionchange`.** The browser may rotate a subscription without user
involvement. The service worker listens for the event, re-subscribes with the
same `applicationServerKey`, and POSTs the new subscription — the endpoint
UNIQUE constraint makes the write an upsert. Firefox fires this reliably; Chrome
is inconsistent and Safari does not fire it at all, which is precisely why the
health-check in §6.1 is not optional.

**Service worker.** `vite-plugin-pwa` with `injectManifest` (D7) so we own the
`push` and `notificationclick` handlers. `notificationclick` focuses an existing
client if one is open (`clients.matchAll`) instead of opening a duplicate tab,
and navigates to `payload.link`. `tag` is set to the intent id so a repeat push
about the same thing replaces the previous banner rather than stacking.

**iOS — the constraint that shapes the whole feature.** Safari on iOS delivers
Web Push **only to a PWA installed on the Home Screen** (iOS 16.4+), and
`Notification.requestPermission()` must be called from a **user gesture**. So:

- Never request permission on first load. Ask at a _meaningful_ moment — right
  after the user accepts their first task, or from Settings → Уведомления.
- Detect the installed state (`display-mode: standalone` / `navigator.standalone`)
  and store it in `push_subscriptions.is_standalone`. On iOS without it, show
  the "Добавить на экран «Домой»" instructions instead of a permission button
  that cannot work.
- iOS silently drops the permission when the PWA is removed and re-added, and
  the subscription is _not_ revoked server-side.
- The user gesture requirement means no `await` may run before
  `requestPermission()` in the click handler — fetch the VAPID key _before_ the
  button is clickable, not inside the handler.

### 6.1 Subscription health-check

iOS subscriptions expire silently: the endpoint keeps returning 201, nothing is
delivered, and the user believes notifications are on. Therefore:

- A daily `subscription-health` job sends a silent, no-badge push carrying
  `{ type: 'health' }`. The service worker answers by POSTing to
  `/api/notifications/subscriptions/ack`, which stamps `last_success_at`.
- A subscription with no acknowledgement for 7 days is marked `expired_at` and
  the user sees the banner **«Уведомления отключились — включите заново»** with a
  one-tap re-subscribe.
- The same banner appears when `Notification.permission === 'denied'`, when the
  user has zero live subscriptions but push preferences enabled, and on iOS when
  the app is not running standalone.
- The Settings screen lists every device (`push_subscription_summary`) with its
  label, last success and a **«Прислать тест»** button. On iOS this button is the
  only honest way to find out whether push actually works.

---

## 7. Escalation

`escalation_policies` answers "if a critical thing is not acknowledged in N
minutes, tell the other adult".

```
escalate sweep (every 5 min):
  for each enabled policy P:
    find deliveries D where
        D.intent.type = P.type
    and D.sent_at <= now() - P.after_minutes
    and D.read_at is null
    and no escalation intent already exists for D.intent
    →  emit a new intent, type = P.type, priority bumped one level,
       dedupe_key = `escalation:${D.intent_id}:${P.id}`,
       audience = P.escalate_to_role ?? P.escalate_to_user_id,
       payload = original payload + { escalatedFrom: D.user_id }
```

- Escalation creates a **new intent**, never a second delivery on the old one.
  This keeps the audit trail readable and makes the dedupe key the only guard
  needed.
- The original recipients are excluded from the escalation audience — the point
  is to reach someone else.
- `escalate_to_role` wins over `escalate_to_user_id` if both are set.
- Escalation never escalates an escalation (the dedupe key prefix makes those
  intents ineligible), so there is no loop.
- Quiet hours still apply, except for `critical`.

### Anti-spam rules, in one place

1. **Dedupe key** on the intent — a retried job, a double-click, or a re-run
   materializer produces at most one intent.
2. **Per-user hourly push cap** (6) and **per-type hourly cap** (3). Overflow is
   deferred and folded into a summary push.
3. **Quiet hours** defer; the release is a single summary push, not a burst.
4. **Self-suppression** — you are never pushed about your own action.
5. **`tag` = intent id** so the OS replaces rather than stacks banners.
6. **Only `critical` bypasses** any of the above, and only `system_alert` is
   critical by default.

---

## 8. Routes — `/api/notifications/*`

Every route requires an authenticated session. Personal routes are guarded by
`notification:manage:own`; there is no `public: true` route in this module.

| Method   | Path                                   | Guard                     | Body / query                     | Response                             |
| -------- | -------------------------------------- | ------------------------- | -------------------------------- | ------------------------------------ |
| `GET`    | `/api/notifications`                   | session                   | `cursor`, `limit`, `unreadOnly`  | `paginated(inAppNotificationSchema)` |
| `GET`    | `/api/notifications/unread-count`      | session                   | —                                | `unreadCountSchema`                  |
| `POST`   | `/api/notifications/read`              | session                   | `markReadRequestSchema`          | `okSchema`                           |
| `GET`    | `/api/notifications/clearable`         | `notification:manage:own` | —                                | `clearableInboxSchema`               |
| `POST`   | `/api/notifications/clear`             | `notification:manage:own` | `clearInboxRequestSchema`        | `clearInboxResponseSchema`           |
| `GET`    | `/api/notifications/preferences`       | `notification:manage:own` | —                                | `preferencesResponseSchema`          |
| `PUT`    | `/api/notifications/preferences`       | `notification:manage:own` | `updatePreferencesRequestSchema` | `preferencesResponseSchema`          |
| `PUT`    | `/api/notifications/quiet-hours`       | `notification:manage:own` | `updateQuietHoursRequestSchema`  | `quietHoursSchema[]`                 |
| `GET`    | `/api/notifications/vapid-public-key`  | session                   | —                                | `vapidPublicKeySchema`               |
| `GET`    | `/api/notifications/subscriptions`     | `notification:manage:own` | —                                | `pushSubscriptionSummarySchema[]`    |
| `POST`   | `/api/notifications/subscriptions`     | `notification:manage:own` | `pushSubscriptionRequestSchema`  | `pushSubscriptionSummarySchema`      |
| `POST`   | `/api/notifications/subscriptions/ack` | `notification:manage:own` | `{ endpoint }`                   | `okSchema`                           |
| `DELETE` | `/api/notifications/subscriptions`     | `notification:manage:own` | `pushUnsubscribeRequestSchema`   | `okSchema`                           |
| `POST`   | `/api/notifications/test`              | `notification:manage:own` | `notificationTestRequestSchema`  | `notificationTestResponseSchema`     |
| `GET`    | `/api/notifications/digest`            | `notification:manage:own` | —                                | `digestSubscriptionSchema`           |
| `PUT`    | `/api/notifications/digest`            | `notification:manage:own` | `digestSubscriptionSchema`       | `digestSubscriptionSchema`           |
| `GET`    | `/api/notifications/telegram`          | `notification:manage:own` | —                                | link status                          |
| `DELETE` | `/api/notifications/telegram`          | `notification:manage:own` | —                                | `okSchema`                           |

Notes:

- Telegram **linking** happens in the auth module (D3 OIDC with
  `telegram:bot_access`); this module only reads `telegram_links` and offers
  unlink. Do not duplicate the OAuth flow here.
- `POST /subscriptions` upserts on `endpoint`, so a re-subscribe is idempotent
  and safe to call on every app start.
- `POST /test` is rate-limited to 5/hour per user via `@fastify/rate-limit` —
  it is the one endpoint a bored child will hammer.
- The inbox list joins deliveries to intents and renders title/body server-side
  from the intent payload, so the client never re-templates copy.

### 8.1 Clearing the inbox — a `cleared_at`, never a delete

«Очистить» is scoped to the caller by construction: the body carries a scope
(`read` — the default — or `all`) and a `confirm` flag, and **no ids**, so there
is no field in which another member's delivery could be named. Without `confirm`
the call only counts, exactly like shopping's `clear-bought`; the counts the
confirmation states first come from the `GET`.

The write is one column, `notification_deliveries.cleared_at`, and this is the
part that matters:

- **The D11 receipts survive.** `sentAt`, `deliveredAt`, `interactedAt`,
  `acknowledgedAt`, `status` and `readAt` are untouched, so
  `GET /intents/:id/receipts` still answers "did this actually reach them" about
  a notification the recipient has tidied away. Deleting the row would destroy
  that record retroactively, for exactly the messages most worth auditing.
- **The escalation ladder cannot notice.** §7's sweep reads `status` and the
  receipt columns and never `cleared_at`, so a clear neither stops a running
  chain nor restarts a finished one.
- **A `high`/`critical` delivery with no `acknowledged_at` is never cleared** —
  not even by `scope: 'all'`. «Подтвердить получение» lives on the inbox row and
  for a `critical` intent it is the only signal that ends the chain; hiding it
  would leave an escalation running with nowhere left for a human to stop it.
  Those rows come back as `keptNeedsAck` so the UI can say why they stayed.
- Every inbox read (`listInbox`, `countUnread`) and `markRead` filter on
  `cleared_at is null`. A badge counting rows the list refuses to show is the
  "badge that never clears" bug reached from the inside.

`/api/notifications/clear` sits under the `['notifications']` prefix in
`ROUTE_DOMAINS`, so the bump happens in `onResponse` and the member's other
devices update. The preview is a `GET` for the same reason: a dry run shaped as
a POST would bump the domain every time somebody opened the dialog and cancelled.

---

## 9. Left for implementers

- `notifications.service.ts` / `.repository.ts` / `.routes.ts`, the renderer
  (`intent + payload → { title, body, link }` in Russian) and the two channel
  adapters (`adapters/web-push.ts`, `adapters/telegram.ts`).
- `backend/src/worker.ts` and the queue definitions.
- The Telegram bot token / webhook plumbing, and the `403 blocked` →
  `can_dm = false` handler.
- Frontend: `features/notifications/` — bell, inbox, preferences matrix driven by
  `NOTIFICATION_TYPE_LABELS_RU`, quiet-hours editor, device list, the
  install/permission prompt flow and the "уведомления отключились" banner.
- The custom service worker `push` / `notificationclick` /
  `pushsubscriptionchange` handlers.
- Seed rows: a default `escalation_policies` entry for `task_overdue`
  (`after_minutes: 120`, `escalate_to_role: 'adult'`) is a reasonable start, but
  ship it disabled and let the family turn it on.
