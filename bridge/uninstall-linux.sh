#!/bin/bash
# Sonos Proxy - Uninstaller

set -e

SERVICE_NAME="sonos-proxy"
REPO_DIR="$HOME/.local/share/sonos-proxy"

echo ""
echo "========================================"
echo "  Sonos Proxy Uninstaller"
echo "========================================"
echo ""

# 1. Stop and disable services
echo "[1/3] Stoppar tjänster..."
systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
systemctl --user stop "$SERVICE_NAME-update.timer" 2>/dev/null || true
systemctl --user stop "$SERVICE_NAME-restart.timer" 2>/dev/null || true
systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
systemctl --user disable "$SERVICE_NAME-update.timer" 2>/dev/null || true
systemctl --user disable "$SERVICE_NAME-restart.timer" 2>/dev/null || true
echo "  ✓ Tjänster stoppade"

# 2. Remove service files
echo "[2/3] Tar bort systemd-filer..."
rm -f "$HOME/.config/systemd/user/$SERVICE_NAME.service"
rm -f "$HOME/.config/systemd/user/$SERVICE_NAME-update.service"
rm -f "$HOME/.config/systemd/user/$SERVICE_NAME-update.timer"
rm -f "$HOME/.config/systemd/user/$SERVICE_NAME-restart.service"
rm -f "$HOME/.config/systemd/user/$SERVICE_NAME-restart.timer"
systemctl --user daemon-reload
echo "  ✓ Systemd-filer borttagna"

# 3. Remove installed files
echo "[3/3] Tar bort installerade filer..."
if [ -d "$REPO_DIR" ]; then
    rm -rf "$REPO_DIR"
    echo "  ✓ $REPO_DIR borttagen"
else
    echo "  ✓ Ingen installation hittad"
fi

echo ""
echo "========================================"
echo "  Avinstallation klar!"
echo "========================================"
echo ""
