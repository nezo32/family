# Family App — Master Plan

## 0. Repositories

| Repo      | Path        | Contents                                                   |
| --------- | ----------- | ---------------------------------------------------------- |
| superrepo | `/`         | infra, docker compose, deploy workflows, global docs, ADRs |
| backend   | `/backend`  | Fastify 5 + Drizzle + Postgres API (own git repo)          |
| frontend  | `/frontend` | React 19 PWA (own git repo)                                |

The superrepo `.gitignore`s `/backend` and `/frontend` so each module is an
independent repository with its own CI.

## 1. Pinned stack (decided by lead — do not re-litigate)

**Backend**

- Node 24 LTS, TypeScript (ESM, `strict` + `noUncheckedIndexedAccess`)
- Fastify 5, plugin-per-concern, `fastify-plugin` for decorators
- Zod schemas as the single source of truth for request/response + OpenAPI
- Drizzle ORM + Postgres 17, migrations via drizzle-kit
- BullMQ + Redis for scheduled notifications & recurrence materialization
- Auth: access JWT (short) + rotating refresh token (httpOnly cookie), OAuth
  Google / Apple / Telegram, argon2id for the local password fallback
- Web Push (VAPID) via `web-push`
- pino structured logging, `/health` + `/ready` probes

**Frontend**

- Vite 6 + React 19 + TypeScript
- Tailwind v4 + shadcn/ui (Radix primitives), lucide icons
- TanStack Query (server state) + Zustand (thin client state)
- React Router v7, RHF + Zod for forms
- `vite-plugin-pwa` with `injectManifest` (custom SW needed for push)
- **All user-facing text in Russian**

**Infra**

- Docker + docker compose (postgres, redis, backend, frontend/caddy)
- GitHub Actions CI in each repo; deploy workflow in the superrepo
- Caddy as reverse proxy + automatic TLS

## 2. Layer contract (how parallel work stays coherent)

```
backend/src/
  modules/<domain>/
    <domain>.schema.ts      # drizzle tables (owned by this module)
    <domain>.contract.ts    # zod request/response schemas
    <domain>.repository.ts  # data access, no HTTP knowledge
    <domain>.service.ts     # business rules, no HTTP knowledge
    <domain>.routes.ts      # fastify plugin, thin
    <domain>.test.ts
  core/        # config, db, logger, errors, auth guards, queue
  db/schema.ts # barrel re-exporting every module schema
```

Rule: modules never import another module's repository. Cross-module needs go
through the other module's **service** (injected), or through a domain event.

```
frontend/src/
  app/          # providers, router, layout shell
  features/<domain>/
    api.ts       # typed fetchers + query keys
    hooks.ts     # useQuery/useMutation wrappers
    components/
    pages/
    locale.ts    # Russian strings for this feature
  shared/        # ui (shadcn), lib, hooks, types
```

## 3. Delivery pipeline

plan → research → architecture → devops → development → test → review → ship

## 4. Feature scope

Confirmed by the product owner:

1. Task scheduling (recurring chores + one-off)
2. Events calendar (appointments, celebrations, birthdays)
3. Moneybox / savings goals with milestones
4. Profiles + OAuth (Google, Apple, Telegram) with binding from settings
5. Roles & permissions
6. Registration requires admin approval
7. Push notifications on phones (iOS PWA first)

Additional scope is selected from the product research report and recorded in
`docs/SCOPE.md`.
