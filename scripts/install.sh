#!/bin/bash
# Sonos Buddy — Install script for Pi Control Center
# This script handles initial setup only. Pi Control Center manages systemd services.

set -e

APP_NAME="sonos-buddy"
INSTALL_DIR="${INSTALL_DIR:-/opt/$APP_NAME}"

echo ""
echo "========================================"
echo "  Sonos Buddy — Installation"
echo "========================================"
echo ""

# Detect script location and repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js krävs men hittades inte."
  echo "   Installera Node.js 20+: https://nodejs.org"
  exit 1
fi
echo "✓ Node.js $(node --version)"

# Determine source: release tarball or git clone
if [ -f "$REPO_ROOT/engine/index.js" ] && [ -d "$REPO_ROOT/dist" ]; then
  echo "✓ Installerar från release-paket"
  SOURCE_TYPE="release"
elif [ -d "$REPO_ROOT/.git" ]; then
  echo "✓ Installerar från git-klon"
  SOURCE_TYPE="git"
else
  echo "❌ Varken release-paket eller git-repo hittades"
  exit 1
fi

# Create install directory if different from repo
if [ "$INSTALL_DIR" != "$REPO_ROOT" ]; then
  echo "Kopierar filer till $INSTALL_DIR..."
  sudo mkdir -p "$INSTALL_DIR"
  sudo chown "$USER:$USER" "$INSTALL_DIR"

  if [ "$SOURCE_TYPE" = "release" ]; then
    cp -r "$REPO_ROOT/engine" "$INSTALL_DIR/"
    cp -r "$REPO_ROOT/dist" "$INSTALL_DIR/"
  else
    cp -r "$REPO_ROOT/engine" "$INSTALL_DIR/"
    # UI must be pre-built for git installs
    if [ -d "$REPO_ROOT/dist" ]; then
      cp -r "$REPO_ROOT/dist" "$INSTALL_DIR/"
    else
      echo "⚠️  dist/ saknas — bygg UI:t först med: npm run build"
    fi
  fi

  # Copy scripts
  mkdir -p "$INSTALL_DIR/scripts"
  cp "$SCRIPT_DIR/install.sh" "$INSTALL_DIR/scripts/" 2>/dev/null || true
  cp "$SCRIPT_DIR/update.sh" "$INSTALL_DIR/scripts/" 2>/dev/null || true
  cp "$SCRIPT_DIR/uninstall.sh" "$INSTALL_DIR/scripts/" 2>/dev/null || true
fi

# Install engine dependencies
echo "Installerar engine dependencies..."
cd "$INSTALL_DIR/engine"
npm install --production 2>&1 | grep -v "DBUS_SESSION_BUS_ADDRESS\|looking for funding\|npm fund" || true

# Create .env if it doesn't exist
if [ ! -f "$INSTALL_DIR/engine/.env" ]; then
  cat > "$INSTALL_DIR/engine/.env" << EOF
# Sonos Buddy Engine Configuration
SONOS_IP=192.168.1.175
EOF
  echo "✓ Skapade engine/.env"
fi

echo ""
echo "========================================"
echo "  Installation klar!"
echo "========================================"
echo ""
echo "Pi Control Center hanterar systemd-tjänster automatiskt."
echo "Engine: $INSTALL_DIR/engine/index.js"
echo "UI:     $INSTALL_DIR/dist/"
echo ""
