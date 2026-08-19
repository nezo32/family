# Household domain — moneybox, shopping, family wall

Design note for the three "household" modules. Binding context: `docs/DECISIONS.md`
(D1 single tenant, D4 RBAC, D6 money, D8 layering, D9 scope) and
`docs/CONVENTIONS.md`.

Owned files:

```
backend/src/modules/goals/goals.schema.ts        savings_goals, goal_milestones, goal_transactions
backend/src/modules/shopping/shopping.schema.ts  shopping_lists, shopping_items, product_catalog
backend/src/modules/wall/wall.schema.ts          posts, comments, reactions, polls, poll_options,
                                                 poll_votes, activity_log
packages/shared/src/contracts/{goals,shopping,wall}.ts
```

No table in this domain has a `household_id` (D1). Rows reference `users.id`
directly; "the family" is "every active row in `users`".

---

## 1. Routes

All routes are under `/api`. Every route declares a permission guard — there is
no `public: true` route in this domain (D4 deny-by-default).

### Moneybox — `/goals`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/goals` | `goal:read` | `?status[]&scope=all\|family\|mine&sort=&cursor=&limit=` |
| POST | `/goals` | `goal:create` | optional inline `milestones[]` |
| GET | `/goals/:id` | `goal:read` | includes `contributors[]` |
| PATCH | `/goals/:id` | `goal:update` | |
| DELETE | `/goals/:id` | `goal:delete` | soft delete (`deleted_at`) |
| POST | `/goals/reorder` | `goal:update` | full ordered id list |
| GET | `/goals/:id/transactions` | `goal:read` | cursor-paginated ledger |
| POST | `/goals/:id/contributions` | `goal:contribute` | positive amount |
| POST | `/goals/:id/withdrawals` | `goal:contribute` | positive amount, negated server-side |
| POST | `/goals/:id/corrections` | `goal:update` | the only signed input |
| POST | `/goals/:id/milestones` | `goal:update` | |
| PATCH | `/goals/:id/milestones/:mid` | `goal:update` | |
| DELETE | `/goals/:id/milestones/:mid` | `goal:update` | hard delete — milestones are not history |

There is deliberately **no** `DELETE /goals/:id/transactions/:txnId`. See §2.

### Shopping — `/shopping`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/shopping/lists` | `shopping:read` | `?includeArchived` |
| POST | `/shopping/lists` | `shopping:list:manage` | |
| PATCH | `/shopping/lists/:id` | `shopping:list:manage` | also archive/unarchive |
| DELETE | `/shopping/lists/:id` | `shopping:list:manage` | cascades to items |
| GET | `/shopping/lists/:id/items` | `shopping:read` | `?state[]&groupByCategory` |
| POST | `/shopping/lists/:id/items` | `shopping:write` | idempotent via `clientId` |
| POST | `/shopping/lists/:id/items/bulk` | `shopping:write` | quick entry, `text` or `items[]` |
| PATCH | `/shopping/items/:id` | `shopping:write` | incl. moving between lists |
| POST | `/shopping/items/:id/toggle` | `shopping:write` | the aisle one-tap |
| DELETE | `/shopping/items/:id` | `shopping:write` | |
| POST | `/shopping/lists/:id/clear-bought` | `shopping:list:manage` | |
| POST | `/shopping/lists/:id/reorder` | `shopping:write` | |
| GET | `/shopping/products/suggest` | `shopping:read` | autocomplete from own history |
| PATCH | `/shopping/products/:id` | `shopping:list:manage` | favourite / default unit & aisle |

### Wall — `/wall`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/wall/posts` | authenticated | pinned first, then `created_at desc` |
| POST | `/wall/posts` | `post:create` | |
| PATCH | `/wall/posts/:id` | `post:delete:own` scope rules¹ | author only, unless `post:delete:any` |
| POST | `/wall/posts/:id/pin` | `post:pin` | body: `{ pinnedUntil }` |
| DELETE | `/wall/posts/:id` | `post:delete:own` / `:any` | soft delete |
| GET | `/:entityType/:entityId/comments` | read perm of the **target** | `post\|task\|event\|goal\|poll` |
| POST | `/:entityType/:entityId/comments` | `comment:create` | |
| PATCH | `/comments/:id` | author only | |
| DELETE | `/comments/:id` | `comment:delete:own` / `:any` | soft delete |
| POST | `/:entityType/:entityId/reactions` | `kudos:give` | idempotent toggle, returns the summary |
| GET | `/wall/polls` | authenticated | `?status=all\|open\|closed` |
| POST | `/wall/polls` | `post:create`² | |
| PATCH | `/wall/polls/:id` | author or `post:delete:any`² | `close: true` is one-way |
| POST | `/wall/polls/:id/votes` | authenticated² | replaces the caller's selection |
| GET | `/activity` | authenticated³ | `?verb&entityType&from&to`, `created_at desc` |

¹ Editing a post is scoped like deleting it: author, or a holder of the `:any`
variant. There is no separate `post:update` permission in the catalog.

² **Open question for the lead:** the permission catalog in
`packages/shared/src/domain/roles.ts` has no `poll:*` entries. The proposal above
reuses `post:create` for authoring and lets any active member vote. If polls
deserve their own permissions, the catalog is lead-owned and needs the entries
added there.

³ The wall activity feed is not the security audit log. `audit:read` (admins
only) covers auth/permission events; `/activity` is the family's own "who did
what" feed and every active member sees it. It never contains rows for `private`
goals a member may not read — the query filters those out.

**404, not 403** for anything outside the caller's read scope (D4): a `private`
goal owned by someone else does not exist as far as the API is concerned.

---

## 2. Money invariants (D6)

1. **Integer minor units, always.** `target_amount` and `delta` are
   `money()` = `bigint({ mode: 'number' })` holding копейки. `1 000,00 ₽` is
   `100000`. No floats, no `numeric`, no division before the wire. JS integers
   are exact to 2^53 — about 90 trillion roubles — so `mode: 'number'` is safe.
2. **The ledger is append-only.** `goal_transactions` is never `UPDATE`d,
   `DELETE`d or soft-deleted. A mistake is offset by a new row with
   `kind = 'correction'` and a mandatory note. An editable history is a history
   nobody trusts. (This used to cite `points_ledger` as the sibling case; that
   ledger is gone — D5 removed the score system outright.)
3. **Balances are derived.**

   ```sql
   SELECT goal_id, SUM(delta) AS current_amount
     FROM goal_transactions
    GROUP BY goal_id;
   ```

   There is **no cached balance column** on `savings_goals`. A cache is a second
   source of truth that drifts the first time a row is inserted outside the
   service. If the aggregate ever becomes hot — it will not, this is a few
   thousand rows — add a materialized view refreshed on write, not a column.
4. **Sign is authoritative, `kind` is a label.** Contributions and interest are
   positive, withdrawals negative, corrections either. The API never accepts a
   signed number except on `/corrections`; withdrawals are submitted positive
   and negated by the service so a client bug cannot silently credit a goal.
   A DB `CHECK` rejects `delta = 0`.
5. **Derived response fields.** `goalResponseSchema` carries `currentAmount`,
   `remainingAmount` and `progressPercent` computed server-side, so the web app,
   the digest and the Telegram bot cannot disagree about progress.
   `progressPercent` is floored at 0 but **not** capped at 100 — an over-funded
   goal reads `112 %`.
6. **Reaching a goal is a service-layer transition**, not a computed status: the
   contribute handler compares the new `SUM(delta)` against `target_amount` and,
   on the crossing edge, sets `status='reached'`, stamps `reached_at`, marks any
   crossed milestones and emits `goal.reached` (activity feed + notification).
   Doing it on the edge rather than on read is what makes the event fire once.
7. **Currency** is stored per goal but the family is single-currency in
   practice. Never sum across different `currency` values; the service rejects a
   contribution whose currency differs from the goal's.

Shopping holds **no money at all**: prices and shared expenses are deferred
(D9). `shopping_items.quantity` is a `numeric` count of stuff, not an amount —
that is the one place `numeric` is correct in this domain.

---

## 3. Polymorphic comments and reactions

`comments` and `reactions` point at their target with `(entity_type, entity_id)`
instead of one nullable FK per commentable table. Allowed types:
`post | task | event | goal | poll`.

**What it buys.** Discussion and emoji on tasks, events and goals for zero extra
tables and zero migrations per new commentable entity. One service, one set of
endpoints, one client component. Kudos (`kudos:give`) is just a reaction on
another member's post or completed task, so the "kudos" feature costs nothing.

**What it costs — and who pays.** Postgres cannot enforce a polymorphic
pointer. Three consequences, all owned by the service layer:

- **No `ON DELETE CASCADE`.** Deleting a task does not delete its comments.
  Every module that soft-deletes a commentable entity must call the wall
  service (or emit a domain event that it handles) to soft-delete the attached
  comments and reactions. Cross-module calls go through the *service*, never the
  repository (D8). A nightly job sweeping orphans by target existence is the
  cheap backstop; it is not a substitute.
- **`entity_type` is unvalidated `text` in the DB.** The closed enum lives in
  `packages/shared/src/contracts/wall.ts` (`COMMENTABLE_ENTITY_TYPES`) and is
  mirrored as a const in `wall.schema.ts` for documentation. Validation happens
  on write, in the contract.
- **Reads need the target's permission.** `GET /:entityType/:entityId/comments`
  must first resolve read access to the *target* (a comment on a private goal is
  as private as the goal) before returning anything. This check is the single
  most important line in the comments service.

**The alternative we rejected.** A `commentable` supertype table with a real FK
from every concrete table would restore integrity, at the price of an extra
insert on every task/event/goal write and a join on every read — to protect a
family-sized dataset from a bug class the service prevents with one delete hook.
Not worth it here; it would be worth it at multi-tenant scale, which D1 says
will never happen.

`reactions` has `UNIQUE (entity_type, entity_id, user_id, emoji)`: a member may
use several different emoji on one target but cannot double-count one. The
endpoint is an idempotent **toggle** and returns the fresh summary, so an
offline double-tap converges instead of oscillating.

**Polls** deliberately keep a laxer constraint: `poll_votes` is unique on
`(poll_id, user_id, option_id)`, which permits several options per voter because
multi-choice polls need exactly that. Single-choice enforcement
(`allow_multiple = false` ⇒ at most one row per `(poll_id, user_id)`) lives in
the **service**, inside the vote transaction: `SELECT … FOR UPDATE` the poll row,
delete the caller's previous votes, insert the new ones. A schema-level rule
would need a conditional unique index that cannot read the parent row, or a
trigger — both worse than ten testable lines.

---

## 4. Offline shopping

The shop is exactly where the signal dies, and the app is an installed PWA (D7).
The shopping list is therefore the one surface designed for optimistic offline
writes. **No CRDTs** — D9 rejects them explicitly; this is a last-write-wins
list with idempotent inserts, which is all a shopping list needs.

The mechanism:

1. The client mints a UUID (`clientId`) **before** the optimistic insert and
   renders the row immediately from the TanStack Query cache.
2. The mutation goes into a persisted queue (idb-keyval / the Query persister).
3. On reconnect the queue replays. `POST …/items` carries the same `clientId`.
4. Server-side, `shopping_items.client_id` has a **partial unique index**
   (`WHERE client_id IS NOT NULL`). A replayed insert raises `23505`; the
   service catches it, looks the row up by `client_id` and returns the existing
   row with `200` instead of creating a duplicate. The create endpoint is
   idempotent by construction, not by convention.
5. `POST /shopping/items/:id/toggle` also accepts `clientId` and an
   `occurredAt` supplied by the client, because a toggle replayed twenty minutes
   later must record when the tap happened, not when the packet landed.
6. Conflict rule: **last write wins on state**, and `bought` beats `needed` on a
   tie — two people in two aisles marking the same item is the common case, and
   the safe resolution is "we have it".
7. The index is partial because server-created and pre-`clientId` rows have
   `NULL` there, and `NULL`s must not collide.

`bulkAddItemsSchema` accepts either the raw multi-line `text` the user typed or
an already-parsed `items[]`. Offline the client parses locally so it can render
optimistic rows; online it can hand the server the raw text and let
`product_catalog` fill in the default unit and aisle.

`product_catalog` learns from this family only: upsert by `lower(name)`,
`usage_count + 1`, `last_used_at = now()` on every item create and buy.
**No external product database** — an imported catalog is 100k rows of noise for
a household that buys ~200 distinct things, and third-party data integrations
are on the rejected list (D9).

---

## 5. Permissions (D4)

From the catalog in `packages/shared/src/domain/roles.ts`:

| Role | Moneybox | Shopping | Wall |
|---|---|---|---|
| owner / admin | full | full | full, incl. `post:pin`, `*:delete:any` |
| adult | `goal:read/create/update/delete/contribute` | full, incl. `shopping:list:manage` | full, incl. pin and `:any` deletes |
| teen | `goal:read` **only** | read + write items | post, comment, react, delete own |
| child | **none** | read + write items | post, comment, react, delete own |
| guest | none | none | none (calendar only) |

- **Children have zero `goal:*` permissions.** Not read, not contribute. A child
  requesting any `/goals` route gets **404** (D4: 404, not 403, outside read
  scope). The Today dashboard and the wall must therefore never assume goal data
  is present — a child's `/api/me` permission list simply lacks `goal:read`, and
  `useCan('goal:read')` gates the widget.
- **Teens are read-only on goals**: `goal:read` and nothing else. They see
  progress, they cannot create, edit or contribute. Contribution on behalf of a
  teen is recorded by an adult via `userId` on the contribution body, which
  requires `goal:update`.
- **`private` goals** narrow further than the permission matrix:
  `visibility='private'` limits reads to `owner_id` plus owner/admin. Filter in
  the repository, and return 404 — never 403 — for the rest.
- **Shopping is intentionally open** to children (`shopping:read` +
  `shopping:write`): adding "мороженое" to the list is exactly the kind of
  participation this app wants. Only list management (create/archive/delete a
  whole list, clear bought, edit the catalog) needs `shopping:list:manage`.
- Guards are `app.requirePermission()` / `app.requireScoped()`; the frontend
  gates UI with `useCan()` and never branches on `role ===`.

---

## 6. Activity feed

`activity_log` is append-only, like the ledgers. `summary` is a **pre-rendered
Russian sentence** written at event time ("Папа выполнил задачу «Вынести
мусор»"). Two reasons: the feed must stay readable after the referenced task is
renamed or deleted, and re-deriving copy on read would couple the feed to every
other module's wording. `metadata` (jsonb) keeps the structured payload for deep
links and richer rendering.

Verbs are dotted domain events: `task.completed`, `goal.reached`,
`goal.contributed`, `shopping.bought`, `post.created`, `member.approved`.
Writers should go through one `activity.record()` helper in the wall service so
the verb list stays enumerable — nothing worse than a feed with three spellings
of the same event.

---

## 7. Left for implementers

- Repositories, services, routes and tests for all three modules (D8 layout).
  The schema and contract layers are complete.
- The `poll:*` permission question in §1, footnote ².
- Registering the seven-plus tables in the lead-owned barrel
  `backend/src/db/schema.ts` and generating the migration.
- The comment/reaction cleanup hook that tasks, events and goals must call on
  delete (§3), and the orphan-sweep job behind it.
- The `product_catalog` upsert hook on item create/buy, and the quick-entry
  line parser ("2 кг картошки" → name/quantity/unit) — shared between the
  server and the offline client.
- Notification intents (D10) for `goal.reached`, milestone crossings, a pinned
  announcement and poll closing.
- Russian strings live in `frontend/src/features/{goals,shopping,wall}/locale.ts`;
  nothing in this domain returns user-facing text except `activity_log.summary`.
