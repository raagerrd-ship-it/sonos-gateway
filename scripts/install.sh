#!/bin/bash
# Sonos Buddy install script
# Called by Pi Control Center after release extraction.
#
# Pure-JS engine (no native modules) — no rebuild step needed.

set -e

INSTALL_DIR="${INSTALL_DIR:-/opt/sonos-buddy}"
ENGINE_VERSION_FILE="$INSTALL_DIR/engine/version.json"
VERSION_FILE="$INSTALL_DIR/VERSION.json"

if [ -f "$ENGINE_VERSION_FILE" ]; then
  INSTALLED_VERSION=$(node -e "const fs=require('fs'); const file=process.argv[1]; const data=JSON.parse(fs.readFileSync(file,'utf8')); if (!data.version) process.exit(1); process.stdout.write(String(data.version));" "$ENGINE_VERSION_FILE")
  printf '{"tag":"v%s","version":"v%s","installedAt":"%s"}\n' \
    "$INSTALLED_VERSION" \
    "$INSTALLED_VERSION" \
    "$(date -Iseconds)" > "$VERSION_FILE"
  echo "✅ Sonos Buddy installed ($INSTALLED_VERSION)"
else
  echo "⚠️ Could not find $ENGINE_VERSION_FILE; VERSION.json was not updated"
fi
