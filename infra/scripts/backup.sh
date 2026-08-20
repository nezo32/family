#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Family App — nightly backup: the database, and the object store.
#
#   Postgres:  pg_dump -> gzip -> sha256 sidecar -> verify read-back -> rotate
#   Objects:   rsync the volume into backups/objects/ -> sha256 manifest
#
# Usage (from the repository root):
#     ./infra/scripts/backup.sh
#
# Cron on the VDI. `infra/scripts/vdi-bootstrap.sh` installs exactly this into
# /etc/cron.d/family-backup, and the two must not be allowed to drift again —
# they said 03:30 and 03:17 respectively for a while, and docs/DEPLOYMENT.md
# said a third thing:
#
#     CRON_TZ=Europe/Moscow
#     17 3 * * * root cd /opt/family && ./infra/scripts/backup.sh >>/var/log/family-backup.log 2>&1
#
# `CRON_TZ` is written down rather than inherited. The VDI's system zone is
# Europe/Moscow today, so it changes nothing — but "what time does the backup
# run" should be answerable from this file rather than from `timedatectl`, and
# the answer has to be comparable with the media sweep's.
#
# ## Why the time matters now
#
# 03:17 Moscow, and the media sweep (BullMQ, `20 5 * * *` in
# backend/src/core/queue/workers.ts) is 05:20 Moscow — the backend container has
# no tzdata, so `date` inside it prints UTC, but Node resolves TZ through ICU
# and `new Date()` there really is MSK. Verified on the VDI, not assumed.
#
# That leaves 2h03m between them, and it is a gap worth having, because the
# sweep is the one scheduled job that deletes from the very tree this script
# walks. They cannot meet: the mirror below finished a 100 MB volume in two
# seconds and an unchanged one in one. What they *can* meet is the hourly
# unclaimed-draft reaper, which has no window at all — handled where rsync's
# exit status is checked, not by scheduling.
#
# Environment (all optional, all overridable):
#     BACKUP_DIR          where dumps live                 (default ./backups)
#     BACKUP_KEEP         how many dumps to retain         (default 14, and
#                         clamped below MEDIA_ORPHAN_TTL_DAYS — see below)
#     BACKUP_READER       unix account the PC pulls as     (default familybackup)
#     COMPOSE_FILE        compose file to talk to          (default infra/docker-compose.yml)
#     ENV_FILE            env file with POSTGRES_*         (default .env)
#     PG_SERVICE          compose service name             (default postgres)
#     RUSTFS_SERVICE      object-storage service name      (default rustfs)
#     RUSTFS_VOLUME       its data volume                  (default: discovered)
#     OBJECTS_SUBDIR      mirror dir under BACKUP_DIR      (default objects)
#     OBJECTS_SYNC_IMAGE  image that reads that volume     (default instrumentisto/rsync-ssh:alpine)
#     SKIP_OBJECTS        set to 1 to dump Postgres only
#
# Read from ${ENV_FILE}, not from the command line:
#     S3_BUCKET               which bucket the volume holds (skip if unset)
#     MEDIA_ORPHAN_TTL_DAYS   see the retention clamp below — and read that
#                             note before setting it, because the backend
#                             does not currently read it
#
# A backup this script writes is NOT considered good until restore-check.sh has
# loaded it into a throwaway database. Run that on a schedule too.
#
# ─── Why objects are a mirror and not a nightly tarball ──────────────────────
#
# They used to be a tarball: `tar -cf - -C /data . | gzip -9`, every night, the
# whole volume, and the PC pulled the whole thing down a domestic line every
# night. That was defensible while the volume was six avatars. Media makes it
# the largest artefact in the system, so it was measured on this VDI against a
# 297 MB synthetic volume of incompressible objects, which is what photographs
# and H.264 are:
#
#     tar -cf - | gzip -9        17.2 s   ->  300 MB archive  (gzip gains 0%)
#     gzip -t on the result       1.7 s
#     tar -tf to count entries    2.0 s   (backup.sh did this TWICE)
#     sha256sum the archive       1.7 s
#     ----------------------------------------------------------------
#     rsync into a mirror         1.7 s cold, 0.68 s when nothing changed
#     sha256 manifest of it       1.7 s
#
# The archive is the problem, not the CPU. gzip cannot compress a JPEG, so the
# archive is the size of the data, it is rewritten in full nightly, it is
# re-transferred in full nightly, and — as `docs/DEPLOYMENT.md` §6 recorded —
# it was never rotated. The VDI has 13 GB free. At BACKUP_KEEP=14 the archive
# has to stay under ~900 MB or the disk fills and takes the whole stack with it
# — and the media limits are ten attachments per note at up to 100 MiB each, so
# **one post can be a gigabyte**. Nothing ever shrinks either: a deleted note
# keeps its bytes for thirty days and clearing the board deletes nothing at all.
# The ceiling is not months away; it is one bad afternoon with a camcorder.
#
# A mirror is one copy, not fourteen, it is updated in proportion to what
# CHANGED, and the PC pulls it the same way. Objects are immutable and named by
# content hash, so an incremental transfer is not merely an optimisation — a
# key that is already on the PC never needs to move again.
#
# ─── Consistency: this reads a LIVE volume ───────────────────────────────────
#
# Same as the tar before it, and the same guarantee: the volume is mounted
# read-only into a throwaway container, so nothing in the backup path can
# damage what it is backing up. RustFS stages writes under `.rustfs.sys/tmp`
# and renames into place, and an object is a directory holding `xl.meta`, so a
# reader sees an object either completely or not at all. Objects are also
# write-once: a replacement is a new key plus a delete, never an in-place edit.
#
# What this does NOT survive is a reader that runs for minutes while the store
# is being written. That is exactly why the PC does not rsync the live volume
# directly: this script takes the snapshot into backups/objects/ in about a
# second, and the PC then pulls a tree that nothing is writing to. Pointing the
# PC at the volume itself would have been one fewer copy and a live, moving
# target for the length of a domestic-line transfer.
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
OBJECTS_SUBDIR="${OBJECTS_SUBDIR:-objects}"
# Alpine + rsync, 25 MB. The same image the PC's puller runs, so the two ends of
# the object path are the same rsync, and there is one image to trust instead of
# two. TAR_IMAGE is still used by nothing here; it stays for the restore
# procedure in docs/DEPLOYMENT.md §8, which untars nothing but does mount the
# volume.
OBJECTS_SYNC_IMAGE="${OBJECTS_SYNC_IMAGE:-instrumentisto/rsync-ssh:alpine}"
# The account docs/DEPLOYMENT.md §8 creates for the PC to pull as. The mirror is
# useless if that account cannot traverse it, and the failure is silent from
# here — the server looks fine and the PC gets "Permission denied" once a day.
# Empty disables the ACL step entirely (a dev machine has no such user).
BACKUP_READER="${BACKUP_READER:-familybackup}"

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

# --- retention must not outlive the objects it references -------------------
# The media sweep deletes an object 30 days after the note holding it was
# soft-deleted, and 24 hours after an upload nobody ever attached. This script
# keeps BACKUP_KEEP nights of database dumps. If a dump outlives the objects its
# rows point at, restoring it produces cards pointing at nothing — a broken
# picture, discovered during a restore, which is the worst possible moment to
# discover anything.
#
# So: the media grace period must exceed BACKUP_KEEP.
#
# ## Where the 30 actually lives, and why this is not simply `.env`
#
# `docs/design/DESIGN.md` specifies `MEDIA_ORPHAN_TTL_DAYS` in `core/config.ts`.
# The implementation did not do that: the sweep's grace period is
# `DETACHED_GRACE_DAYS`, a **hardcoded const in
# backend/src/modules/storage/media.service.ts**, and nothing in the backend
# reads `MEDIA_ORPHAN_TTL_DAYS` at all.
#
# That makes the `.env` variable a trap rather than a knob. Setting it would
# have moved this script's half of the invariant and left the sweep at 30, with
# no error anywhere — the two numbers would silently disagree and the first
# symptom would be a restore producing broken cards. A knob that moves one of
# two coupled numbers is worse than no knob.
#
# So this takes the SMALLER of the two: whichever half is really in force, the
# invariant holds. And if they disagree it says so, loudly, every night, naming
# the file — because the disagreement is the bug, not the retention.
#
# Delete MEDIA_OBJECT_GRACE_DAYS_FALLBACK below the day `DETACHED_GRACE_DAYS`
# becomes `config.storage.orphanTtlDays` fed from `MEDIA_ORPHAN_TTL_DAYS`; this
# script already consumes that variable and needs no further change.
MEDIA_OBJECT_GRACE_DAYS_FALLBACK=30   # == DETACHED_GRACE_DAYS, media.service.ts

MEDIA_ORPHAN_TTL_DAYS="${MEDIA_ORPHAN_TTL_DAYS:-${MEDIA_OBJECT_GRACE_DAYS_FALLBACK}}"
case "${MEDIA_ORPHAN_TTL_DAYS}" in
  ''|*[!0-9]*) MEDIA_ORPHAN_TTL_DAYS="${MEDIA_OBJECT_GRACE_DAYS_FALLBACK}" ;;
esac

MEDIA_GRACE_DAYS="${MEDIA_ORPHAN_TTL_DAYS}"
if [ "${MEDIA_ORPHAN_TTL_DAYS}" -ne "${MEDIA_OBJECT_GRACE_DAYS_FALLBACK}" ]; then
  log "WARNING ${ENV_FILE} sets MEDIA_ORPHAN_TTL_DAYS=${MEDIA_ORPHAN_TTL_DAYS}, but the media sweep uses"
  log "WARNING DETACHED_GRACE_DAYS=${MEDIA_OBJECT_GRACE_DAYS_FALLBACK}, hardcoded in backend/src/modules/storage/media.service.ts."
  log "WARNING The backend does not read MEDIA_ORPHAN_TTL_DAYS, so setting it moves only this half."
  log "WARNING Using the smaller of the two so retention is safe either way."
  [ "${MEDIA_ORPHAN_TTL_DAYS}" -lt "${MEDIA_OBJECT_GRACE_DAYS_FALLBACK}" ] \
    || MEDIA_GRACE_DAYS="${MEDIA_OBJECT_GRACE_DAYS_FALLBACK}"
fi

# The clamp CLAMPS rather than fails, and the direction is not arbitrary. There
# are two ways to satisfy the invariant: keep fewer dumps, or keep objects
# longer. Only one of them is this script's to choose, and it is also the safe
# one — a dump that is not kept costs a night of history, whereas an object
# collected early is gone for good. Refusing to run would be worse than either:
# it would trade a hypothetical broken picture for no backup at all tonight.
if [ "${BACKUP_KEEP}" -ge "${MEDIA_GRACE_DAYS}" ]; then
  log "WARNING BACKUP_KEEP=${BACKUP_KEEP} is not less than the media grace period (${MEDIA_GRACE_DAYS} days)."
  log "WARNING A dump older than that references objects the sweep has already collected,"
  log "WARNING so restoring it would give the family broken cards. Clamping retention instead."
  BACKUP_KEEP="$(( MEDIA_GRACE_DAYS - 1 ))"
  [ "${BACKUP_KEEP}" -ge 1 ] || BACKUP_KEEP=1
  log "WARNING BACKUP_KEEP is ${BACKUP_KEEP} for this run."
fi

# Not clamped, and deliberately: unclaimed uploads are collected after 24 hours
# (DRAFT_TTL_HOURS), which is shorter than any retention this script could
# offer. A dump taken in that window holds a staged media row whose object is
# gone by the time it is restored — but a staged row is a draft nobody has ever
# seen, it is attached to no card, and the same sweep deletes the row again on
# its next pass. It is the one case where the invariant is allowed to fail,
# because failing costs nothing.

COMPOSE=(docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}")

"${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx "${PG_SERVICE}" \
  || die "compose service '${PG_SERVICE}' is not running — nothing to back up"

# ─────────────────────────────────────────────────────────────────────────────
# Object storage — the part of the backup that cannot be retyped
# ─────────────────────────────────────────────────────────────────────────────
# Postgres is not the whole of the durable state. `users.avatar_url` and every
# media attachment on Стена hold an API path pointing at an object in the
# RustFS bucket, and a database restored without that bucket gives every member
# a broken face and every note a grey rectangle, with no way to tell what was
# there. A task can be retyped. A photograph of somebody's child cannot — so
# this half of the backup is the half that has to be right.
#
# ## What it produces
#
#   backups/objects/            a mirror of the RustFS volume, updated in place
#   backups/objects.manifest    sha256 of every file in it, `sha256sum -c` format
#   backups/objects.manifest.sha256
#
# The manifest is the contract with the PC. The puller rsyncs the mirror, then
# checks its own copy against this file — an end-to-end check of every byte that
# survives the network, the disk on both ends, and rsync itself. It is far
# stronger than the old "the gzip stream decompressed" test, and it costs 1.7 s
# per 300 MB.
#
# ## Why a mirror and not `aws s3 sync`
#
# Unchanged from the tarball's reasoning: an S3 client puts a ~400 MB image and
# a second copy of the storage credentials into the backup path. Reading the
# volume needs neither, and what comes out is an ordinary directory tree that a
# human can open in Explorer.
#
# ## What is and is not excluded
#
# `.rustfs.sys` goes into the mirror. It holds `format.json`, `pool.bin` and the
# per-bucket metadata that make the directory a RustFS disk rather than a pile
# of files; restoring the bucket without it gives a server that starts and
# cannot see the bucket. It is a few KB. Being tidy there would cost a restore.
#
# Its `tmp/` and `multipart/` subtrees are the exception, and they are excluded
# for a reason that only showed up under test rather than by reading the code:
# **RustFS implements a delete by moving the object into
# `.rustfs.sys/tmp/.trash/<uuid>/`, payload and all.** Deleting five 5 MB
# objects put 25 MB of `part.1` files there. Left in, the mirror would go on
# copying deleted photographs to the owner's PC, the object count and the mirror
# size would both stop meaning anything, and `--delete` would churn them out
# again whenever RustFS got round to emptying its own trash.
#
# They are staging, not state. RustFS recreates both directories at startup, and
# the patterns keep the directories themselves, so nothing in a restore depends
# on this.
#
# `--delete-excluded` is not decoration. Without it rsync treats an excluded
# path as protected in the destination, so the trash that arrived in the mirror
# before these patterns existed would sit there forever — excluded from being
# refreshed AND excluded from being cleaned up. That is how an exclusion that
# looks like it is saving space silently pins the very bytes it was added to
# get rid of.
sync_object_storage() {
  if [ "${SKIP_OBJECTS}" = "1" ]; then
    log "objects: skipped (SKIP_OBJECTS=1)"
    return 0
  fi

  # A deployment that never configured storage has no bucket and no objects.
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

  local mirror="${BACKUP_DIR}/${OBJECTS_SUBDIR}"
  local manifest="${BACKUP_DIR}/objects.manifest"

  # ── the guard that matters ────────────────────────────────────────────────
  # An empty or bucket-less volume is two completely different events wearing
  # the same clothes:
  #
  #   * storage was configured today and nobody has uploaded anything yet — the
  #     backend creates the bucket lazily, on first upload, so this is normal
  #     and must not fail the nightly run (failing here once aborted a deploy);
  #   * the bucket has STOPPED existing — a wiped volume, a `docker volume rm`,
  #     a bad restore. This is the disaster the backup exists for, and `rsync
  #     --delete` would faithfully propagate it into the mirror and then, one
  #     tick later, into the copy on the owner's PC.
  #
  # They are told apart by whether a mirror already holds the bucket. A bucket
  # that has never existed is a skip; a bucket that has stopped existing stops
  # the run and leaves the last good mirror untouched.
  if ! docker run --rm -v "${volume}:/data:ro" "${OBJECTS_SYNC_IMAGE}" \
         test -d "/data/${S3_BUCKET}" 2>/dev/null; then
    if [ -d "${mirror}/${S3_BUCKET}" ]; then
      die "objects: '${S3_BUCKET}' is missing from the volume but the mirror still has it — refusing to delete the mirror"
    fi
    log "objects: skipped (bucket '${S3_BUCKET}' does not exist yet — nothing uploaded)"
    return 0
  fi

  mkdir -p "${mirror}"

  # ── let the pull account in, and say so ───────────────────────────────────
  # docs/DEPLOYMENT.md §8 grants `familybackup` r-x on backups/ and a default
  # of r-x for what appears in it. Applied here as well, every run, for two
  # reasons: an installation set up before the mirror existed has the older
  # `r--` default, under which the mirror is unreadable because a directory
  # needs +x to be entered; and this is the only place that knows the mirror
  # exists. It is O(1) — the default ACL on the mirror root is what new
  # subdirectories and files inherit from the kernel, so there is no walk.
  #
  # The file mode mask keeps this honest: an object is created 0644, whose
  # group bits give a mask of r--, so the account's effective permission on a
  # file is r-- and the x in the entry only ever applies to directories.
  #
  # This grants read on the object store to an account that could already read
  # every byte of it out of the old tarball. It is not a widening; it is the
  # same access through a different door.
  if [ -n "${BACKUP_READER}" ] && command -v setfacl >/dev/null 2>&1 \
     && id -u "${BACKUP_READER}" >/dev/null 2>&1; then
    setfacl -m "u:${BACKUP_READER}:r-x" -m "d:u:${BACKUP_READER}:r-x" "${mirror}" \
      || log "objects: WARNING could not set the ACL for '${BACKUP_READER}' on ${mirror}"
  fi

  log "mirroring bucket volume '${volume}' -> ${mirror}/"

  local started rsync_status
  started="$(date +%s)"

  # `-rlt`, not `-a`. Ownership and modes are deliberately NOT copied from the
  # volume: the mirror is read by a different account than RustFS runs as, and
  # a 0700 directory anywhere in the tree would make the file-mode mask erase
  # the ACL above and break the pull silently. Fixed 0755/0644 is readable,
  # predictable, and exactly what RustFS wants when the tree is restored (the
  # restore in docs/DEPLOYMENT.md §8 chowns it to the RustFS uid; it never
  # relied on the archive's modes for anything else).
  #
  # `--delete-delay` and not `--delete`: deletions are applied after every
  # transfer has succeeded, so a run that dies halfway has added files and
  # removed none. The mirror degrades towards "too much", never "too little".
  set +e
  docker run --rm \
    -v "${volume}:/data:ro" \
    -v "${mirror}:/mirror" \
    "${OBJECTS_SYNC_IMAGE}" \
    rsync -rlt --delete-delay --delete-excluded --no-perms --chmod=D755,F644 --stats \
    --exclude="/.rustfs.sys/tmp/**" \
    --exclude="/.rustfs.sys/multipart/**" \
    /data/ /mirror/ \
    | sed -n 's/^\(Number of \|Total \|Literal \|Matched \).*/  rsync: &/p'
  rsync_status="${PIPESTATUS[0]}"
  set -e

  # 24 is "some files vanished before I could send them", and here it is
  # EXPECTED rather than exceptional. The media sweep collects unclaimed uploads
  # hourly and detached attachments nightly, and it is the one scheduled job
  # that mutates the very tree this is walking. An object that goes away between
  # rsync building its file list and reaching that entry is the sweep doing its
  # job. The mirror simply does not have it, which is correct — and the manifest
  # below is built from the mirror, not from the volume, so the two cannot
  # disagree about what was captured.
  #
  # Treating 24 as a failure would have meant a backup that fails at random,
  # more often the busier the family is. A backup that cries wolf gets ignored,
  # which is how the real failure gets through.
  case "${rsync_status}" in
    0) ;;
    24) log "objects: rsync reported vanished files (exit 24) — the media sweep was working alongside it; continuing" ;;
    *) die "objects: rsync into the mirror failed (exit ${rsync_status}) — the previous mirror is untouched" ;;
  esac

  # ── the manifest ──────────────────────────────────────────────────────────
  # Written from the MIRROR, not from the volume, so it describes exactly the
  # bytes the PC is about to fetch. Anything RustFS wrote during the rsync is
  # simply not in this snapshot; it is in the next one.
  #
  # `find -print0 | sort -z | xargs -0` rather than a glob or a bare `find |
  # xargs`: object keys come from user-supplied filenames and will eventually
  # contain spaces and non-ASCII. `LC_ALL=C` so the order is byte order and the
  # manifest is reproducible.
  local tmp_manifest="${manifest}.partial"
  ( cd "${mirror}" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum ) \
    >"${tmp_manifest}" || die "objects: could not build the manifest"

  # Same rule the dump obeys: verify before promoting. `sha256sum -c` re-reads
  # every file and compares — if the mirror changed under us, or a disk is
  # returning bad bytes, this is where it is caught, not on the PC and not
  # during a restore.
  ( cd "${mirror}" && sha256sum -c --quiet "${tmp_manifest}" >/dev/null 2>&1 ) \
    || die "objects: the mirror does not match the manifest just written — refusing to publish it"

  # (GNU coreutils here, unlike the PC's busybox: `--quiet` is the right
  # spelling on this side and `-s` on that one. Do not unify them.)

  # ── bit rot in the mirror ─────────────────────────────────────────────────
  # The check above proves the manifest describes the mirror. It does NOT prove
  # the mirror still describes the volume, and there is a real hole between the
  # two that is worth spelling out because it is silent and it eats exactly the
  # data that cannot be replaced:
  #
  #   rsync decides what to re-copy by size and mtime. Bit rot changes neither.
  #   So a mirror file that decays on this disk is never re-copied, the manifest
  #   is rebuilt from the mirror and faithfully records the rotted bytes, the PC
  #   pulls them, verifies them against that manifest, and everything reports
  #   success — for years, until somebody opens the photograph.
  #
  # What closes it is that objects are IMMUTABLE and content-addressed. A key
  # under the bucket can appear and it can disappear, but its bytes can never
  # legitimately change: a replacement is a new key. So a path present in both
  # the old and the new manifest with a different hash is, by construction, not
  # something the application did.
  #
  # `.rustfs.sys` is excluded because RustFS rewrites its caches constantly and
  # they are derived state, not anybody's photograph.
  if [ -s "${manifest}" ]; then
    local changed
    changed="$(
      LC_ALL=C join -j 2 -o 0,1.1,2.1 \
        <(LC_ALL=C sort -k2 "${manifest}") \
        <(LC_ALL=C sort -k2 "${tmp_manifest}") 2>/dev/null \
      | awk -v b="./${S3_BUCKET}/" '$2 != $3 && index($1, b) == 1 { print $1 }'
    )"

    if [ -n "${changed}" ]; then
      local n
      n="$(printf '%s\n' "${changed}" | wc -l | tr -d ' ')"
      log "objects: WARNING ${n} immutable object file(s) changed content at the same key."
      log "objects: WARNING That cannot come from the application. Re-copying them from the volume."
      printf '%s\n' "${changed}" | while IFS= read -r f; do
        [ -n "${f}" ] && log "objects:   suspect ${f}"
        [ -n "${f}" ] && rm -f -- "${mirror}/${f}"
      done

      # Deleted, so rsync cannot skip them on size and mtime this time.
      docker run --rm \
        -v "${volume}:/data:ro" \
        -v "${mirror}:/mirror" \
        "${OBJECTS_SYNC_IMAGE}" \
        rsync -rlt --no-perms --chmod=D755,F644 \
        --exclude="/.rustfs.sys/tmp/**" --exclude="/.rustfs.sys/multipart/**" \
        /data/ /mirror/ >/dev/null 2>&1 \
        || log "objects: WARNING the re-copy itself failed; the manifest below reflects what is on disk"

      ( cd "${mirror}" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum ) \
        >"${tmp_manifest}" || die "objects: could not rebuild the manifest after re-copying"

      # Whether it healed decides who is at fault, and the answer changes what
      # the owner should do — so say which one it was rather than logging
      # "something was wrong".
      local still
      still="$(
        LC_ALL=C join -j 2 -o 0,1.1,2.1 \
          <(LC_ALL=C sort -k2 "${manifest}") \
          <(LC_ALL=C sort -k2 "${tmp_manifest}") 2>/dev/null \
        | awk -v b="./${S3_BUCKET}/" '$2 != $3 && index($1, b) == 1 { print $1 }'
      )"
      if [ -z "${still}" ]; then
        log "objects: the re-copy restored them — the mirror had rotted, the volume is intact. CHECK THIS DISK."
      else
        log "objects: WARNING they are the same after re-copying, so the change is in the VOLUME, not the mirror."
        log "objects: WARNING Something rewrote an object in place. That is not an operation this app performs."
      fi
    fi
  fi
  mv -f -- "${tmp_manifest}" "${manifest}"
  ( cd "${BACKUP_DIR}" && sha256sum "$(basename "${manifest}")" >"$(basename "${manifest}").sha256" )

  # ── say what was actually captured ────────────────────────────────────────
  # The old line counted `avatars/*/xl.meta` and nothing else, so a run that
  # archived forty videos reported «0 avatar object(s)». A backup that reports
  # nothing while doing something is the failure that hides for months. Count
  # what is in the mirror, from the manifest itself, by the shape RustFS gives
  # EVERY object — a directory under the bucket holding an `xl.meta`.
  local files bytes objects elapsed
  files="$(wc -l <"${manifest}" | tr -d ' ')"
  bytes="$(du -sh "${mirror}" | cut -f1)"
  objects="$(grep -cE "  [.]/${S3_BUCKET}/.*/xl[.]meta\$" "${manifest}" || true)"
  elapsed="$(( $(date +%s) - started ))"

  log "objects: mirror holds ${objects} object(s) in ${files} file(s), ${bytes} (${elapsed}s)"
  log "objects: manifest + sha256 written"

  # A first mirror supersedes the tarball pair. Leaving the symlinks would point
  # a human — and an un-updated puller — at an archive that rotation is about to
  # delete. The archives themselves age out through the rotation block below.
  if [ -e "${BACKUP_DIR}/latest-objects.tar.gz" ]; then
    log "objects: removing the superseded latest-objects.tar.gz symlink (the mirror replaces it)"
    rm -f -- "${BACKUP_DIR}/latest-objects.tar.gz" "${BACKUP_DIR}/latest-objects.tar.gz.sha256"
  fi
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

# --- objects ----------------------------------------------------------------
# The object mirror, which is the other half of "restore the backup" and the
# only half that cannot be retyped. Not stamped and not paired with the dump:
# objects are immutable and content-addressed, so there is one mirror that
# moves forward, not a snapshot per night. What the dump's STAMP buys — being
# able to go back to Tuesday — the objects get from the attic on the PC (see
# infra/backup-pull/pull.sh), which is where the history belongs, because the
# server is the thing the history is protecting against.
sync_object_storage

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

# The object tarballs this script used to write. They were never rotated — the
# old code said so and left it for whoever reworked retention, and nothing on
# the VDI had deleted one since the day storage was introduced. On a deployment
# that has been running media, that is the pile that fills the disk.
#
# Aged out by DATE, not by count. Counting is what the dumps do and it is right
# for them, because a new dump arrives every night to push an old one off the
# end. Nothing produces these any more, so a count-based rule would hold the
# last fourteen forever — the file would sit there being neither refreshed nor
# removed, which is the same bug in a smaller costume.
#
# They are not deleted outright, either. A machine that has just been updated
# has a pile of these and they are, at that moment, somebody's only object
# backup. `BACKUP_KEEP` days is the same window the dumps get: long enough that
# the mirror has demonstrably worked for a fortnight first.
if [ -n "${S3_BUCKET:-}" ] && [ -f "${BACKUP_DIR}/objects.manifest" ]; then
  mapfile -t OLD_ARCHIVES < <(
    find "${BACKUP_DIR}" -maxdepth 1 -type f -name "${S3_BUCKET}-*.tar.gz" \
      -mtime "+${BACKUP_KEEP}" -printf '%f\n' | sort
  )
  if [ "${#OLD_ARCHIVES[@]}" -gt 0 ]; then
    log "retiring ${#OLD_ARCHIVES[@]} superseded object archive(s) older than ${BACKUP_KEEP} days (the mirror replaces them)"
    for old in "${OLD_ARCHIVES[@]}"; do
      log "  removing ${old}"
      rm -f -- "${BACKUP_DIR}/${old}" "${BACKUP_DIR}/${old}.sha256"
    done
  fi
fi

log "done — ${BACKUP_DIR} now holds $(find "${BACKUP_DIR}" -maxdepth 1 -type f -name "${POSTGRES_DB}-*.sql.gz" | wc -l) dump(s)"
log "REMINDER: a backup is only a backup once restore-check.sh has replayed it"
