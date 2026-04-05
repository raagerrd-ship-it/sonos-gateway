import { Radio, Wifi, Terminal, Server, Cpu, ArrowRight, Copy, Check, Github } from "lucide-react";
import { useState } from "react";

const CopyBlock = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      className="group flex items-center gap-2 w-full text-left font-mono text-sm bg-secondary/60 hover:bg-secondary rounded-md px-3 py-2 transition-colors"
    >
      <span className="flex-1 text-foreground/80">{text}</span>
      {copied ? (
        <Check className="w-4 h-4 text-primary shrink-0" />
      ) : (
        <Copy className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      )}
    </button>
  );
};

const features = [
  {
    icon: Wifi,
    title: "SSDP Discovery",
    desc: "Hittar automatiskt alla Sonos-enheter på nätverket via UPnP/SSDP-skanning.",
  },
  {
    icon: Radio,
    title: "SSE Real-time",
    desc: "Server-Sent Events strömmar now-playing data i realtid utan polling.",
  },
  {
    icon: Server,
    title: "UPnP Proxy",
    desc: "Prenumererar på Sonos-events och exponerar ett rent REST API.",
  },
  {
    icon: Cpu,
    title: "Pi Zero-optimerad",
    desc: "Körs med ~50 MB RAM. Systemd-tjänst med auto-update var 5:e minut.",
  },
];

const apiEndpoints = [
  { method: "GET", path: "/api/sonos/status", desc: "Full now-playing JSON" },
  { method: "GET", path: "/api/sonos/events", desc: "SSE-ström (real-time)" },
  { method: "GET", path: "/api/sonos/getaa*", desc: "Album art proxy" },
  { method: "GET", path: "/api/sonos/art?url=", desc: "Extern art proxy" },
  { method: "GET", path: "/api/sonos/discover", desc: "SSDP-nätverksskanning" },
  { method: "GET", path: "/api/sonos/config", desc: "Nuvarande config" },
  { method: "PUT", path: "/api/sonos/config", desc: "Byt aktiv Sonos-IP" },
];

const installSteps = [
  { step: "1", title: "Klona repot", cmd: "git clone https://github.com/raagerrd-ship-it/sonos-gateway.git && cd sonos-gateway/bridge" },
  { step: "2", title: "Installera", cmd: "npm install" },
  { step: "3", title: "Konfigurera", cmd: "cp .env.example .env" },
  { step: "4", title: "Starta", cmd: "node index.js" },
];

const Index = () => {
  return (
    <div className="dark min-h-screen bg-background text-foreground">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,hsl(var(--sonos-green)/0.08),transparent_60%)]" />
        <div className="relative max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
          <div className="inline-flex items-center gap-2 bg-accent/60 text-accent-foreground px-4 py-1.5 rounded-full text-xs font-medium mb-8 border border-primary/20">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            Open Source · Raspberry Pi Ready
          </div>
          <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight mb-4">
            <span className="text-primary">Sonos</span> Proxy
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
            Fristående Node.js-proxy som kopplar Sonos UPnP till ett modernt REST + SSE API.
            Perfekt som backend för skärmsläckare, dashboards och hemautomation.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="#installation"
              className="inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground font-semibold px-6 py-3 rounded-lg hover:brightness-110 transition-all"
            >
              Kom igång <ArrowRight className="w-4 h-4" />
            </a>
            <a
              href="#api"
              className="inline-flex items-center justify-center gap-2 border border-border bg-card text-card-foreground font-semibold px-6 py-3 rounded-lg hover:bg-secondary transition-colors"
            >
              API-dokumentation
            </a>
          </div>
        </div>
      </section>

      {/* Architecture diagram */}
      <section className="max-w-4xl mx-auto px-6 pb-16">
        <div className="bg-card border border-border rounded-xl p-6 font-mono text-xs md:text-sm text-muted-foreground overflow-x-auto">
          <pre className="whitespace-pre leading-relaxed">{`┌─────────────────────────────────────────────┐
│  Sonos Proxy  :3002                         │
│                                             │
│  SSDP scan ──► lista alla Sonos-enheter     │
│  Vald IP   ──► UPnP SUBSCRIBE              │
│               ├─ SSE /events                │
│               ├─ REST /status               │
│               ├─ Art proxy /getaa           │
│               └─ Config /config (GET/PUT)   │
│                                             │
│  Webb-UI: /  (setup & discovery)            │
│  config.json (sparar vald IP + UUID)        │
└─────────────────────────────────────────────┘`}</pre>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <h2 className="text-2xl font-bold text-center mb-10">Features</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          {features.map((f) => (
            <div
              key={f.title}
              className="bg-card border border-border rounded-xl p-5 hover:border-primary/30 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-accent flex items-center justify-center mb-3">
                <f.icon className="w-5 h-5 text-primary" />
              </div>
              <h3 className="font-semibold text-foreground mb-1">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* API */}
      <section id="api" className="max-w-4xl mx-auto px-6 pb-20 scroll-mt-8">
        <h2 className="text-2xl font-bold text-center mb-2">API</h2>
        <p className="text-center text-muted-foreground text-sm mb-8">
          Alla endpoints nås via <code className="bg-secondary px-1.5 py-0.5 rounded text-xs">http://&lt;ip&gt;:3002</code>
        </p>
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="grid grid-cols-[auto_1fr_1fr] text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-secondary/50 px-5 py-3 border-b border-border">
            <span className="w-16">Metod</span>
            <span>Sökväg</span>
            <span>Beskrivning</span>
          </div>
          {apiEndpoints.map((ep, i) => (
            <div
              key={ep.path}
              className={`grid grid-cols-[auto_1fr_1fr] px-5 py-3 text-sm items-center ${
                i !== apiEndpoints.length - 1 ? "border-b border-border" : ""
              }`}
            >
              <span
                className={`w-16 font-mono text-xs font-bold ${
                  ep.method === "PUT" ? "text-yellow-400" : "text-primary"
                }`}
              >
                {ep.method}
              </span>
              <span className="font-mono text-foreground/80 text-xs">{ep.path}</span>
              <span className="text-muted-foreground text-xs">{ep.desc}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Installation */}
      <section id="installation" className="max-w-4xl mx-auto px-6 pb-20 scroll-mt-8">
        <h2 className="text-2xl font-bold text-center mb-2">Installation</h2>
        <p className="text-center text-muted-foreground text-sm mb-8">
          Kör manuellt eller använd det automatiska installationsskriptet för Raspberry Pi.
        </p>

        {/* Pi auto-install (primary) */}
        <div className="bg-card border-2 border-primary/30 rounded-xl p-6 mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Cpu className="w-5 h-5 text-primary" />
            <h3 className="font-semibold">Raspberry Pi (rekommenderat)</h3>
            <span className="ml-auto text-[10px] font-medium uppercase tracking-wider bg-primary/15 text-primary px-2 py-0.5 rounded-full">Automatisk</span>
          </div>
          <p className="text-sm text-muted-foreground mb-5 leading-relaxed">
            Du behöver en annan dator (Mac, PC eller Linux) för att ansluta till din Pi via SSH.
          </p>

          {/* SSH help */}
          <details className="bg-accent/30 border border-border rounded-lg mb-5">
            <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none text-sm">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="font-medium text-foreground/90">Hur aktiverar och använder jag SSH?</span>
            </summary>
            <div className="px-4 pb-4 text-xs text-muted-foreground space-y-3">
              <div>
                <p className="font-semibold text-accent-foreground mb-1">Aktivera SSH på din Pi</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>
                    <strong>Raspberry Pi Imager</strong> – när du flashar SD-kortet, klicka på kugghjulet (⚙) och bocka i "Enable SSH". Enklast!
                  </li>
                  <li>
                    <strong>Redan flashat?</strong> – Sätt in SD-kortet i din dator och skapa en tom fil som heter <code className="bg-secondary px-1 rounded">ssh</code> (utan filändelse) i <code className="bg-secondary px-1 rounded">boot</code>-partitionen. Ta ut kortet och starta Pi:n.
                  </li>
                  <li>
                    <strong>Med skärm & tangentbord</strong> – Kör <code className="bg-secondary px-1 rounded">sudo raspi-config</code> → Interface Options → SSH → Enable.
                  </li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-accent-foreground mb-1">Hitta din Pi:s IP-adress</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>Logga in på din router och leta efter en enhet som heter <code className="bg-secondary px-1 rounded">raspberrypi</code>.</li>
                  <li>Eller prova: <code className="bg-secondary px-1 rounded">ping raspberrypi.local</code> från din dator (fungerar ofta på Mac/Linux).</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-accent-foreground mb-1">Anslut</p>
                <ul className="list-disc list-inside space-y-1">
                  <li><strong>Mac / Linux</strong> – Öppna Terminal och kör kommandot nedan.</li>
                  <li><strong>Windows</strong> – Öppna PowerShell eller installera <a href="https://putty.org" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">PuTTY</a>.</li>
                  <li>Standard-lösenord: <code className="bg-secondary px-1 rounded">raspberry</code> (byt det efteråt med <code className="bg-secondary px-1 rounded">passwd</code>).</li>
                </ul>
              </div>
            </div>
          </details>

          <div className="space-y-3">
            <div>
              <span className="text-xs text-muted-foreground mb-1 block">1. Anslut till din Pi via SSH</span>
              <CopyBlock text="ssh pi@<pi-ip>" />
            </div>
            <div>
              <span className="text-xs text-muted-foreground mb-1 block">2. Klona repot</span>
              <CopyBlock text="git clone https://github.com/raagerrd-ship-it/sonos-gateway.git" />
            </div>
            <div>
              <span className="text-xs text-muted-foreground mb-1 block">3. Kör installationen</span>
              <CopyBlock text="cd sonos-gateway && bash bridge/install-linux.sh" />
            </div>
            <div>
              <span className="text-xs text-muted-foreground mb-1 block">4. Välj högtalare</span>
              <p className="text-sm text-muted-foreground">
                Öppna <code className="bg-secondary px-1.5 py-0.5 rounded text-xs text-foreground/80">http://&lt;pi-ip&gt;:3002</code> i webbläsaren på din dator och välj din Sonos-högtalare. Klart!
              </p>
            </div>
          </div>
          <div className="mt-5 bg-accent/40 border border-primary/10 rounded-lg p-4 text-xs text-muted-foreground space-y-1">
            <p className="font-semibold text-accent-foreground">Vad scriptet gör:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Installerar Node.js och Git om de saknas</li>
              <li>Klonar repot till <code className="bg-secondary px-1 rounded">~/.local/share/sonos-proxy/</code></li>
              <li>Skapar systemd-tjänst med resursbegränsningar (200 MB max)</li>
              <li>Auto-update timer (var 5 min) + nattlig omstart 05:00</li>
            </ul>
          </div>
        </div>

        {/* Manual (secondary) */}
        <details className="bg-card border border-border rounded-xl">
          <summary className="flex items-center gap-2 p-6 cursor-pointer select-none">
            <Terminal className="w-5 h-5 text-muted-foreground" />
            <span className="font-semibold text-muted-foreground">Manuell installation</span>
            <span className="text-xs text-muted-foreground ml-auto">för utveckling / andra plattformar</span>
          </summary>
          <div className="px-6 pb-6 space-y-2">
            {installSteps.map((s) => (
              <div key={s.step}>
                <span className="text-xs text-muted-foreground mb-1 block">
                  {s.step}. {s.title}
                </span>
                <CopyBlock text={s.cmd} />
              </div>
            ))}
            <p className="text-xs text-muted-foreground mt-4">
              Öppna sedan{" "}
              <code className="bg-secondary px-1 rounded">http://localhost:3002</code> och
              välj din Sonos-högtalare.
            </p>
          </div>
        </details>
      </section>

      {/* Service commands */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <h2 className="text-lg font-bold mb-4 text-center">Användbara kommandon</h2>
        <div className="bg-card border border-border rounded-xl p-5 grid sm:grid-cols-2 gap-2">
          {[
            { label: "Status", cmd: "systemctl --user status sonos-proxy" },
            { label: "Loggar", cmd: "journalctl --user -u sonos-proxy -f" },
            { label: "Stoppa", cmd: "systemctl --user stop sonos-proxy" },
            { label: "Starta", cmd: "systemctl --user start sonos-proxy" },
          ].map((c) => (
            <div key={c.label}>
              <span className="text-xs text-muted-foreground block mb-1">{c.label}</span>
              <CopyBlock text={c.cmd} />
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">
        <div className="flex items-center justify-center gap-4">
          <span>Sonos Proxy</span>
          <span className="text-border">·</span>
          <span>Open Source</span>
          <span className="text-border">·</span>
          <span>Node.js + UPnP</span>
        </div>
      </footer>
    </div>
  );
};

export default Index;
