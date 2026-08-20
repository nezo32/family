# Media attachments — photo, video and audio on the wall

> Owner request: «должна быть возможность добавлять фото видео аудио к посту».
>
> Read with `docs/DECISIONS.md` (D4, D12, D13), `docs/design/DESIGN.md` §D7 and
> the avatar pipeline in `backend/src/modules/storage/`, which this extends
> rather than replaces.

The bytes come in through one door, are identified by their **magic bytes**, are
stored in the private RustFS bucket under a key we generate, and come back out
through one authenticated route. A post or a comment references an **id we
minted** — never a URL, never a filename, never a bucket path.

---

## 1. What we accept, and why the list is short

| Kind      | Accepted                                  | Why                                                                                                                                             |
| --------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Photo** | `image/jpeg` `image/png` `image/webp`     | The three a `<canvas>` can re-encode to, so the client can downscale anything it can decode before uploading. Same list as avatars.             |
|           | `image/gif`                               | One magic-byte check, renders in an `<img>`, carries no script. Refusing «смешная гифка» would be a security answer to a question nobody asked. |
| **Video** | `video/mp4`                               | The universal container.                                                                                                                        |
|           | `video/quicktime`                         | **An iPhone records `.mov` and a PWA cannot change that.** See §2.                                                                              |
| **Audio** | `audio/mp4` (M4A/AAC), `audio/mpeg` (MP3) | The two Safari plays without argument.                                                                                                          |

The rule that produced this list is **"every device in this family can play
it"**, not "some browser can produce it". That is why the following are refused,
each with its own Russian sentence in `error.details.file` telling the member
what to do instead:

| Refused                                  | Reason                                                               |
| ---------------------------------------- | -------------------------------------------------------------------- |
| **SVG**                                  | A document that executes. Same reason avatars refuse it.             |
| **HEIC / HEIF / AVIF**                   | No browser but Safari renders them, and we cannot transcode. See §2. |
| **WebM / Ogg / Opus**                    | A recording no iPhone in this family could play back.                |
| **WAV**                                  | Uncompressed audio — ten times the bytes for the same voice message. |
| **AVI, PDF, ZIP, anything unrecognised** | Not a photo, a video or a recording.                                 |

`packages/shared/src/contracts/wall.ts` is the single source of that list; the
backend imports it, so the composer's `accept=` attribute and the server's
allowlist cannot drift.

### The magic-byte rule, restated for containers

`backend/src/modules/storage/media.ts`. The declared `Content-Type` and the
filename are **hints we may reject on, never values we store**: the stored
`Content-Type` — the one echoed on every `GET` from our own origin — is derived
from the bytes. An HTML file called `видео.mp4` is a **415**.

Two things here are genuinely new versus `image.ts`:

- **A container is not a type.** `ftyp` at offset 4 means "ISO base media file",
  which covers MP4, QuickTime, M4A **and HEIC**. The brand list separates them,
  and whether a file is video or audio is decided by its **tracks** (`hdlr` =
  `vide` / `soun`), not by its brand — an `.m4a` written with brand `isom` must
  not be served as a video that draws nothing.
- **HEIC has to be recognised in order to be refused well.** Without the brand
  table an iPhone photo would sniff as `video/mp4` and be stored as a video that
  never plays.

---

## 2. iOS: HEIC and `.mov`

**HEIC → reject, with instructions.** Safari usually transcodes HEIC to JPEG on
its way through a file input, so most iPhone uploads never hit this path; the
ones that do (Files app, "Keep Original") get a 415 whose Russian text names
«Настройки → Камера → Форматы → Наиболее совместимые» and points at the client's
own canvas re-encode. Safari _can_ decode HEIC in a canvas, so the PWA can fix
this locally on the one platform where it happens.

**`.mov` → accept as `video/quicktime`.** Rejecting it means the family's main
camera cannot post video at all. The bytes are H.264/AAC in a QuickTime
container in practice, which every browser the family uses plays.

**Transcoding → no.** ffmpeg on this VDI would mean a ~150 MB layer in the
image, a CPU-bound job queue, and one core of a box that already runs Postgres,
Redis, RustFS and the API competing with a family trying to load their calendar.
A 3-minute 1080p H.264 transcode is minutes of CPU, not seconds. The cost is not
worth what it buys: an allowlist of two containers, both of which iPhones,
Android phones and desktop browsers already play.

_If that ever changes_ — say a family member starts posting 4K HEVC that Chrome
on Windows will not play — the seam to use is a BullMQ job that rewrites the
object and updates the row's `content_type`/`object_key`, not an inline
transcode on the request path.

---

## 3. Limits, and why the numbers are these numbers

`MEDIA_LIMITS` in `packages/shared/src/contracts/wall.ts`.

| Kind  | Size        | Duration   |
| ----- | ----------- | ---------- |
| Photo | **10 MiB**  | —          |
| Video | **100 MiB** | **3 min**  |
| Audio | **25 MiB**  | **10 min** |

Plus **10 attachments** per post or comment, and a decompression-bomb guard at
12 000 px per side / 60 MP.

The binding constraint is **not** disk. It is that `infra/scripts/backup.sh`
tars and gzips the **entire RustFS volume every night** — so every byte accepted
here is re-read, re-compressed and re-transferred over the network every night
for as long as the family keeps it. And «Очистить доску» is a horizon rather
than a delete (§D7.11), so nothing ever shrinks on its own.

- **Photo 10 MiB** takes a 12 MP phone JPEG (3–5 MB) straight off the camera with
  headroom, without pretending a 60 MP export is a snapshot.
- **Video 100 MiB / 3 min.** iPhone 1080p30 is ≈ 60 MB per minute, so in practice
  the size cap binds on a long clip and the duration cap binds on a short 4K one.
  Both are published; the refusal names whichever was actually hit. Three minutes
  is a birthday song, a first bike ride, a school concert item — not a film.
- **Audio 25 MiB / 10 min** is a voice message with a ceiling that stops an album
  arriving one track at a time.

### The limit is legible, not a mystery 413

Three mechanisms, in order of when they fire:

1. **Published in the contract.** `MEDIA_LIMITS` is imported by both sides, so the
   composer can refuse a file _before_ uploading it and use the same numbers.
2. **The refusal names the number, in Russian, in `error.details.file`** —
   «Видео весит 140 МБ, а больше 100 МБ мы не принимаем.» `AppError.message`
   stays English/developer-facing per D7; the actionable sentence rides in
   `details`, exactly as `assertEntityType` does.
3. **Duration is measured, not assumed.** A file whose duration cannot be read is
   **rejected**, because an unmeasurable duration is an unenforceable limit —
   "probably short enough" is how a 40-minute file ends up in every nightly
   backup forever.

### Reading dimensions and duration without a decoder

`backend/src/modules/storage/media.probe.ts` parses container headers by hand:
PNG `IHDR`, GIF's screen descriptor, WebP `VP8`/`VP8L`/`VP8X`, JPEG's segment
chain to `SOFn`, ISO-BMFF `mvhd`/`tkhd`/`hdlr`, and MP3 (ID3v2 skip → frame
header → `Xing`/`VBRI`, else CBR arithmetic). No dependency, no decode, no frame
buffer — a decompression bomb is a number we reject rather than memory we
consume.

Two details that would otherwise be silent bugs:

- **The display matrix is applied.** An iPhone records _landscape_ pixels plus a
  90° rotation matrix; reading `tkhd` width/height without the matrix boxes every
  portrait clip on its side.
- **`moov` is read wherever it is**, including after `mdat`, which is where a
  phone recording puts it. This is the reason the upload spools to a seekable
  temp file instead of a buffer.

Dimensions are **required** for image and video, because §D7.6 asks the card to
set `aspect-ratio` from server-supplied numbers so nothing in the feed reflows on
load.

---

## 4. The attachment model

One table: `media_attachments` (in `backend/src/modules/wall/wall.schema.ts`,
because `db/schema.ts` is the lead's barrel and the attachment pointer is a wall
concept — the storage module owns the _objects_).

```
id, uploader_id, kind, content_type, object_key (unique), byte_size,
width, height, duration_ms,
entity_type, entity_id, sort_order, attached_at,
created_at, updated_at, deleted_at
```

**One table, not two.** A join table buys reuse (one object on several posts) and
costs a join on every read plus a second orphan class. Nothing in this app reuses
an object: there is no library screen, no picker over past uploads, no
de-duplication. And a join table with exactly one row per asset is state that can
disagree with itself — two link rows make "delete the object when it is detached"
ambiguous, two `sort_order`s make the draw order a question.

**Ordering** is `sort_order`, assigned from the position in the request's
`attachmentIds` array. The array _is_ the ordering; there is no `sortOrder` on the
wire, because two clients cannot disagree with an array.

**`entity_type` is narrower than `COMMENTABLE_ENTITY_TYPES`**: only `post` and
`comment` (`ATTACHABLE_ENTITY_TYPES`). Tasks, events and goals get media through
their _comment threads_ for free, and no module outside the wall has to learn
about objects.

### Attach-then-post

**Upload happens before the post exists.** `POST /api/media` returns an id; the
composer holds it; `POST /api/wall/posts` sends `attachmentIds`. A row with
`entity_id IS NULL` is a **draft**: readable only by its uploader, listed
nowhere, swept after 24 hours.

Why this way round:

- The note appears complete the moment it is posted — no "uploading…" placeholder
  visible to the family, which matters because post creation is optimistic on the
  client (§D7).
- A failed upload fails **before** anything is published, where the writer can see
  it and retry.
- The alternative (create the post, then attach) publishes a half-formed note to
  everyone and _still_ leaks an object when the second call fails.

The orphan it creates is exactly one: a draft nobody posted. That is a single
indexed predicate (`entity_id is null and created_at < cutoff`) and the sweep's
first population.

### Delete semantics — three different things, deliberately

| What happened                                        | Rows                   | Objects                                   |
| ---------------------------------------------------- | ---------------------- | ----------------------------------------- |
| **«Очистить доску»** (the horizon, §D7.11)           | untouched              | **untouched** — nothing is deleted, ever  |
| Post or comment deleted (soft)                       | soft-deleted (cascade) | **kept** for `DETACHED_GRACE_DAYS` (30)   |
| Photo edited off a post (`attachmentIds` without it) | hard-deleted           | **removed immediately**, after the commit |
| Draft discarded (`DELETE /api/media/:id`)            | hard-deleted           | **removed immediately**                   |
| Draft abandoned                                      | swept after 24 h       | removed by the sweep                      |

The distinction that matters: **who decided.** A person editing one photo out of
their own note is deliberate and immediate — the same rule as replacing an
avatar. A moderator soft-deleting somebody else's note is exactly the case where
«верните, я не то удалил» has to be answerable, so the bytes wait out the grace
period.

**The horizon is not an input to any of this.** A cleared wall is hidden, not
deleted; a sweep keyed off `wall_cleared_at` would turn a reversible product
decision into irreversible data loss. There is a test for precisely that.

### Orphans, and what handles each

| Orphan class                             | Handled by                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Draft never posted                       | `sweepOrphanedMedia`, 24 h                                                                                     |
| Row detached by a cascade                | `sweepOrphanedMedia`, 30 days                                                                                  |
| Post deleted → its own media             | `detachAllFrom(tx, 'post', id)` in `deletePost`, same transaction                                              |
| Post deleted → media on its **comments** | `deleteCommentsFor` now returns the comment ids and detaches their media in the same transaction               |
| Comment deleted individually             | `deleteComment` detaches in the same transaction                                                               |
| Object written, row insert failed        | the upload path removes the object it was about to reference (an object with no row is invisible to the sweep) |

The polymorphic pointer has no foreign key, so **none of this is automatic** —
the same contract `deleteCommentsFor` already carries. Any future module that
lets media hang off something new must call `detachAllFrom` inside its own delete
transaction.

### 4.1 The schedule

`maintenance.sweep-media`, `20 5 * * *`, registered in
`modules/storage/media.jobs.ts` and imported by `modules/jobs.ts`. What each
part of that was chosen against:

**Daily.** The shorter of the two windows is 24 hours, and the cutoffs live in
the queries rather than in the schedule — a draft gets its full day whatever the
cadence. Anything finer buys nothing anybody can perceive; anything coarser
leaves bytes lying about for a multiple of a day for no reason.

**05:20, not the small hours everything else uses.** This is the only scheduled
job that deletes from the object store, and the nightly backup **mirrors that
store's live volume** — `infra/scripts/vdi-bootstrap.sh` installs it at 03:30,
while its own header and `docs/DEPLOYMENT.md` §8 both say 03:17 (worth
reconciling; the owner of `infra/` has that file). Removing objects while rsync
walks the tree is how a mirror ends up holding half an object. BullMQ evaluates
a cron pattern in the **process** timezone, which compose sets to
`Europe/Moscow`, and host cron need not agree — so the four readings of "05:20
here vs 03:17–03:30 there" put the sweep between 57 and 123 minutes clear of the
backup, never inside it. `:20` also dodges the half-hourly OAuth prune on the
same single-slot maintenance queue.

**A bounded drain loop, not one batch.** `sweepOrphanedMedia` takes at most
`batch` (200) rows of each class per call. That is the right unit of work and
the wrong nightly ceiling — the first night after this ships meets everything
that accumulated while there was no schedule — so the handler repeats while a
pass still reclaims something, up to 25 passes. A pass that reclaims nothing
ends it, which is also what a dead store produces.

**Retention, checked against the backups.** `BACKUP_KEEP` defaults to 14, so the
oldest restorable pair is ~14 nights old, and `DETACHED_GRACE_DAYS` (30)
comfortably exceeds it: a restore from any surviving backup finds its objects
still in the mirror. `DRAFT_TTL_HOURS` (24) is far _shorter_ than 14 days and
that is fine, because it only ever applies to rows with no `entity_id` — a draft
is invisible to every screen, so a restored draft row whose bytes were reclaimed
renders nothing and breaks no card. No number needed changing; the invariant to
keep is **`DETACHED_GRACE_DAYS > BACKUP_KEEP`**, and it is what would break if
either were tuned in isolation.

One trap in that invariant, recorded rather than fixed here: `backup.sh` now
enforces it from its own side, reading **`MEDIA_ORPHAN_TTL_DAYS` (default 30)**
from `.env` and clamping `BACKUP_KEEP` below it. The backend does not read that
variable at all — its number is the `DETACHED_GRACE_DAYS` constant. The two
agree at 30 today, so nothing is wrong; but setting `MEDIA_ORPHAN_TTL_DAYS` in
`.env` moves only the backup's half of the invariant and silently breaks it.
`docs/DECISIONS.md` asks for a boot assertion, which needs the constant promoted
to config first — the same promotion §8 already lists for the size limits, and
the right pass to do both in.

**When the store is unreachable.** The row survives, always. Each removal that
throws leaves its row for the next run and is counted in `SweepResult.failed`;
the handler then throws, so the run is not recorded as clean — BullMQ retries it
and, if the store is still down, parks it in the failed set where a human can
see it. The reverse (row gone, bytes stranded under a key only that row knew)
would be unrecoverable, which is why the object goes first. When storage is not
configured at all the handler returns immediately rather than warning once per
candidate row every night.

---

## 5. The API

| Method   | Path             | Access                           | Notes                                                            |
| -------- | ---------------- | -------------------------------- | ---------------------------------------------------------------- |
| `POST`   | `/api/media`     | `comment:create`                 | multipart, one part named `file`. 201 → `MediaAttachment`        |
| `DELETE` | `/api/media/:id` | `comment:create`                 | your own **draft** only; 409 if attached, 404 if somebody else's |
| `GET`    | `/api/media/:id` | `member:read` + `notFoundOnDeny` | streams; `Range`, `If-None-Match`                                |

`comment:create` for the write: it is the broadest "may add something to the
family's shared space" permission — everyone from `child` up, no `guest` —
and a photo on a reply is the same act as a photo on a note.

### Read access: a photo is exactly as private as the thing it hangs on

`media.access.ts` delegates to `assertCanReadEntity`, so a photo on a comment on
a private goal is readable exactly when that goal is, and if the goal's rule
changes this follows it for free. A comment resolves in two hops (comment exists
→ comment's own target readable). A draft is uploader-only. **Every refusal is a
404**, never a 403 — this is a `GET`, and a 403 answers the question it refused
to answer (D4).

### Serving headers

Same shape as avatars: `private, max-age=31536000, immutable` (the id never
changes content), the store's `ETag`, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; sandbox`, `Vary: authorization`,
and a **generated** `Content-Disposition: inline; filename="<id>.<ext>"`.

### Where video stops being a bigger photo

1. **`Range` is not optional.** Safari opens a `<video>` with `Range: bytes=0-1`
   and gives up if it gets a `200` with the whole file. The header is passed to
   the store (which already implements RFC 9110 correctly — re-deriving the
   arithmetic here would be a second implementation to keep right) and the answer
   is a real `206` with `Content-Range`. An unsatisfiable range is a `416` with
   `Content-Range: bytes */<size>`; that status is written out directly because
   416 has no member in the shared `ErrorCode` table and a `<video>` reacts to
   the status, not the body.
2. **The 304 path and the range path are exclusive.** A conditional `HEAD` before
   every ranged read would be a wasted round trip on every seek, and a `304` is
   the wrong answer to a `Range` request. `If-None-Match` is honoured only for a
   full read.
3. **Nothing is buffered, in either direction.** The upload spools to
   `os.tmpdir()` and is streamed to the store with an explicit `Content-Length`
   (`Storage.putStream`); the download is the store's stream piped to the socket.
   A 100 MB video never exists in this process's memory — which on this VDI, with
   Postgres, Redis and RustFS alongside, is the difference between "slow evening"
   and OOM.

### Ordering inside the upload path

1. spool to disk — bounded memory, and seekable so the probe can find `moov`
2. sniff, probe, apply limits — the security gate and the size gate
3. write the object
4. insert the row (a draft)

Every other ordering loses data instead of leaking a few kilobytes. A failure at
step 4 removes the object it was about to reference.

---

## 6. Live sync (D12)

`ROUTE_DOMAINS` gains **`['/api/media', []]`** — classified, and classified as
changing nothing another client can see.

An upload is a private draft: no `entity_id`, no screen lists it, nobody else can
fetch it. It becomes visible when the post or comment carrying its id is
written — and _that_ write already bumps `wall`. Bumping `wall` per upload would
make every other phone in the house refetch the feed once per file while somebody
is still choosing photos, and show them nothing new each time. `DELETE
/api/media/:id` is the same act in reverse and only ever reaches a draft; media
on a live post is changed through `PATCH /api/wall/posts/:id` or `PATCH
/api/comments/:id`, both already `wall`.

The coverage guard in `modules/changes/changes.test.ts` enforces that this row
exists at all: `[]` is a decision, a missing entry is a bug.

---

## 7. Backups

**Media is already covered, with no change to `infra/scripts/backup.sh`.** The
objects archive tars the whole RustFS volume (`tar -cf - -C /data .`), so
`media/…` rides along with `avatars/…` automatically, and the existing
write-once consistency argument holds for media too: an object is never edited in
place — a replacement is a new key plus a delete.

Three things the owner of `infra/` should act on **before** this ships, none of
which block it:

1. **Rotation.** `backup_object_storage()` deliberately does not rotate its own
   archives ("fold `${S3_BUCKET}-*.tar.gz` into the rotation block when it
   lands"). With avatars that was harmless — a few dozen kilobytes a night. With
   video it is not: an unrotated nightly full archive of a growing bucket fills
   the VDI's disk on a schedule. This is now the highest-value line in that file.
2. **`gzip -9` on already-compressed bytes.** JPEG, MP4 and MP3 do not compress;
   `-9` spends real CPU nightly for ~0 gain. `gzip -1` (or no compression for the
   objects archive) is strictly better once media is in the volume.
3. **The log line counts avatars only** — `grep -c '^\./<bucket>/avatars/.*/xl\.meta$'`
   — so a run that captured 40 videos will report "0 avatar object(s)". Cosmetic,
   but it is the line a human reads at 3am to decide whether the backup is real.

Restore is unchanged: `tar -xzf` into a fresh volume. Because ids and object keys
live in Postgres and the objects live in the bucket, the two archives must be
restored as a **pair** — they already share a `STAMP` and a `latest-*` symlink.

---

## 8. Follow-ups outside this pass's scope

- ~~**The sweep needs a schedule.**~~ **Done** — it runs nightly as
  `maintenance.sweep-media`; see §4.1. The handler landed in
  `modules/storage/media.jobs.ts` rather than `modules/maintenance/`, and at
  05:20 rather than the suggested 03:35, for the reasons recorded there.
- **Config.** The limits are constants in `@family/shared` rather than env vars,
  because `core/config.ts` was outside this pass. Promoting them to
  `MEDIA_*_MAX_BYTES` is mechanical if the deployment ever wants to turn video
  down.
- **`postWritableFields.body` is no longer `nonEmptyString`.** A photo with no
  caption is a whole note, so the "body or attachments" rule moved into
  `wall.service.assertPostHasContent` (a `superRefine` would turn the schema into
  a `ZodEffects` and the PWA composer builds its form with
  `createPostSchema.omit(...)`, which only a `ZodObject` has). The composer's own
  `submitDisabled={body.trim().length === 0}` should become
  `… && attachments.length === 0` when the design pass lands.
- **`attachments` is `.optional()` in the response contracts**, not
  `.default([])`, so the PWA's optimistic `const draft: PostResponse = {…}` keeps
  compiling. The server always sends the array. Promote it to `.default([])` in
  the same pass that adds `attachments: []` to that draft.
