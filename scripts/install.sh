#!/bin/bash
# Sonos Buddy install script
# Called by Pi Control Center after release extraction.
#
# Pure-JS engine (no native modules) — no rebuild step needed.

set -e

INSTALL_DIR="${INSTALL_DIR:-/opt/sonos-buddy}"
ENGINE_VERSION_FILE="$INSTALL_DIR/engine/version.json"
VERSION_FILE="$INSTALL_DIR/VERSION.json"
ENGINE_PKG="$INSTALL_DIR/engine/package.json"
ROOT_PKG="$INSTALL_DIR/package.json"

if [ -f "$ENGINE_VERSION_FILE" ]; then
  INSTALLED_VERSION=$(node -e "const fs=require('fs'); const file=process.argv[1]; const data=JSON.parse(fs.readFileSync(file,'utf8')); if (!data.version) process.exit(1); process.stdout.write(String(data.version));" "$ENGINE_VERSION_FILE")

  # Write VERSION.json (PCC primary source)
  printf '{"tag":"v%s","version":"v%s","installedAt":"%s"}\n' \
    "$INSTALLED_VERSION" \
    "$INSTALLED_VERSION" \
    "$(date -Iseconds)" > "$VERSION_FILE"

  # Stamp engine/package.json and root package.json so any reader sees the correct version
  for PKG in "$ENGINE_PKG" "$ROOT_PKG"; do
    if [ -f "$PKG" ]; then
      node -e "const fs=require('fs');const p=process.argv[1];const v=process.argv[2];const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version=v;fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');" "$PKG" "$INSTALLED_VERSION"
    fi
  done

  echo "✅ Sonos Buddy installed (v$INSTALLED_VERSION)"
else
  echo "⚠️ Could not find $ENGINE_VERSION_FILE; VERSION.json was not updated"
fi
