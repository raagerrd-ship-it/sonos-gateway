import { Music } from 'lucide-react';
import type { SonosEvent } from '@/hooks/useSonosSSE';

interface Props {
  data: SonosEvent | null;
}

function PlaybackBadge({ state }: { state?: string }) {
  if (!state) return null;
  const isPlaying = state === 'PLAYBACK_STATE_PLAYING';
  const isPaused = state === 'PLAYBACK_STATE_PAUSED';
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
      {isPlaying ? 'Spelar' : isPaused ? 'Pausad' : 'Stoppad'}
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
      <div className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium mb-3">
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
          <div className="font-semibold text-[15px] text-foreground truncate">
            {hasTrack ? data.trackName : 'Ingen uppspelning'}
          </div>
          <div className="text-sm text-muted-foreground truncate">
            {data?.artistName || '—'}
            {data?.albumName ? ` · ${data.albumName}` : ''}
          </div>
          {(isPlaying || isPaused || hasTrack) && (
            <PlaybackBadge state={data?.playbackState} />
          )}
        </div>
      </div>

      {/* Palette */}
      {data?.palette && data.palette.length > 0 && (
        <div className="mt-3 flex gap-1.5">
          {data.palette.slice(0, 6).map((rgb, i) => (
            <div
              key={i}
              className="flex-1 h-6 rounded-md border border-border/50"
              style={{ backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }}
              title={`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`}
            />
          ))}
        </div>
      )}

      {/* Next track */}
      {data?.nextTrackName && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
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
              <div className="text-[13px] font-semibold text-foreground/80 truncate">
                {data.nextTrackName}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {data.nextArtistName || '—'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
