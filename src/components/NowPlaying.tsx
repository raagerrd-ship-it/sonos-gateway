import { Music } from 'lucide-react';
import { useMemo } from 'react';
import type { SonosEvent } from '@/hooks/useSonosSSE';

interface Props {
  data: SonosEvent | null;
}

type RGB = [number, number, number];

function luminance([r, g, b]: RGB) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function saturation([r, g, b]: RGB) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function contrastColor(rgb: RGB): string {
  return luminance(rgb) > 0.55 ? 'rgb(20,20,22)' : 'rgb(245,245,247)';
}

function pickTheme(palette: number[][] | null | undefined) {
  if (!palette || palette.length === 0) return null;
  const rgbs: RGB[] = palette.map((p) => [p[0], p[1], p[2]] as RGB);

  // Background: prefer a darker, reasonably saturated color
  const sortedForBg = [...rgbs].sort((a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    // prefer mid-dark (0.15-0.4); penalize very dark/bright
    const score = (c: RGB, l: number) =>
      -Math.abs(l - 0.25) + saturation(c) * 0.3;
    return score(b, lb) - score(a, la);
  });
  const bg = sortedForBg[0];

  // Accent: most saturated color that contrasts with bg
  const sortedForAccent = [...rgbs].sort((a, b) => {
    const sa = saturation(a) + Math.abs(luminance(a) - luminance(bg));
    const sb = saturation(b) + Math.abs(luminance(b) - luminance(bg));
    return sb - sa;
  });
  const accent = sortedForAccent.find((c) => c !== bg) || sortedForAccent[0];

  const fg = contrastColor(bg);
  const mutedFg = luminance(bg) > 0.55 ? 'rgba(20,20,22,0.65)' : 'rgba(245,245,247,0.7)';
  const border = luminance(bg) > 0.55 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)';

  return {
    bg: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`,
    bg2: `rgb(${Math.max(0, bg[0] - 15)}, ${Math.max(0, bg[1] - 15)}, ${Math.max(0, bg[2] - 15)})`,
    accent: `rgb(${accent[0]}, ${accent[1]}, ${accent[2]})`,
    fg,
    mutedFg,
    border,
  };
}

function PlaybackBadge({
  state,
  theme,
}: {
  state?: string;
  theme: ReturnType<typeof pickTheme>;
}) {
  if (!state) return null;
  const isPlaying = state === 'PLAYBACK_STATE_PLAYING';
  const isPaused = state === 'PLAYBACK_STATE_PAUSED';
  const label = isPlaying ? 'Spelar' : isPaused ? 'Pausad' : 'Stoppad';

  if (theme) {
    return (
      <span
        className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide mt-1"
        style={{
          backgroundColor: isPlaying ? theme.accent : `${theme.fg === 'rgb(245,245,247)' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)'}`,
          color: isPlaying ? contrastColor(theme.accent.match(/\d+/g)!.map(Number) as RGB) : theme.fg,
        }}
      >
        {label}
      </span>
    );
  }

  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide mt-1 ${
        isPlaying
          ? 'bg-primary/15 text-primary'
          : isPaused
          ? 'bg-yellow-500/15 text-yellow-400'
          : 'bg-muted text-muted-foreground'
      }`}
    >
      {label}
    </span>
  );
}

function ArtPlaceholder({ size = 64 }: { size?: number }) {
  return (
    <div
      className="rounded-lg bg-secondary flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size }}
    >
      <Music className="w-6 h-6 text-muted-foreground" />
    </div>
  );
}

export function NowPlaying({ data }: Props) {
  const hasTrack = data?.trackName;
  const isPlaying = data?.playbackState === 'PLAYBACK_STATE_PLAYING';
  const isPaused = data?.playbackState === 'PLAYBACK_STATE_PAUSED';

  const theme = null as ReturnType<typeof pickTheme>;

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="text-[11px] uppercase tracking-wider font-medium mb-3 text-muted-foreground">
        Nu spelas
      </div>

      <div className="flex gap-3 items-center">
        {data?.albumArtUri ? (
          <img
            src={data.albumArtUri}
            alt="Album art"
            className="w-16 h-16 rounded-lg object-cover flex-shrink-0 bg-secondary"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
              (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
            }}
          />
        ) : null}
        {!data?.albumArtUri && <ArtPlaceholder />}

        <div className="flex-1 min-w-0">
          <div
            className="font-semibold text-[15px] truncate"
            style={theme ? { color: theme.fg } : undefined}
          >
            <span className={theme ? '' : 'text-foreground'}>
              {hasTrack ? data.trackName : 'Ingen uppspelning'}
            </span>
          </div>
          <div
            className="text-sm truncate"
            style={theme ? { color: theme.mutedFg } : undefined}
          >
            <span className={theme ? '' : 'text-muted-foreground'}>
              {data?.artistName || '—'}
              {data?.albumName ? ` · ${data.albumName}` : ''}
            </span>
          </div>
          {(isPlaying || isPaused || hasTrack) && (
            <PlaybackBadge state={data?.playbackState} theme={theme} />
          )}
        </div>
      </div>

      {/* Palette — råa färger från engine, ingen blandning */}
      {data?.palette && data.palette.length > 0 && (
        <div className="mt-3 flex gap-1.5">
          {data.palette.slice(0, 4).map((rgb, i) => (
            <div
              key={i}
              className="flex-1 h-6 rounded-md"
              style={{ backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }}
              title={`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`}
            />
          ))}
        </div>
      )}

      {/* Next track */}
      {data?.nextTrackName && (
        <div
          className="mt-3 pt-3 border-t"
          style={theme ? { borderColor: theme.border } : undefined}
        >
          <div
            className={`text-[10px] uppercase tracking-wider mb-2 ${theme ? '' : 'text-muted-foreground'}`}
            style={theme ? { color: theme.mutedFg } : undefined}
          >
            Nästa
          </div>
          <div className="flex gap-2.5 items-center">
            {data.nextAlbumArtUri ? (
              <img
                src={data.nextAlbumArtUri}
                alt="Next album art"
                className="w-10 h-10 rounded-md object-cover flex-shrink-0 bg-secondary"
              />
            ) : (
              <ArtPlaceholder size={40} />
            )}
            <div className="min-w-0">
              <div
                className={`text-[13px] font-semibold truncate ${theme ? '' : 'text-foreground/80'}`}
                style={theme ? { color: theme.fg } : undefined}
              >
                {data.nextTrackName}
              </div>
              <div
                className={`text-xs truncate ${theme ? '' : 'text-muted-foreground'}`}
                style={theme ? { color: theme.mutedFg } : undefined}
              >
                {data.nextArtistName || '—'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
