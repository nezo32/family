# ─────────────────────────────────────────────────────────────────────────────
# Family App — task runner.
#
#   make            list every target
#   make dev        backing services in docker + pnpm dev on the host
#   make up         full production stack
#
# Everything here is a thin wrapper. If a command is easier to remember than to
# type, it belongs in this file; if it needs logic, it belongs in infra/scripts.
# ─────────────────────────────────────────────────────────────────────────────

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

COMPOSE_PROD := docker compose -f infra/docker-compose.yml --env-file .env
COMPOSE_DEV  := docker compose -f infra/docker-compose.dev.yml --env-file .env
PNPM         := pnpm

.PHONY: help dev dev-up dev-down up down restart build logs ps migrate seed \
        backup restore-check test lint fmt fmt-check typecheck psql redis-cli \
        env-check clean nuke

## ── help ────────────────────────────────────────────────────────────────────
help: ## Show this help
	@printf '\nFamily App — available targets:\n\n'
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sort \
	  | awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@printf '\n'

env-check: ## Fail early if .env is missing
	@test -f .env || { \
	  echo "ERROR: .env not found. Run: cp .env.example .env && \$$EDITOR .env"; \
	  exit 1; \
	}

## ── development ─────────────────────────────────────────────────────────────
dev: env-check dev-up ## Start postgres+redis in docker, then run the app on the host
	@echo "Postgres and Redis are up on localhost. Starting pnpm dev..."
	$(PNPM) run dev

dev-up: env-check ## Start ONLY postgres + redis, ports published to the host
	$(COMPOSE_DEV) up -d
	@echo "waiting for health..."
	@$(COMPOSE_DEV) ps

dev-down: ## Stop the developer datastores (volumes are kept)
	$(COMPOSE_DEV) down

## ── production stack ────────────────────────────────────────────────────────
up: env-check ## Start the full production stack (detached)
	$(COMPOSE_PROD) up -d --remove-orphans
	@$(COMPOSE_PROD) ps

down: ## Stop the production stack (volumes are kept)
	$(COMPOSE_PROD) down

restart: env-check ## Recreate backend + frontend without touching the datastores
	$(COMPOSE_PROD) up -d --force-recreate --no-deps backend frontend

build: env-check ## Build the backend and frontend images locally
	$(COMPOSE_PROD) build --pull

logs: ## Follow logs (make logs S=backend for one service)
	$(COMPOSE_PROD) logs -f --tail=200 $(S)

ps: ## Show container status
	$(COMPOSE_PROD) ps

## ── database ────────────────────────────────────────────────────────────────
migrate: env-check ## Apply drizzle migrations (host-side, against DATABASE_URL)
	$(PNPM) --filter @family/backend run db:migrate

migrate-prod: env-check ## Apply migrations inside the production stack
	$(COMPOSE_PROD) --profile tools run --rm migrate

seed: env-check ## Seed development data
	$(PNPM) --filter @family/backend run db:seed

psql: env-check ## Open a psql shell on the production database
	$(COMPOSE_PROD) exec postgres sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

redis-cli: env-check ## Open a redis-cli shell (auth from REDISCLI_AUTH)
	$(COMPOSE_PROD) exec redis redis-cli

## ── backup ──────────────────────────────────────────────────────────────────
backup: env-check ## Dump the production database (gzip + sha256, rotated)
	./infra/scripts/backup.sh

restore-check: env-check ## Replay the newest dump into a throwaway container and assert the schema
	./infra/scripts/restore-check.sh

## ── quality ─────────────────────────────────────────────────────────────────
test: ## Run every workspace test suite
	$(PNPM) -r run test

lint: ## ESLint across the workspace
	$(PNPM) -r run lint

typecheck: ## tsc --noEmit across the workspace
	$(PNPM) -r run typecheck

fmt: ## Prettier — write
	$(PNPM) run format

fmt-check: ## Prettier — check only (what CI runs)
	$(PNPM) run format:check

## ── housekeeping ────────────────────────────────────────────────────────────
clean: ## Remove build output (keeps node_modules)
	rm -rf packages/shared/dist backend/dist frontend/dist frontend/dev-dist \
	       backend/coverage frontend/coverage
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete

nuke: ## DESTROY the production stack AND its volumes (data is gone forever)
	@printf 'This deletes the Postgres and Redis volumes. Type YES to continue: ' && \
	  read -r ans && [ "$$ans" = "YES" ] || { echo "aborted"; exit 1; }
	$(COMPOSE_PROD) down -v
