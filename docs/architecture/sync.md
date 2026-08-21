# Cross-client sync — the change feed

Implements **D12**. Read `docs/DECISIONS.md` first; this note is _how_ it is
built, not whether it is right. It is written to be built from directly — where
something is genuinely undecided it says so and names the experiment.

Related: **D3** (sessions, refresh rotation), **D7** (frontend), **D10/D11**
(notifications — and why push is not this), `docs/research/ios-pwa-push.md`.

---

## 0. One paragraph

Every successful write bumps a per-domain counter in Redis. A single query on
the client polls `GET /api/changes` while the tab is visible, compares the
counters it gets back with the ones it last saw, and invalidates the query keys
belonging to whichever domains moved. That is the entire mechanism. There is no
connection, no cursor, no log, no event payload, and no new infrastructure.

---

## 1. Domains

Seven, and this list is the contract between both sides. It lives in
`@family/shared` so neither side can drift.

| Domain          | Covers                                                        |
| --------------- | ------------------------------------------------------------- |
| `tasks`         | task series & occurrences, chores, rotations, swaps, fairness |
| `events`        | event series & occurrences, attendees, RSVP                   |
| `goals`         | savings goals, milestones, transactions                       |
| `shopping`      | lists, items, product catalog                                 |
| `wall`          | posts, comments, reactions, polls, kudos, activity log        |
| `members`       | users, roster, approvals, avatars, own profile                |
| `notifications` | the in-app inbox and unread count                             |

**`settings` is deliberately absent.** Sign-in methods, push device rows,
notification preferences and quiet hours are changed by you, on the device in
your hand, and the mutation's own `onSettled` already invalidates them. Adding a
domain to sync your own settings between your phone and your laptop is machinery
for a thing nobody has asked for. If that changes, add `settings` here and map
it to `['settings']`; nothing else needs to change.

`dashboard` is not a domain either — the Today screen is a _view_ over five
domains and is invalidated by all of them, on the client. See §5.

---

## 2. Shared contract

**New file — `packages/shared/src/contracts/changes.ts`**, exported from the
package barrel alongside the other contracts.

```
CHANGE_DOMAINS      readonly tuple of the seven strings above
changeDomainSchema  z.enum(CHANGE_DOMAINS)
ChangeDomain        inferred type
changesResponseSchema  z.object({ rev: z.record(changeDomainSchema, z.number().int().nonnegative()) })
ChangesResponse     inferred type
```

`rev` is a **partial** record: a domain the caller may not read is omitted
entirely (§4). Model it as partial in the type, not as a full record with zeros
— the difference matters on the client, where "absent" must never be read as
"reset to 0".

---

## 3. The revision store

**New file — `backend/src/core/revisions.ts`.** Plain functions over the
existing shared ioredis client from `core/redis.ts` (`getRedis()`). Do **not**
create a new connection; this is ordinary command traffic, not pub/sub.

```
REVISION_HASH_KEY = 'family:rev'

bumpRevisions(domains: readonly ChangeDomain[]): Promise<void>
    one pipeline of HINCRBY family:rev <domain> 1, awaited by the caller only
    when the caller is a worker. Errors are caught and logged at warn; a
    failed bump must never fail the request or the job that triggered it.

readRevisions(): Promise<Partial<Record<ChangeDomain, number>>>
    HGETALL family:rev, Number()-coerced, unknown fields dropped.
```

Redis persistence is `appendonly yes` with `appendfsync everysec`
(`infra/docker-compose.yml`), so counters survive a Redis restart. If they are
ever lost the counters restart at 1, which the client reads as "different" and
handles correctly (§7).

No TTL, no trimming, no growth: seven integers, forever.

---

## 4. Backend — bumping

### 4.1 The hook

**New file — `backend/src/core/plugins/revisions.ts`**, a `fastify-plugin`
registered in `backend/src/app.ts` **after** `authPlugin` (it reads
`request.auth` only for logging, but ordering keeps the hook list readable).

An `onResponse` hook, because a bump must reflect a _completed, successful_
write:

1. Return if `request.method` is `GET`, `HEAD` or `OPTIONS`.
2. Return if `reply.statusCode >= 400`. A rejected write changed nothing.
3. Resolve `request.routeOptions.url` (the route _pattern_, including the `/api`
   prefix that `registerModules` applies) through `ROUTE_DOMAINS`.
4. Return if the match is an empty domain set.
5. `void bumpRevisions(domains)` — fire and forget. The response has already
   been sent; nothing may block on this.

Using the route pattern rather than `request.url` means `/api/shopping/items/:id/toggle`
matches once, not once per item id.

> **Confirm at build time** that `request.routeOptions.url` in Fastify 5 carries
> the `/api` prefix applied by `app.register(mod.default, { prefix: '/api' })`.
> It is believed to. The coverage test in §8.1 settles it on the first run — if
> the prefix is absent, strip it from the table rather than from the lookup.

### 4.2 `ROUTE_DOMAINS`

An ordered list of `[prefix, domains]` pairs, **first match wins**, so the
special cases sit above the general ones. Same file.

| #   | Route prefix (pattern)             | Domains         |
| --- | ---------------------------------- | --------------- |
| 1   | `/api/chores/kudos`                | `wall`          |
| 2   | `/api/tasks/:id/comments`          | `wall`          |
| 3   | `/api/tasks/:id/reactions`         | `wall`          |
| 4   | `/api/events/:id/comments`         | `wall`          |
| 5   | `/api/events/:id/reactions`        | `wall`          |
| 6   | `/api/goals/:id/comments`          | `wall`          |
| 7   | `/api/goals/:id/reactions`         | `wall`          |
| 8   | `/api/kudos/:id/comments`          | `wall`          |
| 9   | `/api/kudos/:id/reactions`         | `wall`          |
| 10  | `/api/media`                       | _(none)_        |
| 11  | `/api/posts`                       | `wall`          |
| 12  | `/api/polls`                       | `wall`          |
| 13  | `/api/notifications/preferences`   | _(none)_        |
| 14  | `/api/notifications/quiet-hours`   | _(none)_        |
| 15  | `/api/notifications/digest`        | _(none)_        |
| 16  | `/api/notifications/subscriptions` | _(none)_        |
| 17  | `/api/notifications/telegram`      | _(none)_        |
| 18  | `/api/notifications/deliveries`    | _(none)_        |
| 19  | `/api/notifications`               | `notifications` |
| 20  | `/api/tasks`                       | `tasks`         |
| 21  | `/api/chores`                      | `tasks`         |
| 22  | `/api/events`                      | `events`        |
| 23  | `/api/goals`                       | `goals`         |
| 24  | `/api/shopping`                    | `shopping`      |
| 25  | `/api/wall`                        | `wall`          |
| 26  | `/api/comments`                    | `wall`          |
| 27  | `/api/members`                     | `members`       |
| 28  | `/api/users`                       | `members`       |
| 29  | `/api/me`                          | `members`       |
| 30  | `/api/auth`                        | _(none)_        |
| 31  | `/api/dashboard`                   | _(none)_        |

Notes on the non-obvious rows:

- **Chores are `tasks`.** Rotations, swaps and blackouts all render on the tasks
  screens and share the `['tasks']` key root. `/api/chores/kudos` is the
  exception because kudos render on the wall. Fairness is deliberately absent
  from that list: nothing renders a split of the housework any more (D5), and
  the rotation's `debt` reaches a screen only through
  `GET /chores/rotations/:id/preview`, which explains a single pick. The prefix
  mapping itself is unchanged — a rotation write still bumps `tasks`, because
  the assignment it produces is what the tasks screens draw.
- **`/api/notifications/deliveries/*`** are the D11 ack endpoints. They are
  written by the service worker on behalf of the device that just received a
  push; they change no shared state and must not cause every open client to
  refetch its inbox.
- **A comment or a reaction is `wall` wherever it is mounted**, which is why
  rows 2–9 sit above the general `/api/tasks`, `/api/events` and `/api/goals`
  entries. A comment on a task changes no task: it changes the thread, which the
  client keys under `['wall','comments',…]`. This row has been wrong once —
  comments were mapped to the domain of the thing they hung off — and the symptom
  was an open thread staying stale on every other phone in the house. Row 26
  (`/api/comments`) covers `PATCH`/`DELETE /api/comments/:id` **and**
  `POST /api/comments/:id/reactions`, the heart on a reply: same argument, same
  domain.
- **`/api/media` is classified as changing nothing**, deliberately. An upload is
  a private draft with no `entity_id`; it becomes visible when the post or
  comment carrying its id is written, and _that_ write already bumps `wall`.
  Bumping here would make every phone in the house refetch the feed once per
  file while somebody is still choosing photos.
  `POST /api/media/:id/ticket` — the short-lived playback URL a `<video>` needs —
  takes the same row and writes nothing at all.
- **`/api/me`** is `members` because your display name and avatar appear on the
  family roster. It also carries the `['me']` invalidation on the client (§5),
  which is what repairs a stale permission list.
- **`/api/auth/*`** and **`/api/dashboard/digest/preview`** change no shared
  state; the latter is a read-shaped POST.

An entry mapping to no domains is **explicit, not a fallthrough**. A write route
that matches nothing at all is a build error, caught by §8.1.

### 4.3 The four writers that never see an HTTP request

BullMQ workers write rows without passing through the hook. Each of these calls
`bumpRevisions` explicitly at the end of its handler:

| File                                                         | Job / call site                                             | Domains         |
| ------------------------------------------------------------ | ----------------------------------------------------------- | --------------- |
| `backend/src/modules/tasks/tasks.jobs.ts`                    | `scheduler.materialize-all`, `scheduler.materialize-series` | `tasks`         |
| `backend/src/modules/events/events.jobs.ts`                  | `scheduler.birthdays`                                       | `events`        |
| `backend/src/modules/chores/chores.jobs.ts`                  | `chores.expire-swaps`                                       | `tasks`         |
| `backend/src/modules/notifications/notifications.service.ts` | `deliver()`, after an `in_app` delivery row is committed    | `notifications` |

The last one is the one that matters day to day: it is what makes the bell
count move within a poll tick when a notification lands, rather than at next
focus. Bump **after commit**, next to where `dispatchAfterCommit` already hooks
the unit of work — a bump before commit tells clients to refetch a row that is
not visible yet, and they would cache the pre-write state for another tick.

Without any of these four the app is still correct, just slower — the underlying
queries still refetch on focus and on mount. Treat a missing bump as a latency
bug, never a correctness bug.

### 4.4 The endpoint

**New module — `backend/src/modules/changes/changes.routes.ts`**, added to
`MODULE_LOADERS` in `backend/src/modules/index.ts` (a one-line edit to a file
the lead owns — coordinate).

```
GET /api/changes
  config: { authenticated: true }
  schema: { response: { 200: changesResponseSchema } }
  200 -> { rev: { tasks: 128, shopping: 4471, … } }
```

The handler reads all counters and then **filters by the caller's read scope**,
using `request.auth.can(...)`:

| Domain          | Included when                        |
| --------------- | ------------------------------------ |
| `tasks`         | `can('task:read')`                   |
| `events`        | `can('event:read')`                  |
| `goals`         | `can('goal:read')`                   |
| `shopping`      | `can('shopping:read')`               |
| `members`       | `can('member:read')`                 |
| `wall`          | always (the wall route is auth-only) |
| `notifications` | always (your own inbox)              |

This is cheap, and it does two things at once: a child's client never learns
that the goals domain moved, and never invalidates a query it is not allowed to
run. It matches D4's "the server decides, the client does not re-derive".

Other properties of the route:

- **No route-level rate limit override.** The global limiter allows 300/min
  keyed on `userId`; the worst case here is 12/min.
- **No new Caddy configuration.** This is an ordinary short JSON GET.
- No `Cache-Control` work is needed either: `shared/api/client.ts` already sends
  `cache: 'no-store'`, and `sw.ts` never caches `/api/*`.
- It must answer **401** when unauthenticated, never 403 — `route-access.test.ts`
  enforces that repo-wide for read routes.

---

## 5. Frontend

Four new files, all under **`frontend/src/shared/sync/`**. No existing file is
modified except `AppShell.tsx` and the one shopping page (§5.4), both one line.

### 5.1 `shared/sync/change-feed.ts` — pure, no React

```
changeKeys = { feed: () => ['changes'] as const }

fetchChanges(): Promise<ChangesResponse>       api.get('/changes')

LIVE_POLL_MS = 5_000
IDLE_POLL_MS = 15_000

pollIntervalMs({ visible, live }): number | false
    !visible          -> false
    live              -> LIVE_POLL_MS
    otherwise         -> IDLE_POLL_MS

diffRevisions(seen, next): ChangeDomain[]
    for each domain present in `next`:
      include it iff seen[domain] !== undefined && seen[domain] !== next[domain]
    a domain absent from `seen` is a baseline, not a change
    a *lower* number is a change (Redis was rebuilt) — compare with !==, never <

CHANGE_DOMAIN_KEYS: Record<ChangeDomain, QueryKey[]>
```

The key map, using the roots that exist today (each feature's `api.ts`):

| Domain          | Query keys invalidated                   |
| --------------- | ---------------------------------------- |
| `tasks`         | `['tasks']`, `['dashboard']`             |
| `events`        | `['calendar']`, `['dashboard']`          |
| `goals`         | `['goals']`, `['dashboard']`             |
| `shopping`      | `['shopping']`, `['dashboard']`          |
| `wall`          | `['wall']`, `['dashboard']`              |
| `members`       | `['members']`, `['me']`, `['dashboard']` |
| `notifications` | `['notifications']`                      |

Three things to know about this table:

- `['dashboard']` is `todayKeys.all`; the Today screen fans in from five
  domains. It only costs a request when the user is actually on Today, because
  everything is invalidated with `refetchType: 'active'`.
- `['members']` is shared by `adminKeys` and `familyKeys` (both re-declare
  `MEMBER_KEY_ROOT`), and `goalKeys.roster` reaches into it too. One entry
  covers all of them — that shared root is deliberate and this relies on it.
- `['me']` under `members` is what heals a stale permission list after a role
  change, in seconds instead of at the next refresh. It does not affect
  enforcement, which is already immediate server-side.

`['calendar']` rather than `['events']` is not a typo — the calendar feature
owns the events UI and names its root `calendar`.

### 5.2 `shared/sync/live-screen.ts` — which screens want 5 seconds

A module-level counter exposed through `useSyncExternalStore`, mirroring the
existing `useOnline` pattern in `features/shopping/hooks.ts`. No new dependency,
and no Zustand store to keep in sync.

```
useLiveScreen(): void        // increments on mount, decrements on unmount
useIsLiveScreen(): boolean   // subscribes; true while the count > 0
```

`useLiveScreen()` is called by exactly one page today:
`frontend/src/features/shopping/pages/ListPage.tsx`. Adding a second screen
later is one import; adding it to a screen that does not need it costs the
family battery, so the bar is "two people would plausibly be looking at this at
the same moment".

### 5.3 `shared/sync/use-change-feed.ts` — the whole client

One hook, mounted **once**, in `frontend/src/app/layout/AppShell.tsx` — the
authenticated shell. Not in `AuthShell`, so `/login` and `/auth/*` never poll;
not in `providers.tsx`, so it cannot run before there is a session.

```ts
useQuery({
  queryKey: changeKeys.feed(),
  queryFn: fetchChanges,
  refetchInterval: () => pollIntervalMs({ visible: …, live }),
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  staleTime: 0,
  gcTime: 0,
  networkMode: 'online',
})
```

Every non-default option earns its place:

- `refetchInterval` **as a function**, so it is recomputed after each fetch and
  whenever `live` changes. `useIsLiveScreen()` re-renders the hook, which is
  what lets entering a shopping list switch 15 s → 5 s without remounting.
- `refetchIntervalInBackground: false` plus the `visible` check inside
  `pollIntervalMs` are belt and braces: the option is the real guard, the
  function is the part that is unit-testable.
- `staleTime: 0` / `gcTime: 0` — this query has no cache value; it is a signal.
- `networkMode: 'online'` overrides the global `offlineFirst` (see D12). This is
  the only query in the app that should do so.
- The default `retry` (`shouldRetry`, two attempts with backoff) is correct
  as-is and must not be raised.

**Applying a diff.** In an effect on `data`, with a ref holding what has been
seen:

1. `changed = diffRevisions(seenRef.current, data.rev)`
2. merge `data.rev` into `seenRef.current` **unconditionally**, before any
   invalidation — so a failure to invalidate can never cause a permanent loop.
3. add `changed` to `pendingRef`, a `Set<ChangeDomain>`.
4. `flush()`.

**`flush()`** — the rule from D12:

```
if (queryClient.isMutating() > 0) return;      // try again later; nothing lost
for (const domain of pendingRef.current)
  for (const key of CHANGE_DOMAIN_KEYS[domain])
    void queryClient.invalidateQueries({ queryKey: key, refetchType: 'active' });
pendingRef.current.clear();
```

`flush()` is called from two places: the effect above, and a subscription to
`queryClient.getMutationCache()` that calls it whenever the count reaches zero.
The subscription is what makes a held-back invalidation land immediately after
the mutation settles rather than up to 15 seconds later.

`isMutating()` is checked **globally**, not per mutation key. That is coarser
than it could be, and deliberately so: adding `mutationKey` to every feature's
mutations would touch nine files owned by other people to save at most one
interval of latency in a case that already resolves itself. Refine it later if a
long-running mutation ever makes the delay visible.

**Session boundaries.** `providers.tsx` already calls `client.clear()` when the
access token becomes `null`. `seenRef` and `pendingRef` live in the hook, which
unmounts with `AppShell` on sign-out, so they reset with it. A signed-in user
whose session ends mid-poll gets a 401 → refresh → retry, or a redirect, from
the existing `shared/api/client.ts` path; nothing here needs to know.

### 5.4 The degraded mode

If `GET /api/changes` is broken — a bad deploy, a missing route, a Redis
outage — the app silently loses cross-client updates and nobody notices for a
month. So: when the query's `failureCount` reaches 3, the hook starts a 60-second
interval that calls `queryClient.invalidateQueries({ refetchType: 'active' })`
with the same `isMutating()` guard, and stops it as soon as the feed succeeds
again. Six lines, and it turns a silent failure into a slow one.

It is deliberately not a user-visible error. «Не удалось синхронизировать» on a
family shopping list is noise; the data still arrives on focus.

### 5.5 Deferred — not part of this build

- **`BroadcastChannel` cross-tab.** Broadcast the domain after a local mutation
  so a second tab on the same laptop invalidates instantly instead of waiting a
  tick. Roughly twenty lines in `shared/sync/`. Build it if two tabs turn out to
  be common; on phones it is worth nothing.
- **Service-worker push bridge.** The `push` handler already runs on every
  notification and `features/settings/push/sw-bridge.ts` already has a
  client↔SW message protocol. After `showNotification()` resolves, the SW could
  `postMessage({ type: 'FAMILY_CHANGE', domains: [...] })` to open clients for
  an instant invalidation. Legal on iOS — the notification _is_ shown — but the
  app is almost always backgrounded when a push arrives, so the value is small.
  Owned by the push agent if it is ever built; do not write push logic here.
- **Leader election** so only one tab of several polls. Unnecessary at six
  users; a second tab costs four requests a minute.

---

## 6. Caddy

**No change.** `infra/caddy/Caddyfile` already proxies `/api/*` to
`backend:3000` and this is an ordinary short-lived JSON GET.

Recorded for whoever revisits SSE (D12), so the question does not have to be
re-derived: the `handle /api/*` block already sets `flush_interval -1`, which is
the setting that stops response buffering and is the one people forget. What is
**not** settled is whether `transport http { read_timeout 120s }` applies as a
per-read idle deadline — reset by each heartbeat, so a stream with a 25-second
heartbeat survives — or as an absolute cap that kills any stream at 120 seconds
regardless of traffic. Do not guess: put the stream route in its own `handle`
block with the timeouts omitted, _and_ send a heartbeat comment line every 25
seconds. The experiment that settles it is in §9.

---

## 7. Failure modes

| Situation                                         | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backend restarts**                              | Counters are in Redis, not in the process, so they survive. In-flight polls fail, retry twice with backoff, and resume. No spurious invalidation.                                                                                                                                                                                                                                                                                                                          |
| **Redis restarts and loses the AOF**              | Counters restart at 1, i.e. _lower_ than what clients hold. `diffRevisions` compares with `!==`, so every client invalidates every domain exactly once and is then correct. This is why the comparison is not `>`.                                                                                                                                                                                                                                                         |
| **Redis unreachable**                             | `readRevisions` throws, the endpoint 500s, the feed enters degraded mode (§5.4) after three failures. The rate limiter runs with `skipOnError: true`, so the rest of the app keeps serving.                                                                                                                                                                                                                                                                                |
| **Network loss**                                  | `networkMode: 'online'` pauses the query. On reconnect, `refetchOnReconnect` fires it immediately, one diff catches everything missed, and the shopping outbox flushes its queued writes on the same `online` event.                                                                                                                                                                                                                                                       |
| **Backgrounded for an hour**                      | The interval stops at `hidden`. On iOS the app most likely comes back as a cold start at `start_url` (research §8), in which case the cache is empty, `seenRef` is empty, the first response is a baseline that invalidates nothing, and every mounted query fetches normally. On a warm resume, `visibilitychange → visible` refetches `['changes']` within a beat and invalidates precisely the domains that moved. Both paths are correct; the second is the cheap one. |
| **Access token expires mid-poll**                 | The poll is a normal `api.get`. It 401s, `refresh.ts` performs one single-flight rotation, the request is retried once, and the tick lands late by the width of one refresh. Because there is no connection to re-establish, N clients resuming together produce N ordinary requests, not N reconnects — this is the whole reason a connection-based design was rejected.                                                                                                  |
| **Refresh fails (revoked family, suspension)**    | Existing behaviour: `endSession()` redirects to `/login` or `/auth/*`, `AppShell` unmounts, the poll stops.                                                                                                                                                                                                                                                                                                                                                                |
| **A mutation is in flight when a diff arrives**   | Held in `pendingRef` and applied when the mutation cache goes idle. The optimistic value is never overwritten. Named regression test in §8.2.                                                                                                                                                                                                                                                                                                                              |
| **Offline shopping outbox flushes on resume**     | Many writes land at once, bumping `shopping` several times. Other clients see a single diff on their next tick — counters coalesce for free, which a per-event channel would not.                                                                                                                                                                                                                                                                                          |
| **Two admins approve the same member**            | One wins, one gets 409 (D3). The loser's `['members']` list is invalidated within a tick and self-corrects without a reload.                                                                                                                                                                                                                                                                                                                                               |
| **A write route is added with no domain mapping** | Caught by the coverage test (§8.1), not in production.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **A worker writes rows and forgets to bump**      | Latency regression only: those queries still refresh on focus and on mount.                                                                                                                                                                                                                                                                                                                                                                                                |

---

## 8. Testing

### 8.1 Backend

`backend/src/modules/changes/changes.test.ts` — unit, no database:

- `ROUTE_DOMAINS` resolution: `/api/shopping/items/:id/toggle` → `shopping`;
  `/api/chores/kudos` → `wall` (proving order beats `/api/chores` → `tasks`);
  `/api/notifications/deliveries/:id/delivered` → none;
  `/api/auth/refresh` → none.
- **The coverage guard, and the most valuable test here.** Use the existing
  `collectRouteAccess()` helper in `backend/src/test/access.ts` to enumerate
  every route every module registers. For each non-GET route under `/api`,
  assert `ROUTE_DOMAINS` produces either a domain set or an explicit
  empty-set entry — never a fallthrough. A new module that adds a write route
  and forgets to classify it fails this test with the route name in the message.
  This mirrors the existing repo-wide invariant in `core/plugins/route-access.test.ts`.

`backend/src/modules/changes/changes.integration.test.ts`, gated on
`TEST_DATABASE_URL` in the usual way:

- Owner reads `/api/changes`, POSTs a shopping item, reads again: `shopping`
  increased, no other domain moved.
- Completing a task occurrence moves `tasks` and not `shopping`.
- A write that 400s moves nothing.
- A GET moves nothing.
- A member with no `goal:read` gets a map with `goals` absent — and with `wall`
  and `notifications` present.
- Unauthenticated → 401 (not 403).

### 8.2 Frontend

`frontend/src/shared/sync/change-feed.test.ts` — pure functions, the cheap half:

- `diffRevisions({}, {tasks: 5})` → `[]` (baseline invalidates nothing).
- `diffRevisions({tasks: 5}, {tasks: 5})` → `[]`.
- `diffRevisions({tasks: 5}, {tasks: 6})` → `['tasks']`.
- `diffRevisions({tasks: 5}, {tasks: 1})` → `['tasks']` (the Redis-rebuild case).
- `diffRevisions({tasks: 5, goals: 2}, {tasks: 5})` → `[]` (a domain that
  disappears because permissions narrowed is not a change).
- `pollIntervalMs({visible: false, live: true})` → `false`.
- `pollIntervalMs({visible: true, live: true})` → `5000`.
- `pollIntervalMs({visible: true, live: false})` → `15000`.

`frontend/src/shared/sync/change-feed.test.tsx` — behaviour, with a real
`QueryClient` and a spy on `invalidateQueries`:

- A diff naming `shopping` invalidates `['shopping']` and `['dashboard']` and
  nothing else, each with `refetchType: 'active'`.
- **The named regression test — "a change tick does not revert an in-flight
  optimistic update".** Seed `['shopping','items','L1']` with one unticked item.
  Start a mutation whose `mutationFn` returns a promise you control and whose
  `onMutate` writes the ticked value into the cache. While it is pending, drive
  the feed with a `shopping` bump. Assert: `invalidateQueries` was **not**
  called, and the cached item is still ticked. Resolve the mutation. Assert:
  `invalidateQueries` is now called for `['shopping']`, and the item was ticked
  at every point in between. This test is the reason the pending set exists — if
  someone later "simplifies" `flush()` by dropping the `isMutating()` guard, this
  is what stops them.
- Degraded mode: three consecutive failures start the 60-second blanket
  invalidation; a subsequent success stops it.

Do not write tests that assert TanStack Query honours `refetchIntervalInBackground`
or `networkMode` — that is framework behaviour, and `docs/CONVENTIONS.md` says
not to. Test `pollIntervalMs` instead; it is our rule, expressed as a function,
precisely so it can be tested without testing the library.

### 8.3 On a device

Add to the pre-launch checklist in `docs/research/ios-pwa-push.md`:

> Two installed PWAs, same shopping list, both foreground. Tick an item on one
> and count seconds until it appears on the other. Expect under six.

---

## 9. Open questions, and the experiment for each

1. **Is 5 seconds actually the right number for the kitchen, or would 10 feel
   the same?** Unknown, and it is a perception question that no amount of
   reasoning settles. Ship 5, run the device test in §8.3 with two real people,
   and raise it if nobody can tell. It is one exported constant.
2. **Does `visibilitychange → visible` fire reliably enough on a warm iOS resume
   for the focus refetch to be the fast path?** Research §8 says an installed
   PWA usually comes back as a _cold_ start, in which case the question is moot.
   Instrument a counter of `['changes']` fetches and check it against
   checklist item 9 ("kill under memory pressure, return") on a real device.
3. **Does `request.routeOptions.url` carry the `/api` prefix?** Settled
   automatically by the coverage test in §8.1 on its first run.
4. **Caddy's `read_timeout` semantics for a streamed response** — only matters
   if SSE is ever revisited. The experiment: hold a `text/event-stream` open
   through the edge with a comment heartbeat every 25 seconds and watch whether
   it survives past 120. If it dies, the timeout is absolute and the SSE route
   needs its own `handle` block.
