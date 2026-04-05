#!/bin/bash
# Sonos Proxy - Linux/Raspberry Pi Installer (Git-based)

set -e

APP_NAME="sonos-proxy"
SERVICE_NAME="sonos-proxy"
DEFAULT_PORT=3002
REPO_DIR="$HOME/.local/share/$APP_NAME"
BRIDGE_DIR="$REPO_DIR/bridge"

echo ""
echo "========================================"
echo "  Sonos Proxy Installer"
echo "========================================"
echo ""

while true; do
    read -p "Port (standard: $DEFAULT_PORT): " PORT_INPUT
    PORT=${PORT_INPUT:-$DEFAULT_PORT}
    
    # Kolla om porten redan används (ignorera vår egen tjänst)
    if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
        OWNER=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | sed 's/.*users:(("//' | sed 's/".*//')
        echo "  ⚠️  Port $PORT är redan upptagen av: $OWNER"
        read -p "  Vill du välja en annan port? (j/n): " RETRY
        if [ "$RETRY" = "n" ] || [ "$RETRY" = "N" ]; then
            echo "  Fortsätter med port $PORT (kan orsaka konflikt)"
            break
        fi
    else
        echo "  ✓ Port $PORT är ledig"
        break
    fi
done

# Om vi kör från en git-klonad mapp, använd den som repo-URL
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GIT_URL=""
if [ -d "$REPO_ROOT/.git" ]; then
    GIT_URL=$(cd "$REPO_ROOT" && git remote get-url origin 2>/dev/null || echo "")
fi

if [ -z "$GIT_URL" ]; then
    read -p "GitHub repo URL: " GIT_URL
    if [ -z "$GIT_URL" ]; then
        echo "❌ Ingen repo URL angiven"
        exit 1
    fi
fi

echo ""
echo "Installation:"
echo "  Namn:  $APP_NAME"
echo "  Port:  $PORT"
echo "  Mapp:  $REPO_DIR"
echo "  Repo:  $GIT_URL"
echo ""

if [ "$EUID" -eq 0 ]; then
    echo "❌ Kör inte detta script som root!"
    echo "   Använd: ./install-linux.sh"
    exit 1
fi

# 1. Kontrollera Node.js & Git
echo "[1/6] Kontrollerar beroenden..."
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

if ! command -v git &> /dev/null; then
    echo "  Git hittades inte. Försöker installera..."
    sudo apt-get install -y git
fi
echo "  ✓ Git $(git --version | cut -d' ' -f3)"

# 2. Stoppa befintlig tjänst
echo "[2/6] Förbereder..."
if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "  Stoppar befintlig tjänst..."
    systemctl --user stop "$SERVICE_NAME"
fi

# 3. Klona eller uppdatera repo
echo "[3/6] Hämtar kod från GitHub..."
if [ -d "$REPO_DIR/.git" ]; then
    echo "  Repo finns redan, uppdaterar..."
    cd "$REPO_DIR"
    git fetch --all
    git reset --hard origin/$(git rev-parse --abbrev-ref HEAD)
    echo "  ✓ Uppdaterad till $(git log -1 --format='%h %s')"
else
    # Spara eventuell befintlig config
    SAVED_CONFIG=""
    if [ -f "$REPO_DIR/bridge/config.json" ]; then
        SAVED_CONFIG=$(cat "$REPO_DIR/bridge/config.json")
    fi
    
    rm -rf "$REPO_DIR"
    git clone "$GIT_URL" "$REPO_DIR"
    echo "  ✓ Klonad till $REPO_DIR"
    
    # Återställ sparad config
    if [ -n "$SAVED_CONFIG" ]; then
        echo "$SAVED_CONFIG" > "$BRIDGE_DIR/config.json"
        echo "  ✓ Återställde sparad config.json"
    fi
fi

# 4. Installera dependencies
echo "[4/6] Installerar dependencies..."
cd "$BRIDGE_DIR"
npm install --production

# Skapa .env om den inte finns
if [ ! -f "$BRIDGE_DIR/.env" ]; then
    cat > "$BRIDGE_DIR/.env" << EOF
# Sonos Proxy Configuration
PORT=$PORT
SONOS_IP=192.168.1.175
EOF
    echo "  ✓ Skapade .env med port $PORT"
else
    echo "  ✓ Behöll befintlig .env"
fi

# 5. Systemd services
echo "[5/6] Skapar systemd services..."
mkdir -p "$HOME/.config/systemd/user"

cat > "$HOME/.config/systemd/user/$SERVICE_NAME.service" << EOF
[Unit]
Description=Sonos Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$BRIDGE_DIR
ExecStart=$(which node) index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

# Auto-update script
cat > "$BRIDGE_DIR/update.sh" << 'UPDATESCRIPT'
#!/bin/bash
# Sonos Proxy Auto-Update
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="sonos-proxy"
LOG_TAG="[SONOS-UPDATE]"

echo "$LOG_TAG Checking for updates at $(date)"

cd "$REPO_DIR"

# Hämta senaste från remote
git fetch origin 2>/dev/null || { echo "$LOG_TAG Git fetch failed"; exit 1; }

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse @{u})

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "$LOG_TAG Already up to date ($LOCAL)"
    exit 0
fi

echo "$LOG_TAG Update available: $LOCAL → $REMOTE"

# Spara config.json
CONFIG_BACKUP=""
if [ -f "$SCRIPT_DIR/config.json" ]; then
    CONFIG_BACKUP=$(cat "$SCRIPT_DIR/config.json")
fi

# Pull changes
git reset --hard origin/$(git rev-parse --abbrev-ref HEAD)
echo "$LOG_TAG Pulled: $(git log -1 --format='%h %s')"

# Återställ config
if [ -n "$CONFIG_BACKUP" ]; then
    echo "$CONFIG_BACKUP" > "$SCRIPT_DIR/config.json"
    echo "$LOG_TAG Restored config.json"
fi

# Installera eventuella nya dependencies
cd "$SCRIPT_DIR"
npm install --production 2>/dev/null

# Starta om tjänsten
systemctl --user restart "$SERVICE_NAME"
echo "$LOG_TAG Service restarted successfully"
UPDATESCRIPT
chmod +x "$BRIDGE_DIR/update.sh"

# Auto-update service + timer (kör kl 04:00 varje natt)
cat > "$HOME/.config/systemd/user/$SERVICE_NAME-update.service" << EOF
[Unit]
Description=Sonos Proxy Auto-Update

[Service]
Type=oneshot
ExecStart=$BRIDGE_DIR/update.sh
Environment=HOME=$HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EOF

cat > "$HOME/.config/systemd/user/$SERVICE_NAME-update.timer" << EOF
[Unit]
Description=Nightly auto-update for Sonos Proxy

[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=900
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Nattlig omstart kl 05:00
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

loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user daemon-reload

systemctl --user enable "$SERVICE_NAME"
systemctl --user enable "$SERVICE_NAME-update.timer"
systemctl --user enable "$SERVICE_NAME-restart.timer"

systemctl --user start "$SERVICE_NAME-update.timer"
systemctl --user start "$SERVICE_NAME-restart.timer"
systemctl --user start "$SERVICE_NAME"

echo "  ✓ Services skapade och startade"

# 6. Sammanfattning
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
echo "Schema:"
echo "  04:00  Auto-update (git pull + restart om ändringar)"
echo "  05:00  Nattlig omstart (säkerhet)"
echo ""
echo "Kommandon:"
echo "  Status:     systemctl --user status $SERVICE_NAME"
echo "  Loggar:     journalctl --user -u $SERVICE_NAME -f"
echo "  Uppdatera:  $BRIDGE_DIR/update.sh"
echo "  Stoppa:     systemctl --user stop $SERVICE_NAME"
echo "  Starta:     systemctl --user start $SERVICE_NAME"
echo ""
