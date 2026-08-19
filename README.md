# Семья — family application

A self-hosted application for one family: shared chores with fair rotation, a
family calendar, savings goals, shopping lists, and notifications that actually
arrive on an iPhone.

Installable as a PWA on iOS/Android, and a first-class web app on desktop.
The interface is in Russian; the code, comments and documentation are in English.

---

## What it does

| | |
|---|---|
| **Задачи** | One-off and recurring chores, assigned by a fairness-weighted rotation rather than by nagging. No points, no scores: the rotation simply counts who has been carrying the week and asks the next person. |
| **Календарь** | Appointments, celebrations and birthdays, with reminders. Subscribable as an ICS feed so it shows up in the iPhone's own Calendar app. |
| **Копилка** | Shared and personal savings goals with milestones. An append-only ledger — the balance is always the sum of its transactions. |
| **Покупки** | Multiple lists, one-line quick add (`2 кг картошки`), store-aisle grouping, and autocomplete that learns from the family's own history. Works offline, because that is where shopping happens. |
| **Лента** | Announcements, comments on anything, kudos and polls. Deliberately not a chat — Telegram already exists. |
| **Уведомления** | Web Push and a Telegram bot, with per-type preferences, quiet hours that defer rather than drop, and escalation for things that matter. |
| **Доступ** | Google and Telegram sign-in, six roles, and registration that only an admin can approve. |

## Stack

**Backend** — Node 24, TypeScript (ESM, strict), Fastify 5, Drizzle ORM,
PostgreSQL 17, BullMQ + Redis, Zod contracts, OpenAPI generated from those
contracts.

**Frontend** — Vite 6, React 19, TypeScript, Tailwind v4, shadcn/ui, TanStack
Query, React Router 7, `vite-plugin-pwa`.

**Infrastructure** — Docker Compose, Caddy with automatic TLS, GitHub Actions.

## Layout

```
.                     pnpm monorepo root — infra, compose, CI, docs
├── packages/shared/   contracts shared by both apps: zod schemas, permissions, error codes
├── backend/           Fastify API
├── frontend/          React PWA
├── infra/             compose files, Caddy, backup scripts
└── docs/              decisions, architecture notes, research
```

## Documentation

Read these in order before contributing:

1. **[docs/DECISIONS.md](docs/DECISIONS.md)** — the ratified architecture
   decisions. Binding. Start here.
2. **[docs/CONVENTIONS.md](docs/CONVENTIONS.md)** — code layout, naming, testing.
3. **[docs/PLAN.md](docs/PLAN.md)** — scope and delivery plan.
4. `docs/architecture/` — per-domain design notes (identity, scheduling,
   household, notifications, frontend).
5. `docs/research/` — platform research that constrains the design, most
   importantly **[ios-pwa-push.md](docs/research/ios-pwa-push.md)**, which
   documents the iOS rules that will silently break push if ignored.

## Getting started

Requires Node 24, pnpm 11 and Docker.

```bash
pnpm install                       # install the workspace
cp .env.example .env               # then fill it in — see infra/README.md
pnpm --filter @family/shared build # the contracts package other two depend on

docker compose -f infra/docker-compose.dev.yml up -d   # postgres + redis
pnpm db:migrate
pnpm db:seed                       # a plausible family to look at

pnpm dev                           # api on :3000, PWA on :5173
```

API reference at <http://localhost:3000/docs>.

### Production

```bash
cp .env.example .env               # set real secrets and APP_PUBLIC_URL
pnpm up                            # docker compose up -d
```

See **[infra/README.md](infra/README.md)** for TLS, OAuth credentials, VAPID key
generation, backups and the deploy workflow.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Run API and PWA together |
| `pnpm build` | Build all three packages |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Across the workspace |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` / `pnpm db:seed` | Apply migrations / seed dev data |
| `pnpm up` / `pnpm down` / `pnpm logs` | The Docker stack |

## A note on notifications and iOS

Push on an iPhone works **only** after the app has been added to the Home
Screen, and the permission prompt must come from a real tap. This is an Apple
platform rule, not a limitation of this app. The onboarding flow walks each
family member through installing it, and the settings screen has a
«Отправить тестовое уведомление» button to confirm the whole chain end to end.

## Licence

Private. Not for redistribution.
