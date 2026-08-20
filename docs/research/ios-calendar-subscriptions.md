# iOS Calendar subscriptions (`webcal://` / ICS feeds) — binding reference

Verified 2026‑08‑20 against **our own production access log**, not against
documentation: the observations below come from `iOS/26.6 (23G71)
dataaccessd/1.0` fetching `https://nezo.su/api/events/feed.ics`. Platform
baseline: iOS/iPadOS 26.6.

Anything marked **HARD RULE** is a platform behaviour, not a preference.
Violating one produces the single most confusing calendar bug there is: the
event is in the feed, the feed is correct, and the phone shows nothing.

## 1. The diagnosis fork — always do this first

"I added an event and it never appeared on my iPhone" is two completely
different bugs and they need opposite fixes:

- **The event is not in the document.** Visibility filter, attendee scoping, an
  unmaterialised occurrence, a date window that excludes it.
- **The document is fine and the phone never asked again.** Far more common.

Never guess. Fetch the feed with the user's own token and count:

```bash
curl -s -D- "https://<host>/api/events/feed.ics?token=<token>" -o /tmp/f.ics
grep -c BEGIN:VEVENT /tmp/f.ics
```

If the event is there, it is a refresh problem, and the next place to look is
the **access log**, not the code. Count `feed.ics` requests per day: a healthy
subscription polls on a visible cadence. One fetch in a week means the phone
subscribed once and went to sleep.

Beware one trap while reading the log: `Content-Length: 388`-ish (an empty
`VCALENDAR` is roughly 350–420 bytes for us) is the signature of a feed with
**zero** events. Caddy's `encode` will not compress a body under 512 bytes, so
an uncompressed small response in the log is itself a hint that the calendar was
empty at that moment.

## 2. HARD RULE — iOS sends `If-Modified-Since`, never `If-None-Match`

This is the one that cost us a day.

Every conditional request `dataaccessd` made in our production log carried
`If-Modified-Since`. **Not one carried `If-None-Match`.** A feed that ships a
beautifully correct `ETag` and no `Last-Modified` therefore has a 304 path that
the only client that matters can never reach, and re-sends the whole document on
every single poll.

Worse: with no `Last-Modified` to echo, iOS synthesises one from our **`Date`
response header** and sends _that_ back as `If-Modified-Since`. The client was
inventing a validator because we had not given it one.

**Required:** send both `ETag` and `Last-Modified`, and honour both requests.
Per RFC 9110 §13.1.3, when `If-None-Match` is present, `If-Modified-Since` is
ignored outright — not used as a tiebreak.

### `Last-Modified` must not be derived from the newest event

The obvious implementation — `max(updatedAt)` over the events in the document —
is **wrong and silently loses deletions**. Delete the most recently edited event
and that maximum jumps _backwards_; the phone's `If-Modified-Since` is now newer
than it; we answer 304; the deleted event stays on the phone forever. A
content-derived timestamp is only safe for a document that never shrinks.

Time the _change_, not the content: remember the last ETag seen for a feed and
the moment it was first seen, and mint a new timestamp — at least one second
after the previous one, because HTTP dates have one-second resolution — whenever
the ETag differs. Additions, edits and deletions all move it forward. See
`createFeedFreshness` in `backend/src/modules/events/ics.service.ts`.

## 3. HARD RULE — `REFRESH-INTERVAL` is read when the user subscribes

iOS maps `REFRESH-INTERVAL;VALUE=DURATION` / `X-PUBLISHED-TTL` onto the
subscription's **«Обновление» (Auto-Refresh)** setting at subscribe time. Its
buckets are: every 5 min, 15 min, 30 min, hourly, daily, weekly, manually — so
advertise a value that lands _on_ a bucket rather than between two.

**Changing the interval later does not retune an existing subscription.** The
value was copied into the subscription record on the phone when it was created.
An owner who subscribed while the feed said `PT1H` keeps hourly refresh no
matter what the feed says today. To pick up a new interval they must either
change Auto-Refresh by hand, or remove and re-add the subscription:

> Настройки → Приложения → Календарь → Учётные записи → Подписные календари →
> «<имя календаря>» → Обновление.

Emit whole hours as `PT1H`, not `PT60M`. Both are legal and identical; the hour
form is what Apple's own published feeds use and what pattern-matching clients
recognise. Emit `REFRESH-INTERVAL` **and** `X-PUBLISHED-TTL` with the _same_
value — Apple reads the former, Outlook and several others read only the latter,
and a feed advertising two different periods gets whichever one was parsed.

We ship **`PT15M`**. See the note on `FEED_REFRESH_MINUTES`.

## 4. The advertised interval is a ceiling, not a promise

Even at `PT15M`, iOS refreshes subscribed calendars from a **background**
daemon. Observed in our log: a 14-minute gap in the evening, then **6 h 41 min**
of silence overnight while the phone was idle, then a fetch at 08:12 the next
morning. That is normal and there is nothing a server can do about it.

Consequences to design around:

- **An overnight edit will not be on the phone until morning.** Push
  notifications, not the calendar feed, are the channel for anything urgent.
- Low Power Mode, no network, and a locked idle phone all suppress refreshes.
- **Settings → Общие → «Обновление контента» (Background App Refresh)** and
  **Настройки → Приложения → Календарь → Учётные записи → Загрузка данных**
  (Fetch New Data) both gate it. A user on "Вручную" (Manually) will never see
  an automatic update at all.
- Pulling down to refresh in the Calendar app forces an immediate fetch. That is
  the correct thing to tell a user who is waiting on a specific event.

## 5. `webcal://` vs `https://`

**HARD RULE — hand the user a `webcal://` link for the tap-to-subscribe path.**
Tapping an `https://…​.ics` link in Safari on iOS _downloads the file once_: the
events appear, they never update, and it looks exactly like a broken
subscription. `webcal://` opens Calendar's subscribe sheet instead.

Pasting an `https://` URL into **Настройки → … → Подписной календарь** is fine —
that field creates a real subscription. So: `webcal://` for links, `https://`
for copy-paste, and say which is which.

## 6. Things that are _not_ the problem (checked, cleared)

- `Cache-Control: private, max-age=0, must-revalidate` is correct. It forces
  every poll to revalidate rather than letting the phone's cache answer.
- Caddy's `encode` rewrites nothing that matters. It may add or strip the `W/`
  weakness prefix, which is why `If-None-Match` must use RFC 9110 §8.8.3.2
  **weak** comparison and not string equality.
- Our request logger strips query strings on purpose (a feed token was once
  logged in full). The Caddy access log still has the full URI — which is where
  the User-Agent evidence in this document came from. Do not "fix" the pino
  serializer.
- A UID derived from the occurrence **row id** would make every "edit all
  future" split look like delete-and-recreate to Calendar, losing the user's
  local alerts. Ours is derived from `seriesId` + `occurrenceKey`; keep it that
  way.
