#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Family App — backup pull (runs INSIDE the container, on the owner's PC).
#
#   ssh probe -> scp latest.sql.gz + latest-objects.tar.gz (+ .sha256 sidecars)
#   -> verify checksum -> verify gzip -> verify payload -> THEN overwrite the
#   weekday slot -> record the success marker.
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

STATE_DIR="${DEST}/_state"
LOG_DIR="${DEST}/_log"
MARKER="${STATE_DIR}/last-success"
TICK="${STATE_DIR}/last-tick"
STATUS="${STATE_DIR}/status.txt"
KNOWN_HOSTS="${STATE_DIR}/known_hosts"
LOCK="${STATE_DIR}/.lock"

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
  if [ "${h}" -le "${STALE_HOURS}" ]; then
    echo "ok: last successful backup ${h}h ago (stale after ${STALE_HOURS}h)"
    exit 0
  fi
  if [ "${h}" -ge 99999 ]; then
    echo "UNHEALTHY: no successful backup has ever completed"
  else
    echo "UNHEALTHY: last successful backup was ${h}h ago (stale after ${STALE_HOURS}h)"
  fi
  exit 1
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
    echo "server       : ${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}"
    echo "slot today   : ${SLOT}"
  } >"${STATUS}" 2>/dev/null || true
}

if [ "${FORCE}" -eq 0 ] && ! is_due; then
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

# ── what is the server offering? ────────────────────────────────────────────
# `latest.sql.gz` and `latest-objects.tar.gz` are symlinks backup.sh points at
# the newest pair, always the same STAMP. Resolving them here is purely so the
# log can name the stamp; scp would follow them regardless.
# shellcheck disable=SC2086
STAMP="$(ssh ${SSH_OPTS} "${REMOTE}" "readlink '${REMOTE_DIR}/latest.sql.gz' 2>/dev/null || echo unknown" 2>/dev/null || echo unknown)"
info "server's newest dump: ${STAMP}"

DUMP_LOCAL="${PREFIX}-db-${SLOT}.sql.gz"
OBJ_LOCAL="${PREFIX}-objects-${SLOT}.tar.gz"

DUMP_OK=0
OBJ_OK=0

if fetch latest.sql.gz "${DUMP_LOCAL}" dump; then DUMP_OK=1; fi

# The database is not the whole of the durable state: `users.avatar_url` points
# into the RustFS bucket, and a database restored without it gives every member
# a broken face and no way to tell whose photo was whose. A deployment that has
# never had an upload has no objects archive at all, which is a skip, not a
# failure — so this does not gate success on its own.
# shellcheck disable=SC2086
if ssh ${SSH_OPTS} "${REMOTE}" "test -e '${REMOTE_DIR}/latest-objects.tar.gz'" 2>/dev/null; then
  if fetch latest-objects.tar.gz "${OBJ_LOCAL}" objects; then OBJ_OK=1; fi
else
  info "objects: the server has no latest-objects.tar.gz yet (nobody has uploaded an avatar)"
  OBJ_OK=1
fi

# ── outcome ─────────────────────────────────────────────────────────────────
# The marker moves only on a real, verified dump. If it does not move, the next
# hourly tick tries again — which is exactly what should happen after a failure.
if [ "${DUMP_OK}" -eq 1 ]; then
  now > "${MARKER}"

  {
    echo "Newest backup pulled from ${REMOTE}:${REMOTE_DIR}"
    echo
    echo "pulled at   : $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "server stamp: ${STAMP}"
    echo "database    : ${DUMP_LOCAL}"
    if [ -f "${DEST}/${OBJ_LOCAL}" ]; then echo "avatars     : ${OBJ_LOCAL}"; fi
    echo
    echo "Restore instructions: docs/DEPLOYMENT.md, section 8."
  } >"${DEST}/LATEST.txt" 2>/dev/null || true

  COUNT="$(find "${DEST}" -maxdepth 1 -type f -name "${PREFIX}-db-*.sql.gz" | wc -l | tr -d ' ')"
  TOTAL="$(du -sh "${DEST}" 2>/dev/null | awk '{print $1}')"
  info "SUCCESS — local set: ${COUNT} dump slot(s), ${TOTAL} total. Next backup in ~${MIN_INTERVAL_HOURS}h."
  if [ "${OBJ_OK}" -eq 1 ]; then
    write_status "success"
  else
    write_status "partial — dump ok, avatars failed"
  fi
  exit 0
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
