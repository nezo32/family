#!/usr/bin/env bash
#
# One-time preparation of the VDI for the family app.
#
#   scp infra/scripts/vdi-bootstrap.sh root@nezo.su:/tmp/
#   ssh root@nezo.su 'bash /tmp/vdi-bootstrap.sh'
#
# Safe to re-run. It is deliberately conservative about the machine's existing
# tenants: this box also runs Amnezia WireGuard, so the firewall rules below
# discover and preserve those UDP ports rather than assuming a clean host.
#
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/family}
DEPLOY_USER=${DEPLOY_USER:-deploy}
BACKUP_USER=${BACKUP_USER:-familybackup}
BACKUP_DIR="$APP_DIR/backups"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$1"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

# --------------------------------------------------------------------------
log "Checking prerequisites"
command -v docker >/dev/null || { echo "docker missing" >&2; exit 1; }
docker compose version >/dev/null || { echo "docker compose v2 missing" >&2; exit 1; }
echo "docker:  $(docker --version)"
echo "compose: $(docker compose version --short)"

FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
echo "free disk: ${FREE_GB}G"
if (( FREE_GB < 8 )); then
  warn "Under 8G free. The stack needs ~1.5G of images plus the database;"
  warn "run 'docker image prune -af' before deploying."
fi

# --------------------------------------------------------------------------
log "Creating directories"
mkdir -p "$APP_DIR"/{backups,infra/caddy,infra/postgres/init,infra/scripts}
chmod 750 "$APP_DIR"

# --------------------------------------------------------------------------
log "Creating the deploy user"
# CI gets its own account rather than root: a separate, individually revocable
# credential with no password auth and a clean audit trail.
#
# Note honestly that this is NOT a privilege boundary — the account must be in
# the `docker` group to run compose, and Docker group membership is effectively
# root (you can mount the host filesystem into a container). The benefit is
# revocability and traceability, not containment.
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --system --group --shell /bin/bash --home "/home/$DEPLOY_USER" "$DEPLOY_USER"
  echo "created $DEPLOY_USER"
else
  echo "$DEPLOY_USER already exists"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

# --------------------------------------------------------------------------
log "Creating the backup user"
# Read-only access to the dump directory, nothing else. The home PC pulls with
# this account, so the key it stores is worth far less than a root key if the
# PC is ever compromised.
# Debian/Ubuntu ship a system account literally called `backup` (uid 34,
# home /var/backups, shell nologin). Reusing it silently produces an account
# that can never log in and an ~/.ssh in the wrong directory, so the name is
# deliberately distinct and a collision is refused rather than worked around.
if id -u "$BACKUP_USER" >/dev/null 2>&1; then
  EXISTING_SHELL=$(getent passwd "$BACKUP_USER" | cut -d: -f7)
  if [[ "$EXISTING_SHELL" == *nologin || "$EXISTING_SHELL" == *false ]]; then
    echo "refusing to reuse system account '$BACKUP_USER' (shell: $EXISTING_SHELL)" >&2
    echo "set BACKUP_USER=<another name> and re-run" >&2
    exit 1
  fi
fi

if ! id -u "$BACKUP_USER" >/dev/null 2>&1; then
  adduser --system --group --shell /bin/bash --home "/home/$BACKUP_USER" "$BACKUP_USER"
  echo "created $BACKUP_USER"
else
  echo "$BACKUP_USER already exists"
fi
install -d -m 700 -o "$BACKUP_USER" -g "$BACKUP_USER" "/home/$BACKUP_USER/.ssh"
touch "/home/$BACKUP_USER/.ssh/authorized_keys"
chown "$BACKUP_USER:$BACKUP_USER" "/home/$BACKUP_USER/.ssh/authorized_keys"
chmod 600 "/home/$BACKUP_USER/.ssh/authorized_keys"

# Dumps are group-readable by the backup user and nobody else.
mkdir -p "$BACKUP_DIR"
chgrp "$BACKUP_USER" "$BACKUP_DIR"
chmod 750 "$BACKUP_DIR"

# --------------------------------------------------------------------------
log "Scheduling the nightly dump"
cat >/etc/cron.d/family-backup <<CRON
# Nightly Postgres dump for the family app. The home PC pulls these; nothing is
# pushed, because that PC is behind NAT and is not always on.
#
# 03:17 Moscow, and the timezone is written down rather than inherited from the
# host: the media sweep runs at 05:20 Moscow (BullMQ, workers.ts) and deletes
# objects from the same volume the backup mirrors, so "do these two windows
# overlap" has to be answerable without running timedatectl. 2h03m apart, and
# the mirror takes seconds.
#
# This time is also written in backup.sh's header and docs/DEPLOYMENT.md §8.
# The three disagreed once (03:30 / 03:17 / 03:17); if you change one, change
# all three.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
CRON_TZ=Europe/Moscow
17 3 * * * root cd $APP_DIR && ./infra/scripts/backup.sh >>/var/log/family-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/family-backup
echo "cron installed: nightly at 03:17 Europe/Moscow"

# --------------------------------------------------------------------------
log "Configuring the firewall"
if command -v ufw >/dev/null; then
  # Discover the UDP ports the existing containers publish, so enabling ufw
  # cannot silently cut the VPN off. Never assume this host is ours alone.
  mapfile -t UDP_PORTS < <(docker ps --format '{{.Ports}}' 2>/dev/null \
    | grep -oE '0\.0\.0\.0:[0-9]+->[0-9]+/udp' \
    | grep -oE ':[0-9]+->' | tr -dc '0-9\n' | sort -u)

  ufw allow 22/tcp   >/dev/null
  ufw allow 80/tcp   >/dev/null
  ufw allow 443/tcp  >/dev/null
  for p in "${UDP_PORTS[@]:-}"; do
    [[ -n "$p" ]] || continue
    ufw allow "$p/udp" >/dev/null
    echo "preserved existing UDP port $p"
  done

  if ufw status | grep -q "Status: active"; then
    echo "ufw already active; rules updated"
  else
    warn "ufw is INACTIVE. Enable it yourself once you have confirmed the rules:"
    warn "    ufw status numbered && ufw enable"
    warn "Not enabling automatically — doing so over SSH can lock you out."
  fi
else
  warn "ufw not installed; skipping firewall configuration"
fi

# --------------------------------------------------------------------------
log "Done"
cat <<SUMMARY

Next steps:

  1. Add CI's public key:
       echo '<ci public key>' >> /home/$DEPLOY_USER/.ssh/authorized_keys

  2. Add the home PC's backup public key:
       echo '<pc public key>' >> /home/$BACKUP_USER/.ssh/authorized_keys

  3. Copy the compose files and .env into $APP_DIR, then chmod 600 $APP_DIR/.env

  4. Run the Deploy workflow from GitHub Actions.

Ports 80 and 443 were free at bootstrap time; the WireGuard UDP ports above
were preserved.
SUMMARY
