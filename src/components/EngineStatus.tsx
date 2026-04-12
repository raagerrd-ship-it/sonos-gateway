import { useEffect, useState } from 'react';
import { sonosAPI, type VersionResponse, type HealthResponse } from '@/hooks/useSonosAPI';
import { Activity } from 'lucide-react';

export function EngineStatus() {
  const [version, setVersion] = useState<VersionResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetch = () => {
      sonosAPI.getVersion().then(setVersion).catch(() => setError(true));
      sonosAPI.getHealth().then((h) => { setHealth(h); setError(false); }).catch(() => setError(true));
    };
    fetch();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, []);

  if (error) {
    return (
      <div className="text-center text-xs text-destructive py-2">
        <Activity className="w-3.5 h-3.5 inline mr-1" />
        Motorn svarar inte — kontrollera att engine körs
      </div>
    );
  }

  if (!version || !health) return null;

  return (
    <div className="text-center text-[11px] text-muted-foreground space-y-0.5">
      <div>
        {version.name} v{version.version}
        {version.commitShort !== 'unknown' && (
          <span className="ml-1 opacity-60">({version.commitShort})</span>
        )}
      </div>
      <div>
        {health.status === 'ok' ? '●' : '○'} {health.sonosIp}
        {health.subscribed ? ' · Prenumererar' : ' · Ej prenumererad'}
        {' · '}{health.memoryMB}MB RAM
      </div>
    </div>
  );
}
