/**
 * Dynamic engine URL configuration for Pi Control Center architecture.
 * 
 * The UI runs on the user-chosen port (e.g. 3002).
 * The engine runs on that port + 50 (e.g. 3052).
 * 
 * In development (Vite dev server on 8080), we fall back to localhost:3052.
 */

const UI_PORT = parseInt(window.location.port) || 3002;
const ENGINE_PORT = UI_PORT + 50;

const isDev = import.meta.env.DEV;

export const API_BASE = isDev
  ? `http://localhost:3052`
  : `http://${window.location.hostname}:${ENGINE_PORT}`;
