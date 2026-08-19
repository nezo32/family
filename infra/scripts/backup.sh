#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Family App — nightly Postgres backup.
#
#   pg_dump -> gzip -> sha256 sidecar -> verify read-back -> rotate
#
# Usage (from the repository root):
#     ./infra/scripts/backup.sh
#
# Cron on the VDI (03:17 keeps it off the top-of-hour thundering herd):
#     17 3 * * * cd /srv/family && ./infra/scripts/backup.sh >> /var/log/family-backup.log 2>&1
#
# Environment (all optional, all overridable):
#     BACKUP_DIR      where dumps live                 (default ./backups)
#     BACKUP_KEEP     how many dumps to retain         (default 14)
#     COMPOSE_FILE    compose file to talk to          (default infra/docker-compose.yml)
#     ENV_FILE        env file with POSTGRES_*         (default .env)
#     PG_SERVICE      compose service name             (default postgres)
#
# A backup this script writes is NOT considered good until restore-check.sh has
# loaded it into a throwaway database. Run that on a schedule too.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

# --- locate the repo root regardless of where we were invoked from ----------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-.env}"
PG_SERVICE="${PG_SERVICE:-postgres}"

log() { printf '%s [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  printf '%s [backup] FATAL %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  exit 1
}

# --- single-instance guard --------------------------------------------------
# A long dump overlapping the next cron tick doubles IO and can produce a
# truncated file. flock is a no-op cost when uncontended.
LOCK_FILE="${BACKUP_DIR}/.backup.lock"
mkdir -p "${BACKUP_DIR}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  flock -n 9 || die "another backup is already running (${LOCK_FILE})"
fi

# --- credentials ------------------------------------------------------------
[ -f "${ENV_FILE}" ] || die "env file not found: ${ENV_FILE}"
set -a
# shellcheck disable=SC1090,SC1091
. "${ENV_FILE}"
set +a

: "${POSTGRES_USER:?POSTGRES_USER missing from ${ENV_FILE}}"
: "${POSTGRES_DB:?POSTGRES_DB missing from ${ENV_FILE}}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD missing from ${ENV_FILE}}"

COMPOSE=(docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}")

"${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx "${PG_SERVICE}" \
  || die "compose service '${PG_SERVICE}' is not running — nothing to back up"

# --- dump -------------------------------------------------------------------
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
BASENAME="${POSTGRES_DB}-${STAMP}.sql.gz"
TARGET="${BACKUP_DIR}/${BASENAME}"
TMP="${TARGET}.partial"

# Anything that dies mid-dump must not leave a plausible-looking file behind:
# a half-written backup is worse than no backup, because it looks like one.
cleanup_partial() { rm -f -- "${TMP}"; }
trap cleanup_partial ERR INT TERM

log "dumping database '${POSTGRES_DB}' -> ${TARGET}"

# --format=plain + gzip rather than --format=custom, so that a human with
# nothing but zcat and psql can restore at 3am. --compress=0 stops pg_dump
# first (double compression wastes CPU for ~0 gain).
#
# `exec -T` disables TTY allocation, which is mandatory under cron: without it
# docker writes CR bytes into the stream and the gzip is corrupt.
"${COMPOSE[@]}" exec -T \
  -e PGPASSWORD="${POSTGRES_PASSWORD}" \
  "${PG_SERVICE}" \
  pg_dump \
  --username="${POSTGRES_USER}" \
  --dbname="${POSTGRES_DB}" \
  --format=plain \
  --compress=0 \
  --clean \
  --if-exists \
  --quote-all-identifiers \
  --no-password \
  | gzip -9 >"${TMP}"

# PIPESTATUS[0] is pg_dump's status. Without this check a failing pg_dump still
# produces a perfectly valid gzip of an error-free-looking partial dump.
PG_STATUS="${PIPESTATUS[0]}"
[ "${PG_STATUS}" -eq 0 ] || die "pg_dump exited ${PG_STATUS}"

[ -s "${TMP}" ] || die "dump is empty"

# --- integrity --------------------------------------------------------------
# gzip -t reads the whole stream and validates the CRC: catches a truncated
# write or a full disk before we ever consider this backup good.
gzip -t "${TMP}" || die "gzip integrity check failed"

# Sanity check the payload, not just the container format. A dump that restores
# to an empty database is a silent catastrophe.
if ! gzip -cd "${TMP}" | grep -qE '^(CREATE TABLE|COPY )' ; then
  die "dump contains no CREATE TABLE/COPY statements — refusing to keep it"
fi

mv -f -- "${TMP}" "${TARGET}"
trap - ERR INT TERM

( cd "${BACKUP_DIR}" && sha256sum "${BASENAME}" > "${BASENAME}.sha256" )
( cd "${BACKUP_DIR}" && sha256sum -c "${BASENAME}.sha256" >/dev/null ) \
  || die "checksum verification failed immediately after write"

SIZE="$(du -h "${TARGET}" | cut -f1)"
log "wrote ${BASENAME} (${SIZE}) + sha256"

# `latest` is what restore-check.sh and any panic-driven human reaches for.
ln -sfn "${BASENAME}" "${BACKUP_DIR}/latest.sql.gz"
ln -sfn "${BASENAME}.sha256" "${BACKUP_DIR}/latest.sql.gz.sha256"

# --- rotation ---------------------------------------------------------------
# Keep the newest N dumps. Sorted by filename, which is safe because the stamp
# is a zero-padded UTC ISO-ish string — never sort by mtime, `touch` lies.
log "rotating: keeping the newest ${BACKUP_KEEP}"
mapfile -t ALL < <(find "${BACKUP_DIR}" -maxdepth 1 -type f -name "${POSTGRES_DB}-*.sql.gz" -printf '%f\n' | sort -r)
if [ "${#ALL[@]}" -gt "${BACKUP_KEEP}" ]; then
  for old in "${ALL[@]:${BACKUP_KEEP}}"; do
    log "  removing ${old}"
    rm -f -- "${BACKUP_DIR}/${old}" "${BACKUP_DIR}/${old}.sha256"
  done
fi

log "done — ${BACKUP_DIR} now holds $(find "${BACKUP_DIR}" -maxdepth 1 -type f -name "${POSTGRES_DB}-*.sql.gz" | wc -l) dump(s)"
log "REMINDER: a backup is only a backup once restore-check.sh has replayed it"
