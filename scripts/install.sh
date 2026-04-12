#!/bin/bash
# Sonos Buddy install script
# Called by Pi Control Center after release extraction

INSTALL_DIR="/opt/sonos-buddy"

echo "Rebuilding native modules for this platform..."
cd "$INSTALL_DIR/engine" && npm install --os=linux --cpu=arm64 sharp

echo "✅ Sonos Buddy installed"
