#!/bin/bash
# Sonos Buddy — Uninstall script for Pi Control Center
# Pi Control Center calls this to clean up before removing the service.

set -e

INSTALL_DIR="${INSTALL_DIR:-/opt/sonos-buddy}"
SERVICE_ENGINE="sonos-buddy-engine"
SERVICE_UI="sonos-buddy-ui"

echo ""
echo "========================================"
echo "  Sonos Buddy — Avinstallation"
echo "========================================"
echo ""

# Stop and disable services
echo "[1/3] Stoppar tjänster..."
systemctl --user stop "$SERVICE_ENGINE" 2>/dev/null || true
systemctl --user stop "$SERVICE_UI" 2>/dev/null || true
systemctl --user disable "$SERVICE_ENGINE" 2>/dev/null || true
systemctl --user disable "$SERVICE_UI" 2>/dev/null || true
echo "  ✓ Tjänster stoppade"

# Remove service files
echo "[2/3] Tar bort systemd-filer..."
rm -f "$HOME/.config/systemd/user/$SERVICE_ENGINE.service"
rm -f "$HOME/.config/systemd/user/$SERVICE_UI.service"
systemctl --user daemon-reload
echo "  ✓ Systemd-filer borttagna"

# Remove installed files
echo "[3/3] Tar bort installerade filer..."
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "  ✓ $INSTALL_DIR borttagen"
else
  echo "  ✓ Ingen installation hittad"
fi

echo ""
echo "========================================"
echo "  Avinstallation klar!"
echo "========================================"
echo ""
