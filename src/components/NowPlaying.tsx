import { Music } from 'lucide-react';
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
          <div className="font-semibold text-[15px] truncate text-foreground">
            {hasTrack ? data.trackName : 'Ingen uppspelning'}
          </div>
          <div className="text-sm truncate text-muted-foreground">
            {data?.artistName || '—'}
            {data?.albumName ? ` · ${data.albumName}` : ''}
          </div>
          {(isPlaying || isPaused || hasTrack) && (
            <PlaybackBadge state={data?.playbackState} />
          )}
        </div>
      </div>

      {/* Palette — råa färger direkt från engine, ingen blandning eller border */}
      {data?.currentPalette && data.currentPalette.length > 0 && (
        <div className="mt-3 flex gap-1.5">
          {data.currentPalette.slice(0, 4).map((rgb, i) => (
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
        <div className="mt-3 pt-3 border-t border-border">
          <div className="text-[10px] uppercase tracking-wider mb-2 text-muted-foreground">
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
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold truncate text-foreground/80">
                {data.nextTrackName}
              </div>
              <div className="text-xs truncate text-muted-foreground">
                {data.nextArtistName || '—'}
              </div>
            </div>
          </div>

          {/* Palette för nästa låt — pre-cachad av engine */}
          {data?.nextPalette && data.nextPalette.length > 0 && (
            <div className="mt-2.5 flex gap-1.5">
              {data.nextPalette.slice(0, 4).map((rgb, i) => (
                <div
                  key={i}
                  className="flex-1 h-4 rounded"
                  style={{ backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }}
                  title={`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
