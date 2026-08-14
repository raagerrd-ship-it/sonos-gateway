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
  currentPalette?: number[][] | null;
  nextPalette?: number[][] | null;
  timestamp?: number;
}

export function useSonosSSE() {
  const [data, setData] = useState<SonosEvent | null>(null);
  const [connected, setConnected] = useState(false);
  const lastFullRef = useRef<SonosEvent | null>(null);

  const retryDelayRef = useRef(1000);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const closedRef = useRef(false);

  const connect = useCallback(() => {
    if (closedRef.current) return;
    esRef.current?.close();
    const es = new EventSource(`${API_BASE}/api/events`);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      retryDelayRef.current = 1000; // reset backoff on success
    };

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
      if (closedRef.current) return;
      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * 2, 15000); // backoff up to 15s
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(connect, delay);
    };
  }, []);

  useEffect(() => {
    closedRef.current = false;
    connect();

    // Reconnect immediately when the tab/network comes back
    const kick = () => {
      if (document.visibilityState === 'hidden') return;
      if (esRef.current && esRef.current.readyState === EventSource.OPEN) return;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryDelayRef.current = 1000;
      connect();
    };
    window.addEventListener('online', kick);
    window.addEventListener('focus', kick);
    document.addEventListener('visibilitychange', kick);

    return () => {
      closedRef.current = true;
      window.removeEventListener('online', kick);
      window.removeEventListener('focus', kick);
      document.removeEventListener('visibilitychange', kick);
      esRef.current?.close();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [connect]);

  return { data, connected };
}

