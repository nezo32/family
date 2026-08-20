# Infrastructure

Everything needed to run the Family App locally and on the self-hosted VDI.

- [Topology](#topology)
- [Prerequisites](#prerequisites)
- [Development](#development)
- [Production — first boot](#production--first-boot)
- [Secrets you must generate](#secrets-you-must-generate)
  - [VAPID keys (Web Push)](#vapid-keys-web-push)
  - [Google OAuth](#google-oauth)
  - [Telegram](#telegram)
- [First user — `BOOTSTRAP_OWNER_EMAIL`](#first-user--bootstrap_owner_email)
- [Backups](#backups)
- [Pulling backups to your PC](#pulling-backups-to-your-pc)
- [Restoring](#restoring)
- [GitHub configuration](#github-configuration)
- [Day-to-day operations](#day-to-day-operations)
- [Troubleshooting](#troubleshooting)

---

## Topology

```
                       internet
                          │
                    :80 / :443
                          │
                   ┌──────▼──────┐        network: family_edge
                   │    caddy    │        (has a route out — OAuth, Web Push,
                   │  auto TLS   │         Telegram all need egress)
                   └──┬───────┬──┘
              /api/*  │       │  everything else
                   ┌──▼───┐ ┌─▼────────┐
                   │backend│ │ frontend │  caddy serving /srv, static only
                   │ :3000 │ │  :8080   │
                   └──┬────┘ └──────────┘
                      │
        ══════════════╪══════════════   network: family_data  (internal: true —
                      │                 no gateway, no internet, no host ports)
              ┌───────┴───────┐
        ┌─────▼─────┐   ┌─────▼─────┐
        │ postgres  │   │   redis   │
        │  17-alpine│   │  7-alpine │
        └───────────┘   └───────────┘
```

Postgres and Redis publish **no host ports in production**. If you can reach
port 5432 from outside the VDI, something is wrong.

| File                              | Purpose                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `docker-compose.yml`              | production stack                                            |
| `docker-compose.dev.yml`          | postgres + redis only, ports published to the host          |
| `caddy/Caddyfile`                 | edge reverse proxy, TLS, security headers, cache policy     |
| `postgres/init/01-extensions.sql` | first-boot extensions + session defaults                    |
| `scripts/backup.sh`               | nightly `pg_dump` + object mirror, sha256, rotation         |
| `scripts/restore-check.sh`        | replays the newest dump into a throwaway container          |
| `backup-pull/`                    | **separate project** — pulls backups down to the owner's PC |

---

## Prerequisites

**Development host** — Node 24 (`.nvmrc`), pnpm 11 (via corepack), Docker.

**VDI** — Docker Engine 26+ with the compose v2 plugin, the deploy user in the
`docker` group, ports 80 and 443 open, and a DNS A/AAAA record pointing
`APP_DOMAIN` at the machine **before** the first start (Caddy needs it to
complete the ACME HTTP-01 challenge).

---

## Development

```bash
cp .env.example .env      # then edit — see "Secrets you must generate"
make dev                  # postgres + redis in docker, pnpm dev on the host
```

`make dev` publishes Postgres on `127.0.0.1:5432` and Redis on
`127.0.0.1:6379` — loopback only, never `0.0.0.0`. Point the host-side app at
them:

```
DATABASE_URL=postgres://family:family@localhost:5432/family
REDIS_URL=redis://:family@localhost:6379
```

Then:

```bash
make migrate     # pnpm --filter @family/backend run db:migrate
make seed        # development fixtures
```

There is **no mail catcher** in the dev stack, deliberately. `docs/DECISIONS.md`
D10 puts every notification on Web Push or the Telegram bot; nothing in this
codebase can send an email, so a mailpit container would be a service nobody
ever opens. Add one only if that decision is ever reversed.

To tear the datastores down (volumes survive): `make dev-down`.

---

## Production — first boot

On the VDI, as the deploy user:

```bash
git clone <this repo> /srv/family && cd /srv/family
cp .env.example .env
$EDITOR .env                 # every secret, real domain, real credentials
chmod 600 .env
chmod +x infra/scripts/*.sh
```

`.env` must additionally contain (it is **not** in `.env.example` yet — see the
note at the end of this file):

```
ACME_EMAIL=you@example.com   # where Let's Encrypt sends expiry warnings
```

Then either let the deploy workflow do it, or by hand:

```bash
make up                                                    # pull/build + start
docker compose -f infra/docker-compose.yml --env-file .env \
  --profile tools run --rm migrate                         # apply migrations
make logs
```

Caddy obtains a certificate on first request. Watch for
`certificate obtained successfully` in `make logs S=caddy`. If it loops,
the DNS record is almost always the cause.

`.env` is **never** written by CI or by the deploy workflow. It lives on the host
and only on the host.

---

## Secrets you must generate

```bash
openssl rand -base64 48     # JWT_ACCESS_SECRET
openssl rand -base64 48     # JWT_REFRESH_SECRET
openssl rand -base64 48     # COOKIE_SECRET
openssl rand -base64 32     # ENCRYPTION_KEY  (OAuth tokens at rest)
openssl rand -base64 36     # POSTGRES_PASSWORD
openssl rand -base64 36     # REDIS_PASSWORD
```

Use a **different** value for every one of them. `DATABASE_URL` and `REDIS_URL`
must be updated to match the passwords you just generated.

### VAPID keys (Web Push)

```bash
pnpm --filter @family/backend run gen:vapid
```

Copy the output into **three** places:

```
VAPID_PUBLIC_KEY=BN...          # backend, signs the push request
VAPID_PRIVATE_KEY=...           # backend, never leaves the server
VITE_VAPID_PUBLIC_KEY=BN...     # frontend, baked into the bundle at build time
VAPID_SUBJECT=mailto:you@example.com
```

`VAPID_PUBLIC_KEY` and `VITE_VAPID_PUBLIC_KEY` **must be identical**. If they
drift, subscriptions are created against one key and pushed with another, and
every delivery fails with `403 VapidPkHashMismatch` — with no client-side
symptom other than notifications silently never arriving.

Rotating VAPID keys invalidates every existing subscription. Every device has to
re-subscribe. Generate once, back them up, do not rotate casually.

### Google OAuth

1. Google Cloud Console → _APIs & Services_ → _Credentials_ → _Create
   credentials_ → _OAuth client ID_ → **Web application**.
2. Authorised redirect URI: `https://<APP_DOMAIN>/api/auth/google/callback`
3. Copy into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

The client secret is still required alongside PKCE for a Web client — this is
not optional for Google, whatever the PKCE spec implies.

### Telegram

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot`.
2. `TELEGRAM_BOT_TOKEN` = the token it prints,
   `TELEGRAM_BOT_USERNAME` = the bot's `@name` **without** the `@`.
3. `/setdomain` → `<APP_DOMAIN>` — the **host only**, exactly as it appears in
   `APP_PUBLIC_URL`: no scheme, no `www.`, no port, no trailing slash. Skip it
   and every sign-in dies on a bare **«Bot domain invalid»** page on
   `oauth.telegram.org`, which our callback never sees. See
   `docs/DEPLOYMENT.md` §2.2 for the one-line `curl` that checks it.
4. Open **@BotFather as a mini app** (not the chat) → select the bot →
   **Login Widget**. Register both Allowed URLs — the origin
   `https://<APP_DOMAIN>` **and** the redirect URI
   `https://<APP_DOMAIN>/api/auth/telegram/callback` — and copy the
   **Client Secret** shown there into `TELEGRAM_CLIENT_SECRET`. It is required:
   `/auth/telegram/start` is OIDC-only and does not fall back to the widget or
   Mini App endpoints. Telegram serves the consent page even for an
   unregistered redirect URI and only rejects it after the user accepts, so a
   missing second URL fails at the very last step.
5. Set `VITE_TELEGRAM_BOT_USERNAME` to the same username.

The Telegram login flow opens a popup. The edge `Caddyfile` sets
`Cross-Origin-Opener-Policy: same-origin-allow-popups` for exactly this reason —
do not "harden" it to `same-origin`, that severs `window.opener` and the popup
can never hand the result back.

---

## First user — `BOOTSTRAP_OWNER_EMAIL`

Registration requires admin approval (D3), which is a chicken-and-egg problem on
an empty database: there is no admin to approve the first admin.

Set `BOOTSTRAP_OWNER_EMAIL` to the email address you will sign in with **before**
the first start. The first user who authenticates with that address is created
`status = active`, `role = owner`, bypassing the approval queue. Everyone after
that lands in `pending_approval` and needs the owner to let them in.

Notes:

- Telegram never provides an email, so the bootstrap sign-in must be Google or

---

## Backups

```bash
make backup          # ./infra/scripts/backup.sh
```

Two artefacts, two shapes.

**The database.** `backups/<db>-<UTC stamp>.sql.gz` plus a `.sha256` sidecar,
the `latest.sql.gz` symlink refreshed, and everything past the newest
`BACKUP_KEEP` (default 14) deleted. The script refuses to keep a dump that fails
`gzip -t` or that contains no `CREATE TABLE`/`COPY` statements.

**The object store.** `backups/objects/` — an rsync mirror of the RustFS volume,
updated in place — plus `backups/objects.manifest`, a `sha256sum -c` file
covering every byte in it, verified against the mirror before it is published.
One copy, not one per night, and refreshed in proportion to what changed.

> It used to be a nightly `tar | gzip -9` of the whole volume, which the PC then
> re-fetched whole every night, and which nothing rotated. Measured here on
> 297 MB of incompressible objects — photographs and H.264 — the tar cost 17.2 s
> and produced a **300 MB** archive; gzip gains nothing on media. Fourteen of
> those need the bucket under ~900 MB or the 30 GB disk fills. The mirror is
> 1.7 s cold, 0.68 s idle, and one copy. `docs/DEPLOYMENT.md` §6 has the full
> arithmetic.

`BACKUP_KEEP` is **clamped below the media sweep's grace period** (30 days,
`DETACHED_GRACE_DAYS` in `backend/src/modules/storage/media.service.ts`). A dump
that outlives the objects its rows point at restores to broken cards. The script
says so in the log when it clamps.

Cron on the VDI — installed by `scripts/vdi-bootstrap.sh`, which must stay in
step with this:

```cron
CRON_TZ=Europe/Moscow
# nightly dump + object mirror at 03:17
17 3 * * * root cd /opt/family && ./infra/scripts/backup.sh >>/var/log/family-backup.log 2>&1
# weekly proof that the dumps are actually restorable
41 4 * * 0 root cd /opt/family && ./infra/scripts/restore-check.sh >>/var/log/family-restore-check.log 2>&1
```

`CRON_TZ` is stated rather than inherited so that "does the backup overlap the
media sweep?" is answerable from this file. The sweep is `20 5 * * *` in
`backend/src/core/queue/workers.ts` — 05:20 Moscow — and it is the one scheduled
job that deletes from the volume the backup is copying. Two hours apart, and the
mirror takes seconds. The **hourly** unclaimed-upload reaper has no window at
all, so `backup.sh` treats rsync's exit 24 ("files vanished") as normal.

```bash
make restore-check   # replay the newest dump into a throwaway container
```

`restore-check.sh` starts a disposable `postgres:17.7-alpine` on a tmpfs, replays
the dump with `ON_ERROR_STOP=1`, and asserts: the sha256 matches, the gzip is
intact, the expected tables exist, `drizzle.__drizzle_migrations` survived, the
extensions came back, and `users` is non-empty. It exits non-zero if any of that
fails — **alert on that exit code**. A backup nobody has restored is a hypothesis,
not a backup.

`backups/` is git-ignored, and a backup that lives only on the machine it backs
up is not protecting you from the failure mode that actually happens — see
**Pulling backups to your PC** below.

---

## Pulling backups to your PC

`backup-pull/` is a **second, independent compose project**. It does not run on
the VDI; it runs on the owner's PC, which is why it is its own file rather than
another service in `docker-compose.yml`. Bringing up production must never try
to start it, and starting it must never need production's `.env`, images or
networks.

```bash
docker compose -f infra/backup-pull/docker-compose.yml up -d
```

That is the entire installation. Docker Desktop starts the container with the
PC; the container schedules itself. No host cron, no Windows scheduled task, no
PowerShell — that path is gone.

| File                             | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `backup-pull/docker-compose.yml` | the service; every knob and why it is set                        |
| `backup-pull/entrypoint.sh`      | validate the key, write the crontab, run one check, `exec crond` |
| `backup-pull/pull.sh`            | one run: is it due, fetch, verify, overwrite the slot            |
| `backup-pull/.env.example`       | the optional overrides                                           |

**How it schedules.** A stock `instrumentisto/rsync-ssh:alpine` (25 MB —
Alpine plus `ssh`, `scp`, `rsync`, `sha256sum`, `crond`, `tzdata`; nothing to
build) runs busybox `crond` with one hourly entry. The `rsync` in that image is
now load-bearing rather than incidental: it is what pulls the object mirror, and
the server needs `apt-get install rsync` to serve it. The hour is not the schedule.
Each tick asks whether it has been ≥ `MIN_INTERVAL_HOURS` (20) since the last
_successful_ backup, and takes one if so and it is past `PREFERRED_HOUR` (14) —
or unconditionally past `MAX_INTERVAL_HOURS` (26), which is the "the PC was
off" case. Container start runs the check too, so waking the machine does not
mean waiting an hour. All the state is files on the bind mount, so `stop`/
`start` cycles — a sleeping laptop — lose nothing.

> `cap_drop: ALL` **breaks busybox crond silently**: it forks, the child's
> `setgroups()` fails, and no job ever runs, with nothing in the log. The
> compose file adds `SETGID`/`SETUID` back for exactly this reason, and the
> healthcheck watches for a stalled schedule (`TICK_STALE_HOURS`) so the same
> class of failure cannot hide again.

**What it fetches.** Both halves, and they are fetched differently because they
are different data.

The **dump** is `scp`'d whole, checked against the server's `.sha256` sidecar,
then `gzip -t`, then a payload check — **before** it is allowed to replace the
existing local file. A corrupt download is deleted and the previous good copy is
untouched.

The **objects** come down as an incremental `rsync` of `backups/objects/`.
`objects.manifest` is fetched and verified against its own sidecar first, then
rsync moves only what changed, then **every local file** is hashed against that
manifest. Failing files are deleted and re-fetched once; a second failure stops
the run with a banner and leaves the previous manifest in place. That last check
is the only bit-rot detection in the system — rsync compares size and mtime, and
rot changes neither.

**Where it lands.** `%USERPROFILE%\Backups\family` by default, overridable with
`BACKUP_DEST`.

- **Database** — seven weekday files, each overwritten once a week. Constant
  disk, no cleanup, a week of history if the newest dump turns out to be bad.
- **Objects** — one mirror at `family-objects/`, updated in place. Anything that
  disappears server-side is moved to `_attic/<date>/` rather than deleted, and
  dated sets past `ATTIC_KEEP_DAYS` (30) are removed. That is what makes
  `rsync --delete` safe to point at photographs: a server that loses its volume
  cannot take this PC's copy with it in one night.

Objects get no weekday generations, deliberately. They are immutable and
content-addressed — a key's bytes never change, because a replacement is a new
key — so seven generations would be seven copies of the same photographs.

**Is it alive?** `docker compose -f infra/backup-pull/docker-compose.yml ps`.
The healthcheck reports `unhealthy` if no good dump arrived in 48 h, if the
object mirror has not synced in 96 h, or if the internal schedule stopped firing.
The object clause matters on its own: a dump arriving nightly while the
photographs quietly stopped three weeks ago would otherwise read as `healthy`. Every tick logs its decision, including
"not due", so silence means the container is down.

The one-time SSH key setup — creating it, authorising it on the server, and the
ACL that lets `familybackup` read `/opt/family/backups` without being able to
read `.env` — is in **docs/DEPLOYMENT.md §8**, along with the full restore
procedure for both halves.

> One detail of that ACL changed with the mirror and is easy to get wrong: the
> **default** entry is now `r-x`, not `r--`. A directory needs `+x` to be
> entered, and with `r--` inherited the account can see `objects/` and not open
> it — the photographs stop being backed up while the database keeps arriving.
> The file-mode mask keeps the x off files. `backup.sh` re-applies this every
> run so an older installation heals itself.

---

## Restoring

Real restore, into the live database. This **destroys** current data.

```bash
cd /srv/family
./infra/scripts/restore-check.sh backups/family-<stamp>.sql.gz   # 1. prove it first

docker compose -f infra/docker-compose.yml --env-file .env stop backend        # 2. stop writers
set -a && . ./.env && set +a

docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE);" \
  -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"              # 3. clean slate

gzip -cd backups/family-<stamp>.sql.gz | \
  docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1                # 4. replay

docker compose -f infra/docker-compose.yml --env-file .env start backend       # 5. back up
```

Step 1 is not optional. Discovering the dump is corrupt _after_ step 3 is how a
bad afternoon becomes a bad week.

That restores the database only. The object store is a separate step — the
mirror is pushed back and copied into the RustFS volume, with a `chown` to the
RustFS uid that the old tarball did not need. Full procedure, including how to
rehearse it on a throwaway volume, is in **docs/DEPLOYMENT.md §8**.

Redis holds only BullMQ queue state (scheduled notifications, the recurrence
materializer). It is rebuildable and is not backed up; after a restore the
nightly job re-materializes the rolling window.

---

## GitHub configuration

`ci.yml` and `docker.yml` need nothing beyond the built-in `GITHUB_TOKEN`.
`deploy.yml` is inert until these exist — its preflight step fails with an
explicit list of what is missing.

### Secrets — _Settings → Secrets and variables → Actions → Secrets_

| Name                     | Required             | What it is                                                                                                                                                                                                         |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEPLOY_SSH_KEY`         | yes                  | Private key (OpenSSH PEM, **no passphrase**) whose public half is in the deploy user's `~/.ssh/authorized_keys` on the VDI. Generate a dedicated one: `ssh-keygen -t ed25519 -C github-deploy -f deploy_key -N ""` |
| `DEPLOY_SSH_KNOWN_HOSTS` | strongly recommended | Output of `ssh-keyscan -p <port> <host>`. Without it the workflow trusts whatever answers on first connect and logs a warning.                                                                                     |
| `DEPLOY_HOST`            | yes*                 | Hostname or IP of the VDI                                                                                                                                                                                          |
| `DEPLOY_USER`            | yes*                 | SSH user, must be in the `docker` group                                                                                                                                                                            |
| `DEPLOY_PATH`            | yes*                 | Absolute path of the checkout on the VDI, e.g. `/srv/family`                                                                                                                                                       |

\* `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_PATH` may be **either** secrets or
variables — the workflow reads `secrets.X || vars.X`. Use variables unless the
hostname itself is sensitive.

### Variables — _…→ Variables_

| Name                         | Default | What it is                                                                                                                     |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `DEPLOY_PORT`                | `22`    | SSH port                                                                                                                       |
| `APP_DOMAIN`                 | —       | Public domain, used for the deployment environment URL                                                                         |
| `VITE_API_URL`               | `/api`  | Baked into the frontend bundle                                                                                                 |
| `VITE_VAPID_PUBLIC_KEY`      | —       | The **public** VAPID key. Public by definition — a variable, not a secret. Must match `VAPID_PUBLIC_KEY` in the host's `.env`. |
| `VITE_TELEGRAM_BOT_USERNAME` | —       | Bot username without `@`                                                                                                       |

### Environment

`deploy.yml` runs in the GitHub environment **`production`**. Create it
(_Settings → Environments_) to attach required reviewers or a wait timer; the
workflow works without it, but an approval gate on a one-click production deploy
is cheap insurance.

### Running a deploy

_Actions → Deploy → Run workflow_ → pick a tag (`latest`, `sha-<40 hex>`, or
`v1.2.3` — whatever `docker.yml` published).

The workflow: preflight → ssh → sync `infra/` and `Makefile` to the host →
`docker compose pull` → **pre-migration `pg_dump`** → migrate → `up -d` → health
gate on `/ready` (not `/health` — a process that booted but cannot reach Postgres
is not a successful deploy) → record the tag in `$DEPLOY_PATH/.deploy-state`.

On any failure it prints the last 120 log lines and rolls the images back to the
tag in `.deploy-state`. **Schema changes are not rolled back**: write migrations
expand/contract so the previous release can still run against the new schema,
otherwise the image rollback is cosmetic.

---

## Day-to-day operations

```bash
make up              # start the production stack
make down            # stop it (volumes survive)
make ps              # what is running
make logs            # follow everything
make logs S=backend  # follow one service
make restart         # recreate backend + frontend, leave the datastores alone
make psql            # psql shell on the production database
make redis-cli       # redis-cli shell
make backup
make restore-check
make nuke            # destroys the volumes; asks you to type YES
```

Edited the Caddyfile? Reload without dropping connections:

```bash
docker compose -f infra/docker-compose.yml --env-file .env exec caddy \
  caddy reload --config /etc/caddy/Caddyfile
```

---

## Troubleshooting

**Caddy never gets a certificate.** DNS first: `dig +short <APP_DOMAIN>` must
return the VDI's public address. Then ports: 80 must be reachable from the
internet for HTTP-01. Then rate limits: Let's Encrypt allows 5 failures per
account/hostname per hour — use `APP_DOMAIN=localhost` (internal cert) while
debugging everything else.

**`ACME_EMAIL is required`.** Compose refuses to start Caddy without it, because
Caddy refuses to parse a Caddyfile with an empty `email` directive. Add it
to `.env`.

**Backend restarts in a loop.** `make logs S=backend`. Nearly always `.env`:
a `DATABASE_URL` still pointing at `localhost` instead of `postgres`, or a
`change_me` secret that the config schema rejects. Inside the compose network
the hostnames are the service names — `postgres` and `redis`, not `localhost`.

**Telegram login opens a blank popup and hangs.** `Cross-Origin-Opener-Policy`
has been changed to `same-origin`, or `/setdomain` was never done in BotFather.

**The PWA will not update.** Something is caching `sw.js` or `index.html`.
Verify: `curl -sI https://<domain>/sw.js | grep -i cache-control` must say
`no-cache`. Both the frontend container and the edge set this; if a CDN was
added in front, it has to honour it too.

**Push notifications never arrive.** Check `VITE_VAPID_PUBLIC_KEY` equals
`VAPID_PUBLIC_KEY`. Then remember iOS only permits `Notification.requestPermission()`
from an installed-to-Home-Screen PWA, triggered by a user gesture.

**`docker compose` says the lockfile is out of date during an image build.**
The Dockerfiles copy _every_ workspace `package.json` on purpose. If a new
workspace package is added to `pnpm-workspace.yaml`, add its manifest to the
`COPY` list in both `backend/Dockerfile` and `frontend/Dockerfile`.

---

## Known gaps for the lead

- **`.env.example` is missing `ACME_EMAIL`.** Infra requires it; the file is
  owned elsewhere, so it was not edited. Please add:
  `ACME_EMAIL=admin@example.com`.
- **`backend/scripts/generate-vapid.ts` does not exist yet**, although
  `gen:vapid` is wired up in `backend/package.json`.
- Migrations in production run as `node dist/db/migrate.js` (the `migrate`
  compose service), because `db:migrate` goes through `tsx`, a devDependency
  the production image deliberately does not contain. `src/db/migrate.ts` must
  therefore be a standalone, runnable entry point.
