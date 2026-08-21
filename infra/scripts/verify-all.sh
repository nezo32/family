#!/usr/bin/env bash
#
# Full-stack verification.
#
#   ./infra/scripts/verify-all.sh
#
# Runs every gate in dependency order and keeps going after a failure so one
# run tells you everything that is broken rather than only the first thing.
# Exits non-zero if any gate failed.
#
# Needs Postgres and Redis up:
#   docker compose -f infra/docker-compose.dev.yml up -d
#
# It also builds both Docker images (the `build` stage only). Set
# SKIP_IMAGE_BUILDS=1 to leave them out — but read why they are here first, in
# the `images` block below.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_DB="${TEST_DATABASE_URL:-postgres://family:family@127.0.0.1:5432/family_test}"
API_PORT="${API_PORT:-3102}"
TEST_S3="${TEST_S3_ENDPOINT:-http://127.0.0.1:9000}"
S3_KEY="${TEST_S3_ACCESS_KEY_ID:-family}"
S3_SECRET="${TEST_S3_SECRET_ACCESS_KEY:-familysecret}"
WEB_PORT="${WEB_PORT:-5175}"

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

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null
  [[ -n "${FRONTEND_IMAGE_PID:-}" ]] && kill "$FRONTEND_IMAGE_PID" 2>/dev/null
  [[ -n "${BACKEND_IMAGE_PID:-}" ]] && kill "$BACKEND_IMAGE_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

# --------------------------------------------------------------- images ----
#
# ── Why the image builds are in here, and why they start first ─────────────
#
# Everything above and below this runs against the *working tree*. The images
# do not: `.dockerignore` deliberately withholds parts of it (`**/e2e`,
# `**/dist`, `docs`, `.env*`), so a file that compiles here can fail to compile
# in the container because something it imports was never copied in. That is
# not hypothetical — `playwright.config.ts` importing `RUN_ID` from
# `e2e/helpers.ts` passed three consecutive green runs of this script and broke
# the production image build for forty minutes, because nothing here ever built
# an image. CI catches it, but only after a push.
#
# `--target build` is the whole point: it stops at the stage where `tsc` and
# `vite build` run — which is where this class of failure lives — and skips the
# runtime stage (Caddy config, the pnpm-symlink-graph copy, healthchecks),
# which is slow and not what we are testing. Both images, because both compile
# TypeScript against a filtered context and the risk is identical.
#
# The cost is close to zero because they are started HERE, before the first
# gate, and only collected after the frontend production build: BuildKit runs
# them while the backend integration suite (the long pole, minutes) is running.
# Layer caching means an unchanged dependency set replays instantly and only
# the compile stage re-runs. Second-order benefit: this keeps the pnpm store
# cache mount warm, so CI-shaped builds are not the only place they happen.
#
# They are ON BY DEFAULT on purpose. A flag would mean nobody runs them, which
# is exactly the state that let the last one through.

FRONTEND_IMAGE_LOG="${TMPDIR:-/tmp}/verify-image-frontend.log"
BACKEND_IMAGE_LOG="${TMPDIR:-/tmp}/verify-image-backend.log"

# Collects a build started below. Used as a `step` command so a failure lands in
# the same report as everything else.
#
# `wait` only works on a child of THIS shell, which is why the two builds are
# launched inline further down rather than from a `start_image_build` helper —
# a `pid=$(helper)` would run the `&` inside the command-substitution subshell
# and the pid would not be waitable here.
await_image_build() {
  local pid="$1" log="$2"
  if wait "$pid"; then
    return 0
  fi
  tail -30 "$log"
  return 1
}

IMAGE_BUILDS=0
if [[ -n "${SKIP_IMAGE_BUILDS:-}" ]]; then
  printf '\n\033[1;33m── docker images: skipped (SKIP_IMAGE_BUILDS)\033[0m\n'
elif ! command -v docker >/dev/null 2>&1; then
  printf '\n\033[1;33m── docker images: skipped (no docker on PATH)\033[0m\n'
else
  printf '\n\033[1;36m── docker images: building `build` stage in the background\033[0m\n'
  docker build -f frontend/Dockerfile --target build -t family-frontend-verify . >"$FRONTEND_IMAGE_LOG" 2>&1 &
  FRONTEND_IMAGE_PID=$!
  docker build -f backend/Dockerfile --target build -t family-backend-verify . >"$BACKEND_IMAGE_LOG" 2>&1 &
  BACKEND_IMAGE_PID=$!
  IMAGE_BUILDS=1
fi

# ---------------------------------------------------------------- build ----
step "shared: build"        bash -c 'pnpm --filter @family/shared build >/dev/null 2>&1'
step "backend: typecheck"   bash -c 'cd backend && npx tsc --noEmit'
step "frontend: typecheck"  bash -c 'cd frontend && npx tsc -b --noEmit'

# ----------------------------------------------------------------- lint ----
step "backend: lint"        bash -c 'cd backend && npx eslint src --max-warnings 100'
step "frontend: lint"       bash -c 'cd frontend && npx eslint src --max-warnings 100'

# ---------------------------------------------------------------- tests ----
# The DB-backed suites are the ones that matter: the unit suites were green
# while three sections of the app were 500ing in production.
# Object storage too, or the avatar suite silently skips itself and the whole
# upload path ships unexercised.
step "backend: tests (database + object storage)" \
  bash -c "cd backend && TEST_DATABASE_URL='$TEST_DB' \
    TEST_S3_ENDPOINT='$TEST_S3' TEST_S3_ACCESS_KEY_ID='$S3_KEY' \
    TEST_S3_SECRET_ACCESS_KEY='$S3_SECRET' npx vitest run"
step "frontend: tests"      bash -c 'cd frontend && npx vitest run'

# ---------------------------------------------------------------- build ----
step "frontend: production build" bash -c 'cd frontend && npx vite build >/dev/null'

# --------------------------------------------------------------- images ----
# Started before the first gate; by now they have had the whole run to finish.
if [[ "$IMAGE_BUILDS" == "1" ]]; then
  step "frontend: docker image (build stage)" await_image_build "$FRONTEND_IMAGE_PID" "$FRONTEND_IMAGE_LOG"
  step "backend: docker image (build stage)"  await_image_build "$BACKEND_IMAGE_PID" "$BACKEND_IMAGE_LOG"
  FRONTEND_IMAGE_PID=""; BACKEND_IMAGE_PID=""
fi

# ------------------------------------------------------------------ e2e ----
#
# `localhost` and `127.0.0.1` are different origins to CORS, and the backend
# builds its allow-list from APP_PUBLIC_URL — so both halves use `localhost`.
# RATE_LIMIT_FACTOR keeps a ~90-context suite from tripping the refresh limit;
# it is forced to 1 in production regardless.
printf '\n\033[1;36m── stack for e2e\033[0m\n'

# Object storage, said out loud before a single spec runs.
#
# Three specs in `wall-media.spec.ts` upload real bytes, and `uploadMedia()`
# opens with `requireStorage()` — so a missing object store does not *skip*
# them, it fails them: six failures across the two browser projects, thirty
# seconds apart, and the loudest of them asserts a refusal, so it reads as a
# broken assertion about file formats rather than as a missing service. CI
# spent a red run being read that way. One curl says it in one line instead,
# and `.github/workflows/ci.yml` now asserts the same thing twice in the job
# this section is a transcription of.
s3_up=$(curl -s -o /dev/null -w '%{http_code}' "$TEST_S3/health" 2>/dev/null)
if [[ "$s3_up" != "200" ]]; then
  printf '\033[1;31m   object storage is not answering at %s (http %s)\033[0m\n' "$TEST_S3" "$s3_up"
  printf '   the media specs will fail on the wrong error until it is up:\n'
  printf '     docker compose -f infra/docker-compose.dev.yml up -d rustfs\n'
  FAIL=$((FAIL + 1))
  FAILED+=("e2e: object storage unreachable at $TEST_S3 — the media specs cannot pass")
fi

api_up=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/health" 2>/dev/null)
web_up=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$WEB_PORT/" 2>/dev/null)

if [[ "$api_up" == "200" && "$web_up" == "200" ]]; then
  echo "   reusing the stack already on :$API_PORT and :$WEB_PORT"
else
  echo "   starting api on :$API_PORT and preview on :$WEB_PORT"
  (cd backend && BACKEND_PORT="$API_PORT" APP_PUBLIC_URL="http://localhost:$WEB_PORT" \
    RATE_LIMIT_FACTOR=100 S3_ENDPOINT="$TEST_S3" S3_ACCESS_KEY_ID="$S3_KEY" \
    S3_SECRET_ACCESS_KEY="$S3_SECRET" S3_BUCKET=family-media \
    npx tsx --env-file-if-exists=.env src/main.ts >/tmp/verify-api.log 2>&1) &
  API_PID=$!
  (cd frontend && VITE_API_PROXY_TARGET="http://localhost:$API_PORT" \
    npx vite preview --port "$WEB_PORT" --strictPort >/tmp/verify-web.log 2>&1) &
  WEB_PID=$!

  for _ in $(seq 1 60); do
    api_up=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/health" 2>/dev/null)
    web_up=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$WEB_PORT/" 2>/dev/null)
    [[ "$api_up" == "200" && "$web_up" == "200" ]] && break
    sleep 1
  done
fi
echo "   api=$api_up web=$web_up"

# Reachable is only half of it: the API also has to have been *told*.
# `storage.routes.ts` logs one of two lines from an `onReady` hook, which runs
# before the server listens — so whichever line it is, it is already in the log
# by the time /health answers. Only when this run started the API itself: a
# reused stack's log belongs to whoever started it, and a stale line from an
# earlier one would be a false alarm.
if [[ -n "${API_PID:-}" ]] && grep -q 'object storage is not configured' /tmp/verify-api.log 2>/dev/null; then
  printf '\033[1;31m   the API on :%s booted with no object storage configured\033[0m\n' "$API_PORT"
  printf '   POST /api/media answers 503, so the upload specs fail on the wrong sentence.\n'
  FAIL=$((FAIL + 1))
  FAILED+=("e2e: the API has no object storage configured — the media specs cannot pass")
fi

if [[ "$api_up" == "200" && "$web_up" == "200" ]]; then
  step "e2e: whole app (smoke + deep)" bash -c \
    "cd frontend && E2E_BASE_URL=http://localhost:$WEB_PORT E2E_API_URL=http://localhost:$WEB_PORT \
     npx playwright test --reporter=line"
else
  echo "   could not start the stack; see /tmp/verify-api.log and /tmp/verify-web.log"
  tail -20 /tmp/verify-api.log
  FAIL=$((FAIL + 1)); FAILED+=("e2e: stack did not start")
fi

# --------------------------------------------------------------- report ----
printf '\n\033[1m═══ %d passed, %d failed ═══\033[0m\n' "$PASS" "$FAIL"
for f in "${FAILED[@]:-}"; do [[ -n "$f" ]] && printf '  \033[1;31m✗\033[0m %s\n' "$f"; done
[[ $FAIL -eq 0 ]]
