import { useState, useEffect, useRef, useCallback } from 'react';
import { API_BASE } from '@/config';

export interface SonosEvent {
  ok?: boolean;
  source?: string;
  playbackState?: string;
  positionMillis?: number | null;
  durationMillis?: number | null;
  trackName?: string | null;
  artistName?: string | null;
  albumName?: string | null;
  albumArtUri?: string | null;
  nextTrackName?: string | null;
  nextArtistName?: string | null;
  nextAlbumArtUri?: string | null;
  volume?: number | null;
  mute?: boolean | null;
  bass?: number | null;
  treble?: number | null;
  loudness?: boolean | null;
  crossfade?: boolean | null;
  mediaType?: string | null;
  trackNumber?: number | null;
  nrTracks?: number | null;
  groupName?: string | null;
  palette?: number[][] | null;
  nextPalette?: number[][] | null;
  timestamp?: number;
}

export function useSonosSSE() {
  const [data, setData] = useState<SonosEvent | null>(null);
  const [connected, setConnected] = useState(false);
  const lastFullRef = useRef<SonosEvent | null>(null);

  const connect = useCallback(() => {
    const es = new EventSource(`${API_BASE}/api/events`);

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      try {
        const parsed: SonosEvent = JSON.parse(e.data);
        if (!parsed || (!parsed.trackName && !parsed.playbackState)) return;

        if (parsed.source === 'position-tick') {
          if (lastFullRef.current) {
            const merged = {
              ...lastFullRef.current,
              ...parsed,
              albumArtUri: lastFullRef.current.albumArtUri,
              nextTrackName: lastFullRef.current.nextTrackName,
              nextArtistName: lastFullRef.current.nextArtistName,
              nextAlbumArtUri: lastFullRef.current.nextAlbumArtUri,
            };
            setData(merged);
          }
        } else {
          lastFullRef.current = parsed;
          setData(parsed);
        }
      } catch {}
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      setTimeout(connect, 3000);
    };

    return es;
  }, []);

  useEffect(() => {
    const es = connect();
    return () => es.close();
  }, [connect]);

  return { data, connected };
}
