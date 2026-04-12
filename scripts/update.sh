#!/bin/bash
# Sonos Buddy — Update script for Pi Control Center
# Called by Pi Control Center when a new release is available.

set -e

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/sonos-buddy}"
LOG_TAG="[SONOS-UPDATE]"

echo "$LOG_TAG Starting update at $(date)"

# Preserve user config files
CONFIG_BACKUP=""
ENV_BACKUP=""
if [ -f "$INSTALL_DIR/engine/config.json" ]; then
  CONFIG_BACKUP=$(cat "$INSTALL_DIR/engine/config.json")
fi
if [ -f "$INSTALL_DIR/engine/.env" ]; then
  ENV_BACKUP=$(cat "$INSTALL_DIR/engine/.env")
fi

# Pi Control Center downloads and extracts dist.tar.gz here
# We just need to install deps and restore config

cd "$INSTALL_DIR/engine"
npm install --production 2>&1 | grep -v "DBUS_SESSION_BUS_ADDRESS\|looking for funding\|npm fund" || true

# Restore config files
if [ -n "$CONFIG_BACKUP" ]; then
  echo "$CONFIG_BACKUP" > "$INSTALL_DIR/engine/config.json"
  echo "$LOG_TAG Restored config.json"
fi
if [ -n "$ENV_BACKUP" ]; then
  echo "$ENV_BACKUP" > "$INSTALL_DIR/engine/.env"
  echo "$LOG_TAG Restored .env"
fi

echo "$LOG_TAG Update complete"
