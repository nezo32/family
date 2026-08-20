#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Family App — backup-pull container entrypoint.
#
#   validate the mounted SSH key -> snapshot the env for cron -> run one pull
#   now -> hand PID 1 to crond and stay out of the way.
#
# Why a run at startup as well as the hourly tick: a laptop that wakes at 14:37
# would otherwise sit doing nothing until 15:07. Container start *is* the
# "machine came back" event, so it is the right moment to ask whether a backup
# is due. `pull.sh` decides; this just asks.
#
# Why crond rather than a `while sleep 3600` loop: it is what was asked for, it
# survives being stopped and started constantly (there is no in-memory state to
# lose — the schedule is a file and the interval gate is a file on the bind
# mount), and it costs about 200 KB of RSS.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

DEST=/backups
KEY_SRC=/run/backup-key
KEY=/root/.ssh/backup_key

SERVER_HOST="${SERVER_HOST:-nezo.su}"
SERVER_USER="${SERVER_USER:-familybackup}"
CHECK_CRON="${CHECK_CRON:-7 * * * *}"

say() { printf '%s [INFO] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*"; }
banner() {
  printf '\n'
  printf '  ##########################################################################\n'
  while [ "$#" -gt 0 ]; do printf '  ## %s\n' "$1"; shift; done
  printf '  ##########################################################################\n\n'
}

# ── timezone ────────────────────────────────────────────────────────────────
# "Around 14:00" has to mean 14:00 where the owner lives, not UTC. crond reads
# local time, so this has to be settled before crond starts.
if [ -n "${TZ:-}" ] && [ -f "/usr/share/zoneinfo/${TZ}" ]; then
  cp "/usr/share/zoneinfo/${TZ}" /etc/localtime
  printf '%s\n' "${TZ}" >/etc/timezone
fi

say "family backup-pull starting — ${SERVER_USER}@${SERVER_HOST}, timezone $(date '+%Z (%z)')"

# ── destination ─────────────────────────────────────────────────────────────
if ! mkdir -p "${DEST}/_state" "${DEST}/_log" 2>/dev/null; then
  banner "CANNOT WRITE TO THE BACKUP DESTINATION" \
         "" \
         "${DEST} is not writable inside the container. Check the BACKUP_DEST" \
         "bind mount in infra/backup-pull/docker-compose.yml, and that Docker" \
         "Desktop has file sharing enabled for that drive." \
         "" \
         "Settings -> Resources -> File sharing"
  sleep 60
  exit 1
fi

# ── the SSH key ─────────────────────────────────────────────────────────────
# Failing loudly here is the entire point. A backup container that starts
# cleanly and then silently copies nothing is worse than one that will not
# start, because the first one looks fine on `docker ps` for three weeks.
#
# Note the `-d` case: when the host path does not exist, Docker helpfully
# creates an empty *directory* at it and mounts that, so "no key" arrives
# looking like a directory rather than a missing file.
mkdir -p /root/.ssh
chmod 700 /root/.ssh

key_help() {
  banner \
    "NO USABLE SSH KEY — THIS CONTAINER CANNOT BACK ANYTHING UP" \
    "" \
    "$1" \
    "" \
    "Fix it once, on this PC:" \
    "" \
    "  1. Create the key (no passphrase — it must run unattended):" \
    "       ssh-keygen -t ed25519 -f \$env:USERPROFILE\\.ssh\\family_backup -N '\"\"' -C family-backup" \
    "     (bash: ssh-keygen -t ed25519 -f ~/.ssh/family_backup -N '' -C family-backup)" \
    "" \
    "  2. Install its public half on the server, from a machine with root there:" \
    "       ssh root@${SERVER_HOST} \"install -d -m700 -o ${SERVER_USER} -g ${SERVER_USER} /home/${SERVER_USER}/.ssh\"" \
    "       cat ~/.ssh/family_backup.pub | ssh root@${SERVER_HOST} \\" \
    "         \"cat >> /home/${SERVER_USER}/.ssh/authorized_keys\"" \
    "" \
    "  3. If Docker created an empty directory where the key should be, delete it:" \
    "       rm -rf ~/.ssh/family_backup   (then re-run step 1)" \
    "" \
    "  4. docker compose -f infra/backup-pull/docker-compose.yml up -d --force-recreate"
}

if [ -d "${KEY_SRC}" ]; then
  key_help "The key path is a DIRECTORY, which means the host file did not exist when this container started."
  sleep 60
  exit 1
fi
if [ ! -f "${KEY_SRC}" ] || [ ! -s "${KEY_SRC}" ]; then
  key_help "No key was mounted at ${KEY_SRC} (or it is empty)."
  sleep 60
  exit 1
fi

cp "${KEY_SRC}" "${KEY}"
chmod 600 "${KEY}"

# An encrypted key cannot be used unattended, and ssh's failure for one is an
# obscure BatchMode error 40 minutes into a log. Say so up front instead.
if ! ssh-keygen -y -f "${KEY}" >/dev/null 2>&1; then
  key_help "The mounted key is not a usable private key, or it has a passphrase (this must run unattended, so it cannot have one)."
  sleep 60
  exit 1
fi
say "ssh key loaded: $(ssh-keygen -l -f "${KEY}" 2>/dev/null || echo unknown)"

# ── environment snapshot for cron ───────────────────────────────────────────
# cron jobs inherit essentially nothing. Without this, every knob set in
# docker-compose.yml would silently fall back to its default on every tick but
# the first — the classic "it works when I run it by hand" cron bug.
#
# `:=` and not `=`: a value already in the environment wins. Under cron there
# is no environment, so these all apply; under `docker exec -e FOO=bar` the
# override survives, which is what makes a one-off run testable by hand.
{
  echo "# generated by entrypoint.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ) — do not edit"
  for v in TZ SERVER_HOST SERVER_USER REMOTE_DIR GENERATIONS MIN_INTERVAL_HOURS \
           MAX_INTERVAL_HOURS PREFERRED_HOUR CONNECT_TIMEOUT STALE_HOURS PREFIX; do
    eval "val=\${$v:-}"
    [ -n "${val}" ] && printf ": \"\${%s:=%s}\"; export %s\n" "$v" \
      "$(printf '%s' "${val}" | sed 's/[\\"$`]/\\&/g')" "$v"
  done
  printf ": \"\${DEST:=%s}\"; export DEST\n" "${DEST}"
  printf ": \"\${KEY:=%s}\"; export KEY\n" "${KEY}"
} >/etc/backup-pull.env
chmod 600 /etc/backup-pull.env

# ── the schedule ────────────────────────────────────────────────────────────
# Hourly, not daily-at-14:00. A bare `0 14 * * *` is the requirement's failure
# mode written down: a PC that happens to be off at 14:00 simply never backs
# up. The tick is cheap (a marker-file stat, then nothing); pull.sh's interval
# gate is what makes it "about once a day, about 14:00".
#
# `>/proc/1/fd/1 2>&1` sends the job's output to the container's own stdout,
# which is what `docker compose logs` reads. Without it busybox crond tries to
# mail the output and it disappears.
mkdir -p /etc/crontabs
printf '%s /bin/sh /opt/backup-pull/pull.sh >/proc/1/fd/1 2>&1\n' "${CHECK_CRON}" >/etc/crontabs/root
chmod 600 /etc/crontabs/root
say "schedule: '${CHECK_CRON}' — that is how often it CHECKS. A backup happens only when one is due (see pull.sh)"

# ── one check now ───────────────────────────────────────────────────────────
# Container start is the "the PC came back" event. Do not wait up to an hour
# to find out whether a backup was missed while it was asleep.
say "running the startup check"
/bin/sh /opt/backup-pull/pull.sh || say "startup check did not produce a backup (see above); the hourly schedule will retry"

if [ -f "${DEST}/_state/status.txt" ]; then
  printf '\n'
  sed 's/^/  /' "${DEST}/_state/status.txt"
  printf '\n'
fi

say "handing over to crond — every check from here on is logged, whatever it decides"
exec crond -f -l 8
