#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Family App — backup pull (runs INSIDE the container, on the owner's PC).
#
# Two halves, two shapes, for two different kinds of data:
#
#   database  ssh probe -> scp latest.sql.gz (+ .sha256) -> verify checksum ->
#             verify gzip -> verify payload -> THEN overwrite the weekday slot.
#
#   objects   scp objects.manifest (+ .sha256) -> rsync the mirror incrementally,
#             deletions moved into a dated attic rather than erased -> verify
#             EVERY local file against the manifest -> record the marker.
#
# The database is small, changes completely every night and benefits from seven
# weekday generations. The object store is large, append-only and named by
# content hash — seven generations of it would be seven copies of the same
# bytes, and re-fetching it whole every night was the thing that made media
# unshippable. One mirror plus a bounded attic is the equivalent guarantee at a
# fraction of the transfer.
#
# The PC pulls; the server never pushes. The PC is behind NAT with no inbound
# port and no stable address, so a server-side `scp` would fail more often than
# it succeeded — and it would hand the VDI a route into a home network, which
# is exactly the wrong direction if the VDI is ever compromised.
#
# Called two ways:
#     pull.sh              one run: decide whether a backup is due, and do it
#     pull.sh --force      run regardless of the interval gate
#     pull.sh --health     exit 0 if the newest good backup is fresh enough
#
# `crond` calls the first form every hour. The *hour* is not the schedule —
# the schedule is "has it been long enough since the last good backup", which
# is the only form of "daily" that survives a PC that is off half the time.
# See `is_due` for the three-line policy.
#
# Everything is configured by environment; entrypoint.sh snapshots the
# container environment into /etc/backup-pull.env so cron (which inherits
# nothing) sees the same values.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

# Cron gives a job an almost-empty environment. entrypoint.sh wrote the real
# one here at container start.
if [ -f /etc/backup-pull.env ]; then
  . /etc/backup-pull.env
fi

SERVER_HOST="${SERVER_HOST:-nezo.su}"
SERVER_USER="${SERVER_USER:-familybackup}"
REMOTE_DIR="${REMOTE_DIR:-/opt/family/backups}"
DEST="${DEST:-/backups}"
KEY="${KEY:-/root/.ssh/backup_key}"
GENERATIONS="${GENERATIONS:-7}"
MIN_INTERVAL_HOURS="${MIN_INTERVAL_HOURS:-20}"
MAX_INTERVAL_HOURS="${MAX_INTERVAL_HOURS:-26}"
PREFERRED_HOUR="${PREFERRED_HOUR:-14}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-20}"
STALE_HOURS="${STALE_HOURS:-48}"
TICK_STALE_HOURS="${TICK_STALE_HOURS:-3}"
PREFIX="${PREFIX:-family}"

# ── objects ─────────────────────────────────────────────────────────────────
# The object store is pulled incrementally into ONE mirror, not into weekday
# slots. Objects are immutable and named by content hash, so seven generations
# of them would be seven copies of almost exactly the same bytes — the history
# a weekday slot buys for a dump buys nothing here. What replaces it is the
# attic: anything that disappears from the server is moved aside under a dated
# directory rather than deleted, and those directories are pruned by age. That
# is the bounded rotation, and it is the thing that survives the server losing
# its volume.
#
# OBJECTS_MIN_INTERVAL_HOURS is a separate cadence from the dump's, because the
# two change at completely different rates. It defaults to the same ~daily
# rhythm rather than the weekly one the design pass suggested: weekly was the
# right answer when a run meant re-transferring the whole tarball, and once the
# transfer is incremental the only thing a longer interval buys is up to a week
# of new photographs living nowhere but the VDI. Set it to 168 on a metered
# link, knowing that is the trade.
OBJECTS_MIN_INTERVAL_HOURS="${OBJECTS_MIN_INTERVAL_HOURS:-20}"
OBJECTS_STALE_HOURS="${OBJECTS_STALE_HOURS:-96}"
ATTIC_KEEP_DAYS="${ATTIC_KEEP_DAYS:-30}"
# rsync deletions above this count get a banner. Not a refusal — the attic
# already means nothing is lost — but a family does not delete four hundred
# photographs in a day, and if the number is large the owner should hear about
# it the same evening rather than the next time they go looking.
ATTIC_ALERT_FILES="${ATTIC_ALERT_FILES:-100}"

STATE_DIR="${DEST}/_state"
LOG_DIR="${DEST}/_log"
MARKER="${STATE_DIR}/last-success"
OBJ_MARKER="${STATE_DIR}/last-success-objects"
TICK="${STATE_DIR}/last-tick"
STATUS="${STATE_DIR}/status.txt"
KNOWN_HOSTS="${STATE_DIR}/known_hosts"
LOCK="${STATE_DIR}/.lock"

OBJ_MIRROR="${DEST}/${PREFIX}-objects"
OBJ_MANIFEST="${DEST}/${PREFIX}-objects.manifest"
ATTIC="${DEST}/_attic"

mkdir -p "${STATE_DIR}" "${LOG_DIR}"

LOG_FILE="${LOG_DIR}/pull-$(date +%Y-%m).log"

# ── logging ─────────────────────────────────────────────────────────────────
# Two destinations on purpose. stdout is what `docker compose logs` shows, and
# is the thing the owner will actually look at; the monthly file is what
# survives a log rotation and answers "when did this last work" three weeks
# later. A backup system that fails quietly is the only kind that ever fails.
log() {
  _lvl="$1"; shift
  _line="$(date '+%Y-%m-%d %H:%M:%S %Z') [${_lvl}] $*"
  printf '%s\n' "${_line}"
  printf '%s\n' "${_line}" >>"${LOG_FILE}" 2>/dev/null || true
}
info()  { log INFO  "$@"; }
warn()  { log WARN  "$@"; }
error() { log ERROR "$@"; }

# A banner, not a line. The difference between a backup that has been broken
# for three weeks and one that was fixed the same day is entirely whether the
# failure was possible to miss while scrolling.
banner() {
  printf '\n'
  printf '  ##########################################################################\n'
  while [ "$#" -gt 0 ]; do
    printf '  ## %s\n' "$1"
    shift
  done
  printf '  ##########################################################################\n\n'
}

now()    { date +%s; }
age_of() { # age in whole hours of the epoch-seconds value in file $1; 99999 if absent
  if [ -f "$1" ]; then
    _t="$(cat "$1" 2>/dev/null || echo 0)"
    case "${_t}" in ''|*[!0-9]*) echo 99999; return;; esac
    echo $(( ( $(now) - _t ) / 3600 ))
  else
    echo 99999
  fi
}

# ── health ──────────────────────────────────────────────────────────────────
# Drives the compose healthcheck, so `docker compose ps` says `unhealthy` when
# backups have stopped happening. This is the signal that does not require
# anybody to read a log.
if [ "${1:-}" = "--health" ]; then
  # Is the scheduler itself still alive? This is not paranoia: `cap_drop: ALL`
  # on this container makes busybox crond fork, fail its setgroups(), and run
  # nothing at all — without a single line in the log. It was caught by
  # watching the clock during testing, which is not a reliable way to catch
  # anything. A tick happens every hour and on every container start, so a
  # last-tick older than a few hours means the schedule has stopped, and that
  # is worth knowing hours rather than days later.
  t="$(age_of "${TICK}")"
  if [ "${t}" -ge 99999 ]; then
    echo "UNHEALTHY: the internal schedule has never fired — crond is not running jobs"
    exit 1
  fi
  if [ "${t}" -gt "${TICK_STALE_HOURS}" ]; then
    echo "UNHEALTHY: the internal schedule has not fired for ${t}h — crond is not running jobs"
    exit 1
  fi

  h="$(age_of "${MARKER}")"
  if [ "${h}" -ge 99999 ]; then
    echo "UNHEALTHY: no successful backup has ever completed"
    exit 1
  fi
  if [ "${h}" -gt "${STALE_HOURS}" ]; then
    echo "UNHEALTHY: last successful backup was ${h}h ago (stale after ${STALE_HOURS}h)"
    exit 1
  fi

  # The objects half gets its own staleness, because it has its own cadence and
  # because it is the half that cannot be retyped. A dump arriving nightly while
  # the photographs quietly stopped three weeks ago is exactly the failure this
  # whole rework exists to prevent, and without this line `ps` would say
  # `healthy` throughout.
  #
  # Only complained about once objects have EVER been pulled. A deployment with
  # no storage configured has no mirror and is not broken.
  o="$(age_of "${OBJ_MARKER}")"
  if [ "${o}" -lt 99999 ] && [ "${o}" -gt "${OBJECTS_STALE_HOURS}" ]; then
    echo "UNHEALTHY: the database is current (${h}h) but objects last synced ${o}h ago (stale after ${OBJECTS_STALE_HOURS}h)"
    exit 1
  fi

  if [ "${o}" -ge 99999 ]; then
    echo "ok: last successful backup ${h}h ago (stale after ${STALE_HOURS}h); no objects on the server"
  else
    echo "ok: last successful backup ${h}h ago, objects ${o}h ago"
  fi
  exit 0
fi

# `case`, not `[ ... ] && FORCE=1`: under `set -e` an AND-OR list whose last
# command never runs still reports failure, and shells disagree about whether
# that is fatal. This one cannot be.
FORCE=0
case "${1:-}" in --force) FORCE=1 ;; esac

# Proof of life for the scheduler, read by --health above. Written before any
# decision, because "did the tick happen" and "did a backup happen" are
# different questions with different answers.
now > "${TICK}"

# ── single instance ─────────────────────────────────────────────────────────
# The hourly tick must never overlap a slow transfer on a bad link: two scps
# writing the same `.partial` is exactly how a truncated file gets promoted.
exec 9>"${LOCK}"
if ! flock -n 9; then
  info "another pull is already running — skipping this tick"
  exit 0
fi

# ── which slot ──────────────────────────────────────────────────────────────
# Overwrite rather than accumulate, as asked. The filename is the weekday, so
# the set is exactly seven files that each get replaced once a week: constant
# disk, old backups genuinely overwritten, and still a week of history.
#
# Seven rather than one on purpose. With a single overwritten file, the moment
# a dump is truncated — or the database was already corrupt when it was taken —
# the last good copy is gone and the backup has destroyed the thing it exists
# to protect. Set GENERATIONS=1 if you truly want exactly one file.
#
# This governs the DUMP only. Objects have no slot: see sync_objects.
slot_name() {
  if [ "${GENERATIONS}" -le 1 ]; then
    echo latest
  elif [ "${GENERATIONS}" -eq 7 ]; then
    date +%a | tr 'A-Z' 'a-z'
  else
    echo "slot$(( $(date +%j) % GENERATIONS ))"
  fi
}
SLOT="$(slot_name)"

# ── is a backup due? ────────────────────────────────────────────────────────
# The old Windows task fired at fixed clock times and leaned on
# `StartWhenAvailable`; the gate that actually decided anything was
# `-MinIntervalHours 20`. That gate is the part worth keeping, so it is the
# whole policy here:
#
#   * younger than MIN_INTERVAL_HOURS (20h)  -> never; one backup per day.
#   * older than MAX_INTERVAL_HOURS (26h)    -> now, whatever the clock says.
#     This is the PC-was-off case: it comes back at 09:00 after two days down
#     and backs up immediately rather than waiting for 14:00.
#   * in between                             -> at or after PREFERRED_HOUR.
#     This is what pins the routine to ~14:00 local. Without it a pure 20h
#     gate walks the backup four hours earlier every day until it lands at
#     03:00, which is when the PC is off.
is_due() {
  _age="$(age_of "${MARKER}")"
  _hour="$(date +%H | sed 's/^0//')"
  _hour="${_hour:-0}"

  if [ "${_age}" -ge 99999 ]; then
    info "due: no previous successful backup recorded"
    return 0
  fi
  if [ "${_age}" -lt "${MIN_INTERVAL_HOURS}" ]; then
    info "not due: last backup ${_age}h ago, minimum interval is ${MIN_INTERVAL_HOURS}h"
    return 1
  fi
  if [ "${_age}" -ge "${MAX_INTERVAL_HOURS}" ]; then
    info "due: last backup ${_age}h ago, past the ${MAX_INTERVAL_HOURS}h catch-up limit"
    return 0
  fi
  if [ "${_hour}" -ge "${PREFERRED_HOUR}" ]; then
    info "due: last backup ${_age}h ago and it is past ${PREFERRED_HOUR}:00 local"
    return 0
  fi
  info "not due: last backup ${_age}h ago, waiting for ${PREFERRED_HOUR}:00 local (now $(date +%H:%M))"
  return 1
}

write_status() {
  {
    echo "last run     : $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "last result  : $1"
    if [ -f "${MARKER}" ]; then
      echo "last success : $(date -d "@$(cat "${MARKER}")" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || cat "${MARKER}") ($(age_of "${MARKER}")h ago)"
    else
      echo "last success : never"
    fi
    if [ -f "${OBJ_MARKER}" ]; then
      echo "objects sync : $(date -d "@$(cat "${OBJ_MARKER}")" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || cat "${OBJ_MARKER}") ($(age_of "${OBJ_MARKER}")h ago)"
    else
      echo "objects sync : never"
    fi
    echo "server       : ${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}"
    echo "slot today   : ${SLOT}  (database only — objects are one mirror)"
  } >"${STATUS}" 2>/dev/null || true
}

# ── two cadences, one tick ──────────────────────────────────────────────────
# The dump and the object store are asked separately, because they change at
# completely different rates and because one gate for both would quietly make
# the looser of the two the only one that mattered.
#
# Getting this wrong is easy and silent: leaving the objects behind `is_due`
# means that if OBJECTS_MIN_INTERVAL_HOURS is ever set shorter than the dump's
# interval it does nothing at all, and — worse — a dump that has stopped being
# due for any reason takes the photographs down with it. They are gated apart,
# and the tick does something if EITHER is due.
DUMP_DUE=0
OBJ_DUE=0
if [ "${FORCE}" -eq 1 ]; then
  DUMP_DUE=1
  OBJ_DUE=1
else
  if is_due; then DUMP_DUE=1; fi
  OBJ_AGE="$(age_of "${OBJ_MARKER}")"
  if [ "${OBJ_AGE}" -ge "${OBJECTS_MIN_INTERVAL_HOURS}" ]; then
    OBJ_DUE=1
    if [ "${OBJ_AGE}" -ge 99999 ]; then
      info "objects: due — never synced"
    else
      info "objects: due — last sync ${OBJ_AGE}h ago, interval is ${OBJECTS_MIN_INTERVAL_HOURS}h"
    fi
  else
    info "objects: not due — last sync ${OBJ_AGE}h ago, interval is ${OBJECTS_MIN_INTERVAL_HOURS}h"
  fi
fi

if [ "${DUMP_DUE}" -eq 0 ] && [ "${OBJ_DUE}" -eq 0 ]; then
  write_status "skipped (not due)"
  exit 0
fi

# ── ssh ─────────────────────────────────────────────────────────────────────
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=${CONNECT_TIMEOUT} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${KNOWN_HOSTS} -o LogLevel=ERROR -i ${KEY}"
REMOTE="${SERVER_USER}@${SERVER_HOST}"

info "pull starting — ${REMOTE}:${REMOTE_DIR} -> ${DEST} (slot '${SLOT}')"

PROBE_ERR="$(mktemp)"
# shellcheck disable=SC2086
if ! ssh ${SSH_OPTS} "${REMOTE}" true 2>"${PROBE_ERR}"; then
  MSG="$(cat "${PROBE_ERR}")"
  rm -f "${PROBE_ERR}"
  case "${MSG}" in
    *"Permission denied"*|*"Too many authentication failures"*|*"no matching host key"*)
      # A rejected key is a configuration error, not weather. It will never fix
      # itself, and every hour it stays broken is an hour with no backup — so
      # it gets the banner rather than a WARN nobody reads.
      error "the server refused this key"
      banner \
        "SSH KEY REFUSED by ${REMOTE}" \
        "" \
        "ssh said: ${MSG}" \
        "" \
        "NO BACKUP IS BEING TAKEN until this is fixed. Install the public half" \
        "of the key on the server (once, from a machine with root there):" \
        "" \
        "  ssh root@${SERVER_HOST} \"install -d -m700 -o ${SERVER_USER} -g ${SERVER_USER} /home/${SERVER_USER}/.ssh\"" \
        "  ssh root@${SERVER_HOST} \"echo '\$(cat ~/.ssh/family_backup.pub)' >> /home/${SERVER_USER}/.ssh/authorized_keys\"" \
        "" \
        "Then: docker compose -f infra/backup-pull/docker-compose.yml restart"
      write_status "FAILED — ssh key refused"
      exit 0
      ;;
    *)
      # The PC being awake while the link is not is normal operation for this
      # design, not an incident. Retry on the next tick.
      warn "server unreachable (${MSG:-no detail}) — will retry on the next tick"
      write_status "server unreachable"
      exit 0
      ;;
  esac
fi
rm -f "${PROBE_ERR}"

# ── fetch one artefact ──────────────────────────────────────────────────────
# fetch <remote-basename> <local-basename> <kind>
#
# The order here is the whole point of the script: download to `.partial`,
# verify the checksum against the server's own sidecar, verify the gzip, verify
# the payload — and only then let it replace the file that is currently the
# owner's last good backup. A truncated download must never be able to take out
# a working copy; that failure turns a backup system into a liability.
fetch() {
  _remote_name="$1"
  _local_name="$2"
  _kind="$3"

  _target="${DEST}/${_local_name}"
  _tmp="${_target}.partial"
  _sidecar="${_target}.sha256"
  _tmp_sidecar="${_tmp}.sha256"

  rm -f "${_tmp}" "${_tmp_sidecar}"

  # shellcheck disable=SC2086
  if ! scp ${SSH_OPTS} -p "${REMOTE}:${REMOTE_DIR}/${_remote_name}" "${_tmp}" 2>/dev/null; then
    warn "${_kind}: transfer failed — keeping the previous copy, retrying next run"
    rm -f "${_tmp}"
    return 1
  fi

  # shellcheck disable=SC2086
  if ! scp ${SSH_OPTS} "${REMOTE}:${REMOTE_DIR}/${_remote_name}.sha256" "${_tmp_sidecar}" 2>/dev/null; then
    warn "${_kind}: no .sha256 sidecar on the server — refusing an unverifiable file"
    rm -f "${_tmp}" "${_tmp_sidecar}"
    return 1
  fi

  # The sidecar names the file by its server-side stamped name, so
  # `sha256sum -c` cannot be used directly — compare the digests themselves.
  _want="$(awk '{print $1; exit}' "${_tmp_sidecar}")"
  _got="$(sha256sum "${_tmp}" | awk '{print $1}')"
  if [ -z "${_want}" ] || [ "${_want}" != "${_got}" ]; then
    error "${_kind}: CHECKSUM MISMATCH — server says ${_want:-<empty>}, we got ${_got}"
    error "${_kind}: refusing to overwrite ${_local_name} with a corrupt download"
    rm -f "${_tmp}" "${_tmp_sidecar}"
    return 1
  fi

  if ! gzip -t "${_tmp}" 2>/dev/null; then
    error "${_kind}: gzip integrity check failed — refusing to overwrite ${_local_name}"
    rm -f "${_tmp}" "${_tmp_sidecar}"
    return 1
  fi

  # Payload check, not just container format — the same reasoning backup.sh
  # applies on the server. A dump that restores to an empty database is a
  # silent catastrophe, and it is a perfectly valid gzip.
  #
  # `grep -c` and not `grep -q`: `-q` exits on the first match, `gzip -cd`
  # then dies of SIGPIPE, and a *good* file gets thrown away at random. This
  # exact race bit backup.sh; it is not hypothetical.
  case "${_kind}" in
    dump)
      _n="$(gzip -cd "${_tmp}" | grep -cE '^(CREATE TABLE|COPY )' || true)"
      if [ "${_n:-0}" -eq 0 ]; then
        error "dump: no CREATE TABLE/COPY statements — refusing to overwrite ${_local_name}"
        rm -f "${_tmp}" "${_tmp_sidecar}"
        return 1
      fi
      _detail="${_n} schema/data statement(s)"
      ;;
    objects)
      _n="$(gzip -cd "${_tmp}" | tar -tf - 2>/dev/null | grep -c . || true)"
      if [ "${_n:-0}" -eq 0 ]; then
        error "objects: archive lists no entries — refusing to overwrite ${_local_name}"
        rm -f "${_tmp}" "${_tmp_sidecar}"
        return 1
      fi
      _detail="${_n} archive entries"
      ;;
  esac

  # Verified. Now — and only now — the overwrite.
  mv -f "${_tmp}" "${_target}"
  ( cd "${DEST}" && sha256sum "${_local_name}" >"${_local_name}.sha256" )
  rm -f "${_tmp_sidecar}"

  _size="$(du -h "${_target}" | awk '{print $1}')"
  info "${_kind}: ${_local_name} <- ${_remote_name} (${_size}, ${_detail}) verified and written"
  return 0
}

# One pass of "does the local mirror match the manifest". Returns 0 on a clean
# match; on failure it leaves the failing lines in ${STATE_DIR}/objects.verify.
#
# Two passes on purpose: `-s` is the cheap silent form that answers yes/no, and
# only a "no" pays for the per-file output. On a mirror of twenty thousand
# objects the difference is twenty thousand lines of «OK» in the log every
# night versus none.
#
# `-s`, not `--quiet`: this is busybox sha256sum, where `-s` is the silent form
# and `--quiet` is a GNU spelling that does not exist here. Worth checking
# rather than assuming — an unrecognised option would have failed this on every
# single run, which reads exactly like a corrupt mirror.
verify_mirror() {
  _man="$1"
  if ( cd "${OBJ_MIRROR}" && sha256sum -cs "${_man}" ); then
    return 0
  fi
  ( cd "${OBJ_MIRROR}" && sha256sum -c "${_man}" 2>&1 | grep -v ': OK$' )     >"${STATE_DIR}/objects.verify" 2>&1 || true
  return 1
}

# ── sync the object store ───────────────────────────────────────────────────
# The database is not the whole of the durable state: `users.avatar_url` and
# every media attachment on Стена point into the RustFS bucket, and a database
# restored without it gives every member a broken face and every note a grey
# rectangle, with no way to tell what was there. It is also the only data here
# that cannot be retyped.
#
# It does NOT come down as a tarball any more. backup.sh publishes
# `backups/objects/` — a mirror of the volume — plus `objects.manifest`, a
# `sha256sum -c` file covering every byte in it. This fetches the manifest,
# rsyncs the tree, and then verifies its own local copy against the manifest.
# The verification is what preserves the property the tarball path had: nothing
# is called good until it has been checked, and nothing that fails a check is
# allowed to stand as this month's backup.
#
# Where it differs, and deliberately: rsync verifies and replaces PER FILE.
# Every transfer lands on a temporary name and is renamed into place only when
# it is complete, so an aborted pull leaves every already-good file exactly as
# it was — the guarantee is finer-grained than the tarball's, not coarser.
# What it cannot do on its own is notice bad bytes, which is what the manifest
# is for.
sync_objects() {
  # Is the server offering a mirror at all?
  # shellcheck disable=SC2086
  if ! ssh ${SSH_OPTS} "${REMOTE}" "test -f '${REMOTE_DIR}/objects.manifest' && test -d '${REMOTE_DIR}/objects'" 2>/dev/null; then
    return 2   # no mirror — the caller decides whether that is legacy or empty
  fi

  # rsync has to exist on BOTH ends; it is the one thing this design needs that
  # a stock Ubuntu does not have. Saying so precisely is worth a lot more than
  # an obscure "protocol version mismatch" at 03:00.
  # shellcheck disable=SC2086
  if ! ssh ${SSH_OPTS} "${REMOTE}" "command -v rsync >/dev/null" 2>/dev/null; then
    error "objects: the server has a mirror but no rsync binary"
    banner \
      "THE SERVER CANNOT SERVE THE OBJECT MIRROR" \
      "" \
      "${REMOTE} has backups/objects/ but no rsync. Photographs and video are" \
      "NOT being backed up to this PC. The database still is." \
      "" \
      "Fix it once, on the server:" \
      "" \
      "  ssh root@${SERVER_HOST} 'apt-get install -y rsync'"
    return 1
  fi

  # The interval decision was made once, up top, alongside the dump's. Coming
  # here not-due means the dump was due and this is not: nothing to do, and
  # emphatically not a failure.
  if [ "${OBJ_DUE}" -eq 0 ]; then
    return 0
  fi

  mkdir -p "${OBJ_MIRROR}" "${ATTIC}"

  # ── the manifest, before the data ──────────────────────────────────────────
  # Fetched first and verified against its own sidecar, so a truncated manifest
  # cannot later be read as "the mirror is missing files".
  _mtmp="${STATE_DIR}/objects.manifest.new"
  _mtmp_sc="${_mtmp}.sha256"
  rm -f "${_mtmp}" "${_mtmp_sc}"

  # shellcheck disable=SC2086
  if ! scp ${SSH_OPTS} "${REMOTE}:${REMOTE_DIR}/objects.manifest" "${_mtmp}" 2>/dev/null; then
    warn "objects: could not fetch the manifest — keeping the previous mirror, retrying next run"
    return 1
  fi
  # shellcheck disable=SC2086
  if ! scp ${SSH_OPTS} "${REMOTE}:${REMOTE_DIR}/objects.manifest.sha256" "${_mtmp_sc}" 2>/dev/null; then
    warn "objects: no .sha256 beside the manifest — refusing an unverifiable file list"
    rm -f "${_mtmp}" "${_mtmp_sc}"
    return 1
  fi
  _want="$(awk '{print $1; exit}' "${_mtmp_sc}")"
  _got="$(sha256sum "${_mtmp}" | awk '{print $1}')"
  if [ -z "${_want}" ] || [ "${_want}" != "${_got}" ]; then
    error "objects: MANIFEST CHECKSUM MISMATCH — server says ${_want:-<empty>}, we got ${_got}"
    rm -f "${_mtmp}" "${_mtmp_sc}"
    return 1
  fi
  _want_files="$(wc -l <"${_mtmp}" | tr -d ' ')"
  info "objects: manifest lists ${_want_files} file(s) on the server"

  # ── the transfer ──────────────────────────────────────────────────────────
  # `--backup --backup-dir` is the bounded rotation, and it is the reason
  # `--delete` is safe to use at all. A file that has gone from the server is
  # not erased here; it is moved under _attic/<date>/ with its path intact, and
  # those directories are pruned by age at the end of this function. So:
  #
  #   * the local set never grows without bound — the attic is the only thing
  #     that accumulates and it has a ceiling in days;
  #   * a server that loses its volume (a wipe, a bad restore, ransomware)
  #     cannot take the family's photographs with it inside one night. It has
  #     to do it and then stay broken for ATTIC_KEEP_DAYS.
  #
  # `--delete-delay` so deletions happen after every transfer has succeeded: a
  # run killed halfway has added files and removed none.
  #
  # No `-p`/`-o`/`-g`. The destination is a Windows folder through a Docker
  # bind mount; unix ownership does not survive it and attempting it produces a
  # nightly page of warnings. The restore procedure chowns the tree to the
  # RustFS uid on arrival, which is where that belongs anyway.
  # `%Y-%m-%d`, not `%Y%m%d`: busybox `date -d` parses the dashed form and
  # rejects the compact one, and prune_attic has to be able to read this back.
  _today="$(date +%Y-%m-%d)"
  _itemize="${STATE_DIR}/objects.itemize"
  rm -f "${_itemize}"

  info "objects: rsync ${REMOTE}:${REMOTE_DIR}/objects/ -> ${OBJ_MIRROR}/"
  _started="$(now)"

  # shellcheck disable=SC2086
  rsync -rlt --delete-delay --no-perms --chmod=D755,F644 --omit-dir-times         --backup --backup-dir="${ATTIC}/${_today}"         --out-format='%i %n'         -e "ssh ${SSH_OPTS}"         "${REMOTE}:${REMOTE_DIR}/objects/" "${OBJ_MIRROR}/" >"${_itemize}" 2>&1     && _rc=0 || _rc=$?

  # 24 means files vanished between rsync listing them and sending them. On the
  # server that is the media sweep at work and it is expected; here it means the
  # server re-mirrored while we were mid-transfer. Either way the manifest check
  # below is the authority on whether what landed is right, so this is a note,
  # not a failure. Anything else is.
  case "${_rc}" in
    0) ;;
    24) warn "objects: files vanished server-side mid-transfer (rsync exit 24) — the manifest check below decides" ;;
    *)
      error "objects: rsync failed (exit ${_rc}) — the previous mirror is untouched. Last lines:"
      tail -n 5 "${_itemize}" | while IFS= read -r _l; do error "  ${_l}"; done
      rm -f "${_mtmp}" "${_mtmp_sc}"
      return 1
      ;;
  esac

  # Clamped at zero. Docker Desktop's clock steps when the host resumes from
  # sleep, and a run straddling that prints "-1s", which reads like a bug in
  # something that should never look buggy.
  _elapsed="$(( $(now) - _started ))"
  [ "${_elapsed}" -ge 0 ] || _elapsed=0
  _new="$(grep -c '^>f' "${_itemize}" || true)"
  _gone="$(grep -c '^\*deleting' "${_itemize}" || true)"

  # ── verify what actually landed ───────────────────────────────────────────
  # Every file, every byte, against the server's manifest. This is the check
  # that replaces "the gzip decompressed", and it is strictly stronger: it
  # covers the network, rsync itself, and the disk this PC is writing to. On an
  # unchanged 100 MB mirror it costs about two seconds.
  #
  # It runs on the LOCAL copy, so a pass means the bytes on this disk are the
  # bytes the server hashed — which is the only statement a backup can usefully
  # make.
  #
  # It is also the only thing here that can catch bit rot, and that is not a
  # side benefit. rsync decides what to re-send by size and mtime; a file that
  # decays in place on this PC keeps both, so rsync will never look at it again
  # and the corruption would sit in the backup until somebody tried to restore
  # a photograph. Which is why the failure path below does not merely report.
  if ! verify_mirror "${_mtmp}"; then
    # ── heal, once ──────────────────────────────────────────────────────────
    # Delete exactly the files that failed and let rsync fetch them again. They
    # are gone, so the size/mtime shortcut cannot skip them this time.
    #
    # Exactly one attempt. A second failure is not a bad transfer — it is this
    # PC's disk, or a server whose mirror moved under us — and retrying in a
    # loop would turn that into a nightly re-download of the entire store.
    _bad="$(grep -c ': FAILED$' "${STATE_DIR}/objects.verify" || true)"
    warn "objects: ${_bad} file(s) failed verification — deleting them and re-fetching once"

    sed -n 's/: FAILED$//p' "${STATE_DIR}/objects.verify" | while IFS= read -r _f; do
      [ -n "${_f}" ] && rm -f "${OBJ_MIRROR}/${_f}"
    done

    # shellcheck disable=SC2086
    if rsync -rlt --delete-delay --no-perms --chmod=D755,F644 --omit-dir-times \
          --backup --backup-dir="${ATTIC}/${_today}" \
          --out-format='%i %n' \
          -e "ssh ${SSH_OPTS}" \
          "${REMOTE}:${REMOTE_DIR}/objects/" "${OBJ_MIRROR}/" >>"${_itemize}" 2>&1; then
      :
    else
      _rc=$?
      [ "${_rc}" -eq 24 ] || error "objects: the re-fetch itself failed (exit ${_rc})"
    fi

    if ! verify_mirror "${_mtmp}"; then
      error "objects: THE LOCAL MIRROR STILL DOES NOT MATCH THE SERVER'S MANIFEST"
      head -n 5 "${STATE_DIR}/objects.verify" | while IFS= read -r _l; do error "  ${_l}"; done
      banner \
        "OBJECT MIRROR FAILED VERIFICATION TWICE" \
        "" \
        "${OBJ_MIRROR} does not match objects.manifest from ${REMOTE}," \
        "and re-fetching the failing files did not fix it." \
        "" \
        "Nothing has been deleted and the previous manifest is still in place." \
        "The database backup is unaffected." \
        "" \
        "This PC's disk is the first suspect, and not merely by elimination:" \
        "before publishing that manifest the server verified it against its" \
        "own copy, AND compared every immutable object key against the previous" \
        "night's hashes to catch rot on its own disk. Both passed." \
        "" \
        "Check the drive holding ${DEST}. If it stays clean, run backup.sh on" \
        "the server by hand and read its objects: lines."
      rm -f "${_mtmp}" "${_mtmp_sc}"
      return 1
    fi
    info "objects: re-fetch healed it — the mirror now matches the manifest"
  fi

  # Extra files are not a verification failure, but they are worth naming: they
  # mean --delete did not do its job, which usually means the run was killed.
  _here="$(find "${OBJ_MIRROR}" -type f | wc -l | tr -d ' ')"
  if [ "${_here}" -ne "${_want_files}" ]; then
    warn "objects: mirror holds ${_here} file(s), manifest lists ${_want_files} — extra files present, next run will tidy"
  fi

  # Verified. Promote the manifest so a human (and restore-check) can re-run the
  # same check offline, at any time, without the server.
  mv -f "${_mtmp}" "${OBJ_MANIFEST}"
  rm -f "${_mtmp_sc}"
  now >"${OBJ_MARKER}"

  _size="$(du -sh "${OBJ_MIRROR}" 2>/dev/null | awk '{print $1}')"
  info "objects: ${_want_files} file(s), ${_size}, verified against the manifest (+${_new} new, -${_gone} moved to the attic, ${_elapsed}s)"

  if [ "${_gone}" -gt "${ATTIC_ALERT_FILES}" ]; then
    banner \
      "${_gone} OBJECTS DISAPPEARED FROM THE SERVER TODAY" \
      "" \
      "They have NOT been deleted here. They are in:" \
      "  ${ATTIC}/${_today}" \
      "and will be kept for ${ATTIC_KEEP_DAYS} days." \
      "" \
      "If nobody deleted anything on Стена today, look at the server before" \
      "that window closes."
  fi

  prune_attic
  retire_legacy_tarball
  return 0
}

# ── the attic: bounded, and the only thing here that accumulates ────────────
# Whole dated directories, removed by age. Not by count, because a day on which
# nothing was deleted creates no directory at all, so counting would let a busy
# fortnight evict a deletion from a month ago.
prune_attic() {
  [ -d "${ATTIC}" ] || return 0
  _cutoff="$(( $(now) - ATTIC_KEEP_DAYS * 86400 ))"
  for _d in "${ATTIC}"/*; do
    [ -d "${_d}" ] || continue
    _name="$(basename "${_d}")"
    # YYYY-MM-DD -> epoch. Anything that does not parse is left alone rather
    # than guessed at: this loop calls `rm -rf`.
    _when="$(date -d "${_name}" +%s 2>/dev/null || echo 0)"
    case "${_when}" in ''|*[!0-9]*) _when=0 ;; esac
    [ "${_when}" -gt 0 ] || continue
    if [ "${_when}" -lt "${_cutoff}" ]; then
      info "attic: removing ${_name} (older than ${ATTIC_KEEP_DAYS} days)"
      rm -rf "${_d}"
    fi
  done
  # rsync creates the backup directory whether or not it ends up putting
  # anything in it, so most nights leave an empty shell behind. Remove those:
  # an attic listing should mean "something went away on these days".
  find "${ATTIC}" -mindepth 1 -type d -empty -delete 2>/dev/null || true

  _kept="$(find "${ATTIC}" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${_kept}" -gt 0 ]; then
    info "attic: ${_kept} dated set(s) held, $(du -sh "${ATTIC}" 2>/dev/null | awk '{print $1}'), ${ATTIC_KEEP_DAYS}-day window"
  fi
}

# The weekday object tarballs the old design left behind. Once a verified
# mirror exists they are dead weight — never refreshed again, and exactly the
# wrong thing for a panicking human to reach for at 3am, because they are
# frozen at whatever day the changeover happened. Removed one at a time as
# their weekday comes round, so the set drains over a week rather than
# vanishing the moment this script is first run.
retire_legacy_tarball() {
  _old="${DEST}/${PREFIX}-objects-${SLOT}.tar.gz"
  [ -f "${_old}" ] || return 0
  [ -f "${OBJ_MANIFEST}" ] || return 0
  info "objects: retiring the superseded tarball ${PREFIX}-objects-${SLOT}.tar.gz (the mirror replaces it)"
  rm -f "${_old}" "${_old}.sha256"
}

# ── what is the server offering? ────────────────────────────────────────────
# `latest.sql.gz` is a symlink backup.sh points at the newest dump. Resolving it
# here is purely so the log can name the stamp; scp would follow it regardless.
# shellcheck disable=SC2086
STAMP="$(ssh ${SSH_OPTS} "${REMOTE}" "readlink '${REMOTE_DIR}/latest.sql.gz' 2>/dev/null || echo unknown" 2>/dev/null || echo unknown)"
info "server's newest dump: ${STAMP}"

DUMP_LOCAL="${PREFIX}-db-${SLOT}.sql.gz"
OBJ_LEGACY="${PREFIX}-objects-${SLOT}.tar.gz"

DUMP_OK=0
OBJ_OK=0

if [ "${DUMP_DUE}" -eq 1 ]; then
  if fetch latest.sql.gz "${DUMP_LOCAL}" dump; then DUMP_OK=1; fi
else
  info "dump: not due this tick — the object store is what brought us here"
fi

# Objects. Three outcomes, and the legacy branch matters for exactly as long as
# it takes an installation to update both halves: a PC running this script
# against a server still running the old backup.sh would otherwise silently
# stop backing up photographs, which is the failure this whole change exists to
# prevent. So a server with no mirror but with the old tarball still gets
# pulled the old way.
# `if`, not `sync_objects; OBJ_RC=$?`. Under `set -e` a function that returns
# non-zero as a bare command ends the script, and a failed object sync must
# still let the outcome block below report a partial backup.
if sync_objects; then OBJ_RC=0; else OBJ_RC=$?; fi
case "${OBJ_RC}" in
  0) OBJ_OK=1 ;;
  1) OBJ_OK=0 ;;
  2)
    # shellcheck disable=SC2086
    if ssh ${SSH_OPTS} "${REMOTE}" "test -e '${REMOTE_DIR}/latest-objects.tar.gz'" 2>/dev/null; then
      warn "objects: the server still publishes a tarball and no mirror — using the old path"
      warn "objects: update infra/scripts/backup.sh on ${SERVER_HOST} to get incremental transfers"
      if fetch latest-objects.tar.gz "${OBJ_LEGACY}" objects; then
        OBJ_OK=1
        now >"${OBJ_MARKER}"
      fi
    else
      info "objects: the server has no object mirror yet (storage unconfigured, or nobody has uploaded anything)"
      OBJ_OK=1
    fi
    ;;
esac

# ── outcome ─────────────────────────────────────────────────────────────────
# Each marker moves only on its own verified artefact. If one does not move,
# the next hourly tick tries that half again — which is exactly what should
# happen after a failure.
#
# A tick that was only ever here for the objects (the dump was not due) is not
# a failed dump. It reports on what it did and leaves the dump's marker where
# it was.
if [ "${DUMP_DUE}" -eq 0 ]; then
  if [ "${OBJ_OK}" -eq 1 ]; then
    info "objects-only tick complete; the dump is not due for another $(( MIN_INTERVAL_HOURS - $(age_of "${MARKER}") ))h"
    write_status "success (objects only — dump not due)"
    exit 0
  fi
  error "objects-only tick failed. See the ERROR lines above."
  write_status "FAILED — objects only, and they failed"
  exit 1
fi

if [ "${DUMP_OK}" -eq 1 ]; then
  now > "${MARKER}"

  {
    echo "Newest backup pulled from ${REMOTE}:${REMOTE_DIR}"
    echo
    echo "pulled at   : $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "server stamp: ${STAMP}"
    echo "database    : ${DUMP_LOCAL}"
    if [ -d "${OBJ_MIRROR}" ] && [ -f "${OBJ_MANIFEST}" ]; then
      echo "objects     : ${PREFIX}-objects/  ($(wc -l <"${OBJ_MANIFEST}" | tr -d ' ') files, $(du -sh "${OBJ_MIRROR}" 2>/dev/null | awk '{print $1}'))"
      echo "              verified against ${PREFIX}-objects.manifest"
    elif [ -f "${DEST}/${OBJ_LEGACY}" ]; then
      echo "objects     : ${OBJ_LEGACY}  (legacy tarball — update backup.sh on the server)"
    fi
    echo
    echo "Restore instructions: docs/DEPLOYMENT.md, section 8."
  } >"${DEST}/LATEST.txt" 2>/dev/null || true

  COUNT="$(find "${DEST}" -maxdepth 1 -type f -name "${PREFIX}-db-*.sql.gz" | wc -l | tr -d ' ')"
  TOTAL="$(du -sh "${DEST}" 2>/dev/null | awk '{print $1}')"
  info "SUCCESS — local set: ${COUNT} dump slot(s), ${TOTAL} total. Next backup in ~${MIN_INTERVAL_HOURS}h."
  if [ "${OBJ_OK}" -eq 1 ]; then
    write_status "success"
    exit 0
  fi
  # A dump without its objects is a partial backup, and it must not be reported
  # as a success: the run exits non-zero so the startup check and any wrapper
  # sees it, while the dump's marker still moves because the dump really did
  # arrive.
  write_status "PARTIAL — dump ok, objects FAILED"
  error "the database was pulled but the object mirror was not. See the ERROR lines above."
  exit 1
fi

AGE="$(age_of "${MARKER}")"
if [ "${AGE}" -ge 99999 ]; then
  banner "BACKUP FAILED and there is NO previous successful backup at all." \
         "Read the ERROR lines above. Nothing has ever been pulled to ${DEST}."
  write_status "FAILED — nothing pulled, ever"
elif [ "${AGE}" -gt "${STALE_HOURS}" ]; then
  banner "BACKUP FAILED. The newest good backup is now ${AGE}h old." \
         "Read the ERROR lines above — this has been failing for a while."
  write_status "FAILED — newest good backup is ${AGE}h old"
else
  error "this run failed; the previous good backup (${AGE}h old) is untouched. Retrying next tick."
  write_status "FAILED — previous good backup (${AGE}h) kept"
fi
exit 1
