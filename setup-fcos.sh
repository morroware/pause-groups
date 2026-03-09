#!/usr/bin/env bash
# setup-fcos.sh — Install pause-groups on Fedora CoreOS (FCOS)
#
# This server runs Fedora CoreOS with containerized services via Podman.
# It cannot use `dnf install` in the traditional sense; instead this script:
#
#   1. Copies app files into /var/persist/pause-groups/ (survives rebuilds)
#   2. Generates a random AES-256 encryption key in config.php
#   3. Runs the interactive PHP installer inside a temporary PHP container
#   4. Creates a rootful Podman + systemd unit for PHP-FPM (port 9001, TCP)
#   5. Prints the Nginx server block to add to /var/persist/nginx.conf
#   6. Creates systemd timers for the watchdog (every minute) and daily cron
#
# USAGE:
#   sudo bash setup-fcos.sh
#
# PREREQUISITES:
#   - Run on the FCOS VM itself (SSH in first).
#   - The app source must be present in the same directory as this script,
#     OR set SOURCE_DIR below to point to where you've checked out the repo.
#
# IMPORTANT — Nginx config:
#   This script does NOT auto-edit /var/persist/nginx.conf. Nginx already has
#   working reverse-proxy configs; auto-patching risks breaking them. Instead,
#   the script prints the exact server block to add. Review and merge it yourself.
# ----------------------------------------------------------------------------
set -euo pipefail

# ---------- helpers ----------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
step()  { echo -e "\n${BOLD}── $* ${NC}"; }
box()   { echo -e "\n${BOLD}${GREEN}$*${NC}"; }

require_root() { [[ $EUID -eq 0 ]] || die "Please run as root: sudo bash $0"; }

# ---------- configuration — edit these if needed -----------------------------
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/var/persist/pause-groups"       # survives FCOS rebuilds
DATA_DIR="${INSTALL_DIR}/data"
SOCK_VOL="/var/persist/pause-groups-fpm"      # shared socket directory
PHP_IMAGE="docker.io/library/php:8.3-fpm"    # official PHP-FPM image
PHP_PORT=9001                                 # TCP port PHP-FPM listens on
NGINX_CONF="/var/persist/nginx.conf"          # existing Nginx config (do NOT overwrite)
SERVER_NAME="pause-groups.local"              # hostname or IP for the Nginx server block
HTTP_PORT=80                                  # port for this vhost (Grafana uses 3000)
# ----------------------------------------------------------------------------

require_root

echo ""
echo "========================================================"
echo "  pause-groups — Fedora CoreOS Setup"
echo "  Source:  ${SOURCE_DIR}"
echo "  Install: ${INSTALL_DIR}"
echo "========================================================"
echo ""

# ── 1. Verify this is actually FCOS ------------------------------------------
step "1. Verifying environment"
if ! command -v rpm-ostree &>/dev/null && ! command -v podman &>/dev/null; then
    warn "Neither rpm-ostree nor podman found. Are you sure this is Fedora CoreOS?"
    read -r -p "Continue anyway? [y/N] " CONT
    [[ "${CONT,,}" == "y" ]] || die "Aborted."
fi
if ! command -v podman &>/dev/null; then
    die "podman is required but not found. Cannot continue."
fi
ok "Podman $(podman --version | awk '{print $3}') found."

# ── 2. Copy app files to /var/persist ----------------------------------------
step "2. Copying app files to ${INSTALL_DIR}"
if [[ "$SOURCE_DIR" == "$INSTALL_DIR" ]]; then
    ok "Already running from ${INSTALL_DIR} — no copy needed."
else
    mkdir -p "${INSTALL_DIR}"
    # rsync if available, otherwise cp -a
    if command -v rsync &>/dev/null; then
        rsync -a --exclude='data/' --exclude='.git/' "${SOURCE_DIR}/" "${INSTALL_DIR}/"
    else
        cp -a "${SOURCE_DIR}/." "${INSTALL_DIR}/"
        rm -rf "${INSTALL_DIR}/.git" "${INSTALL_DIR}/data"
    fi
    ok "Files copied to ${INSTALL_DIR}."
fi

# ── 3. Create data directory --------------------------------------------------
step "3. Creating data directory"
mkdir -p "${DATA_DIR}"
# PHP-FPM container runs as www-data (uid 33) inside the official php image.
# Grant it write access to the data dir via world-writable or chown.
chmod 777 "${DATA_DIR}"
ok "Data directory ready at ${DATA_DIR}."

# ── 4. Generate AES-256 encryption key ---------------------------------------
step "4. Generating AES-256 encryption key"
CONFIG_FILE="${INSTALL_DIR}/config.php"
if [[ ! -f "$CONFIG_FILE" ]]; then
    die "config.php not found in ${INSTALL_DIR}. Check that the files copied correctly."
fi

# Only generate a new key if config still has a placeholder
if grep -qE "(CHANGE_ME|your_32_byte|0{64})" "$CONFIG_FILE"; then
    NEW_KEY=$(openssl rand -hex 32)
    # Patch the define() line that sets ENCRYPTION_KEY's fallback value
    sed -i "s/\(getenv('PG_ENCRYPTION_KEY') ?:\s*\)'[0-9a-fA-F]*'/\1'${NEW_KEY}'/" "$CONFIG_FILE" \
        || warn "Auto-patch failed — set ENCRYPTION_KEY manually in config.php or via PG_ENCRYPTION_KEY env var."
    ok "Encryption key written to config.php."
else
    warn "config.php already has a non-default key — skipping."
fi

# ── 5. Pull the PHP-FPM image ------------------------------------------------
step "5. Pulling PHP-FPM container image"
podman pull "${PHP_IMAGE}" || die "Could not pull ${PHP_IMAGE}. Check network/DNS."
ok "Image pulled: ${PHP_IMAGE}"

# ── 6. Run the installer inside a temporary PHP container --------------------
step "6. Running the interactive installer"
info "Launching installer in a disposable PHP container..."
info "(Type answers at the prompts — this is the normal install.php wizard)"
echo ""

podman run --rm -it \
    --network host \
    -v "${INSTALL_DIR}:${INSTALL_DIR}:z" \
    -w "${INSTALL_DIR}" \
    -e "PG_APP_DEBUG=false" \
    "${PHP_IMAGE}" \
    php install.php

ok "Installer finished."

# ── 7. Set final permissions --------------------------------------------------
step "7. Fixing permissions for PHP-FPM container user"
# Official php:fpm image runs as www-data (uid 33 / gid 33)
chown -R 33:33 "${DATA_DIR}"
chmod 770 "${DATA_DIR}"
ok "Permissions set on ${DATA_DIR} (uid 33 = www-data inside container)."

# ── 8. Create the PHP-FPM systemd service ------------------------------------
step "8. Creating PHP-FPM systemd service"

# Create the socket/volume directory (used for any shared state if needed)
mkdir -p "${SOCK_VOL}"

PHPFPM_SERVICE="/etc/systemd/system/pause-groups-fpm.service"
cat > "${PHPFPM_SERVICE}" <<UNIT
[Unit]
Description=pause-groups PHP-FPM container
Documentation=https://hub.docker.com/_/php
After=network-online.target
Wants=network-online.target

[Service]
Restart=always
RestartSec=10s
ExecStartPre=-/usr/bin/podman rm -f pause-groups-fpm
ExecStart=/usr/bin/podman run --rm \\
    --name pause-groups-fpm \\
    --network host \\
    -v ${INSTALL_DIR}:${INSTALL_DIR}:z \\
    -w ${INSTALL_DIR} \\
    -e PG_APP_DEBUG=false \\
    ${PHP_IMAGE} \\
    php-fpm -F -d listen=0.0.0.0:${PHP_PORT} \\
            -d listen.allowed_clients=127.0.0.1
ExecStop=/usr/bin/podman stop pause-groups-fpm

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now pause-groups-fpm
ok "pause-groups-fpm.service enabled and started (PHP-FPM on port ${PHP_PORT})."

# ── 9. Watchdog and daily cron via systemd timers ----------------------------
step "9. Creating systemd timers for cron jobs"

# --- watchdog (every minute) ---
cat > /etc/systemd/system/pause-groups-watchdog.service <<UNIT
[Unit]
Description=pause-groups watchdog (missed-action enforcement)
After=pause-groups-fpm.service

[Service]
Type=oneshot
ExecStart=/usr/bin/podman run --rm \\
    --network host \\
    -v ${INSTALL_DIR}:${INSTALL_DIR}:z \\
    -w ${INSTALL_DIR} \\
    -u 33:33 \\
    ${PHP_IMAGE} \\
    php cron_watchdog.php
StandardOutput=append:${DATA_DIR}/watchdog.log
StandardError=append:${DATA_DIR}/watchdog.log
UNIT

cat > /etc/systemd/system/pause-groups-watchdog.timer <<UNIT
[Unit]
Description=pause-groups watchdog — run every minute
After=pause-groups-fpm.service

[Timer]
OnCalendar=minutely
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# --- daily planner (00:05) ---
cat > /etc/systemd/system/pause-groups-daily.service <<UNIT
[Unit]
Description=pause-groups daily planner (game sync + day planning)
After=pause-groups-fpm.service

[Service]
Type=oneshot
ExecStart=/usr/bin/podman run --rm \\
    --network host \\
    -v ${INSTALL_DIR}:${INSTALL_DIR}:z \\
    -w ${INSTALL_DIR} \\
    -u 33:33 \\
    ${PHP_IMAGE} \\
    php cron.php
StandardOutput=append:${DATA_DIR}/cron.log
StandardError=append:${DATA_DIR}/cron.log
UNIT

cat > /etc/systemd/system/pause-groups-daily.timer <<UNIT
[Unit]
Description=pause-groups daily planner — run at 00:05

[Timer]
OnCalendar=*-*-* 00:05:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now pause-groups-watchdog.timer
systemctl enable --now pause-groups-daily.timer
ok "Systemd timers created and enabled."

# ── 10. Security: delete fresh_install.php -----------------------------------
step "10. Removing fresh_install.php (security)"
FRESH="${INSTALL_DIR}/fresh_install.php"
if [[ -f "$FRESH" ]]; then
    rm -f "$FRESH"
    ok "fresh_install.php removed."
else
    ok "fresh_install.php already absent."
fi

# ── 11. Print the Nginx server block to add manually -------------------------
step "11. Nginx configuration block (add manually)"

echo ""
warn "======================================================================"
warn "ACTION REQUIRED — Do NOT auto-apply; review before merging"
warn "======================================================================"
echo ""
info "Your Nginx config is at: ${NGINX_CONF}"
info "It already has working reverse-proxy rules — this script does NOT"
info "touch that file. Add the block below as a new 'server {}' block."
echo ""
info "Suggested placement: after the last existing server{} block."
echo ""
echo "-------- Add this to ${NGINX_CONF} --------"
cat <<NGINXBLOCK

# pause-groups — PHP web app (PHP-FPM on 127.0.0.1:${PHP_PORT})
server {
    listen ${HTTP_PORT};
    server_name ${SERVER_NAME};        # <-- change to your actual hostname/IP

    root ${INSTALL_DIR};
    index index.php;

    # Block direct access to sensitive server-side files
    location ~ ^/(data|lib|api|config\\.php|cron.*\\.php|run_action\\.php|fresh_install\\.php|AUDIT\\.md|README\\.md) {
        deny all;
        return 404;
    }

    # SPA + API router
    location / {
        try_files \$uri \$uri/ /index.php?\$query_string;
    }

    # Static assets
    location /public/ {
        expires 1h;
        add_header Cache-Control "public, immutable";
    }

    # PHP-FPM via TCP (container listens on host port ${PHP_PORT})
    location ~ \\.php\$ {
        include        fastcgi_params;
        fastcgi_pass   127.0.0.1:${PHP_PORT};
        fastcgi_index  index.php;
        fastcgi_param  SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_param  REMOTE_ADDR     \$remote_addr;
    }

    # Block hidden files
    location ~ /\\. {
        deny all;
    }
}
NGINXBLOCK
echo "-------- end of block --------"
echo ""
info "After editing ${NGINX_CONF}, test and reload Nginx:"
echo ""
echo -e "  ${YELLOW}sudo podman exec systemd-nginx nginx -t${NC}"
echo -e "  ${YELLOW}sudo podman exec systemd-nginx nginx -s reload${NC}"
echo ""

# ── 12. Summary ---------------------------------------------------------------
box "========================================================"
box "  Setup complete!"
box "========================================================"
echo ""
info "Services running:"
echo "  pause-groups-fpm.service       — PHP-FPM on port ${PHP_PORT}"
echo "  pause-groups-watchdog.timer    — fires every minute"
echo "  pause-groups-daily.timer       — fires daily at 00:05"
echo ""
info "App files:   ${INSTALL_DIR}"
info "Data/DB:     ${DATA_DIR}"
echo ""
warn "Next steps:"
echo "  1. Add the Nginx server block above to ${NGINX_CONF}"
echo "  2. Test + reload Nginx (commands above)"
echo "  3. Open http://${SERVER_NAME}/ in a browser"
echo ""
warn "Grafana continues running on port 3000 — no conflict."
echo ""
