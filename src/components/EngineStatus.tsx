import { useEffect, useState } from 'react';
import { sonosAPI, type VersionResponse, type HealthResponse } from '@/hooks/useSonosAPI';
import { Activity } from 'lucide-react';
import { StatusDot } from '@/components/piUi';

export function EngineStatus() {
  const [version, setVersion] = useState<VersionResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const load = () => {
      sonosAPI.getVersion().then(setVersion).catch(() => setError(true));
      sonosAPI.getHealth().then((h) => { setHealth(h); setError(false); }).catch(() => setError(true));
    };
    load();
    const interval = setInterval(load, error ? 5000 : 30000);
    return () => clearInterval(interval);
  }, [error]);

  if (error) {
    return (
      <div className="flex items-center justify-center gap-1.5 text-[11px] text-destructive py-2">
        <Activity className="w-3.5 h-3.5" />
        Motorn svarar inte — kontrollera att engine körs
      </div>
    );
  }

  if (!version || !health) return null;

  return (
    <div className="flex flex-col items-center gap-1.5 py-1">
      <StatusDot
        label={health.status === 'ok' ? 'Motor online' : health.status === 'degraded' ? 'Motor degraderad' : 'Motor fel'}
        state={health.status === 'ok' ? 'ok' : health.status === 'degraded' ? 'warn' : 'error'}
      />
      <div className="font-mono text-[10px] tabular-nums text-muted-foreground/80">
        {health.sonosIp} · {health.subscribed ? 'prenumererar' : 'ej prenumererad'} · {health.memory.rss}MB
      </div>
      <div className="font-mono text-[10px] text-muted-foreground/60">
        {version.name} v{version.version}
        {version.commitShort !== 'unknown' && ` (${version.commitShort})`}
      </div>
    </div>
  );
}
