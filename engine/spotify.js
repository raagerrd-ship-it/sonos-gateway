// Spotify audio-features integration.
// - Client Credentials flow (server-to-server, no user scope)
// - Token cached ~55 min in memory
// - Per-track audio-features cache persisted to PCC_DATA_DIR
// - All failures are tyst no-op; state visible via getSpotifyStatus()

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_DIR = process.env.PCC_CONFIG_DIR || path.join(__dirname);
const DATA_DIR = process.env.PCC_DATA_DIR || path.join(__dirname);

const CREDS_FILE = path.join(CONFIG_DIR, 'spotify.json');
const CACHE_FILE = path.join(DATA_DIR, 'spotify-cache.json');

const TOKEN_TTL_MS = 55 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

let log = { info: () => {}, warn: () => {}, error: () => {} };

let clientId = null;
let clientSecret = null;
let token = null;
let tokenExpiresAt = 0;
let tokenValid = false;
let lastError = null;

let cache = {}; // key `${artist}::${track}` → { features | 'not_found', ts }
let current = null; // { artist, track, features, updatedAt }
let inFlightKey = null;

function setLogger(l) { if (l) log = l; }

function loadCreds() {
  try {
    if (fs.existsSync(CREDS_FILE)) {
      const j = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
      if (j.clientId && j.clientSecret) {
        clientId = j.clientId;
        clientSecret = j.clientSecret;
      }
    }
  } catch (e) { log.warn(`[SPOTIFY] Could not read ${CREDS_FILE}: ${e.message}`); }
}

function saveCreds() {
  try {
    fs.writeFileSync(CREDS_FILE, JSON.stringify({ clientId, clientSecret }, null, 2));
    try { fs.chmodSync(CREDS_FILE, 0o600); } catch {}
  } catch (e) { log.error(`[SPOTIFY] Could not write ${CREDS_FILE}: ${e.message}`); throw e; }
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (j && typeof j === 'object') cache = j;
    }
  } catch {}
}

let cacheSaveTimer = null;
function scheduleCacheSave() {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    try {
      const keys = Object.keys(cache);
      if (keys.length > MAX_CACHE_ENTRIES) {
        const sorted = keys.map(k => [k, cache[k].ts || 0]).sort((a, b) => b[1] - a[1]);
        const kept = {};
        for (const [k] of sorted.slice(0, MAX_CACHE_ENTRIES)) kept[k] = cache[k];
        cache = kept;
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch (e) { log.warn(`[SPOTIFY] cache save failed: ${e.message}`); }
  }, 2000);
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode || 0, body: text });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function fetchToken() {
  if (!clientId || !clientSecret) {
    tokenValid = false;
    lastError = 'no_credentials';
    return null;
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = 'grant_type=client_credentials';
  const { status, body: text } = await httpsRequest({
    method: 'POST',
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (status !== 200) {
    tokenValid = false;
    lastError = status === 400 || status === 401 ? 'invalid_credentials' : `token_http_${status}`;
    log.warn(`[SPOTIFY] token fetch failed ${status}`);
    return null;
  }
  try {
    const j = JSON.parse(text);
    token = j.access_token;
    tokenExpiresAt = Date.now() + Math.min(TOKEN_TTL_MS, (j.expires_in || 3600) * 1000 - 60000);
    tokenValid = true;
    lastError = null;
    return token;
  } catch (e) {
    tokenValid = false;
    lastError = 'token_parse_error';
    return null;
  }
}

async function ensureToken() {
  if (token && Date.now() < tokenExpiresAt) return token;
  return fetchToken();
}

async function apiGet(pathAndQuery) {
  const t = await ensureToken();
  if (!t) return null;
  const { status, body: text } = await httpsRequest({
    method: 'GET',
    hostname: 'api.spotify.com',
    path: pathAndQuery,
    headers: { 'Authorization': `Bearer ${t}` },
  });
  if (status === 401) {
    // token maybe rotated — force refresh once
    token = null;
    const t2 = await ensureToken();
    if (!t2) return null;
    const retry = await httpsRequest({
      method: 'GET', hostname: 'api.spotify.com', path: pathAndQuery,
      headers: { 'Authorization': `Bearer ${t2}` },
    });
    return handleResponse(retry.status, retry.body);
  }
  return handleResponse(status, text);
}

function handleResponse(status, text) {
  if (status === 429) { lastError = 'quota_exceeded'; return null; }
  if (status === 404) { return { __notfound: true }; }
  if (status < 200 || status >= 300) { lastError = `http_${status}`; return null; }
  try { return JSON.parse(text); } catch { lastError = 'parse_error'; return null; }
}

function normalize(s) { return (s || '').toString().trim().toLowerCase(); }
function cacheKey(artist, track) { return `${normalize(artist)}::${normalize(track)}`; }

async function searchTrackId(artist, track) {
  const q = encodeURIComponent(`track:${track} artist:${artist}`);
  const j = await apiGet(`/v1/search?q=${q}&type=track&limit=1`);
  if (!j || j.__notfound) return null;
  const item = j.tracks && j.tracks.items && j.tracks.items[0];
  return item ? item.id : null;
}

async function fetchFeatures(trackId) {
  const j = await apiGet(`/v1/audio-features/${trackId}`);
  if (!j || j.__notfound) return null;
  return {
    tempo: j.tempo,
    energy: j.energy,
    danceability: j.danceability,
    acousticness: j.acousticness,
    valence: j.valence,
    instrumentalness: j.instrumentalness,
    loudness: j.loudness,
  };
}

async function onTrackChange(artist, track) {
  if (!clientId || !clientSecret) return;
  if (!artist || !track) return;
  const key = cacheKey(artist, track);
  if (inFlightKey === key) return;

  const cached = cache[key];
  if (cached && cached.features === 'not_found') {
    current = { artist, track, features: null, updatedAt: Math.floor(Date.now() / 1000) };
    return;
  }
  if (cached && cached.features) {
    current = { artist, track, features: cached.features, updatedAt: Math.floor(Date.now() / 1000) };
    return;
  }

  inFlightKey = key;
  try {
    const id = await searchTrackId(artist, track);
    if (!id) {
      cache[key] = { features: 'not_found', ts: Date.now() };
      scheduleCacheSave();
      current = { artist, track, features: null, updatedAt: Math.floor(Date.now() / 1000) };
      return;
    }
    const features = await fetchFeatures(id);
    if (!features) {
      current = { artist, track, features: null, updatedAt: Math.floor(Date.now() / 1000) };
      return;
    }
    cache[key] = { features, ts: Date.now() };
    scheduleCacheSave();
    current = { artist, track, features, updatedAt: Math.floor(Date.now() / 1000) };
    log.info(`[SPOTIFY] features: ${artist} — ${track} | tempo=${features.tempo?.toFixed?.(0)} energy=${features.energy?.toFixed?.(2)}`);
  } catch (e) {
    lastError = e.message || 'unknown';
    log.warn(`[SPOTIFY] onTrackChange failed: ${lastError}`);
  } finally {
    if (inFlightKey === key) inFlightKey = null;
  }
}

async function setSpotifyCredentials(id, secret) {
  const prevId = clientId, prevSecret = clientSecret;
  clientId = (id || '').trim();
  clientSecret = (secret || '').trim();
  token = null; tokenExpiresAt = 0;
  const t = await fetchToken();
  if (!t) {
    // rollback
    clientId = prevId; clientSecret = prevSecret;
    return { ok: false, error: lastError || 'validation_failed' };
  }
  try { saveCreds(); } catch (e) { return { ok: false, error: `save_failed: ${e.message}` }; }
  return { ok: true };
}

function clearSpotifyCredentials() {
  clientId = null; clientSecret = null; token = null; tokenExpiresAt = 0; tokenValid = false;
  cache = {}; current = null; lastError = null;
  try { if (fs.existsSync(CREDS_FILE)) fs.unlinkSync(CREDS_FILE); } catch {}
  try { if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE); } catch {}
}

function getSpotifyStatus() {
  return {
    configured: !!(clientId && clientSecret),
    tokenValid,
    cacheSize: Object.keys(cache).length,
    lastError,
  };
}

function getCurrentFeatures() {
  return current;
}

function init(logger) {
  setLogger(logger);
  loadCreds();
  loadCache();
  if (clientId && clientSecret) {
    fetchToken().catch(() => {});
  }
}

module.exports = {
  init,
  setSpotifyCredentials,
  clearSpotifyCredentials,
  getSpotifyStatus,
  getCurrentFeatures,
  onTrackChange,
};
