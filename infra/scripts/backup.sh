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
#     RUSTFS_SERVICE  object-storage service name      (default rustfs)
#     RUSTFS_VOLUME   its data volume                  (default: discovered)
#     TAR_IMAGE       image used to read that volume   (default postgres:17.7-alpine)
#     SKIP_OBJECTS    set to 1 to dump Postgres only
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
RUSTFS_SERVICE="${RUSTFS_SERVICE:-rustfs}"
TAR_IMAGE="${TAR_IMAGE:-postgres:17.7-alpine}"
SKIP_OBJECTS="${SKIP_OBJECTS:-0}"

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

# ─────────────────────────────────────────────────────────────────────────────
# Object storage (user avatars)
# ─────────────────────────────────────────────────────────────────────────────
# Postgres is not the whole of the durable state any more. `users.avatar_url`
# holds an API path pointing at an object in the RustFS bucket, and a database
# restored without that bucket gives every member a broken face and no way to
# tell which photo was theirs. Avatars are the *only* other durable state, so
# covering them here makes "restore the backup" mean the whole application
# again.
#
# Self-contained on purpose — one function, called once, touching nothing above
# or below it — because the retention and scheduling around it are being
# reworked separately. **It deliberately does not rotate its own archives**: a
# second retention policy living here would have to be reconciled with that
# rework. Fold `${S3_BUCKET}-*.tar.gz` into the rotation block when it lands.
#
# ## Why a volume tar rather than an S3 client
#
# `aws s3 sync` or `mc mirror` would produce a nicer, object-level archive — and
# would put a ~400 MB image and a set of credentials into the backup path for a
# few dozen small files. Reading the volume directly needs neither: the archive
# is a plain `tar.gz` any human can list with `tar -tzf` and restore with `tar
# -xzf` into a fresh volume, and the image doing the reading is one the stack
# has already pulled.
#
# ## Consistency
#
# This reads a live volume, so in principle a write in flight could be caught
# half-done. In practice avatar objects are write-once — a replacement is a new
# key and a delete of the old one, never an in-place edit — so the worst case is
# one object written during the exact second of the tar, which the next run
# picks up. Stopping RustFS for a consistent snapshot would trade a theoretical
# torn avatar for real downtime, every night.
backup_object_storage() {
  local stamp="$1"

  if [ "${SKIP_OBJECTS}" = "1" ]; then
    log "objects: skipped (SKIP_OBJECTS=1)"
    return 0
  fi

  # A deployment that never configured storage has no bucket and no avatars.
  # That is a valid configuration (the app boots and refuses uploads), so it is
  # a skip, not a failure.
  if [ -z "${S3_BUCKET:-}" ]; then
    log "objects: skipped (S3_BUCKET not set in ${ENV_FILE})"
    return 0
  fi

  if ! "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx "${RUSTFS_SERVICE}"; then
    log "objects: skipped ('${RUSTFS_SERVICE}' is not running)"
    return 0
  fi

  # Ask Docker which volume is actually mounted at /data rather than assuming
  # the name: a renamed compose project would otherwise back up nothing at all
  # and say nothing about it.
  local volume="${RUSTFS_VOLUME:-}"
  if [ -z "${volume}" ]; then
    local cid
    cid="$("${COMPOSE[@]}" ps -q "${RUSTFS_SERVICE}" 2>/dev/null | head -n 1)"
    [ -n "${cid}" ] || die "objects: could not resolve the '${RUSTFS_SERVICE}' container"
    volume="$(docker inspect -f \
      '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "${cid}")"
  fi
  [ -n "${volume}" ] || die "objects: no volume is mounted at /data in '${RUSTFS_SERVICE}'"

  local basename="${S3_BUCKET}-${stamp}.tar.gz"
  local target="${BACKUP_DIR}/${basename}"
  local tmp="${target}.partial"

  # Same rule as the dump above: nothing that dies mid-write may leave a
  # plausible-looking archive behind.
  cleanup_partial_objects() { rm -f -- "${tmp}"; }
  trap cleanup_partial_objects ERR INT TERM

  log "archiving bucket volume '${volume}' -> ${target}"

  # `-C /data .` keeps the paths relative, so the archive restores into any
  # volume rather than only into one called /data. Read-only mount: a backup
  # must not be able to damage what it is backing up.
  docker run --rm \
    -v "${volume}:/data:ro" \
    "${TAR_IMAGE}" \
    tar -cf - -C /data . \
    | gzip -9 >"${tmp}"

  local tar_status="${PIPESTATUS[0]}"
  [ "${tar_status}" -eq 0 ] || die "objects: tar exited ${tar_status}"
  [ -s "${tmp}" ] || die "objects: archive is empty"

  gzip -t "${tmp}" || die "objects: gzip integrity check failed"

  # Payload check, not just container format — the same reasoning as the
  # CREATE TABLE grep above. An archive of an empty volume is a valid gzip of a
  # valid tar and a catastrophe to discover during a restore. RustFS lays the
  # bucket out as `./<bucket>/<key>/`, so the bucket directory must be present.
  #
  # Except on the very first deploy after storage is introduced: the backend
  # creates the bucket lazily, on the first upload, so a freshly created volume
  # legitimately has no `./<bucket>` in it yet. Failing there aborted the entire
  # deploy — the backup runs before anything could ever have written an object.
  #
  # The two cases are told apart by whether a previous objects backup exists. A
  # bucket that has never existed is a skip; a bucket that has *stopped*
  # existing is exactly the disaster this check was written for, and must never
  # overwrite the last good archive.
  # Counted through a variable for the same SIGPIPE reason as the dump check
  # above: `tar -tf - <member>` can stop as soon as it finds the entry, and
  # under `pipefail` the upstream `gzip -cd` dying of SIGPIPE would be read as
  # "bucket absent" — discarding a perfectly good archive at random.
  BUCKET_ENTRIES="$(gzip -cd "${tmp}" | tar -tf - 2>/dev/null \
    | grep -cE "^\./${S3_BUCKET}(/|$)" || true)"
  if [ "${BUCKET_ENTRIES:-0}" -eq 0 ]; then
    rm -f -- "${tmp}"
    trap - ERR INT TERM
    if [ -e "${BACKUP_DIR}/latest-objects.tar.gz" ]; then
      die "objects: '${S3_BUCKET}' is missing from the volume but a previous backup exists — refusing to overwrite it"
    fi
    log "objects: skipped (bucket '${S3_BUCKET}' does not exist yet — nothing uploaded)"
    return 0
  fi

  # How many avatars we actually captured. Zero is legitimate (nobody has set a
  # photo yet) but it is worth saying out loud in the log rather than implying
  # a full backup.
  local objects
  objects="$(gzip -cd "${tmp}" | tar -tf - 2>/dev/null | grep -c "^\./${S3_BUCKET}/avatars/.*/xl\.meta$" || true)"

  mv -f -- "${tmp}" "${target}"
  trap - ERR INT TERM

  ( cd "${BACKUP_DIR}" && sha256sum "${basename}" > "${basename}.sha256" )
  ( cd "${BACKUP_DIR}" && sha256sum -c "${basename}.sha256" >/dev/null ) \
    || die "objects: checksum verification failed immediately after write"

  local size
  size="$(du -h "${target}" | cut -f1)"
  log "wrote ${basename} (${size}, ${objects} avatar object(s)) + sha256"

  # Paired with `latest.sql.gz`: a human restoring at 3am reaches for both, and
  # the two `latest` symlinks always point at the same STAMP.
  ln -sfn "${basename}" "${BACKUP_DIR}/latest-objects.tar.gz"
  ln -sfn "${basename}.sha256" "${BACKUP_DIR}/latest-objects.tar.gz.sha256"
}

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
#
# `grep -c`, not `grep -q`, and the count goes through a variable. Under
# `set -o pipefail` a `grep -q` exits the instant it matches, `gzip -cd` then
# dies of SIGPIPE, and the pipeline reports failure — so a *valid* dump is read
# as "no CREATE TABLE found" and thrown away. Whether it happens is a race
# between gzip finishing and grep short-circuiting, which at this dump's ~16KB
# it lost about half the time: the same backup passed at 00:19 and failed at
# 00:21 on identical data. `grep -c` consumes the whole stream, so gzip always
# finishes.
DUMP_STATEMENTS="$(gzip -cd "${TMP}" | grep -cE '^(CREATE TABLE|COPY )' || true)"
if [ "${DUMP_STATEMENTS:-0}" -eq 0 ]; then
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

# --- avatars ----------------------------------------------------------------
# Same STAMP as the dump above, so the pair is obviously a pair.
backup_object_storage "${STAMP}"

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
