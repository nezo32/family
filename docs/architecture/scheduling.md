# Scheduling, Tasks, Events & Chore Fairness

Design note for the modules `scheduling`, `tasks`, `events`, `chores`.
Binding context: **D1** (single tenant), **D2** (recurrence & time model),
**D5** (chore fairness), **D8** (backend layering).

Owned files:

| File                                                     | Contents                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `backend/src/modules/scheduling/recurrence.schema.ts`    | `recurrenceColumns()`, `visibility`, `occurrence_status`                  |
| `backend/src/modules/tasks/tasks.schema.ts`              | `task_series`, `task_occurrences`, `assigned_via`                         |
| `backend/src/modules/events/events.schema.ts`            | `event_series`, `event_occurrences`, `event_attendees`                    |
| `backend/src/modules/chores/chores.schema.ts`            | `rotations`, `rotation_members`, `user_blackouts`, `chore_swaps`, `kudos` |
| `packages/shared/src/contracts/{tasks,events,chores}.ts` | zod contracts                                                             |

---

## 1. The shape: rule + materialized window

A recurring thing is two rows, not one:

- **series** — the rule. Floating local anchor (`dtstart_local` + `timezone`),
  an RRULE line without DTSTART, RDATE/EXDATE lists, and the two bookkeeping
  columns `series_ends_at` and `materialized_through`.
- **occurrence** — one materialized instance inside the rolling **90-day**
  horizon, carrying everything that is per-instance: status, assignee,
  completion, overrides, comments, attendees.

Per-occurrence state has to live somewhere, and a pure-rule design has nowhere
to put "Миша did the bins on the 14th". Pure materialization, on the other hand,
cannot answer "change every future Monday" without rewriting thousands of rows.
The hybrid is the only shape that answers both cheaply.

A **one-off** task or event is the same shape with `rrule = NULL` and exactly one
occurrence. No second code path, no second table, no `if (isRecurring)` in the
completion handler.

### Why `occurrence_key` and not `starts_at` is the identity

`occurrence_key` is the floating local datetime the rule _originally_ produced.
It never changes. When a user drags Tuesday's dentist appointment to Wednesday,
`starts_at` / `ends_at` / `local_date` / `starts_local` all change and
`occurrence_key` stays `2026-09-08T14:00:00`.

That is what lets the materializer run again without resurrecting a phantom at
the original slot: it computes the keys the rule produces, and every key it
already has in the database is skipped, moved or not. If identity were
`starts_at`, the next horizon extension would helpfully re-create the appointment
on Tuesday, and the family would have two dentists.

---

## 2. The materializer

Lives in `src/modules/scheduling/materializer.service.ts`; the recurrence
library is reached only through `src/core/recurrence/engine.ts` (D2).

Triggers:

1. **Nightly BullMQ job** (`scheduling:materialize`), 03:15 family time.
2. **Eagerly on every series write** — create, schedule change, un-archive — for
   that one series, inside the same transaction as the write.
3. **On demand** from an admin route, for repair.

### Algorithm

```
horizon      := now + 90 days
for each series S where archived_at is null
                  and rrule is not null
                  and (materialized_through is null or materialized_through < horizon)
                  and (series_ends_at is null or series_ends_at > materialized_through)
  -- driven by the partial index task_series_materializer_idx / event_series_materializer_idx
  BEGIN TRANSACTION
    SELECT S FOR UPDATE                    -- serialises with a concurrent write
    from  := max(S.materialized_through, S.dtstart_local resolved) - 1 day   -- overlap, on purpose
    keys  := engine.expand(S.rule, { from, to: horizon })  -- floating local datetimes
    for each key in keys
      startsAt   := engine.toInstant(key, S.timezone)      -- disambiguation: 'compatible'
      dueAt      := engine.addWallClock(key, S.due_offset_minutes, S.timezone)
      assignee   := resolveAssignee(S, startsAt)           -- see §5, only for tasks
      INSERT INTO <t>_occurrences (series_id, occurrence_key, ...)
        VALUES (S.id, key, ...)
        ON CONFLICT (series_id, occurrence_key) DO NOTHING  -- <= the whole guarantee
    S.materialized_through := horizon
  COMMIT
```

### The idempotency guarantee

`UNIQUE (series_id, occurrence_key)` + `ON CONFLICT DO NOTHING` means:

- Re-running over an already-materialized window is a no-op.
- A crash halfway through leaves a consistent prefix; the next run finishes the
  job, because `materialized_through` is only advanced on commit.
- Two workers racing on the same series produce one winner — the loser's inserts
  conflict away and its `FOR UPDATE` serialises the watermark update.
- A moved, retitled or reassigned occurrence is **never touched**: the key
  already exists, so `DO NOTHING` protects it. This is why user edits survive
  the next horizon extension.

The deliberate one-day overlap on `from` costs a handful of no-op conflicts and
removes an entire class of boundary bug around DST and clock skew.

### Trimming

The same job cancels stale rows: `status = 'scheduled' AND due_at < now() -
auto_cancel_after_days` becomes `cancelled` (never deleted — the history is
someone's record of not doing the dishes). Occurrences are never deleted by the
job; a series delete cascades.

---

## 3. Mutation semantics

Every edit and delete of a recurring item carries an explicit
`scope: 'this' | 'this_and_future' | 'all'` (`editScopeSchema`). There is no
default, because guessing here is how calendars lose data.

### 3.1 Skip

Not an edit at all: `status := 'skipped'`, `skipped_by_id`, `skip_reason`. The
series is untouched and the next occurrence appears as normal. A skipped
occurrence counts for nobody in the fairness window — it is neither done nor
still owed. `suppressFuture: true` additionally appends the key to `exdates_local`
so the slot never returns if the row is ever re-materialized.

Skip is the escape valve that keeps people from deleting a series because they
missed it once.

### 3.2 Edit this only

Write the override columns on the occurrence (`title_override`,
`notes_override`, a new `starts_local`, ...) and set `is_exception = true`.
The rule is not modified, `occurrence_key` is not modified.

`is_exception` is the materializer's "hands off" flag and the UI's "изменено"
badge. Resolution is always `COALESCE(override, series_value)` — resolved once
in the repository, so services and clients only ever see the effective value.

### 3.3 Edit this and future — the series split

The only mutation that creates a row:

1. `UNTIL` on the old series is set to just before the anchor occurrence's key;
   `series_ends_at` is recomputed.
2. Old occurrences at or after the anchor **that are still `scheduled` and not
   exceptions** are deleted. Anything `done` / `skipped` and every exception
   stays — history is not rewritten.
3. A new series is inserted with the edited fields, `dtstart_local` = the anchor
   key (or its new local start, if the edit moved it), and
   `supersedes_series_id` = the old series id.
4. The new series is materialized eagerly through the horizon.

The `supersedes_series_id` chain keeps history walkable: "this chore has existed
since March, under three different schedules".

### 3.4 Edit all

Update the series in place. If the _schedule_ changed, delete every
`scheduled`, non-exception future occurrence and re-materialize; if only
metadata changed (title, notes, category), nothing is deleted — the resolution
rule means every non-overridden occurrence picks the new value up for free.

Past occurrences are never touched by any scope. "All" means all future.

### 3.5 Delete

Same three scopes. `this` on a materialized row → `status = 'cancelled'` plus an
EXDATE (state preserved, calendar clean). `this_and_future` → the split of §3.3
without a successor. `all` → `archived_at` on the series; a hard delete is only
offered when the series has no completed occurrences, and it cascades.

---

## 4. Overdue is derived, never stored

`isOverdue := status = 'scheduled' AND due_at + grace_minutes < now()`

There is no `overdue` status and no `is_overdue` column. Reasons, in order of
how much pain each one saves:

1. **It is a function of the clock.** A stored flag is wrong from the moment it
   is written until a job repairs it — and the job would have to run every
   minute to keep the dashboard honest.
2. **It would fight the materializer.** Two writers (the sweeper and the user)
   racing on the same row for a value that is derivable from data already there.
3. **The status enum stays meaningful.** `scheduled → done | skipped |
cancelled` are transitions a _person_ causes. Overdue is not something anyone
   did.
4. **It is cheap.** `task_occurrences_overdue_idx` is a partial index on
   `due_at where status = 'scheduled'`; the family-scale row count makes this a
   sub-millisecond index scan.

The same logic applies to the "on time" bonus: it is evaluated once, at
completion, from `completed_at <= due_at + grace_minutes`, and then it is a fact
in the ledger rather than a derived flag.

---

## 5. Rotation & fairness (D5)

### Eligibility

A member is eligible for an occurrence when they are an `active` row in the
rotation, their effective weight is `> 0`, and no `user_blackouts` row of theirs
covers `starts_at`.

Effective weight = `rotation_members.weight` (which defaults to `1.00` and is
seeded from `users.chore_weight`). A blackout **skips without forgiving**: the
member keeps their accrued debt, so they surface at the top of the queue when
they come back, rather than quietly getting a free week.

### `weighted_balance` — the default

For each eligible member, over the last `balance_window_days` (28):

```
completed = COUNT(task_occurrences) with status='done', completed_by_id = them, inside the window
committed = COUNT(task_occurrences) with status='scheduled' already assigned to them
debt      = (completed + committed) / weight
```

Both terms are **counts of chores**. There is no points ledger and no score of
any kind — see D5 for why the scoring was removed and why the scheduling signal
was kept. Every occurrence counts as exactly one, so nobody has to agree on
what the bins are worth relative to the dishes.

Lowest `debt` wins. `committed` is what stops the materializer handing one
person the entire next month in a single pass: each assignment immediately adds
one to that member's committed count for the following iteration inside the
same run.

Ties break **deterministically**, in this order:

1. longest time since their last assignment (`MAX(starts_at)` ascending, NULL
   first — somebody who has never been assigned goes first),
2. `rotation_members.position` ascending,
3. `user_id` ascending (the final, total tie-break).

**Never random.** Re-running the materializer must reproduce the same schedule
bit for bit; a random tie-break turns every horizon extension into a silent
reshuffle, and the family stops trusting the calendar.

The other strategies: `round_robin` walks `position` from `rotations.cursor`
(advanced per assignment, still skipping blackouts); `fixed` always picks the
single active member; `anyone` materializes with `assignee_id = NULL` and lets
the first claimer take it (`assigned_via = 'claimed'`).

### Assignment is frozen at materialization

Written once, when the occurrence row is created, along with `assigned_via`.
Never recomputed on read, never rebalanced by a background job.

If assignment were derived at read time, next Tuesday's chore would belong to a
different person every time somebody completed something today. Nobody can plan
against that, and "but it said it was mine yesterday" is the end of the feature.
A rotation change therefore only affects occurrences materialized _after_ the
change, unless an adult explicitly asks for `reassignFuture: true`.

### The chore counts for the doer

`completed_by_id`, not `assignee_id`, is what the count groups by (D5). That is
what makes the loop self-correcting: covering for your brother raises your debt,
so the rotation gives you less next week — the system pays you back in time off
rather than in a leaderboard position.

**The count is never shown to anybody, as a personal total or otherwise.** It
exists to order a queue. It had three read surfaces and all three are gone. In
the order they were found:

1. `GET /chores/fairness`, drawn as a family-level load bar in the side column
   of Задачи and Семья. The endpoint, its `FairnessSummaryResponse` contract and
   the bar went together.
2. The `fairness` object on `GET /dashboard/today` — `doneCount` and
   `sharePercent` for every active member, gated on `task:read:any`. It outlived
   the widget that drew it by a release, computed on every open of the home
   screen and serialised for nobody. A payload field that exists is a payload
   field somebody renders, so it was removed rather than left dormant.
3. The `load` section of the **weekly digest** — «Вы закрыли N дел» plus the
   family's weekly total, pushed to a phone. This one was the furthest from a
   "display" and the closest to the thing D5 forbids: a per-person running total
   is no less a scoreboard for arriving as a notification, and the digest is the
   one message a family will not switch off.

Removing a digest section needs no migration. `digest_subscriptions.sections` is
a `text[]`, and `sanitizeSections()` in `dashboard/digest.service.ts` filters
every stored value through `DIGEST_SECTIONS` on read, falling back to the
defaults when nothing survives — the same route `points` took before `load`.
(One caveat, recorded where it was found: `notifications.service`'s
`getDigestSubscription` casts `row.sections` instead of sanitizing it, so a row
still holding a removed value 500s that one endpoint. It wants the same call.)

See D5 for why, and do not add any of them back.

What remains is `GET /chores/rotations/:id/preview`, which explains a _single
pick_ to the person who got it. That is auditability, not display: it answers
"why did I get the bins again?" for one occurrence rather than reporting what
everybody's week added up to.

Idempotency is structural rather than enforced. Completion is the one action a
user can fire twice (double tap, retry after a timeout, an offline queue
replaying), and the conditional `UPDATE ... WHERE status = 'scheduled'` means
the second attempt writes nothing. Since fairness counts rows rather than
summing a ledger, there is no second place for a duplicate to land — reopening
an occurrence likewise removes it from every count in the same statement, with
no compensating entry to write.

### Swaps

`chore_swaps` has a partial unique index allowing **one `pending` row per
occurrence**, so two taps cannot create two live offers. Accepting rewrites
`assignee_id` (`assigned_via = 'swap'`) and nothing else; when the chore is
done, the count follows `completed_by_id` as always. A pending swap past
`expires_at` is swept to `expired`.

A swap carries **no sweetener column** and must not grow one: a bribe between
siblings would be denominated in exactly the score D5 removed.

---

## 6. Birthdays

**No `birthdays` table exists, and none should be added.**

A birthday is an ordinary yearly `event_series` generated from `users.birth_date`
by the `scheduling:birthday-sync` job:

- `rrule = 'FREQ=YEARLY'`, `is_all_day = true`, `duration_minutes = 0`
- `dtstart_local` = `<birth year or current year>-MM-DDT00:00:00`, family timezone
- `source_kind = 'user_birthday'`, `source_ref = users.id`
- `visibility = 'household'`, `reminder_offsets = {10080, 1440}` (a week and a day)

Idempotency comes from the partial unique index
`event_series_source_uq (source_kind, source_ref) where source_ref is not null`:
the job upserts, so re-running it or changing a birth date updates the one row.
Clearing `birth_date` archives it; deleting the user cascades.

A dedicated table would buy nothing and cost a second calendar read path, a
second notification path, a second ICS exporter and a second permission check —
for a row that is already a perfectly ordinary yearly event. Age is computed at
render time from `birth_date`; it is not stored on the event.

---

## 7. The recurrence engine interface

`src/core/recurrence/engine.ts` is the **only** module allowed to import
`rrule-temporal` or `temporal-polyfill` (D2). Everything else takes this
interface. All datetimes crossing it are floating local strings or explicit
`{ instant, timezone }` pairs — never a bare `Date`.

```ts
/** `YYYY-MM-DDTHH:mm:ss`, no offset, no Z. */
export type FloatingDateTime = string;
/** IANA id, e.g. 'Europe/Moscow'. */
export type TimeZoneId = string;

export interface SeriesRule {
  /** RRULE line WITHOUT DTSTART, or null for a one-off. */
  rrule: string | null;
  dtstartLocal: FloatingDateTime;
  timezone: TimeZoneId;
  rdatesLocal: FloatingDateTime[];
  exdatesLocal: FloatingDateTime[];
}

export interface RecurrenceEngine {
  /**
   * Expand to the floating local keys in [from, to] (inclusive), ascending,
   * RDATEs merged, EXDATEs removed, de-duplicated. A null rrule yields
   * [dtstartLocal] when it falls in the window. Hard-capped at `maxCount`
   * (default 1000) so a malformed import cannot hang a worker.
   */
  expand(rule: SeriesRule, window: { from: Date; to: Date; maxCount?: number }): FloatingDateTime[];

  /** Resolve a local key to a UTC instant. DST: disambiguation 'compatible'. */
  toInstant(local: FloatingDateTime, tz: TimeZoneId): Date;

  /** Wall-clock arithmetic: zdt.add({ minutes }), NEVER instant + n*60000. */
  addWallClock(
    local: FloatingDateTime,
    minutes: number,
    tz: TimeZoneId,
  ): { local: FloatingDateTime; instant: Date };

  /** Local calendar date of a key, for the denormalized `local_date` column. */
  localDateOf(local: FloatingDateTime): string;

  /** Last instant the rule can produce (COUNT/UNTIL), or null if infinite. */
  seriesEndsAt(rule: SeriesRule): Date | null;

  /** Restricted UI preset -> RRULE line. The only writer of rrule text. */
  compile(preset: RecurrencePreset, ends: RecurrenceEnd, dtstartLocal: FloatingDateTime): string;

  /** RRULE line -> preset, or null when outside the restricted grammar. */
  decompile(rrule: string): { preset: RecurrencePreset; ends: RecurrenceEnd } | null;

  /** Russian human summary: "Каждый вторник и четверг, 09:00". */
  describe(rule: SeriesRule): string;

  /** Set UNTIL just before a key — the series-split primitive of §3.3. */
  withUntilBefore(rule: SeriesRule, key: FloatingDateTime): string;
}
```

DST tests that must exist before this is considered done:

- spring-forward gap (`02:30` on a day where `02:00–03:00` does not exist) →
  pushed forward, `compatible`;
- autumn fall-back overlap → the **earlier** instance;
- a weekly 09:00 series crossing both transitions stays 09:00 local throughout;
- a 60-minute event starting at 23:30 on a transition night ends at 00:30 local;
- a `BYMONTHDAY=31` rule silently produces no February occurrence;
- an `Europe/Moscow` series with dates in 2013 resolves at UTC+4, not UTC+3.

### The restricted rule builder

The UI may only produce these (`recurrencePresetSchema` in
`@family/shared/contracts/tasks`):

| Preset             | Compiles to                             |
| ------------------ | --------------------------------------- |
| `daily`            | `FREQ=DAILY;INTERVAL=n`                 |
| `weekly`           | `FREQ=WEEKLY;INTERVAL=n;BYDAY=MO,WE`    |
| `monthly_day`      | `FREQ=MONTHLY;INTERVAL=n;BYMONTHDAY=d`  |
| `monthly_last_day` | `FREQ=MONTHLY;INTERVAL=n;BYMONTHDAY=-1` |

`ends` adds `COUNT=n` or `UNTIL=<utc>`. `weekly` with `interval: 1` is "specific
weekdays"; `monthly_day` with `interval: n` is "every N months". The `raw`
escape hatch exists for ICS import only and rejects an embedded DTSTART, because
a second anchor carrying an offset would silently beat the floating one.

A series whose stored rule does not `decompile()` is shown read-only in the UI
with its `summary`, and offers "replace the schedule" instead of "edit".

---

## 8. Route table

All routes are under `/api`. Every one declares a permission guard (D4);
`404`, not `403`, outside the caller's read scope. Visibility (`household` /
`private` / `restricted`) narrows _after_ the permission check.

### Tasks

| Method   | Path                                | Permission                 | Notes                                          |
| -------- | ----------------------------------- | -------------------------- | ---------------------------------------------- |
| `GET`    | `/tasks/series`                     | `task:read:own`/`:any`     | `taskSeriesListQuerySchema`, cursor paginated  |
| `POST`   | `/tasks/series`                     | `task:create`              | `taskSeriesCreateSchema`; materializes eagerly |
| `GET`    | `/tasks/series/:id`                 | `task:read:*`              | includes `recurrence.summary` + `preset`       |
| `PATCH`  | `/tasks/series/:id`                 | `task:update:own`/`:any`   | `taskSeriesUpdateSchema`, requires `scope`     |
| `DELETE` | `/tasks/series/:id`                 | `task:delete:own`/`:any`   | `taskSeriesDeleteSchema`, requires `scope`     |
| `POST`   | `/tasks/series/:id/archive`         | `task:update:*`            | soft stop                                      |
| `GET`    | `/tasks/occurrences`                | `task:read:*`              | filters incl. `overdueOnly`, `assignee=me`     |
| `GET`    | `/tasks/calendar`                   | `task:read:*`              | `calendarRangeSchema`, local-date window       |
| `GET`    | `/tasks/today`                      | `task:read:own`            | dashboard payload, one round trip              |
| `GET`    | `/tasks/occurrences/:id`            | `task:read:*`              |                                                |
| `PATCH`  | `/tasks/occurrences/:id`            | `task:update:*`            | overrides / move; sets `is_exception`          |
| `POST`   | `/tasks/occurrences/:id/complete`   | `task:complete:own`/`:any` | idempotent; books the ledger                   |
| `POST`   | `/tasks/occurrences/:id/uncomplete` | `task:complete:any`        | compensating ledger entries                    |
| `POST`   | `/tasks/occurrences/:id/skip`       | `task:update:*`            | optional EXDATE                                |
| `POST`   | `/tasks/occurrences/:id/assign`     | `task:assign:any`          | `assigned_via = 'manual'`                      |
| `POST`   | `/tasks/occurrences/:id/claim`      | `task:complete:own`        | unassigned only; `'claimed'`                   |

### Events

| Method   | Path                             | Permission                   | Notes                                     |
| -------- | -------------------------------- | ---------------------------- | ----------------------------------------- |
| `GET`    | `/events/series`                 | `event:read`                 |                                           |
| `POST`   | `/events/series`                 | `event:create`               | `attendeeIds` fanned out                  |
| `GET`    | `/events/series/:id`             | `event:read`                 |                                           |
| `PATCH`  | `/events/series/:id`             | `event:update:own`/`:any`    | requires `scope`; 409 on generated series |
| `DELETE` | `/events/series/:id`             | `event:delete:own`/`:any`    | requires `scope`                          |
| `GET`    | `/events/occurrences`            | `event:read`                 |                                           |
| `GET`    | `/events/calendar`               | `event:read`                 | `includeTasks` folds in the task feed     |
| `GET`    | `/events/today`                  | `event:read`                 | agenda strip                              |
| `PATCH`  | `/events/occurrences/:id`        | `event:update:*`             | overrides / move / resize                 |
| `POST`   | `/events/occurrences/:id/cancel` | `event:delete:*`             | `status = 'cancelled'`                    |
| `PUT`    | `/events/occurrences/:id/rsvp`   | `event:read`                 | own answer; `:any` for somebody else      |
| `PUT`    | `/events/series/:id/attendees`   | `event:update:*`             | scoped fan-out                            |
| `GET`    | `/events/feed.ics`               | signed token, `public: true` | read-only ICS export                      |

### Chores

| Method   | Path                            | Permission               | Notes                                         |
| -------- | ------------------------------- | ------------------------ | --------------------------------------------- |
| `GET`    | `/chores/rotations`             | `task:read:any`          |                                               |
| `POST`   | `/chores/rotations`             | `task:assign:any`        |                                               |
| `PATCH`  | `/chores/rotations/:id`         | `task:assign:any`        | `reassignFuture` off by default               |
| `DELETE` | `/chores/rotations/:id`         | `task:assign:any`        | 409 while series reference it                 |
| `GET`    | `/chores/rotations/:id/preview` | `task:read:any`          | auditable dry run of the next N picks         |
| `GET`    | `/chores/blackouts`             | `task:read:own`/`:any`   |                                               |
| `POST`   | `/chores/blackouts`             | `task:update:own`        | another user needs `task:assign:any`          |
| `DELETE` | `/chores/blackouts/:id`         | `task:update:own`/`:any` |                                               |
| `GET`    | `/chores/swaps`                 | `task:read:own`          | `direction=incoming\|outgoing\|all`           |
| `POST`   | `/chores/swaps`                 | `task:update:own`        | one pending per occurrence (409)              |
| `POST`   | `/chores/swaps/:id/respond`     | `task:update:own`        | accept ⇒ reassign                             |
| `POST`   | `/chores/swaps/:id/cancel`      | `task:update:own`        | asker only                                    |
| `GET`    | `/chores/kudos`                 | `kudos:give`             |                                               |
| `POST`   | `/chores/kudos`                 | `kudos:give`             | 409 on the unique `(from, occurrence, emoji)` |

---

## 9. Left for implementers

- `src/core/recurrence/engine.ts` — the adapter above, plus its DST test suite.
- `materializer.service.ts`, `rotation.service.ts` (the debt calculation and the
  tie-break chain), the four mutation paths, and the swaps service.
- The BullMQ jobs: `scheduling:materialize`, `scheduling:auto-cancel`,
  `scheduling:birthday-sync`, `chores:expire-swaps`.
- Repository-level resolution of `COALESCE(override, series_value)` so nothing
  above the repository ever sees a raw override column.
- `task_series.rotation_id` has **no** database foreign key (it would make the
  tasks ⇄ chores import cycle bidirectional); the service layer must validate it.
