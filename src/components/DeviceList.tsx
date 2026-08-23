import { useState } from 'react';
import { Wifi, Loader2, Speaker } from 'lucide-react';
import { Panel, Button } from '@/components/piUi';
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
    <Panel
      title="Enheter"
      icon={<Speaker className="w-3 h-3" />}
      action={
        <Button onClick={onRefresh} disabled={scanning} className="!w-auto min-h-[34px] px-3.5 text-[11px] shrink-0">
          {scanning ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Skannar
            </>
          ) : (
            <>
              <Wifi className="w-3.5 h-3.5" />
              Skanna
            </>
          )}
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        {devices.length === 0 && !scanning && (
          <div className="text-center py-8 text-[13px] text-muted-foreground">
            Tryck "Skanna" för att hitta Sonos-enheter
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
              className={`flex justify-between items-center rounded-xl px-4 min-h-[56px] py-3 text-left transition-all active:scale-[0.99] ring-1 ring-inset ${
                isActive
                  ? 'bg-primary/10 ring-primary/40 shadow-[0_0_18px_hsl(var(--primary)/0.15)]'
                  : 'bg-foreground/[0.04] ring-border hover:bg-foreground/[0.07]'
              } ${selecting === d.ip ? 'opacity-60' : ''}`}
            >
              <div className="min-w-0">
                <div className="font-semibold text-[13px] text-foreground truncate">
                  {d.name || 'Okänd'}
                </div>
                <div className="font-mono text-[10px] text-muted-foreground mt-0.5 truncate">
                  {d.ip} · {d.model || 'Sonos'}
                  {d.uuid ? ` · ${d.uuid.substring(0, 8)}` : ''}
                </div>
              </div>
              {isActive && (
                <span className="ml-3 shrink-0 text-[10px] font-bold uppercase tracking-[0.18em] text-primary">
                  Aktiv
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
