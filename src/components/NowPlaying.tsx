import { Music } from 'lucide-react';
import { Panel } from '@/components/piUi';
import type { SonosEvent } from '@/hooks/useSonosSSE';

interface Props {
  data: SonosEvent | null;
}

function PlaybackBadge({ state }: { state?: string }) {
  if (!state) return null;
  const isPlaying = state === 'PLAYBACK_STATE_PLAYING';
  const isPaused = state === 'PLAYBACK_STATE_PAUSED';
  const label = isPlaying ? 'Spelar' : isPaused ? 'Pausad' : 'Stoppad';

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold tracking-wide mt-2 ring-1 ring-inset ${
        isPlaying
          ? 'bg-primary/10 text-primary ring-primary/30'
          : isPaused
          ? 'bg-warn/10 text-warn ring-warn/30'
          : 'bg-foreground/[0.05] text-muted-foreground ring-border'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          isPlaying ? 'bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.8)]' : isPaused ? 'bg-warn' : 'bg-muted-foreground'
        }`}
      />
      {label}
    </span>
  );
}

function ArtPlaceholder({ size = 64 }: { size?: number }) {
  return (
    <div
      className="rounded-xl bg-foreground/[0.05] ring-1 ring-inset ring-border flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size }}
    >
      <Music className="w-5 h-5 text-muted-foreground" />
    </div>
  );
}

export function NowPlaying({ data }: Props) {
  const hasTrack = data?.trackName;
  const isPlaying = data?.playbackState === 'PLAYBACK_STATE_PLAYING';
  const isPaused = data?.playbackState === 'PLAYBACK_STATE_PAUSED';

  return (
    <Panel title="Nu spelas" icon={<Music className="w-3 h-3" />}>
      <div className="flex gap-3.5 items-center">
        {data?.albumArtUri ? (
          <img
            src={data.albumArtUri}
            alt="Omslagsbild för spelande låt"
            className="w-16 h-16 rounded-xl object-cover flex-shrink-0 ring-1 ring-inset ring-border"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <ArtPlaceholder />
        )}

        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[15px] truncate text-foreground">
            {hasTrack ? data.trackName : 'Ingen uppspelning'}
          </div>
          <div className="text-[13px] truncate text-muted-foreground">
            {data?.artistName || '—'}
            {data?.albumName ? ` · ${data.albumName}` : ''}
          </div>
          {(isPlaying || isPaused || hasTrack) && (
            <PlaybackBadge state={data?.playbackState} />
          )}
        </div>
      </div>

      {/* Palette — råa färger direkt från engine */}
      {data?.currentPalette && data.currentPalette.length > 0 && (
        <div className="mt-4 flex gap-1.5">
          {data.currentPalette.slice(0, 4).map((rgb, i) => (
            <div
              key={i}
              className="flex-1 h-6 rounded-lg ring-1 ring-inset ring-border/60"
              style={{ backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }}
              title={`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`}
            />
          ))}
        </div>
      )}

      {/* Next track */}
      {data?.nextTrackName && (
        <div className="mt-4 pt-4 border-t border-border">
          <div className="label-eyebrow mb-3">Nästa</div>
          <div className="flex gap-2.5 items-center">
            {data.nextAlbumArtUri ? (
              <img
                src={data.nextAlbumArtUri}
                alt="Omslagsbild för nästa låt"
                className="w-10 h-10 rounded-lg object-cover flex-shrink-0 ring-1 ring-inset ring-border"
              />
            ) : (
              <ArtPlaceholder size={40} />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold truncate text-foreground/90">
                {data.nextTrackName}
              </div>
              <div className="text-xs truncate text-muted-foreground">
                {data.nextArtistName || '—'}
              </div>
            </div>
          </div>

          {data?.nextPalette && data.nextPalette.length > 0 && (
            <div className="mt-3 flex gap-1.5">
              {data.nextPalette.slice(0, 4).map((rgb, i) => (
                <div
                  key={i}
                  className="flex-1 h-4 rounded-md ring-1 ring-inset ring-border/60"
                  style={{ backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }}
                  title={`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
