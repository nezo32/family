#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Family App — restore verification.
#
# Loads a dump into a THROWAWAY Postgres container, on a private network, with
# a random port and a random password, and asserts the schema actually arrived.
# It never touches the production database or the production volume.
#
# Per the product research: an unverified backup is not a backup. This is the
# script that turns "we have dumps" into "we can restore".
#
# Usage (from anywhere):
#     ./infra/scripts/restore-check.sh                 # newest dump
#     ./infra/scripts/restore-check.sh backups/family-20260819-031700Z.sql.gz
#
# Environment:
#     BACKUP_DIR        where to look for dumps    (default ./backups)
#     ENV_FILE          source of POSTGRES_USER/DB (default .env)
#     PG_IMAGE          verification image         (default postgres:17.7-alpine)
#     REQUIRED_TABLES   space-separated must-exist (default users user_identities family_settings)
#     MIN_TABLES        minimum public tables      (default 10)
#     KEEP_CONTAINER    set to 1 to leave it up for poking around
#
# Exit code is 0 only if every assertion passed. Wire it into cron and alert on
# non-zero — a silent restore-check is the same as no restore-check.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
ENV_FILE="${ENV_FILE:-.env}"
PG_IMAGE="${PG_IMAGE:-postgres:17.7-alpine}"
REQUIRED_TABLES="${REQUIRED_TABLES:-users user_identities family_settings}"
MIN_TABLES="${MIN_TABLES:-10}"
KEEP_CONTAINER="${KEEP_CONTAINER:-0}"

log() { printf '%s [restore-check] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  printf '%s [restore-check] FAIL %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  exit 1
}

# --- which dump ------------------------------------------------------------
DUMP="${1:-}"
if [ -z "${DUMP}" ]; then
  # Newest by filename (the stamp sorts lexicographically), not by mtime.
  DUMP="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name '*.sql.gz' -printf '%f\n' \
    | sort -r | head -n 1 || true)"
  [ -n "${DUMP}" ] || die "no *.sql.gz found in ${BACKUP_DIR}"
  DUMP="${BACKUP_DIR}/${DUMP}"
fi
[ -f "${DUMP}" ] || die "dump not found: ${DUMP}"
DUMP="$(cd -- "$(dirname -- "${DUMP}")" && pwd)/$(basename -- "${DUMP}")"

log "verifying ${DUMP}"

# --- credentials (role names must match, or every GRANT in the dump fails) --
if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090,SC1091
  . "${ENV_FILE}"
  set +a
fi
PGUSER_NAME="${POSTGRES_USER:-family}"
PGDB_NAME="${POSTGRES_DB:-family}"
# Deliberately NOT the production password. This database is ephemeral and
# never leaves the container's own network namespace.
TMP_PASSWORD="verify-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"

# --- assertion 1: the checksum sidecar, if present -------------------------
if [ -f "${DUMP}.sha256" ]; then
  ( cd -- "$(dirname -- "${DUMP}")" && sha256sum -c "$(basename -- "${DUMP}").sha256" >/dev/null ) \
    || die "sha256 mismatch — the dump on disk is not the dump that was written"
  log "PASS  sha256 sidecar matches"
else
  log "WARN  no .sha256 sidecar next to this dump"
fi

# --- assertion 2: it is a valid gzip stream --------------------------------
gzip -t "${DUMP}" || die "gzip integrity check failed"
log "PASS  gzip stream intact"

# --- throwaway instance ----------------------------------------------------
CONTAINER="family-restore-check-$$"
cleanup() {
  if [ "${KEEP_CONTAINER}" = "1" ]; then
    log "KEEP_CONTAINER=1 — leaving ${CONTAINER} running; remove it with: docker rm -f ${CONTAINER}"
    return
  fi
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

log "starting throwaway ${PG_IMAGE} as ${CONTAINER}"
# No -p: nothing is published to the host. No volume: the data dies with the
# container. --network none is not usable (docker exec still needs the daemon,
# but psql runs inside), so we simply never expose a port.
docker run -d --rm \
  --name "${CONTAINER}" \
  -e POSTGRES_USER="${PGUSER_NAME}" \
  -e POSTGRES_PASSWORD="${TMP_PASSWORD}" \
  -e POSTGRES_DB="${PGDB_NAME}" \
  -e POSTGRES_INITDB_ARGS='--encoding=UTF8 --locale=C' \
  -v "${REPO_ROOT}/infra/postgres/init:/docker-entrypoint-initdb.d:ro" \
  --tmpfs /var/lib/postgresql/data:rw,size=2g \
  "${PG_IMAGE}" >/dev/null

log "waiting for it to accept connections"
READY=0
for _ in $(seq 1 60); do
  if docker exec "${CONTAINER}" pg_isready -U "${PGUSER_NAME}" -d "${PGDB_NAME}" -h 127.0.0.1 >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
[ "${READY}" = "1" ] || { docker logs "${CONTAINER}" 2>&1 | tail -30; die "throwaway postgres never became ready"; }
log "PASS  throwaway instance is up"

# --- assertion 3: the dump replays without a single error ------------------
# ON_ERROR_STOP=1 is the whole point. Without it psql happily prints errors and
# exits 0, which is exactly how people discover at 3am that their restore
# "worked" but half the tables are missing.
log "replaying dump (ON_ERROR_STOP=1)"
RESTORE_LOG="$(mktemp)"
if ! gzip -cd "${DUMP}" | docker exec -i \
  -e PGPASSWORD="${TMP_PASSWORD}" \
  "${CONTAINER}" \
  psql --username="${PGUSER_NAME}" --dbname="${PGDB_NAME}" \
  --set=ON_ERROR_STOP=1 --quiet --no-psqlrc >"${RESTORE_LOG}" 2>&1
then
  tail -40 "${RESTORE_LOG}" >&2
  rm -f "${RESTORE_LOG}"
  die "psql refused the dump — this backup is NOT restorable"
fi
rm -f "${RESTORE_LOG}"
log "PASS  dump replayed cleanly"

psql_q() {
  docker exec -e PGPASSWORD="${TMP_PASSWORD}" "${CONTAINER}" \
    psql --username="${PGUSER_NAME}" --dbname="${PGDB_NAME}" \
    --no-psqlrc --tuples-only --no-align --command "$1"
}

# --- assertion 4: the schema is actually there -----------------------------
TABLE_COUNT="$(psql_q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';" | tr -d '[:space:]')"
log "public schema has ${TABLE_COUNT} table(s)"
[ "${TABLE_COUNT}" -ge "${MIN_TABLES}" ] \
  || die "expected at least ${MIN_TABLES} tables, found ${TABLE_COUNT} — the dump is structurally empty"

MISSING=""
for t in ${REQUIRED_TABLES}; do
  EXISTS="$(psql_q "select to_regclass('public.${t}') is not null;" | tr -d '[:space:]')"
  if [ "${EXISTS}" != "t" ]; then
    MISSING="${MISSING} ${t}"
  fi
done
[ -z "${MISSING}" ] || die "required table(s) missing from the restored database:${MISSING}"
log "PASS  required tables present: ${REQUIRED_TABLES}"

# --- assertion 5: migration bookkeeping survived ---------------------------
# drizzle records applied migrations in drizzle.__drizzle_migrations. If that
# is gone, a restored database will happily re-run every migration on boot.
DRIZZLE="$(psql_q "select to_regclass('drizzle.__drizzle_migrations') is not null;" | tr -d '[:space:]')"
if [ "${DRIZZLE}" = "t" ]; then
  APPLIED="$(psql_q "select count(*) from drizzle.__drizzle_migrations;" | tr -d '[:space:]')"
  log "PASS  drizzle migration ledger restored (${APPLIED} migration(s) recorded)"
else
  log "WARN  drizzle.__drizzle_migrations not found — a restore would re-run migrations"
fi

# --- assertion 6: extensions came back -------------------------------------
for ext in pgcrypto citext; do
  HAS="$(psql_q "select count(*) from pg_extension where extname='${ext}';" | tr -d '[:space:]')"
  [ "${HAS}" = "1" ] || die "extension '${ext}' missing after restore"
done
log "PASS  extensions present (pgcrypto, citext)"

# --- assertion 7: there is data, not just structure ------------------------
# A schema-only dump restores perfectly and tells you nothing. `users` must
# have at least the bootstrap owner in any real deployment.
if [ "$(psql_q "select to_regclass('public.users') is not null;" | tr -d '[:space:]')" = "t" ]; then
  USER_ROWS="$(psql_q "select count(*) from public.users;" | tr -d '[:space:]')"
  if [ "${USER_ROWS}" -gt 0 ]; then
    log "PASS  data restored (users: ${USER_ROWS} row(s))"
  else
    log "WARN  users table is empty — expected on a brand-new deployment, alarming otherwise"
  fi
fi

log "──────────────────────────────────────────────"
log "RESTORE VERIFIED: $(basename -- "${DUMP}")"
log "──────────────────────────────────────────────"
