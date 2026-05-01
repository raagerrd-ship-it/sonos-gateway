import { useState, useEffect } from 'react';
import { Settings, Cloud, Bug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { sonosAPI, type CloudConfig } from '@/hooks/useSonosAPI';
import { toast } from 'sonner';

export function SettingsPanel() {
  const [open, setOpen] = useState(false);
  const [cloud, setCloud] = useState<CloudConfig | null>(null);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Local form state
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [cloudUrl, setCloudUrl] = useState('');
  const [cloudPositionUrl, setCloudPositionUrl] = useState('');
  const [cloudSecret, setCloudSecret] = useState('');
  const [cloudInterval, setCloudInterval] = useState(3000);

  useEffect(() => {
    if (!open) return;
    sonosAPI.getCloudConfig().then((c) => {
      setCloud(c);
      setCloudEnabled(c.enabled);
      setCloudUrl(c.url || '');
      setCloudPositionUrl(c.positionUrl || '');
      setCloudSecret(c.hasSecret ? '••••••••' : 'Fasanvagen');
      setCloudInterval(c.intervalMs || 3000);
      setDirty(false);
    }).catch(() => {});
    sonosAPI.getDebug().then((d) => setDebugEnabled(d.enabled)).catch(() => {});
  }, [open]);

  // Poll push status
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => {
      sonosAPI.getCloudConfig().then((c) => setCloud(c)).catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [open]);

  const saveCloud = async () => {
    setSaving(true);
    try {
      const result: any = await sonosAPI.setCloudConfig({
        enabled: cloudEnabled,
        url: cloudUrl,
        positionUrl: cloudPositionUrl,
        secret: cloudSecret,
        intervalMs: cloudInterval,
      });
      if (result && result.ok === false) {
        toast.error(result.error || 'Engine kunde inte spara');
        return;
      }
      // Re-fetch from engine to confirm what was actually persisted
      const fresh = await sonosAPI.getCloudConfig();
      setCloud(fresh);
      setCloudEnabled(fresh.enabled);
      setCloudUrl(fresh.url || '');
      setCloudPositionUrl(fresh.positionUrl || '');
      setCloudSecret(fresh.hasSecret ? '••••••••' : 'Fasanvagen');
      setCloudInterval(fresh.intervalMs || 3000);
      setDirty(false);
      toast.success('Cloud-inställningar sparade');
    } catch (e: any) {
      toast.error(e?.message || 'Kunde inte spara');
    } finally {
      setSaving(false);
    }
  };

  const toggleDebug = async (enabled: boolean) => {
    setDebugEnabled(enabled);
    try {
      await sonosAPI.setDebug(enabled);
      toast.success(enabled ? 'Debug-loggning aktiverad' : 'Debug-loggning avstängd');
    } catch {
      toast.error('Kunde inte ändra debug');
    }
  };

  const ps = cloud?.pushStatus;

  return (
    <div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground"
      >
        <Settings className="w-5 h-5" />
      </Button>

      {open && (
        <div className="bg-card border border-border rounded-xl p-4 mt-4 space-y-5">
          {/* Cloud Push */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Cloud className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Cloud Push</h3>
            </div>

            <div className="flex items-center justify-between mb-3">
              <div>
                <Label className="text-sm">Skicka till databas</Label>
                <p className="text-xs text-muted-foreground">Pusha speldata till Brew Monitor TV</p>
              </div>
              <Switch
                checked={cloudEnabled}
                onCheckedChange={(v) => { setCloudEnabled(v); setDirty(true); }}
              />
            </div>

            <div className="space-y-3">
              <div>
                <Label className="text-xs">Cloud Push URL (state)</Label>
                <Input
                  value={cloudUrl}
                  onChange={(e) => { setCloudUrl(e.target.value); setDirty(true); }}
                  placeholder="https://xxx.supabase.co/functions/v1/sonos-state"
                  className="mt-1 font-mono text-xs"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Full payload: track-byten, palette, volym, audio-settings.
                </p>
              </div>
              <div>
                <Label className="text-xs">Cloud Push URL (position)</Label>
                <Input
                  value={cloudPositionUrl}
                  onChange={(e) => { setCloudPositionUrl(e.target.value); setDirty(true); }}
                  placeholder="https://xxx.supabase.co/functions/v1/sonos-position"
                  className="mt-1 font-mono text-xs"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Optional. Lättviktig position-uppdatering (~5 fält) varje sekund. Lämna tomt för att stänga av.
                </p>
              </div>
              <div>
                <Label className="text-xs">Bridge Secret</Label>
                <Input
                  type="password"
                  value={cloudSecret}
                  onChange={(e) => { setCloudSecret(e.target.value); setDirty(true); }}
                  placeholder="Hemlig nyckel"
                  className="mt-1 font-mono text-xs"
                />
              </div>
              <div>
                <Label className="text-xs">Push-intervall (ms)</Label>
                <Input
                  type="number"
                  min={100}
                  step={100}
                  value={cloudInterval}
                  onChange={(e) => { setCloudInterval(parseInt(e.target.value) || 3000); setDirty(true); }}
                  className="mt-1 font-mono text-xs"
                />
              </div>

              <Button
                onClick={saveCloud}
                disabled={!dirty || saving}
                variant="outline"
                className="w-full"
                size="sm"
              >
                {saving ? 'Sparar...' : 'Spara'}
              </Button>
            </div>

            {/* Push status */}
            {ps?.lastPushAt && (
              <div className="mt-3 p-3 bg-secondary/50 rounded-lg text-xs">
                <div className="text-muted-foreground uppercase tracking-wider text-[10px] mb-1.5">
                  Senaste push
                </div>
                <div className="flex justify-between items-center">
                  <span className={ps.ok ? 'text-primary' : 'text-destructive'}>
                    {ps.ok ? 'Lyckades' : 'Misslyckades'}
                  </span>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                      ps.ok
                        ? 'bg-primary/15 text-primary'
                        : 'bg-destructive/15 text-destructive'
                    }`}
                  >
                    {ps.statusCode || (ps.ok ? 'OK' : 'FEL')}
                  </span>
                </div>
                <div className="text-muted-foreground mt-1">
                  {new Date(ps.lastPushAt).toLocaleTimeString('sv-SE')}
                </div>
                {!ps.ok && ps.error && (
                  <div className="text-destructive mt-1.5 font-mono break-all">
                    {ps.error}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Debug */}
          <div className="pt-4 border-t border-border">
            <div className="flex items-center gap-2 mb-3">
              <Bug className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Debug-loggning</h3>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">Logga rådata</Label>
                <p className="text-xs text-muted-foreground">
                  Skriver ut rå XML/DIDL-data i journalctl
                </p>
              </div>
              <Switch checked={debugEnabled} onCheckedChange={toggleDebug} />
            </div>
            {debugEnabled && (
              <div className="mt-2 p-2 bg-secondary/50 rounded font-mono text-[11px] text-muted-foreground">
                journalctl --user -u sonos-buddy-engine -f
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
