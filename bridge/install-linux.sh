#!/bin/bash
# Sonos Proxy - Linux/Raspberry Pi Installer (Git-based)

set -e

APP_NAME="sonos-proxy"
SERVICE_NAME="sonos-proxy"
PORT=3002
CPU_CORE=3
TOTAL_CPUS=$(nproc 2>/dev/null || echo 4)
REPO_DIR="$HOME/.local/share/$APP_NAME"
BRIDGE_DIR="$REPO_DIR/bridge"

# Parse CLI arguments (from Pi Dashboard)
while [[ $# -gt 0 ]]; do
    case $1 in
        --port) PORT="$2"; shift 2 ;;
        --core) CPU_CORE="$2"; shift 2 ;;
        *) shift ;;
    esac
done

echo ""
echo "========================================"
echo "  Sonos Proxy Installer"
echo "========================================"
echo ""
echo "  Port: $PORT"
echo "  CPU:  Kärna $CPU_CORE (av $TOTAL_CPUS)"

# Om vi kör från en git-klonad mapp, använd den som repo-URL
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GIT_URL=""
if [ -d "$REPO_ROOT/.git" ]; then
    GIT_URL=$(cd "$REPO_ROOT" && git remote get-url origin 2>/dev/null || echo "")
fi

if [ -z "$GIT_URL" ]; then
    echo "❌ Ingen repo URL hittad (kör från git-klonad mapp)"
    exit 1
fi

echo ""
echo "Installation:"
echo "  Namn:  $APP_NAME"
echo "  Port:  $PORT"
echo "  CPU:   Kärna $CPU_CORE (av $TOTAL_CPUS)"
echo "  Mapp:  $REPO_DIR"
echo "  Repo:  $GIT_URL"
echo ""

if [ "$EUID" -eq 0 ]; then
    echo "❌ Kör inte detta script som root!"
    echo "   Använd: ./install-linux.sh"
    exit 1
fi

# 1. Kontrollera system, Node.js & Git
echo "[1/6] Kontrollerar system och beroenden..."

# Kontrollera RAM och swap (Pi Zero 2 W har bara 512MB)
TOTAL_RAM=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}')
TOTAL_SWAP=$(free -m 2>/dev/null | awk '/^Swap:/{print $2}')
if [ -n "$TOTAL_RAM" ]; then
    echo "  RAM: ${TOTAL_RAM}MB, Swap: ${TOTAL_SWAP:-0}MB"
    if [ "$TOTAL_RAM" -lt 600 ] && [ "${TOTAL_SWAP:-0}" -lt 100 ]; then
        echo "  ⚠️  Lite RAM och ingen swap — rekommenderar minst 256MB swap"
    fi
fi

if ! command -v node &> /dev/null; then
    echo "  Node.js hittades inte. Försöker installera..."
    if command -v apt-get &> /dev/null; then
        # Använd NodeSource LTS för ARM-stöd (Pi Zero 2 W = armv7l/aarch64)
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    else
        echo "  ❌ Installera Node.js 18+ manuellt: https://nodejs.org"
        exit 1
    fi
fi
NODE_VERSION=$(node --version)
echo "  ✓ Node.js $NODE_VERSION ($(uname -m))"

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

# Spara användarfiler innan vi rör repot
SAVED_CONFIG=""
SAVED_ENV=""
if [ -f "$BRIDGE_DIR/config.json" ]; then
    SAVED_CONFIG=$(cat "$BRIDGE_DIR/config.json")
fi
if [ -f "$BRIDGE_DIR/.env" ]; then
    SAVED_ENV=$(cat "$BRIDGE_DIR/.env")
fi

if [ -d "$REPO_DIR/.git" ]; then
    echo "  Repo finns redan, uppdaterar..."
    cd "$REPO_DIR"
    git fetch --all
    BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    git reset --hard "origin/$BRANCH"
    echo "  ✓ Uppdaterad till $(git log -1 --format='%h %s')"
else
    rm -rf "$REPO_DIR"
    git clone "$GIT_URL" "$REPO_DIR"
    echo "  ✓ Klonad till $REPO_DIR"
fi

# Återställ sparade användarfiler
if [ -n "$SAVED_CONFIG" ]; then
    echo "$SAVED_CONFIG" > "$BRIDGE_DIR/config.json"
    echo "  ✓ Återställde sparad config.json"
fi
if [ -n "$SAVED_ENV" ]; then
    echo "$SAVED_ENV" > "$BRIDGE_DIR/.env"
    echo "  ✓ Återställde sparad .env"
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
ExecStart=$(which node) --max-old-space-size=128 index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=UV_THREADPOOL_SIZE=2
Environment=POSITION_INTERVAL_MS=500
MemoryMax=200M
AllowedCPUs=$CPU_CORE
CPUQuota=100%
IOWeight=50
Nice=-5

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
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git reset --hard "origin/$BRANCH"
echo "$LOG_TAG Pulled: $(git log -1 --format='%h %s')"

# Återställ config
if [ -n "$CONFIG_BACKUP" ]; then
    echo "$CONFIG_BACKUP" > "$SCRIPT_DIR/config.json"
    echo "$LOG_TAG Restored config.json"
fi

# Installera eventuella nya dependencies
cd "$SCRIPT_DIR"
npm install --production || echo "$LOG_TAG Warning: npm install failed"

# Starta om tjänsten
systemctl --user restart "$SERVICE_NAME"
echo "$LOG_TAG Service restarted successfully"
UPDATESCRIPT
chmod +x "$BRIDGE_DIR/update.sh"

# Auto-update service + timer (var 5:e minut)
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
Description=Auto-update for Sonos Proxy (every 5 min)

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
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
echo "  Var 5:e min  Auto-update (git pull + restart om ändringar)"
echo "  05:00        Nattlig omstart (säkerhet)"
echo ""
echo "Kommandon:"
echo "  Status:     systemctl --user status $SERVICE_NAME"
echo "  Loggar:     journalctl --user -u $SERVICE_NAME -f"
echo "  Uppdatera:  $BRIDGE_DIR/update.sh"
echo "  Stoppa:     systemctl --user stop $SERVICE_NAME"
echo "  Starta:     systemctl --user start $SERVICE_NAME"
echo ""
