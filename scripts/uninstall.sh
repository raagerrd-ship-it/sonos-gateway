#!/bin/bash
# Sonos Buddy — Uninstall script for Pi Control Center
# Stoppar tjänster först, rensar sedan all data.

INSTALL_DIR="${INSTALL_DIR:-/opt/sonos-buddy}"
SERVICES=("sonos-buddy-ui" "sonos-buddy-engine")

echo ""
echo "========================================"
echo "  Sonos Buddy — Avinstallation"
echo "========================================"
echo ""

# 1. Stoppa och inaktivera systemd-tjänster (UI först, sedan engine)
for svc in "${SERVICES[@]}"; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${svc}\.service"; then
    echo "  • Stoppar ${svc}..."
    systemctl stop "${svc}" 2>/dev/null || true
    systemctl disable "${svc}" 2>/dev/null || true
    rm -f "/etc/systemd/system/${svc}.service"
    echo "    ✓ ${svc} stoppad"
  fi
done

# Ladda om systemd om vi tog bort några unit-filer
systemctl daemon-reload 2>/dev/null || true
systemctl reset-failed 2>/dev/null || true

# 2. Avsluta eventuella kvarvarande processer
pkill -f "sonos-buddy" 2>/dev/null || true
pkill -f "${INSTALL_DIR}/engine" 2>/dev/null || true

# 3. Rensa installationskatalog (kod, node_modules, config, cache)
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "  ✓ $INSTALL_DIR borttagen"
else
  echo "  ✓ Ingen installation hittad"
fi

echo ""
echo "✅ Sonos Buddy avinstallerad"
echo ""
