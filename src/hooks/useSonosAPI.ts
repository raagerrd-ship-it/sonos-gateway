import { API_BASE } from '@/config';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export interface SonosDevice {
  name: string;
  ip: string;
  uuid?: string;
  model?: string;
}

export interface SonosConfig {
  ok: boolean;
  sonosIp: string;
  sonosName?: string | null;
  sonosUuid?: string | null;
  currentIp: string;
  knownDevices: SonosDevice[];
}

export interface CloudConfig {
  ok: boolean;
  enabled: boolean;
  url: string;
  secret: string;
  intervalMs: number;
  hasSecret: boolean;
  pushStatus: {
    lastPushAt: string | null;
    statusCode: number | null;
    ok: boolean | null;
    error: string | null;
  };
}

export interface HealthResponse {
  status: string;
  uptime: number;
  sonosIp: string;
  subscribed: boolean;
  sseClients: number;
  memoryMB: number;
}

export interface VersionResponse {
  name: string;
  version: string;
  commit: string;
  commitShort: string;
  branch: string;
}

export const sonosAPI = {
  getConfig: () => apiFetch<SonosConfig>('/api/config'),
  setConfig: (data: { sonosIp: string; sonosName?: string; sonosUuid?: string }) =>
    apiFetch<{ ok: boolean }>('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  discover: () => apiFetch<{ ok: boolean; devices: SonosDevice[]; currentUuid?: string; currentIp?: string }>('/api/discover'),
  getCloudConfig: () => apiFetch<CloudConfig>('/api/cloud-config'),
  setCloudConfig: (data: { enabled?: boolean; url?: string; secret?: string; intervalMs?: number }) =>
    apiFetch<{ ok: boolean }>('/api/cloud-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  getDebug: () => apiFetch<{ ok: boolean; enabled: boolean }>('/api/debug'),
  setDebug: (enabled: boolean) =>
    apiFetch<{ ok: boolean }>('/api/debug', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  getVersion: () => apiFetch<VersionResponse>('/api/version'),
  getHealth: () => apiFetch<HealthResponse>('/api/health'),
};
