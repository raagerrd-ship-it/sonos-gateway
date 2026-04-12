#!/bin/bash
# Sonos Buddy — Uninstall script for Pi Control Center
# Pi Control Center hanterar systemd-tjänster automatiskt.
# Detta skript rensar bara installationskatalogen.

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/sonos-buddy}"

echo ""
echo "========================================"
echo "  Sonos Buddy — Avinstallation"
echo "========================================"
echo ""

# Rensa installationskatalog
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "  ✓ $INSTALL_DIR borttagen"
else
  echo "  ✓ Ingen installation hittad"
fi

echo ""
echo "✅ Sonos Buddy avinstallerad"
echo ""
