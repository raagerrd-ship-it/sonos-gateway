# Sonos Proxy

Fristående Sonos UPnP-proxy med SSDP-nätverksskanning, SSE-streaming och webb-UI för att välja aktiv Sonos-högtalare.

## Arkitektur

```
┌─────────────────────────────────────────┐
│  Sonos Proxy  :3002                     │
│                                         │
│  SSDP scan ──► lista alla Sonos-enheter │
│  Vald IP   ──► UPnP SUBSCRIBE          │
│               ├─ SSE /events            │
│               ├─ REST /status           │
│               ├─ Art proxy /getaa       │
│               └─ Config /config (GET/PUT)│
│                                         │
│  Webb-UI: /  (enkel setup-sida)         │
│  config.json (sparar vald IP)           │
└─────────────────────────────────────────┘
```

## API

| Metod | Sökväg | Beskrivning |
|-------|--------|-------------|
| GET | `/api/sonos/status` | Full now-playing JSON |
| GET | `/api/sonos/events` | SSE-ström (real-time) |
| GET | `/api/sonos/getaa*` | Album art proxy från Sonos |
| GET | `/api/sonos/art?url=` | Extern art proxy |
| NOTIFY | `/api/sonos/upnp-callback` | UPnP event-mottagare |
| GET | `/api/sonos/discover` | SSDP-nätverksskanning |
| GET | `/api/sonos/config` | Nuvarande config |
| PUT | `/api/sonos/config` | Byt aktiv Sonos-IP |

## Installation

### Manuellt

```bash
cd bridge
npm install
cp .env.example .env
# Redigera .env med din Sonos-IP
node index.js
```

### Raspberry Pi (systemd)

```bash
chmod +x install-linux.sh
./install-linux.sh
```

## Konfiguration

- `config.json` sparas automatiskt vid val av enhet via webb-UI
- `SONOS_IP` i `.env` används som fallback om ingen config.json finns
- Vid IP-byte: avsluta nuvarande UPnP subscription → ny subscription med ny IP

## Webb-UI

Öppna `http://<ip>:3000/` i webbläsaren:
- Visar hittade Sonos-enheter (namn, IP, modell)
- Markerar nuvarande vald enhet
- Knapp "Skanna igen"
- Klick på enhet → byter IP och re-subscribar
- Visar live now-playing status som bekräftelse

## Filer

```
sonos-proxy/
├── index.js           # Huvudserver (~800 rader, ren Sonos-logik)
├── discover.js        # SSDP-skanning modul
├── package.json
├── config.json        # Auto-genererad vid första start
├── .env.example
├── install-linux.sh   # systemd-tjänst
├── public/
│   └── index.html     # Setup/discovery UI
└── README.md
```
