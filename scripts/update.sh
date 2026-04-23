#!/bin/bash
# Sonos Buddy — Update script for Pi Control Center
# Called by Pi Control Center when a new release is available.

set -e

INSTALL_DIR="${INSTALL_DIR:-/opt/sonos-buddy}"
LOG_TAG="[SONOS-UPDATE]"
ENGINE_VERSION_FILE="$INSTALL_DIR/engine/version.json"
VERSION_FILE="$INSTALL_DIR/VERSION.json"

echo "$LOG_TAG Starting update at $(date)"

# Settings/state/logs live in PCC_CONFIG_DIR / PCC_DATA_DIR / PCC_LOG_DIR (outside /opt),
# so they survive updates automatically. Only legacy engine/config.json (pre-PCC layout)
# may exist inside /opt/ — preserve it for one-time migration on next start.
LEGACY_BACKUP=""
if [ -f "$INSTALL_DIR/engine/config.json" ]; then
  LEGACY_BACKUP=$(cat "$INSTALL_DIR/engine/config.json")
fi

# Pi Control Center downloads and extracts dist.tar.gz here; install prod deps.
cd "$INSTALL_DIR/engine"
npm install --production 2>&1 | grep -v "DBUS_SESSION_BUS_ADDRESS\|looking for funding\|npm fund" || true

if [ -n "$LEGACY_BACKUP" ]; then
  echo "$LEGACY_BACKUP" > "$INSTALL_DIR/engine/config.json"
  echo "$LOG_TAG Restored legacy config.json (will be migrated to PCC_CONFIG_DIR/PCC_DATA_DIR on next start)"
fi

if [ -f "$ENGINE_VERSION_FILE" ]; then
  INSTALLED_VERSION=$(node -e "const fs=require('fs'); const file=process.argv[1]; const data=JSON.parse(fs.readFileSync(file,'utf8')); if (!data.version) process.exit(1); process.stdout.write(String(data.version));" "$ENGINE_VERSION_FILE")
  printf '{"tag":"v%s","version":"v%s","installedAt":"%s"}\n' \
    "$INSTALLED_VERSION" \
    "$INSTALLED_VERSION" \
    "$(date -Iseconds)" > "$VERSION_FILE"
  echo "$LOG_TAG Synced VERSION.json to v$INSTALLED_VERSION"
else
  echo "$LOG_TAG Warning: missing $ENGINE_VERSION_FILE; VERSION.json not updated"
fi

echo "$LOG_TAG Update complete"
