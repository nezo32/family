#!/usr/bin/env bash
#
# "Will CI pass?" — answered locally, without pushing.
#
#     ./infra/scripts/verify-ci.sh
#
# This runs the SAME COMMANDS as `.github/workflows/ci.yml`, in the same order
# as its jobs, against the working tree — seven of its eight jobs. The eighth is
# `e2e`, which drives Playwright against a running stack: `verify-all.sh`
# already orchestrates exactly that, and duplicating it here would double this
# script's runtime for no coverage it does not already have.
#
# So this answers "are the fast CI jobs going to pass?" in a few minutes, and
# `verify-all.sh` is what you run before calling a piece of work done — it adds
# the Playwright suite and both Docker images at `--target build`.
#
# ── Why this file had to exist ───────────────────────────────────────────────
#
# Three separate breakages now share one shape: a gate that passed locally and
# failed in the place that counts.
#
#   1. A path alias that `tsc` accepted and the container could not resolve.
#   2. `playwright.config.ts` importing from `e2e/`, which `.dockerignore`
#      withholds from the image build context.
#   3. `eslint .` vs `eslint src`. Every local gate — `verify-all.sh` included —
#      linted `src`. CI lints `.`, which also covers `eslint.config.js`,
#      `vitest.config.ts`, `drizzle.config.ts` and `e2e/`. The backend's own
#      flat config was a hard parsing error under `eslint .` for as long as it
#      had existed, and no local run could see it.
#
# So: run the CI commands verbatim, not a local approximation of them. Where a
# command below has to differ from the workflow, the difference is commented.
#
# Needs Postgres and Redis for the backend job:
#     docker compose -f infra/docker-compose.dev.yml --env-file .env up -d
#
# Keeps going after a failure so one run tells you everything that is broken.
# Exits non-zero if any gate failed.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_DB="${TEST_DATABASE_URL:-postgres://family:family@127.0.0.1:5432/family_test}"
TEST_S3="${TEST_S3_ENDPOINT:-http://127.0.0.1:9000}"
S3_KEY="${TEST_S3_ACCESS_KEY_ID:-family}"
S3_SECRET="${TEST_S3_SECRET_ACCESS_KEY:-familysecret}"

PASS=0
FAIL=0
declare -a FAILED=()

step() {
  local name="$1"; shift
  printf '\n\033[1;36m── %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[1;32m   ok\033[0m\n'
    PASS=$((PASS + 1))
  else
    printf '\033[1;31m   FAILED\033[0m\n'
    FAIL=$((FAIL + 1))
    FAILED+=("$name")
  fi
}

# ─────────────────────────────────────────────────── job: setup ─────────────
# `@family/shared` must exist as compiled JS before anything else resolves it.
# CI builds it once and ships `packages/shared/dist` to the other jobs as an
# artifact; locally we build it in place.
step "setup: build @family/shared" \
  pnpm --filter @family/shared run build

# ────────────────────────────────────────────── job: lint + format ──────────
#
# `eslint .`, NOT `eslint src`. This is the whole reason the file exists; see
# the header. `pnpm -r run lint` is the workflow's literal command and every
# package's `lint` script is already `eslint .`, so run it exactly.
step "lint: pnpm -r run lint" \
  pnpm -r run lint

# `pnpm run format:check` with one deliberate change: `--end-of-line auto`.
#
# `.prettierrc` sets `endOfLine: lf` and `.gitattributes` sets `* text=auto
# eol=lf`, so CI's checkout is LF and the literal command is correct THERE. On
# a Windows working tree it is not: files an editor or an agent wrote land as
# CRLF, the literal command reports several hundred of them, and the real
# deviations drown in the noise — which is how 106 genuinely misformatted files
# sat unnoticed behind a "known bogus" number.
#
# `text=auto` normalises to LF in the index, so no file can reach CI with CRLF
# no matter what the working tree holds. Ignoring line endings here is
# therefore not a weaker check than CI's; it is the same check with a platform
# artefact removed. Set VERIFY_CI_STRICT_EOL=1 to run it literally.
format_check() {
  local eol=(--end-of-line auto)
  [[ -n "${VERIFY_CI_STRICT_EOL:-}" ]] && eol=()
  npx prettier --check "${eol[@]}" "**/*.{ts,tsx,json,md,yml,yaml}"
}
step "lint: format:check" format_check

# ─────────────────────────────────────────────────── job: typecheck ─────────
step "typecheck: pnpm -r run typecheck" \
  pnpm -r run typecheck

# ─────────────────────────────────────────────── job: backend tests ─────────
#
# CI runs `db:migrate` against a fresh service container first; locally the
# test database usually already has them and the command is idempotent.
#
# `migrate.ts` imports `core/logger.ts`, which calls `getConfig()`, so it needs
# the app's whole environment schema satisfied and not just DATABASE_URL. The
# workflow satisfies it from the job's `env:` block; these are the same
# throwaway values, defaulted so a real `backend/.env` still wins. They exist
# only to get past config validation — nothing here signs anything that leaves
# the machine.
db_migrate() {
  DATABASE_URL="$TEST_DB" \
  REDIS_URL="${REDIS_URL:-${TEST_REDIS_URL:-redis://:family@127.0.0.1:6379}}" \
  APP_PUBLIC_URL="${APP_PUBLIC_URL:-http://localhost:5173}" \
  JWT_ACCESS_SECRET="${JWT_ACCESS_SECRET:-ci-access-secret-not-used-anywhere-else-0123456789abcdef}" \
  JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-ci-refresh-secret-not-used-anywhere-else-0123456789abcde}" \
  COOKIE_SECRET="${COOKIE_SECRET:-ci-cookie-secret-not-used-anywhere-else-0123456789abcdef}" \
  ENCRYPTION_KEY="${ENCRYPTION_KEY:-Y2ktZW5jcnlwdGlvbi1rZXktMzItYnl0ZXMtbG9uZyE=}" \
  VAPID_SUBJECT="${VAPID_SUBJECT:-mailto:ci@example.com}" \
    pnpm --filter @family/backend run db:migrate
}
step "backend: db:migrate (test database)" db_migrate

# `test:cov`, not `test` — the coverage provider instruments differently and
# the point of this script is to run what CI runs.
#
# TEST_S3_* is passed because the CI job now provides a RustFS service
# container and therefore runs the object-storage suite. Without it here,
# `avatar.integration.test.ts` gates itself off and this script reports 1026
# passing tests for a CI job that will run 1040 — a local gate that is quieter
# than the real one, which is the failure mode this whole file exists to end.
# Start it with the rest of the dev stack:
#
#     docker compose -f infra/docker-compose.dev.yml up -d
#
# The report at the bottom warns on any non-zero skip count for the same reason.
BACKEND_LOG="${TMPDIR:-/tmp}/verify-ci-backend.log"
backend_tests() {
  # `pipefail` is set, so vitest's exit status survives the tee.
  (cd backend && TEST_DATABASE_URL="$TEST_DB"     TEST_S3_ENDPOINT="$TEST_S3" TEST_S3_ACCESS_KEY_ID="$S3_KEY"     TEST_S3_SECRET_ACCESS_KEY="$S3_SECRET"     pnpm run test:cov 2>&1) | tee "$BACKEND_LOG"
}
step "backend: test:cov (Postgres + Redis + object storage — same as CI)" backend_tests

# ────────────────────────────────────────────── job: frontend tests ─────────
step "frontend: test:cov" \
  pnpm --filter @family/frontend run test:cov

# ────────────────────────────────────────────── job: frontend build ─────────
#
# The workflow passes empty placeholders for the three VITE_* build args — the
# published image is built with the real ones and this job only proves the
# bundle compiles. Matching that keeps a stray local `.env` from changing the
# result.
frontend_build() {
  VITE_API_URL='' VITE_VAPID_PUBLIC_KEY='' VITE_TELEGRAM_BOT_USERNAME='' \
    pnpm --filter @family/frontend run build
}
step "frontend: production build" frontend_build

# The workflow's own assertion. vite-plugin-pwa in injectManifest mode fails
# silently when `src/sw.ts` drops out of the build, and the PWA then ships with
# no push handler — which nobody notices until a notification does not arrive.
#
# Either filename counts: the plugin's `filename` option decides which one is
# emitted. The workflow used to spell this as `ls sw.js service-worker.js`,
# which exits non-zero when EITHER is missing, so it demanded both and failed
# every healthy build.
assert_service_worker() {
  test -f frontend/dist/index.html || { echo "no frontend/dist/index.html"; return 1; }
  if [ ! -f frontend/dist/sw.js ] && [ ! -f frontend/dist/service-worker.js ]; then
    echo "No service worker in frontend/dist — looked for sw.js and service-worker.js;"
    echo "vite-plugin-pwa injectManifest did not run."
    ls -la frontend/dist
    return 1
  fi
  ls -la frontend/dist/sw.js frontend/dist/service-worker.js 2>/dev/null
  return 0
}
step "frontend: service worker emitted" assert_service_worker

# ───────────────────────────────────────────────────────── report ───────────
#
# A suite that skips itself quietly is how three sections of the app once
# shipped broken behind a green tick, so any skip is surfaced next to the
# pass/fail count rather than left in the scrollback. CI now runs the whole
# 1040 — Postgres, Redis and object storage all provided — so a skip here means
# this run checked LESS than the push will, which is worth a warning even
# though the gate itself passed.
if [[ -f "$BACKEND_LOG" ]]; then
  # vitest colours its summary, so strip the escape sequences before matching.
  skips="$(sed -e 's/\x1b\[[0-9;]*m//g' "$BACKEND_LOG" \
    | grep -aoE 'Tests +[0-9]+ passed \| [0-9]+ skipped' | tail -1)"
  if [[ -n "$skips" ]]; then
    printf '\n\033[1;33m── backend: %s\033[0m\n' "$skips"
    printf '   CI runs these. Something they need is not up locally — usually the\n'
    printf '   object store: docker compose -f infra/docker-compose.dev.yml up -d\n'
  fi
fi

printf '\n\033[1m═══ %d passed, %d failed ═══\033[0m\n' "$PASS" "$FAIL"
for f in "${FAILED[@]:-}"; do [[ -n "$f" ]] && printf '  \033[1;31m✗\033[0m %s\n' "$f"; done

if [[ $FAIL -eq 0 ]]; then
  printf '\n\033[1;32mSeven of the eight CI jobs pass.\033[0m\n'
  printf 'Not run here: the `e2e` job (Playwright, ~4 minutes) and the two Docker image\n'
  printf 'builds, which live in docker.yml. `infra/scripts/verify-all.sh` covers both —\n'
  printf 'run it before pushing anything that touches the app itself.\n'
fi

[[ $FAIL -eq 0 ]]
