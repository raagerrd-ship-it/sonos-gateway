#!/bin/bash
# Sonos Proxy - Linux/Raspberry Pi Installer

set -e

APP_NAME="sonos-proxy"
SERVICE_NAME="sonos-proxy"
DEFAULT_PORT=3000

echo ""
echo "========================================"
echo "  Sonos Proxy Installer"
echo "========================================"
echo ""

read -p "Port (standard: $DEFAULT_PORT): " PORT_INPUT
PORT=${PORT_INPUT:-$DEFAULT_PORT}

APP_DIR="$HOME/.local/share/$APP_NAME"

echo ""
echo "Installation:"
echo "  Namn: $APP_NAME"
echo "  Port: $PORT"
echo "  Mapp: $APP_DIR"
echo ""

if [ "$EUID" -eq 0 ]; then
    echo "❌ Kör inte detta script som root!"
    echo "   Använd: ./install-linux.sh"
    exit 1
fi

# 1. Kontrollera Node.js
echo "[1/5] Kontrollerar Node.js..."
if ! command -v node &> /dev/null; then
    echo "  Node.js hittades inte. Försöker installera..."
    if command -v apt-get &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
        sudo apt-get install -y nodejs
    else
        echo "  ❌ Installera Node.js 18+ manuellt: https://nodejs.org"
        exit 1
    fi
fi
echo "  ✓ Node.js $(node --version)"

# 2. Förbered uppdatering
echo "[2/5] Förbereder..."
if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "  Stoppar befintlig tjänst..."
    systemctl --user stop "$SERVICE_NAME"
fi

if [ -d "$APP_DIR" ]; then
    rm -rf "$APP_DIR"
fi

mkdir -p "$APP_DIR"
mkdir -p "$APP_DIR/public"

# 3. Kopiera filer
echo "[3/5] Kopierar filer..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for file in index.js discover.js package.json; do
    if [ -f "$SCRIPT_DIR/$file" ]; then
        cp "$SCRIPT_DIR/$file" "$APP_DIR/"
        echo "  Kopierade $file"
    fi
done

if [ -d "$SCRIPT_DIR/public" ]; then
    cp -r "$SCRIPT_DIR/public/"* "$APP_DIR/public/"
    echo "  Kopierade public-mapp"
fi

# 4. Installera dependencies + skapa .env
echo "[4/5] Installerar dependencies..."
cd "$APP_DIR"
npm install --production

cat > "$APP_DIR/.env" << EOF
# Sonos Proxy Configuration
PORT=$PORT
SONOS_IP=192.168.1.175
EOF

echo "  ✓ Port: $PORT"

# 5. Systemd service
echo "[5/5] Skapar systemd service..."
mkdir -p "$HOME/.config/systemd/user"

cat > "$HOME/.config/systemd/user/$SERVICE_NAME.service" << EOF
[Unit]
Description=Sonos Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$(which node) index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

# Timer för nattlig omstart kl 05:00
cat > "$HOME/.config/systemd/user/$SERVICE_NAME-restart.service" << EOF
[Unit]
Description=Restart Sonos Proxy

[Service]
Type=oneshot
ExecStart=/bin/systemctl --user restart $SERVICE_NAME
EOF

cat > "$HOME/.config/systemd/user/$SERVICE_NAME-restart.timer" << EOF
[Unit]
Description=Nightly restart of Sonos Proxy

[Timer]
OnCalendar=*-*-* 05:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user enable "$SERVICE_NAME-restart.timer"
systemctl --user start "$SERVICE_NAME-restart.timer"
loginctl enable-linger "$USER" 2>/dev/null || true

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user start "$SERVICE_NAME"

echo "  ✓ Service skapad och startad"

IP_ADDR=$(hostname -I | awk '{print $1}')

echo ""
echo "========================================"
echo "  Installation klar!"
echo "========================================"
echo ""
echo "Öppna webbläsaren:"
echo "  http://localhost:$PORT"
echo "  http://$IP_ADDR:$PORT"
echo ""
echo "Kommandon:"
echo "  Status:  systemctl --user status $SERVICE_NAME"
echo "  Loggar:  journalctl --user -u $SERVICE_NAME -f"
echo "  Stoppa:  systemctl --user stop $SERVICE_NAME"
echo "  Starta:  systemctl --user start $SERVICE_NAME"
echo ""
