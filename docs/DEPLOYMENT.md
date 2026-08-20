# Deployment — nezo.su (193.124.180.31)

Everything you need to acquire, where to put it, and how to run it.

**Target as probed:** Ubuntu 22.04.5 LTS · Docker 28.3.0 · Compose v2.37.3 ·
6.8 GB RAM · **14 GB free disk** · ports 80/443 free.
The box already runs Amnezia WireGuard on UDP 31150 and 42965 — the family
stack touches neither, and nothing here restarts them.

DNS is already correct: `nezo.su` → `193.124.180.31`. Caddy can get a
certificate the moment port 80 is reachable.

---

## 1. Secrets you generate yourself

No account, no third party. Run these locally and keep the output.

```bash
# Four independent 48-byte secrets. Do NOT reuse one value for several.
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -base64 48   # COOKIE_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -base64 24   # POSTGRES_PASSWORD
openssl rand -base64 24   # REDIS_PASSWORD

# Web Push keypair
pnpm --filter @family/backend run gen:vapid
```

`COOKIE_SECRET` also derives the calendar-feed HMAC key, so changing it later
invalidates every family member's ICS subscription URL. Set it once.

`VAPID_*` is likewise once-only in practice: rotating it invalidates **every**
push subscription, and on iOS re-subscribing needs a fresh user gesture from
each person — treat a rotation as a migration, not a config tweak.

---

## 2. Accounts and tokens you must acquire

### 2.1 Google — free, ~10 minutes

1. <https://console.cloud.google.com> → create a project (e.g. `family`).
2. **APIs & Services → OAuth consent screen** → User type **External**.
   Fill in app name, your email, and add the family's Google addresses under
   **Test users**.
   **Leave it in "Testing" — do not publish.** A Testing app works indefinitely
   for listed test users and skips Google's verification review entirely. Only
   publish if you ever exceed 100 users, which you will not.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorized JavaScript origins: `https://nezo.su`
   - Authorized redirect URI: `https://nezo.su/api/auth/google/callback`

**You get:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

### 2.2 Telegram — free, ~5 minutes

1. Message **@BotFather** → `/newbot` → pick a name and a username.
2. `/setdomain` → select the bot → send `nezo.su`.

   **Not optional, and it is the step everyone skips.** Without it every sign-in
   attempt dies on a bare white page reading **«Bot domain invalid»**, served
   from `oauth.telegram.org` — our callback is never reached, so nothing shows
   up in our logs unless we go looking. Send the **host only**: no `https://`,
   no `www.`, no port, no trailing slash, and it must equal the host of
   `APP_PUBLIC_URL` exactly. Since the app preflights this,
   `/api/auth/telegram/start` now logs the origin it sent and bounces the user
   back to `/login` with a Russian explanation instead.

   To check the current state without a browser:

   ```sh
   curl -s "https://oauth.telegram.org/auth?bot_id=<token prefix before the colon>&origin=https://nezo.su&embed=1" | head -c 60
   ```

   `Bot domain invalid` means unregistered or registered to a different domain;
   an HTML page means it is set correctly.

3. **Client Secret — open @BotFather _as a mini app_, not as a chat.** Tap the
   menu/attachment button on the @BotFather chat to launch the mini app, select
   the bot, then select **Login Widget**. That screen is the only place the
   **Client ID** and **Client Secret** are shown. There is no
   `Bot Settings → Web Login / OAuth` menu item — that path is from an older
   BotFather and no longer exists.

   Copy the Client Secret into `TELEGRAM_CLIENT_SECRET`. It is **not** the bot
   token and is not derivable from it.

   **`TELEGRAM_CLIENT_SECRET` is required, not optional.** `/auth/:provider/start`
   is OIDC-only — it does **not** fall back to the Login Widget or Mini App
   flows. Those two live behind their own endpoints
   (`POST /api/auth/telegram/widget`, `POST /api/auth/telegram/init-data`) and
   nothing routes a browser sign-in into them. Telegram's discovery document
   advertises only `client_secret_basic` and `client_secret_post` — never
   `none` — so a token exchange without a secret cannot succeed. With the
   variable empty the app now refuses at `/start`, before the redirect, rather
   than after the user has already approved the login.

4. **Allowed URLs — on the same Login Widget screen, register both:**

   ```
   https://nezo.su
   https://nezo.su/api/auth/telegram/callback
   ```

   The origin alone is not enough. Telegram happily serves the consent page for
   an **unregistered `redirect_uri`** and only rejects it _after_ the user taps
   «Accept», so the symptom is a login that looks fine right up until the last
   step. Register the redirect URI byte-for-byte as the app sends it — scheme,
   host and path all exactly as above, no trailing slash. If you change
   `APP_PUBLIC_URL`, both entries have to be re-registered.

**You get:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (without the `@`),
and `TELEGRAM_CLIENT_SECRET`.

The bot doubles as the **second notification channel**, and it is the more
reliable of the two — `sendMessage` returns a real delivery confirmation, which
Web Push never does. Worth configuring even if nobody signs in with Telegram.

### 2.3 GHCR pull token — free, 2 minutes

The VDI pulls images from GitHub Container Registry. Either:

- **Make the packages public** (Repo → Packages → each package → Change
  visibility → Public) and the server needs no credentials at all; or
- Create a **classic PAT** with only `read:packages`, and on the server run
  `docker login ghcr.io -u nezo32 -p <PAT>`.

Public is simpler and leaks nothing — the images contain no secrets, since all
configuration is injected at runtime.

---

## 3. GitHub configuration

### 3.1 Repository **secrets**

`Settings → Secrets and variables → Actions → Secrets`

| Name                     | Value                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `DEPLOY_SSH_KEY`         | Private key that may SSH to the VDI (see §4.2). Paste the whole file including the BEGIN/END lines.            |
| `DEPLOY_SSH_KNOWN_HOSTS` | Output of `ssh-keyscan -H 193.124.180.31`. Without it the workflow falls back to trust-on-first-use and warns. |

### 3.2 Repository **variables**

`Settings → Secrets and variables → Actions → Variables`

| Name                         | Value                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `DEPLOY_HOST`                | `193.124.180.31`                                                                                                     |
| `DEPLOY_USER`                | `deploy` (or `root` — see §4.2)                                                                                      |
| `DEPLOY_PATH`                | `/opt/family`                                                                                                        |
| `DEPLOY_PORT`                | `22`                                                                                                                 |
| `APP_DOMAIN`                 | `nezo.su`                                                                                                            |
| `VITE_API_URL`               | **leave empty** — API and app share one origin. Setting `/api` here produces `/api/api/...` and breaks every screen. |
| `VITE_VAPID_PUBLIC_KEY`      | the public half from `gen:vapid`                                                                                     |
| `VITE_TELEGRAM_BOT_USERNAME` | your bot username, no `@`                                                                                            |

Note the last three are **build-time**: they are compiled into the PWA bundle,
so changing one requires a rebuild, not just a restart.

### 3.3 Environment (optional)

Create an environment named `production` if you want a manual approval gate on
deploys. `deploy.yml` is `workflow_dispatch`-only regardless — nothing reaches
the server until you deliberately run it.

`ci.yml` and `docker.yml` need nothing beyond the built-in `GITHUB_TOKEN`.

---

## 4. Server preparation

### 4.1 One-time bootstrap

```bash
scp infra/scripts/vdi-bootstrap.sh root@193.124.180.31:/tmp/
ssh root@193.124.180.31 'bash /tmp/vdi-bootstrap.sh'
```

It creates `/opt/family`, a `deploy` user in the `docker` group, a `familybackup`
user restricted to reading dumps, the backup cron entry, and a firewall that
opens 22/80/443 **while preserving the existing WireGuard UDP ports**.

### 4.2 Which SSH user should CI use?

The bootstrap creates a **`deploy`** user rather than using `root`, and puts CI's
key there.

Be clear about how much that buys, though: `deploy` is in the `docker` group,
and Docker group membership is **effectively root** — anyone in it can start a
container that mounts the host filesystem. So this is not a real privilege
boundary. What it does give you is a separate, individually revocable
credential, no password auth, and a clean audit trail — remove one line from
`authorized_keys` and CI is locked out without touching your own access. Worth
doing, but do not treat it as a sandbox.

If you would rather keep it simple, set `DEPLOY_USER=root` and skip that part;
the workflow works either way.

### 4.3 The `.env` file lives on the server, never in git

```bash
scp .env.example root@193.124.180.31:/opt/family/.env
ssh root@193.124.180.31 'chmod 600 /opt/family/.env && nano /opt/family/.env'
```

Fill in everything from §1 and §2. Set:

```
APP_PUBLIC_URL=https://nezo.su
APP_DOMAIN=nezo.su
ACME_EMAIL=<your real email>        # Caddy refuses to start without it
BOOTSTRAP_OWNER_EMAIL=<your email>  # first sign-in becomes owner, once
VITE_API_URL=                       # empty
```

`BOOTSTRAP_OWNER_EMAIL` is consumed the moment the first owner exists, so it is
safe to leave set — but clearing it afterwards costs nothing.

---

## 5. Deploying

```
GitHub → Actions → Deploy → Run workflow
```

It pulls the images tagged for that commit, runs migrations as a one-shot
container, restarts the stack, waits on `/health`, and rolls back to the
previous image tag if the health gate fails.

First deploy only, seed a starting family if you want sample data:

```bash
ssh deploy@193.124.180.31 \
  'cd /opt/family && docker compose -f infra/docker-compose.yml run --rm backend node dist/db/seed.js'
```

Then open <https://nezo.su>, sign in with the bootstrap email, and approve
everyone else from **Семья → Заявки**.

### Install on each iPhone

Push notifications do **not** work until the app is on the Home Screen — that is
an Apple platform rule, not a limitation of this app. Safari → Share → «На экран
„Домой“» → open it from the icon → then enable notifications in Настройки, and
use **«Отправить тестовое уведомление»** to confirm the whole chain.

---

## 6. Disk

14 GB free is workable but not roomy. The stack is ~1.5 GB of images plus the
database. Keep it healthy:

```bash
docker image prune -af --filter "until=720h"   # monthly
df -h /
```

**Database dumps.** The backup script keeps the newest `BACKUP_KEEP` (default
14); a family-sized dump is a few MB gzipped, so that is negligible.

**Objects.** `backups/objects/` is a mirror of the RustFS volume — **one** copy,
refreshed in place, not one per night. Budget for it as roughly the size of the
bucket:

|                    | on the VDI               |
| ------------------ | ------------------------ |
| the volume itself  | _S_                      |
| `backups/objects/` | _S_                      |
| dumps              | a few MB × `BACKUP_KEEP` |

So object storage costs 2 × _S_ on a 30 GB disk, and the ceiling is _S_ ≈ 6 GB
before it starts to hurt. Watch `du -sh backups/objects` next to `df -h /`.

> **This used to be much worse, and the fix is worth knowing about.** Until
> recently the objects were tarred whole every night into
> `backups/<bucket>-<stamp>.tar.gz`, and — as this section used to record —
> those archives were **never rotated**. They are now folded into the same
> `BACKUP_KEEP`, so any left over from that era age out on their own.
>
> But rotation alone would not have been enough. Measured on this VDI against a
> 297 MB volume of incompressible objects, which is what photographs and H.264
> are: `tar | gzip -9` took 17.2 s and produced a **300 MB** archive — gzip
> gains nothing on media, so each night's archive is the size of the whole
> bucket. Fourteen of those need the bucket to stay under ~900 MB or the disk
> fills and takes the entire stack with it. A single note may carry ten
> attachments at up to 100 MiB each, so **one post can be a gigabyte**, and
> nothing ever shrinks: a delete keeps the bytes for 30 days and a board clear
> touches no object at all.
>
> The mirror is one copy instead of fourteen, and it is updated in proportion to
> what changed rather than rewritten: the same 297 MB took 1.7 s cold and 0.68 s
> when nothing had changed.

**`BACKUP_KEEP` must stay below the media grace period.** A dump older than the
window in which the sweep collects detached attachments restores rows whose
objects are already gone — broken cards, discovered during a restore.
`backup.sh` enforces this by clamping `BACKUP_KEEP` down and saying so in the
log; it never shortens the object side, because a dump not kept costs a night of
history while an object collected early is gone for good.

> The grace period is `DETACHED_GRACE_DAYS = 30`, **hardcoded in
> `backend/src/modules/storage/media.service.ts`**. `docs/design/DESIGN.md`
> specifies it as `MEDIA_ORPHAN_TTL_DAYS` in `core/config.ts`, but the backend
> does not read that variable — so setting it in `.env` moves only the backup's
> half of the invariant. `backup.sh` therefore uses the **smaller** of the two
> and prints a loud warning if they disagree. When the constant is promoted into
> config, delete `MEDIA_OBJECT_GRACE_DAYS_FALLBACK` from `backup.sh`; nothing
> else needs to change.

The real consumer of disk is old image layers after many deploys —
`docker.yml` tags by SHA, so they accumulate.

**Timing.** The backup runs at **03:17 Europe/Moscow** (`CRON_TZ` is written
into `/etc/cron.d/family-backup`, not inherited from the host) and the media
sweep at **05:20 Europe/Moscow** (BullMQ, `backend/src/core/queue/workers.ts`;
the backend image ships no tzdata, so `date` inside it prints UTC, but Node
resolves `TZ` through ICU and its local time really is Moscow — checked on the
VDI). Two hours apart, and the mirror takes seconds, so the one job that deletes
from the volume and the one job that copies it cannot meet. The **hourly**
unclaimed-upload reaper has no window at all; that is handled by treating
rsync's exit 24 (“files vanished”) as normal rather than by scheduling.

---

## 7. Quick reference — every variable

| Variable                                                                     | Where from           | Required?                                                      |
| ---------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------- |
| `APP_PUBLIC_URL`, `APP_DOMAIN`, `ACME_EMAIL`                                 | you                  | **yes**                                                        |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD`                                        | `openssl rand`       | **yes**                                                        |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET`, `ENCRYPTION_KEY` | `openssl rand`       | **yes**                                                        |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`                     | `gen:vapid`          | for push                                                       |
| `BOOTSTRAP_OWNER_EMAIL`                                                      | you                  | first boot                                                     |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                   | Google Cloud Console | for Google sign-in                                             |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`                                | @BotFather           | for Telegram sign-in **and** the fallback notification channel |
| `TELEGRAM_CLIENT_SECRET`                                                     | @BotFather           | OIDC flow only                                                 |

`VAPID_SUBJECT` **must** be a real, resolvable `mailto:` or `https://` — Apple
rejects anything else with `403 BadJwtToken`, which breaks push on every iPhone
with no other symptom. `mailto:admin@localhost` is the classic way to lose a day.

---

## 8. Backups to your PC

The server dumps nightly; **your PC pulls**. The server never pushes.

That direction matters. Your PC is behind NAT with no inbound port and no stable
address, and it is off for much of the day — a server-side copy would fail more
often than it worked. Pulling needs no open ports on your machine, and a missed
night simply catches up on the next run. It also means the VDI never holds a
route into your home network, which is the right way round if the VDI is ever
compromised.

The pull runs in a **container on your PC**, started by Docker Desktop. Not a
scheduled task, not a script you have to remember to run. The container is up
whenever the machine is up, and it decides for itself when a backup is due.

```
VDI  03:17 nightly   pg_dump | gzip | sha256      ->  backups/latest.sql.gz
     (Europe/Moscow) rsync the object volume      ->  backups/objects/
                     sha256 every file in it      ->  backups/objects.manifest

PC   container       every hour: "is either half due?"
       database        scp latest.sql.gz + its .sha256
                       check sha256, check the gzip, check the payload is real
                       ONLY THEN overwrite this weekday's slot
       objects         scp objects.manifest + its .sha256, check that first
                       rsync only what changed; anything that vanished
                         server-side moves to _attic/<date>/ rather than dying
                       check EVERY local file against the manifest
```

**The two halves have different shapes because they are different data.** The
database is small, changes completely every night, and gets seven weekday
generations. The object store is large, append-only and content-addressed — a
key's bytes never change, because a replacement is a new key. Seven generations
of that would be seven copies of the same photographs, and re-fetching it whole
every night is what made media unshippable in the first place. So objects get
one mirror, kept current, plus an attic that is the bounded rotation.

> **This replaced a nightly tarball, and the numbers are why.** Measured on this
> VDI against 297 MB of incompressible objects — which is what photographs and
> H.264 are: `tar | gzip -9` cost 17.2 s and produced a **300 MB** archive,
> every night, transferred whole, every night, down a domestic line. The mirror
> costs 1.7 s cold and 0.68 s when nothing changed, and transfers only what is
> new. See §6 for the disk arithmetic that made this urgent rather than merely
> nice.

### Set it up — one command, plus a key

```bash
docker compose -f infra/backup-pull/docker-compose.yml up -d
```

That is the whole installation. Start it now, before you have a key: it will
stop and print a banner telling you exactly what to do. Then do this once:

**1. Create a key on your PC.** No passphrase — it has to run unattended.

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\family_backup -N '""' -C family-backup
```

```bash
# or, from bash
ssh-keygen -t ed25519 -f ~/.ssh/family_backup -N '' -C family-backup
```

> If you started the container before creating the key, Docker will have made an
> empty **directory** at `~/.ssh/family_backup`. Delete it (`rm -rf`) before
> running `ssh-keygen`, or the key will not be created.

**2. Install the public half on the server**, from a machine that has root there:

```bash
ssh root@nezo.su "install -d -m700 -o familybackup -g familybackup /home/familybackup/.ssh"
cat ~/.ssh/family_backup.pub | ssh root@nezo.su "cat >> /home/familybackup/.ssh/authorized_keys"
ssh root@nezo.su "chown familybackup:familybackup /home/familybackup/.ssh/authorized_keys && chmod 600 /home/familybackup/.ssh/authorized_keys"
```

**3. Let `familybackup` read the backups — and nothing else.** `/opt/family` is
`deploy:deploy 0750`, so without this the key authenticates and then every copy
fails with `Permission denied`. An ACL grants exactly the backups directory
rather than putting the account in the `deploy` group, which would also hand it
`.env`. `rsync` has to exist on the server too — it is the one package this
design needs that a stock Ubuntu does not ship:

```bash
ssh root@nezo.su "apt-get install -y acl rsync"
ssh root@nezo.su "setfacl -m u:familybackup:--x /opt/family"            # traverse, not list
ssh root@nezo.su "setfacl -m u:familybackup:r-x /opt/family/backups"    # read the dumps
ssh root@nezo.su "setfacl -d -m u:familybackup:r-x /opt/family/backups" # …and future ones
```

> **The default is `r-x`, not `r--`, and the x matters.** It used to be `r--`,
> which worked while `backups/` held nothing but flat `.sql.gz` files. The object
> mirror is a directory tree, and a directory needs `+x` to be entered — with
> `r--` inherited, `familybackup` could see `objects/` and not open it, and the
> photographs would silently stop being backed up while the database kept
> arriving nightly.
>
> The x does not leak into files. Effective ACL permissions are masked by the
> file's group mode bits, and an object is created 0644 — mask `r--` — so the
> account gets `r--` on every file and `r-x` only on directories. Check it with
> `getfacl` if you want to see the mask do it.
>
> `backup.sh` re-applies this on `backups/objects/` every run, so an installation
> set up before the mirror existed heals itself. It is logged when it happens.

**What this account can now read, and why that is not a widening.** It can read
the object store — which is the family's photographs. It could already read every
byte of them, because the old design handed it a tarball of the same volume. The
access is identical; only the door changed. It still cannot read `.env`, cannot
list `/opt/family`, and has no route to Postgres. Verify all three:

```bash
ssh root@nezo.su "su -s /bin/sh familybackup -c '
  ls /opt/family/backups             # works
  ls /opt/family/backups/objects     # works
  cat /opt/family/.env               # Permission denied
  ls /opt/family                     # Permission denied'"
```

**4. Restart and watch it work:**

```bash
docker compose -f infra/backup-pull/docker-compose.yml restart
docker compose -f infra/backup-pull/docker-compose.yml logs -f
```

### Where the files land

`%USERPROFILE%\Backups\family` by default — a real folder you can open in
Explorer, not a Docker volume. Override it with `BACKUP_DEST` in a `.env` beside
`infra/backup-pull/docker-compose.yml` (see `.env.example` there).

```
Backups\family\
  family-db-mon.sql.gz            the database, one file per weekday
  family-db-mon.sql.gz.sha256
  …tue, wed, thu, fri, sat, sun

  family-objects\                 the object store, ONE mirror, not per-weekday
    family-media\avatars\…            every avatar
    family-media\media\…              every photo, video and voice note
    .rustfs.sys\…                     what makes it a RustFS disk on restore
  family-objects.manifest         sha256 of every file above, as pulled

  _attic\2026-08-14\              what disappeared server-side, by date
  LATEST.txt                      what was pulled last, and when
  _state\status.txt               last run, last result, last success
```

**Rotation, and what "new backups overwrite old ones" means for each half.**

- **Database** — seven weekday files, each replaced once a week. Constant disk,
  a week of history, nothing to clean up.
- **Objects** — one mirror, updated in place. Its size tracks the bucket's, so
  it does not grow except when the family adds photographs. Anything the server
  no longer has is **moved into `_attic\<date>\`, not deleted**, and dated sets
  older than `ATTIC_KEEP_DAYS` (30) are removed. That is the bound.

The attic is what makes `rsync --delete` safe to point at irreplaceable data. A
server that loses its volume — a wipe, a bad restore, ransomware — cannot take
this PC's copy with it in one night; it has to stay broken for a month first.
And if more than `ATTIC_ALERT_FILES` (100) objects vanish in one run, the log
says so in a banner, because a family does not delete four hundred photographs
in a day.

> The attic also collects RustFS's own housekeeping — `.usage-cache.bin` and
> friends get rewritten constantly, so their superseded versions land there. A
> few KB a night, capped by the same 30 days. If you see the attic holding
> nothing but `.rustfs.sys` paths, nothing has been lost.

> Seven weekday **dumps** rather than one is deliberate: with a single
> overwritten file, the moment a dump arrives truncated — or the database was
> already corrupt when it was taken — the last good copy is gone and the backup
> has destroyed the thing it exists to protect. `GENERATIONS=1` if you truly want
> one file. It has no effect on objects, which need no generations: their content
> never changes under a given key.

### When it runs

Around **14:00 local**, roughly daily — but driven by _when the last backup
actually happened_, never by the clock alone. The container wakes every hour and
asks one question:

| Since the last good backup | What happens                          |
| -------------------------- | ------------------------------------- |
| less than 20 h             | nothing                               |
| 20–26 h, before 14:00      | wait for 14:00                        |
| 20–26 h, at or after 14:00 | back up now — this is the normal case |
| more than 26 h             | back up now, whatever time it is      |

That last row is the one that matters. If the PC was off at 14:00 — or off for
three days — the backup happens within an hour of it next coming on, rather than
being skipped until tomorrow. Container start counts as a wake-up too, so
switching the machine on triggers the check immediately, not up to an hour later.

**The object store is asked separately**, against `OBJECTS_MIN_INTERVAL_HOURS`
(also 20), and a tick does something if _either_ half is due. That matters even
when both numbers are the same: with one shared gate, a dump that stopped being
due for any reason would take the photographs down with it, and setting the
object interval shorter than the dump's would do nothing at all.

The default is the same daily rhythm rather than the weekly one originally
proposed. Weekly was the right answer when a run meant re-fetching the whole
tarball; now that the transfer is incremental, the only thing a longer interval
buys is up to a week of new photographs living nowhere but the VDI. Set it to
`168` on a metered connection, knowing that is the trade.

### Is it working?

```bash
docker compose -f infra/backup-pull/docker-compose.yml ps
```

`Up … (healthy)` means three things at once: a good dump arrived within the last
48 hours, the object mirror synced within the last 96 (`OBJECTS_STALE_HOURS`),
and the internal schedule is still firing. `(unhealthy)` says which one broke.
This is the check that does not require you to read anything.

The object clause is not decoration. Without it, a dump arriving nightly while
the photographs quietly stopped three weeks ago would show `healthy` throughout —
and the photographs are the half that cannot be retyped.

```bash
docker compose -f infra/backup-pull/docker-compose.yml logs --tail 30
type %USERPROFILE%\Backups\family\_state\status.txt
```

Every run logs its decision — including "not due", so silence means the
container is not running, not that everything is fine. Failures that need you
(a refused key, a corrupt download, a mirror that will not verify) are printed
as a hash-bordered banner rather than a line you can scroll past.

### Why a separate `familybackup` user

The pull account can read the backups directory and nothing else — not `.env`,
not even a listing of `/opt/family`. If the PC is ever compromised, the key it
holds is worth far less than a root key, and the VDI also hosts your WireGuard
setup, which has nothing to do with this app.

### Verify it, because an unverified backup is not a backup

**The dump.** Three things are checked on arrival, **before** the new file is
allowed to replace last week's copy in that slot:

1. the sha256 matches the sidecar the server wrote next to the dump,
2. the gzip stream decompresses cleanly end to end,
3. the contents are real — `CREATE TABLE`/`COPY` statements are present.

If any of them fails, the download is deleted, the existing local backup is left
exactly as it was, and the run is retried on the next tick.

**The objects.** Stronger, because there is no single file to checksum:

1. `objects.manifest` is fetched first and checked against its own `.sha256`, so
   a truncated file list can never be read as "the mirror is missing things";
2. rsync transfers only what changed, writing each file to a temporary name and
   renaming it into place only when complete — an aborted transfer leaves every
   already-good file untouched, which is a **finer**-grained guarantee than the
   tarball's all-or-nothing;
3. then **every local file** is hashed and compared against the manifest. Not
   just the new ones.

That third step is the one worth understanding. rsync decides what to re-send by
size and mtime, and bit rot changes neither — so a photograph that decays on this
PC would never be looked at again, and the corruption would sit in the backup
until somebody tried to open it. The manifest check catches exactly that, and
when it does, the failing files are deleted and re-fetched once. If the second
attempt still fails, the run stops, the previous manifest stays in place, and you
get a banner: at that point the drive holding `%USERPROFILE%\Backups` is the
suspect, because the server checks its own copy the same way before publishing.

> Verifying everything costs about two seconds per 100 MB. It is deliberately
> not optimised down to "only what changed", because doing so would remove the
> only bit-rot detection this system has.

**On the server**, `backup.sh` does the mirror image of this: it verifies the
mirror against the manifest it has just written, and compares every object key
against the previous night's hashes. Objects are immutable, so a key whose
content changed cannot have come from the application — it re-copies those files
from the volume and reports whether that fixed it, which distinguishes "the
mirror rotted" from "something rewrote an object in the volume".

Beyond all that, actually restore one now and then. This runs on **your PC**, on
the file the container pulled:

```bash
./infra/scripts/restore-check.sh "$HOME/Backups/family/family-db-thu.sql.gz"
```

It loads the dump into a throwaway `postgres:17.7-alpine` on a tmpfs and asserts
the sha256 matches, the gzip is intact, the schema is there, the drizzle
migration ledger survived, the extensions came back and `users` is non-empty.
It never touches anything real.

For the objects, the equivalent one-liner needs no server and no container —
the manifest is an ordinary `sha256sum -c` file:

```bash
cd "$HOME/Backups/family/family-objects" && sha256sum -c ../family-objects.manifest
```

> **Pass the filename.** Run `restore-check.sh` with no argument and it picks the
> lexicographically last `*.sql.gz`, which for weekday slots is `wed` — not the
> newest. `LATEST.txt` names the one that was pulled most recently.
>
> If your PC has a repo `.env` with different `POSTGRES_USER`/`POSTGRES_DB` than
> production, pass `ENV_FILE=/dev/null` so the check uses the dump's own role
> names.

### Restoring for real

This is the part that matters, and it is worth reading before you need it.

**1. Prove the backup first.** Run `restore-check.sh` on it, as above.
Discovering the dump is bad _after_ step 3 turns a bad afternoon into a bad week.

**2. Copy the file up to the server.**

```bash
scp -i ~/.ssh/family_backup "$HOME/Backups/family/family-db-thu.sql.gz" root@nezo.su:/tmp/
```

**3. Stop the writers, recreate the database, replay.**

```bash
ssh root@nezo.su
cd /opt/family
set -a && . ./.env && set +a

docker compose -f infra/docker-compose.yml --env-file .env stop backend

docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE);" \
  -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"

gzip -cd /tmp/family-db-thu.sql.gz | \
  docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1

docker compose -f infra/docker-compose.yml --env-file .env start backend
```

**4. Restore the objects too, or every face and every photograph is gone.**
`users.avatar_url` and every media attachment point into the RustFS bucket; a
database restored without it keeps the rows and loses the images, with no way to
tell what was there.

This is a **directory**, not a tarball — that changed when the nightly tar was
replaced by an incremental mirror. It is pushed back up with the same `rsync`
the pull uses, from inside the same container, so no extra tooling is needed on
either end:

```bash
# from your PC — pushes the mirror to a staging directory on the server
docker exec family-backup-pull sh -c '
  . /etc/backup-pull.env
  rsync -rlt --delete --no-perms --chmod=D755,F644 \
    -e "ssh -o BatchMode=yes -o UserKnownHostsFile=/backups/_state/known_hosts -i /root/.ssh/backup_key" \
    /backups/family-objects/ familybackup@nezo.su:/tmp/restore-objects/'
```

```bash
# on the server
ssh root@nezo.su
cd /opt/family
VOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' \
      "$(docker compose -f infra/docker-compose.yml --env-file .env ps -q rustfs)")

docker compose -f infra/docker-compose.yml --env-file .env stop rustfs

docker run --rm -v "$VOL:/data" -v /tmp/restore-objects:/restore:ro alpine sh -c '
  rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null
  cp -a /restore/. /data/
  mkdir -p /data/.rustfs.sys/tmp /data/.rustfs.sys/multipart
  chown -R 10001:10001 /data
  chmod 750 /data'

docker compose -f infra/docker-compose.yml --env-file .env start rustfs
```

Three details in that container command are load-bearing, and each was found by
rehearsing rather than by reading:

- **`chown -R 10001:10001`.** RustFS runs as uid 10001 and the mirror lives on a
  Windows filesystem, which does not carry unix ownership — so the restored tree
  arrives owned by root and RustFS cannot write to it. The old tarball preserved
  uids and hid this; the mirror cannot, so it is done explicitly. `chmod 750` on
  the root matches what the image ships.
- **`mkdir -p .rustfs.sys/tmp .rustfs.sys/multipart`.** Those are staging
  directories, deliberately excluded from the mirror because RustFS implements a
  delete by moving the object's payload into `.rustfs.sys/tmp/.trash/` — left in,
  the backup would keep copying deleted photographs. They are recreated empty.
- **The paths are relative to the volume root** (`family-media/…`,
  `.rustfs.sys/…`), so this restores into any volume, whatever it is called.

Then check it actually came back, rather than assuming:

```bash
docker compose -f infra/docker-compose.yml --env-file .env exec rustfs \
  curl -fsS -o /dev/null -w 'health: %{http_code}\n' http://127.0.0.1:9000/health
docker run --rm -v "$VOL:/data:ro" alpine \
  sh -c 'find /data/family-media -name xl.meta | wc -l'   # object count
```

> **Rehearse this on a throwaway volume, not on production.** Every command
> above works unchanged with `docker volume create family_restore_rehearsal` in
> place of `$VOL` and a scratch `rustfs/rustfs:1.0.0-rc.2` container pointed at
> it. That is how this procedure was last proven: the mirror was pushed back, a
> fresh RustFS booted on it and answered `health: 200`, and an avatar fetched
> back out through the S3 API was byte-identical to the live one.

**5. Redis is not backed up and does not need to be.** It holds only BullMQ
queue state; the nightly job re-materializes the rolling recurrence window after
a restore.

**6. If you only need one photograph back**, do not restore anything. The mirror
is an ordinary directory tree — the object is at
`family-objects\family-media\<key>\xl.meta`, and for anything larger than a few
KB the payload is the `part.1` file in the directory beside it. Copy it out and
be done.

### What is and is not covered

Covered: the entire Postgres database — every task, event, goal, list, message
and account — and every object in the bucket: avatars, photographs, video and
voice notes.

**Not covered:** the `.env` file. It lives only on the server, it is the one
thing that is not in git, and losing `COOKIE_SECRET` invalidates every calendar
subscription while losing `VAPID_PRIVATE_KEY` invalidates every push
subscription. Copy it into your password manager once, by hand.
