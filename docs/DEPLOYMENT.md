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

The backup script keeps the newest `BACKUP_KEEP` dumps on the server (default
14); a family-sized dump is a few MB gzipped, so that is negligible. Note that
it does **not** yet rotate the `*-objects.tar.gz` avatar archives — those
accumulate until `BACKUP_KEEP` is extended to cover them.

The real consumer of disk is old image layers after many deploys —
`docker.yml` tags by SHA, so they accumulate.

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
VDI  03:17 nightly   pg_dump | gzip | sha256   ->  /opt/family/backups
                     tar the avatar volume     ->  latest.sql.gz, latest-objects.tar.gz

PC   container       every hour: "has it been 20h since the last good backup?"
                     if yes:  scp both files down
                              check sha256 against the server's sidecar
                              check the gzip
                              check the payload is real
                              ONLY THEN overwrite this weekday's slot
```

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

**3. Let `familybackup` read the dumps — and nothing else.** `/opt/family` is
`deploy:deploy 0750`, so without this the key authenticates and then every copy
fails with `Permission denied`. An ACL grants exactly the backups directory
rather than putting the account in the `deploy` group, which would also hand it
`.env`:

```bash
ssh root@nezo.su "apt-get install -y acl"
ssh root@nezo.su "setfacl -m u:familybackup:--x /opt/family"          # traverse, not list
ssh root@nezo.su "setfacl -m u:familybackup:r-x /opt/family/backups"  # read the dumps
ssh root@nezo.su "setfacl -d -m u:familybackup:r-- /opt/family/backups"  # …and future ones
```

Check it landed correctly — this should list the dumps and refuse everything else:

```bash
ssh root@nezo.su "su -s /bin/sh familybackup -c 'ls /opt/family/backups; ls /opt/family'"
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
  family-objects-mon.tar.gz       the avatars, same weekday slot
  family-objects-mon.tar.gz.sha256
  …tue, wed, thu, fri, sat, sun
  LATEST.txt                      what was pulled last, and when
  _state\status.txt               last run, last result, last success
  _log\pull-2026-08.log           one line per decision, kept per month
```

**New backups overwrite old ones.** The filename is the weekday, so the set is
exactly seven database files and seven avatar files, each replaced once a week.
Disk use is constant; there is no cleanup to remember.

Seven rather than one is deliberate. With a single overwritten file, the moment
a dump arrives truncated — or the database was already corrupt when it was
taken — the last good copy is gone and the backup has destroyed the thing it
exists to protect. Set `GENERATIONS=1` if you truly want exactly one file.

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

### Is it working?

```bash
docker compose -f infra/backup-pull/docker-compose.yml ps
```

`Up … (healthy)` means a good backup arrived within the last 48 hours **and**
the internal schedule is still firing. `(unhealthy)` says which of the two
broke. This is the check that does not require you to read anything.

```bash
docker compose -f infra/backup-pull/docker-compose.yml logs --tail 30
type %USERPROFILE%\Backups\family\_state\status.txt
```

Every run logs its decision — including "not due", so silence means the
container is not running, not that everything is fine. Failures that need you
(a refused key, a corrupt download) are printed as a hash-bordered banner rather
than a line you can scroll past.

### Why a separate `familybackup` user

The pull account can read the dump directory and nothing else — not `.env`, not
even a listing of `/opt/family`. If the PC is ever compromised, the key it holds
is worth far less than a root key, and the VDI also hosts your WireGuard setup,
which has nothing to do with this app.

### Verify it, because an unverified backup is not a backup

Three things are checked on arrival, **before** the new file is allowed to
replace last week's copy in that slot:

1. the sha256 matches the sidecar the server wrote next to the dump,
2. the gzip stream decompresses cleanly end to end,
3. the contents are real — `CREATE TABLE`/`COPY` statements in the dump, actual
   entries in the avatar archive.

If any of them fails, the download is deleted, the existing local backup is left
exactly as it was, and the run is retried on the next tick. A corrupt fetch can
never take out a good copy.

Beyond that, actually restore one now and then. This runs on **your PC**, on the
file the container pulled:

```bash
./infra/scripts/restore-check.sh "$HOME/Backups/family/family-db-thu.sql.gz"
```

It loads the dump into a throwaway `postgres:17.7-alpine` on a tmpfs and asserts
the sha256 matches, the gzip is intact, the schema is there, the drizzle
migration ledger survived, the extensions came back and `users` is non-empty.
It never touches anything real.

> **Pass the filename.** Run with no argument and it picks the
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

**4. Restore the avatars too, or every member gets a broken face.**
`users.avatar_url` points into the RustFS bucket; a database restored without it
keeps the rows and loses the images, with no way to tell whose photo was whose.

```bash
scp -i ~/.ssh/family_backup "$HOME/Backups/family/family-objects-thu.tar.gz" root@nezo.su:/tmp/

ssh root@nezo.su
cd /opt/family
VOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' \
      "$(docker compose -f infra/docker-compose.yml --env-file .env ps -q rustfs)")

docker compose -f infra/docker-compose.yml --env-file .env stop rustfs
docker run --rm -v "$VOL:/data" -v /tmp:/backup:ro postgres:17.7-alpine \
  sh -c 'rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null; tar -xzf /backup/family-objects-thu.tar.gz -C /data'
docker compose -f infra/docker-compose.yml --env-file .env start rustfs
```

The archive stores paths relative to the volume root (`./family-media/…`), so it
extracts into any volume, not only one called `/data`. It is a plain `tar.gz` —
`tar -tzf` lists it, no special tooling.

**5. Redis is not backed up and does not need to be.** It holds only BullMQ
queue state; the nightly job re-materializes the rolling recurrence window after
a restore.

### What is and is not covered

Covered: the entire Postgres database — every task, event, goal, list, message
and account — and the avatar objects.

**Not covered:** the `.env` file. It lives only on the server, it is the one
thing that is not in git, and losing `COOKIE_SECRET` invalidates every calendar
subscription while losing `VAPID_PRIVATE_KEY` invalidates every push
subscription. Copy it into your password manager once, by hand.
