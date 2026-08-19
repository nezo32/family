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
3. For the OIDC flow, BotFather's **Bot Settings → Web Login / OAuth** section
   issues the client secret. If your BotFather build does not expose it, the app
   falls back to the Login Widget and Mini App flows, which need only the bot
   token — `TELEGRAM_CLIENT_SECRET` may be left empty in that case.

**You get:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (without the `@`),
optionally `TELEGRAM_CLIENT_SECRET`.

The bot doubles as the **second notification channel**, and it is the more
reliable of the two — `sendMessage` returns a real delivery confirmation, which
Web Push never does. Worth configuring even if nobody signs in with Telegram.

### 2.3 Apple — **costs $99/year**, ~30 minutes

Only do this if you actually want the «Войти через Apple» button. Everything
else works without it, and the app hides the button when it is unconfigured.

1. Join the **Apple Developer Program** ($99/year) — there is no free tier for
   Sign in with Apple.
2. **Certificates, IDs & Profiles → Identifiers → App ID**, enable *Sign in with
   Apple*.
3. **Identifiers → Services ID**, e.g. `su.nezo.family.web`. Enable *Sign in
   with Apple* → Configure:
   - Domain: `nezo.su`
   - Return URL: `https://nezo.su/api/auth/apple/callback`
   - Download the domain-verification file and serve it at
     `https://nezo.su/.well-known/apple-developer-domain-association.txt`
4. **Keys → new key**, enable *Sign in with Apple*, download the `.p8`.
   **It downloads exactly once.**

```bash
base64 -w0 AuthKey_XXXXXXXXXX.p8   # -> APPLE_PRIVATE_KEY_BASE64
```

**You get:** `APPLE_CLIENT_ID` (the **Services ID**, not the App ID),
`APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_BASE64`.

### 2.4 GHCR pull token — free, 2 minutes

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

| Name | Value |
|---|---|
| `DEPLOY_SSH_KEY` | Private key that may SSH to the VDI (see §4.2). Paste the whole file including the BEGIN/END lines. |
| `DEPLOY_SSH_KNOWN_HOSTS` | Output of `ssh-keyscan -H 193.124.180.31`. Without it the workflow falls back to trust-on-first-use and warns. |

### 3.2 Repository **variables**
`Settings → Secrets and variables → Actions → Variables`

| Name | Value |
|---|---|
| `DEPLOY_HOST` | `193.124.180.31` |
| `DEPLOY_USER` | `deploy` (or `root` — see §4.2) |
| `DEPLOY_PATH` | `/opt/family` |
| `DEPLOY_PORT` | `22` |
| `APP_DOMAIN` | `nezo.su` |
| `VITE_API_URL` | **leave empty** — API and app share one origin. Setting `/api` here produces `/api/api/...` and breaks every screen. |
| `VITE_VAPID_PUBLIC_KEY` | the public half from `gen:vapid` |
| `VITE_TELEGRAM_BOT_USERNAME` | your bot username, no `@` |

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

It creates `/opt/family`, a `deploy` user in the `docker` group, a `backup`
user restricted to reading dumps, the backup cron entry, and a firewall that
opens 22/80/443 **while preserving the existing WireGuard UDP ports**.

### 4.2 Which SSH user should CI use?

The bootstrap creates a **`deploy`** user rather than using `root`, and puts CI's
key there. It is one line of extra setup and it means a leaked CI key cannot
rewrite the whole box — including the VPN containers that have nothing to do
with this app. `deploy` is in the `docker` group, which is enough for compose.

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

The backup script keeps 7 rotated dumps on the server; a family-sized dump is a
few MB gzipped, so that is negligible. The real consumer is old image layers
after many deploys — `docker.yml` tags by SHA, so they accumulate.

---

## 7. Quick reference — every variable

| Variable | Where from | Required? |
|---|---|---|
| `APP_PUBLIC_URL`, `APP_DOMAIN`, `ACME_EMAIL` | you | **yes** |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | `openssl rand` | **yes** |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET`, `ENCRYPTION_KEY` | `openssl rand` | **yes** |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | `gen:vapid` | for push |
| `BOOTSTRAP_OWNER_EMAIL` | you | first boot |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud Console | for Google sign-in |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | @BotFather | for Telegram sign-in **and** the fallback notification channel |
| `TELEGRAM_CLIENT_SECRET` | @BotFather | OIDC flow only |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_BASE64` | Apple Developer ($99/yr) | for Apple sign-in |

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

```
VDI  03:30 nightly  ->  pg_dump | gzip | sha256  ->  /opt/family/backups (keeps 7)
PC   09:00/14:00/21:00/logon  ->  scp down, verify gzip, keep 180 days
```

### Set it up (once, on the PC, elevated PowerShell)

```powershell
cd <repo>\infra\scripts
.\install-backup-pull.ps1
```

It generates a dedicated `family_backup` SSH key, prints the one command to
authorise it on the server, creates `%USERPROFILE%\Backupsamily`, and
registers a scheduled task.

The task uses **`StartWhenAvailable`**, so a run missed while the PC was off
happens as soon as it wakes — without that, a machine that is rarely on at 09:00
would back up almost nothing.

### Why a separate `backup` user

The pull account can read the dump directory and nothing else. If the PC is ever
compromised, the key it holds is worth far less than a root key — and the VDI
also hosts your WireGuard setup, which has nothing to do with this app.

### Verify it, because an unverified backup is not a backup

Each archive is gzip-verified on arrival before it is allowed to count, and a
partial transfer is written to `.partial` so it can never be mistaken for a
finished one. Beyond that, actually restore one now and then:

```bash
ssh root@nezo.su 'cd /opt/family && ./infra/scripts/restore-check.sh'
```

That loads the newest dump into a throwaway container and asserts the schema is
present. Do it after the first deploy and then occasionally — a restore you have
never rehearsed is the one that fails.

### What is and is not covered

Covered: the entire Postgres database — every task, event, goal, list, message
and account.

**Not covered:** the `.env` file. It lives only on the server, it is the one
thing that is not in git, and losing `COOKIE_SECRET` invalidates every calendar
subscription while losing `VAPID_PRIVATE_KEY` invalidates every push
subscription. Copy it into your password manager once, by hand.
