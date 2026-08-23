import { useState, useEffect, useCallback } from 'react';
import { NowPlaying } from '@/components/NowPlaying';
import { DeviceList } from '@/components/DeviceList';
import { SettingsPanel } from '@/components/SettingsPanel';
import { EngineStatus } from '@/components/EngineStatus';
import { useSonosSSE } from '@/hooks/useSonosSSE';
import { sonosAPI, type SonosDevice } from '@/hooks/useSonosAPI';

const Index = () => {
  const { data } = useSonosSSE();
  const [devices, setDevices] = useState<SonosDevice[]>([]);
  const [currentUuid, setCurrentUuid] = useState<string | null>(null);
  const [currentIp, setCurrentIp] = useState<string>('');
  const [scanning, setScanning] = useState(false);

  // Load config and cached devices on mount
  useEffect(() => {
    sonosAPI.getConfig().then((cfg) => {
      setCurrentUuid(cfg.sonosUuid || null);
      setCurrentIp(cfg.currentIp);
      if (cfg.knownDevices?.length > 0) {
        setDevices(cfg.knownDevices);
      }
    }).catch(() => {});
  }, []);

  const scanDevices = useCallback(async () => {
    setScanning(true);
    try {
      const result = await sonosAPI.discover();
      setDevices(result.devices || []);
      if (result.currentUuid) setCurrentUuid(result.currentUuid);
      if (result.currentIp) setCurrentIp(result.currentIp);
    } catch {
      // silent
    } finally {
      setScanning(false);
    }
  }, []);

  const refreshAfterSelect = useCallback(async () => {
    try {
      const cfg = await sonosAPI.getConfig();
      setCurrentUuid(cfg.sonosUuid || null);
      setCurrentIp(cfg.currentIp);
      if (cfg.knownDevices?.length > 0) {
        setDevices(cfg.knownDevices);
      }
    } catch {
      scanDevices();
    }
  }, [scanDevices]);

  return (
    <div className="min-h-screen bg-background text-foreground animate-fade-in">
      <div className="max-w-lg mx-auto px-4 pt-7 space-y-4 safe-bottom">
        {/* Header */}
        <header className="flex justify-between items-center gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
              Sonos Buddy
            </h1>
            <p className="label-eyebrow mt-1">Välj aktiv högtalare</p>
          </div>
          <SettingsPanel />
        </header>


        {/* Now Playing */}
        <NowPlaying data={data} />

        {/* Device List */}
        <DeviceList
          devices={devices}
          currentUuid={currentUuid}
          currentIp={currentIp}
          onRefresh={scanDevices}
          scanning={scanning}
        />

        {/* Engine Status */}
        <EngineStatus />
      </div>
    </div>
  );
};

export default Index;
