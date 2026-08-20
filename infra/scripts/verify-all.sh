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
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_DB="${TEST_DATABASE_URL:-postgres://family:family@127.0.0.1:5432/family_test}"
API_PORT="${API_PORT:-3100}"
TEST_S3="${TEST_S3_ENDPOINT:-http://127.0.0.1:9000}"
S3_KEY="${TEST_S3_ACCESS_KEY_ID:-family}"
S3_SECRET="${TEST_S3_SECRET_ACCESS_KEY:-familysecret}"
WEB_PORT=5173   # not negotiable: the backend's CORS allow-list holds only this origin

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
  return 0
}
trap cleanup EXIT

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

# ------------------------------------------------------------------ e2e ----
printf '\n\033[1;36m── starting the stack for e2e\033[0m\n'
(cd backend && BACKEND_PORT="$API_PORT" npx tsx --env-file-if-exists=.env src/main.ts \
  >/tmp/verify-api.log 2>&1) &
API_PID=$!
(cd frontend && npx vite preview --port "$WEB_PORT" --strictPort \
  >/tmp/verify-web.log 2>&1) &
WEB_PID=$!

for _ in $(seq 1 60); do
  api_up=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/health" 2>/dev/null)
  web_up=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/" 2>/dev/null)
  [[ "$api_up" == "200" && "$web_up" == "200" ]] && break
done
echo "   api=$api_up web=$web_up"

if [[ "$api_up" == "200" && "$web_up" == "200" ]]; then
  step "e2e: whole app (smoke + deep)" bash -c \
    "cd frontend && E2E_BASE_URL=http://127.0.0.1:$WEB_PORT E2E_API_URL=http://127.0.0.1:$API_PORT \
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
