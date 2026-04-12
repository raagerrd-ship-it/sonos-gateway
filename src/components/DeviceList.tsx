import { useState } from 'react';
import { Wifi, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { sonosAPI, type SonosDevice } from '@/hooks/useSonosAPI';
import { toast } from 'sonner';

interface Props {
  devices: SonosDevice[];
  currentUuid?: string | null;
  currentIp?: string;
  onRefresh: () => void;
  scanning: boolean;
}

export function DeviceList({ devices, currentUuid, currentIp, onRefresh, scanning }: Props) {
  const [selecting, setSelecting] = useState<string | null>(null);

  const selectDevice = async (device: SonosDevice) => {
    const isActive =
      (currentUuid && device.uuid === currentUuid) ||
      (!currentUuid && device.ip === currentIp);
    if (isActive) return;

    setSelecting(device.ip);
    try {
      await sonosAPI.setConfig({
        sonosIp: device.ip,
        sonosName: device.name,
        sonosUuid: device.uuid || '',
      });
      toast.success(`Bytte till ${device.name || device.ip}`);
      onRefresh();
    } catch {
      toast.error('Kunde inte byta enhet');
    } finally {
      setSelecting(null);
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <span className="text-sm font-semibold text-muted-foreground">
          Enheter på nätverket
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={scanning}
          className="text-xs"
        >
          {scanning ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              Skannar...
            </>
          ) : (
            <>
              <Wifi className="w-3.5 h-3.5 mr-1.5" />
              Skanna
            </>
          )}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {devices.length === 0 && !scanning && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            Klicka "Skanna" för att hitta Sonos-enheter
          </div>
        )}
        {devices.map((d) => {
          const isActive =
            (currentUuid && d.uuid === currentUuid) ||
            (!currentUuid && d.ip === currentIp);
          return (
            <button
              key={d.uuid || d.ip}
              onClick={() => selectDevice(d)}
              disabled={!!selecting}
              className={`flex justify-between items-center bg-card border rounded-xl px-4 py-3.5 text-left transition-colors hover:border-muted-foreground/30 ${
                isActive
                  ? 'border-primary bg-primary/5'
                  : 'border-border'
              } ${selecting === d.ip ? 'opacity-60' : ''}`}
            >
              <div>
                <div className="font-semibold text-sm text-foreground">
                  {d.name || 'Okänd'}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {d.ip} · {d.model || 'Sonos'}
                  {d.uuid ? ` · ${d.uuid.substring(0, 8)}` : ''}
                </div>
              </div>
              {isActive && (
                <span className="text-[10px] font-bold uppercase tracking-wide bg-primary/15 text-primary px-2 py-0.5 rounded">
                  Aktiv
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
