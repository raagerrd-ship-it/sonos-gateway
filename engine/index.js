require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { discoverSonos, discoverRooms, fetchZoneTopology } = require('./discover');
const { extractPalette, pushHueHistory, getHueHistory, clearHueHistory } = require('./palette');

// [ALBUMART-UPLOAD] 2026-09-18 — omslaget skickas som base64 till molnet.
// Molnet (sonos-bridge-push) kan inte nå högtalarens LAN-URL (http://<sonos>:1400/getaa…),
// så TV-bakgrunden blev tom. Kontrakt från Lovable: `albumArtBase64` (nuvarande låt) och
// `nextAlbumArtBase64` (valfritt) i SAMMA anrop som låtinfon, JPEG som data-URL.
// Bilden hämtas en gång per omslags-URI, PNG kodas om till JPEG, cache 4 poster.
// Av: "cloudPushAlbumArt": false i settings.json.
const albumArtJpeg = require('jpeg-js');
const { PNG: AlbumArtPNG } = require('pngjs');
const ALBUMART_MAX_BYTES = 512 * 1024;
const ALBUMART_TIMEOUT_MS = 8000;
const ALBUMART_CACHE_MAX = 4;
const albumArtB64Cache = new Map();   // rawUri → data-URL
const albumArtInFlight = new Map();   // rawUri → Promise

// Kvittens (Lovable 2026-09-18): svaret på varje state-push bär need_album_art /
// need_next_album_art / ack_track / ack_next_track. Regel: skicka bilden bara när
// senaste svaret sa need=true, när omslaget bytt sedan kvittensen, eller när förra
// pushen gick fel (nät/timeout/inget svar). En bild per låt i stället för en per push.
const albumArtSync = {
  needArt: true, needNext: true,          // senaste svarets need_* (true tills molnet säger nej)
  ackedArtUri: null, ackedNextUri: null,  // rå URI vi skickade när molnet svarade need=false
  lastPushFailed: false,
  lastAckTrack: null, lastAckNextTrack: null,
  sentArt: { uri: null, n: 0, warned: false }, sentNext: { uri: null, n: 0, warned: false },   // leveranser molnet SVARAT need=true på, sedan senaste kvittens
};
// Skydd mot ett moln som aldrig kvitterar (sett 2026-09-18: need_next_album_art=true efter 3
// leveranser): efter så här många skickade bilder för samma omslag hålls den inne tills
// omslaget byter eller en push går fel. Molnet har redan bytesen.
const ALBUMART_MAX_SENDS = 3;
let albumArtFollowUpTimer = null;

function albumArtWanted(kind, rawUri) {
  const need = kind === 'next' ? albumArtSync.needNext : albumArtSync.needArt;
  const acked = kind === 'next' ? albumArtSync.ackedNextUri : albumArtSync.ackedArtUri;
  return need || rawUri !== acked || albumArtSync.lastPushFailed;
}

function albumArtForPush(rawUri, kind) {
  if (!rawUri || !cloudConfig.albumArt) return null;
  if (!albumArtWanted(kind, rawUri)) return null;
  const dataUrl = albumArtB64Cache.get(rawUri);
  if (!dataUrl) return null;
  const sent = kind === 'next' ? albumArtSync.sentNext : albumArtSync.sentArt;
  if (sent.uri !== rawUri) { sent.uri = rawUri; sent.n = 0; sent.warned = false; }
  // Räknas vid SVARET (albumArtOnCloudReply), inte här — en startskur med flera pushar i luften
  // samtidigt ska inte kunna slå i taket innan molnet hunnit svara.
  if (sent.n >= ALBUMART_MAX_SENDS && !albumArtSync.lastPushFailed) {
    if (!sent.warned) { sent.warned = true; log.warn(`🖼️ [ALBUMART] ${kind}: ${ALBUMART_MAX_SENDS} leveranser utan kvittens — håller inne bilden tills omslaget byter`); }
    return null;
  }
  return dataUrl;
}

// Molnet sa "behövs" på en push utan bild och vi har den → skicka nu, inte vid nästa händelse.
// Spärr: bara när pushen som besvarades SAKNADE bilden — annars kan ett moln som alltid
// svarar need=true skapa en loop. Då bär i stället nästa ordinarie push bilden igen.
function albumArtFollowUpPush(reason) {
  if (albumArtFollowUpTimer || !lastSonosEvent) return;
  albumArtFollowUpTimer = setTimeout(() => {
    albumArtFollowUpTimer = null;
    if (!lastSonosEvent) return;
    const prevSource = lastSonosEvent.source;
    lastSonosEvent.source = reason;
    cloudPushState(lastSonosEvent);
    lastSonosEvent.source = prevSource;
  }, 250);
}

function albumArtOnCloudReply(payload, meta, body) {
  if (!cloudConfig.albumArt) return;
  let r = null;
  if (body) { try { r = JSON.parse(body); } catch { r = null; } }
  if (!r || typeof r !== 'object') {
    if (!albumArtSync.lastPushFailed) log.warn('🖼️ [ALBUMART] state-push utan kvittens — bilden skickas igen nästa gång');
    albumArtSync.lastPushFailed = true;
    return;
  }
  albumArtSync.lastPushFailed = false;
  const before = `${albumArtSync.needArt}/${albumArtSync.needNext}/${albumArtSync.lastAckTrack}/${albumArtSync.lastAckNextTrack}`;
  if (typeof r.need_album_art === 'boolean') {
    albumArtSync.needArt = r.need_album_art;
    if (payload.albumArtBase64 && meta && meta.artUri && meta.artUri === albumArtSync.sentArt.uri) {
      if (r.need_album_art) albumArtSync.sentArt.n++;   // levererad men inte kvitterad
      else { albumArtSync.ackedArtUri = meta.artUri; albumArtSync.sentArt.n = 0; albumArtSync.sentArt.warned = false; }
    }
  }
  if (typeof r.need_next_album_art === 'boolean') {
    albumArtSync.needNext = r.need_next_album_art;
    if (payload.nextAlbumArtBase64 && meta && meta.nextUri && meta.nextUri === albumArtSync.sentNext.uri) {
      if (r.need_next_album_art) albumArtSync.sentNext.n++;
      else { albumArtSync.ackedNextUri = meta.nextUri; albumArtSync.sentNext.n = 0; albumArtSync.sentNext.warned = false; }
    }
  }
  if (r.ack_track !== undefined) albumArtSync.lastAckTrack = r.ack_track;
  if (r.ack_next_track !== undefined) albumArtSync.lastAckNextTrack = r.ack_next_track;
  const after = `${albumArtSync.needArt}/${albumArtSync.needNext}/${albumArtSync.lastAckTrack}/${albumArtSync.lastAckNextTrack}`;
  if (after !== before) log.info(`🖼️ [ALBUMART] kvittens: need_art=${albumArtSync.needArt} need_next=${albumArtSync.needNext} ack_track=${JSON.stringify(r.ack_track ?? null)} ack_next=${JSON.stringify(r.ack_next_track ?? null)}`);
  const wantsArt = r.need_album_art === true && !payload.albumArtBase64 && meta && meta.artUri
    && meta.artUri === cachedRawAlbumArtUri && albumArtB64Cache.has(meta.artUri);
  const wantsNext = r.need_next_album_art === true && !payload.nextAlbumArtBase64 && meta && meta.nextUri
    && meta.nextUri === cachedRawNextAlbumArtUri && albumArtB64Cache.has(meta.nextUri);
  if (wantsArt || wantsNext) albumArtFollowUpPush(wantsArt ? 'albumart-requested' : 'next-albumart-requested');
}

function albumArtDownload(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: ALBUMART_TIMEOUT_MS }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = []; let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > ALBUMART_MAX_BYTES) { req.destroy(); reject(new Error(`bilden för stor (>${ALBUMART_MAX_BYTES} B)`)); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function fetchAlbumArtBase64(rawUri) {
  if (!rawUri || !cloudConfig.enabled || !cloudConfig.albumArt) return Promise.resolve(null);
  if (albumArtB64Cache.has(rawUri)) return Promise.resolve(albumArtB64Cache.get(rawUri));
  if (albumArtInFlight.has(rawUri)) return albumArtInFlight.get(rawUri);
  const url = rawUri.startsWith('/') ? `http://${SONOS_IP}:1400${rawUri}` : rawUri;
  const p = (async () => {
    const buf = await albumArtDownload(url);
    let jpegBuf;
    if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) {
      jpegBuf = buf;
    } else if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50) {
      const png = AlbumArtPNG.sync.read(buf);
      jpegBuf = albumArtJpeg.encode({ data: png.data, width: png.width, height: png.height }, 85).data;
    } else {
      throw new Error('okänt bildformat');
    }
    const dataUrl = `data:image/jpeg;base64,${jpegBuf.toString('base64')}`;
    albumArtB64Cache.set(rawUri, dataUrl);
    while (albumArtB64Cache.size > ALBUMART_CACHE_MAX) albumArtB64Cache.delete(albumArtB64Cache.keys().next().value);
    log.info(`🖼️ [ALBUMART] hämtat ${buf.length} B → ${Math.round(dataUrl.length / 1024)} kB base64 (${rawUri.substring(0, 60)})`);
    return dataUrl;
  })();
  albumArtInFlight.set(rawUri, p);
  p.then(() => albumArtInFlight.delete(rawUri), (e) => {
    albumArtInFlight.delete(rawUri);
    log.warn(`🖼️ [ALBUMART] hämtning misslyckades: ${e.message} (${rawUri.substring(0, 60)})`);
  });
  return p;
}

// Efter en lyckad hämtning: pusha om tillståndet så bilden följer med.
// Cache-träff → ingen extra push (ordinarie state-push bär bilden redan).
function pushAlbumArtWhenReady(rawUri, isNext) {
  // Cache-träff → ordinarie push bär bilden; redan i luften → första anroparen pushar.
  if (!rawUri || albumArtB64Cache.has(rawUri) || albumArtInFlight.has(rawUri)) return;
  fetchAlbumArtBase64(rawUri).then((dataUrl) => {
    if (!dataUrl || !lastSonosEvent) return;
    const stillCurrent = isNext ? (rawUri === cachedRawNextAlbumArtUri) : (rawUri === cachedRawAlbumArtUri);
    if (!stillCurrent) return;
    const prevSource = lastSonosEvent.source;
    lastSonosEvent.source = isNext ? 'next-albumart-update' : 'albumart-update';
    cloudPushState(lastSonosEvent);
    lastSonosEvent.source = prevSource;
  }).catch(() => {});
}
const spotify = require('./spotify');

// Version — prefer version.json (CI-generated), fallback to package.json
const VERSION = (() => {
  try {
    const vf = path.join(__dirname, 'version.json');
    if (fs.existsSync(vf)) {
      const vj = JSON.parse(fs.readFileSync(vf, 'utf8'));
      if (vj.version) return vj.version;
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch { return '1.0.0'; }
})();

// Git commit hash — resolved once at startup (try version.json first, then git)
const { execSync } = require('child_process');
let GIT_COMMIT = 'unknown';
let GIT_COMMIT_SHORT = 'unknown';
let GIT_BRANCH = 'unknown';
try {
  const versionFile = path.join(__dirname, 'version.json');
  if (fs.existsSync(versionFile)) {
    const vj = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    GIT_COMMIT = vj.commit || 'unknown';
    GIT_COMMIT_SHORT = vj.commitShort || GIT_COMMIT.substring(0, 7);
    GIT_BRANCH = vj.branch || 'unknown';
  } else {
    GIT_COMMIT = execSync('git rev-parse HEAD', { cwd: __dirname, timeout: 3000 }).toString().trim();
    GIT_COMMIT_SHORT = GIT_COMMIT.substring(0, 7);
    GIT_BRANCH = execSync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname, timeout: 3000 }).toString().trim();
  }
} catch (e) {
  // Not a git repo or git not available
}

// Configuration — PCC owns storage. /opt/ is code-only and may be wiped on update.
//   PCC_CONFIG_DIR → user settings (settings.json)
//   PCC_DATA_DIR   → runtime state that must survive updates (state.json: knownDevices, palette cache, …)
//   PCC_LOG_DIR    → log files
// Standalone fallback: keep everything under engine/ so dev still works without PCC.
const CONFIG_DIR = process.env.PCC_CONFIG_DIR || __dirname;
const DATA_DIR = process.env.PCC_DATA_DIR || __dirname;
try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
// Legacy: single config.json under engine/ (pre-PCC layout) — migrate once
const LEGACY_CONFIG_FILE = path.join(__dirname, 'config.json');

const UI_PORT = parseInt(process.env.UI_PORT || process.env.PORT || '3002');
const ENGINE_PORT = parseInt(process.env.ENGINE_PORT || String(UI_PORT + 50));
const PORT = ENGINE_PORT;

// Settings keys live in PCC_CONFIG_DIR; everything else is state in PCC_DATA_DIR.
const SETTINGS_KEYS = new Set([
  'sonosIp', 'sonosName', 'sonosUuid', 'debugLogging',
  'cloudPushEnabled', 'cloudPushUrl', 'cloudPushPositionUrl', 'cloudPushSecret', 'cloudPushIntervalMs'
]);

function readJson(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return null;
}

function loadSonosConfig() {
  const settings = readJson(SETTINGS_FILE) || {};
  const state = readJson(STATE_FILE) || {};
  // One-time migration from legacy single config.json
  if (!Object.keys(settings).length && !Object.keys(state).length) {
    const legacy = readJson(LEGACY_CONFIG_FILE);
    if (legacy && typeof legacy === 'object') {
      for (const [k, v] of Object.entries(legacy)) {
        if (SETTINGS_KEYS.has(k)) settings[k] = v; else state[k] = v;
      }
      try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {}
      try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
    }
  }
  return {
    sonosIp: settings.sonosIp || process.env.SONOS_IP || '192.168.1.175',
    sonosName: settings.sonosName || null,
    sonosUuid: settings.sonosUuid || null,
    debugLogging: !!settings.debugLogging,
    cloudPushEnabled: settings.cloudPushEnabled,
    cloudPushUrl: settings.cloudPushUrl,
    cloudPushPositionUrl: settings.cloudPushPositionUrl,
    cloudPushSecret: settings.cloudPushSecret,
    cloudPushIntervalMs: settings.cloudPushIntervalMs,
    knownDevices: Array.isArray(state.knownDevices) ? state.knownDevices : []
  };
}

function saveSonosConfig(cfg, options = {}) {
  const { includeSettings = true, includeState = true } = options;
  const settings = {};
  const state = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined) continue;
    if (SETTINGS_KEYS.has(k)) settings[k] = v; else state[k] = v;
  }

  const result = {
    ok: true,
    settingsSaved: !includeSettings,
    stateSaved: !includeState,
    settingsError: null,
    stateError: null,
  };

  if (includeSettings) {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      result.settingsSaved = true;
    } catch (e) {
      result.ok = false;
      result.settingsError = e.message;
      log.error(`Settings save failed: ${e.message}`);
    }
  }

  if (includeState) {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      result.stateSaved = true;
    } catch (e) {
      result.ok = false;
      result.stateError = e.message;
      log.error(`State save failed: ${e.message}`);
    }
  }

  return result;
}

let sonosConfig = loadSonosConfig();
let SONOS_IP = sonosConfig.sonosIp;
let debugLogging = sonosConfig.debugLogging || false;

// ============ Logging ============

const LOG_BUFFER_SIZE = 30;
let logBuffer = [];

// Optional file logging when PCC provides PCC_LOG_DIR.
// stdout always receives logs (systemd/journald captures them); file is a parallel sink.
let logFileStream = null;
if (process.env.PCC_LOG_DIR) {
  try {
    fs.mkdirSync(process.env.PCC_LOG_DIR, { recursive: true });
    logFileStream = fs.createWriteStream(
      path.join(process.env.PCC_LOG_DIR, 'sonos-buddy-engine.log'),
      { flags: 'a' }
    );
    logFileStream.on('error', () => { logFileStream = null; });
  } catch { logFileStream = null; }
}

function writeFileLog(level, ts, msg, args) {
  if (!logFileStream) return;
  try {
    const extra = args && args.length ? ' ' + args.map(a => {
      try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
    }).join(' ') : '';
    logFileStream.write(`[${level.toUpperCase()}] ${ts} - ${msg}${extra}\n`);
  } catch {}
}

function addToLogBuffer(level, msg, args) {
  // Skip debug entries unless DEBUG is on — keeps buffer lean
  if (level === 'debug' && !process.env.DEBUG) return;
  logBuffer.push({
    timestamp: new Date().toISOString(),
    level,
    message: msg,
    args: args.length > 0 ? args : undefined
  });
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

const log = {
  info: (msg, ...args) => { const ts = new Date().toISOString(); console.log(`[INFO] ${ts} - ${msg}`, ...args); writeFileLog('info', ts, msg, args); addToLogBuffer('info', msg, args); },
  warn: (msg, ...args) => { const ts = new Date().toISOString(); console.warn(`[WARN] ${ts} - ${msg}`, ...args); writeFileLog('warn', ts, msg, args); addToLogBuffer('warn', msg, args); },
  error: (msg, ...args) => { const ts = new Date().toISOString(); console.error(`[ERROR] ${ts} - ${msg}`, ...args); writeFileLog('error', ts, msg, args); addToLogBuffer('error', msg, args); },
  debug: (msg, ...args) => {
    const ts = new Date().toISOString();
    if (process.env.DEBUG) { console.log(`[DEBUG] ${ts} - ${msg}`, ...args); writeFileLog('debug', ts, msg, args); }
    addToLogBuffer('debug', msg, args);
  }
};

// ============ Sonos UPnP Helpers ============

// Pre-built SOAP bodies — hoisted to module scope so we don't allocate
// new strings on every poll/event (these run once per second).
const SOAP_GET_POSITION = `<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo>`;
const SOAP_GET_TRANSPORT = `<u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo>`;
const SOAP_GET_MEDIA = `<u:GetMediaInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetMediaInfo>`;
const SOAP_GET_VOLUME = `<u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume>`;
const SOAP_GET_MUTE = `<u:GetMute xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetMute>`;
const SOAP_GET_BASS = `<u:GetBass xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID></u:GetBass>`;
const SOAP_GET_TREBLE = `<u:GetTreble xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID></u:GetTreble>`;
const SOAP_GET_LOUDNESS = `<u:GetLoudness xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetLoudness>`;
const SOAP_GET_CROSSFADE = `<u:GetCrossfadeMode xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetCrossfadeMode>`;
const SOAP_GET_ZONE_GROUP = `<u:GetZoneGroupState xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1"></u:GetZoneGroupState>`;
const RC_PATH = '/MediaRenderer/RenderingControl/Control';
const RC_SERVICE = 'RenderingControl';

function soapRequest(body, action, controlPath, serviceType) {
  controlPath = controlPath || '/MediaRenderer/AVTransport/Control';
  serviceType = serviceType || 'AVTransport';
  return new Promise((resolve, reject) => {
    const postData = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>${body}</s:Body>
</s:Envelope>`;
    
    const options = {
      hostname: SONOS_IP,
      port: 1400,
      path: controlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"urn:schemas-upnp-org:service:${serviceType}:1#${action}"`,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 2000
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    
    req.on('timeout', () => { req.destroy(); reject(new Error('SOAP request timeout')); });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function parseTime(timeStr) {
  if (!timeStr || timeStr === 'NOT_IMPLEMENTED') return null;
  const parts = timeStr.split(':');
  if (parts.length !== 3) return null;
  const [h, m, s] = parts.map(Number);
  if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
  return (h * 3600 + m * 60 + s) * 1000;
}

function extractTag(xml, tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapedTag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractDidl(xml) {
  let didlMatch = xml.match(/&lt;DIDL-Lite[\s\S]*?&lt;\/DIDL-Lite&gt;/);
  let didl;
  if (didlMatch) {
    didl = decodeXmlEntities(didlMatch[0]);
  } else {
    didlMatch = xml.match(/<DIDL-Lite[\s\S]*?<\/DIDL-Lite>/);
    if (!didlMatch) return null;
    didl = didlMatch[0];
  }
  
  let protocolInfo = null;
  const resMatch = didl.match(/<res[^>]*protocolInfo="([^"]*)"[^>]*>/);
  if (resMatch) protocolInfo = resMatch[1];
  
  return {
    title: extractTag(didl, 'dc:title'),
    creator: extractTag(didl, 'dc:creator'),
    album: extractTag(didl, 'upnp:album'),
    albumArtURI: extractTag(didl, 'upnp:albumArtURI'),
    upnpClass: extractTag(didl, 'upnp:class'),
    originalTrackNumber: extractTag(didl, 'upnp:originalTrackNumber'),
    streamContent: extractTag(didl, 'r:streamContent'),
    radioShowMd: extractTag(didl, 'r:radioShowMd'),
    protocolInfo
  };
}

async function resolveNextTrack(nextMeta, trackNumber, nrTracks) {
  let nextTrackName = null;
  let nextArtistName = null;
  let nextAlbumArtUri = null;
  let rawNextAlbumArtUri = null;

  if (debugLogging) log.info(`[RAW-NEXT] nextMeta: ${nextMeta || 'NULL'}`);
  log.info(`[NEXT-TRACK] resolveNextTrack called — nextMeta: ${nextMeta ? nextMeta.substring(0, 120) + '...' : 'NULL'}, trackNumber: ${trackNumber}, nrTracks: ${nrTracks}`);

  if (nextMeta) {
    let nextDidl = extractDidl(nextMeta);
    if (!nextDidl) nextDidl = extractDidl(decodeXmlEntities(nextMeta));
    log.info(`[NEXT-TRACK] nextDidl parsed: ${nextDidl ? JSON.stringify({ title: nextDidl.title, creator: nextDidl.creator, albumArtURI: nextDidl.albumArtURI }) : 'NULL'}`);
    if (nextDidl) {
      nextTrackName = nextDidl.title || null;
      nextArtistName = nextDidl.creator || null;
      if (nextDidl.albumArtURI) {
        const cleanUri = nextDidl.albumArtURI.replace(/&amp;/g, '&');
        rawNextAlbumArtUri = cleanUri;
        nextAlbumArtUri = cleanUri.startsWith('/')
          ? `http://${SONOS_IP}:1400${cleanUri}`
          : cleanUri;
      }
    }
  }

  if (!nextTrackName && trackNumber != null) {
    const nextIndex = parseInt(trackNumber, 10);
    const total = nrTracks != null ? parseInt(nrTracks, 10) : 0;
    if (nextIndex < total) {
      try {
        const browseBody = `<u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
          <ObjectID>Q:0</ObjectID>
          <BrowseFlag>BrowseDirectChildren</BrowseFlag>
          <Filter>dc:title,dc:creator,upnp:album,upnp:albumArtURI,upnp:class</Filter>
          <StartingIndex>${nextIndex}</StartingIndex>
          <RequestedCount>1</RequestedCount>
          <SortCriteria></SortCriteria>
        </u:Browse>`;
        const browseXml = await soapRequest(browseBody, 'Browse', '/MediaServer/ContentDirectory/Control', 'ContentDirectory');
        const resultRaw = extractTag(browseXml, 'Result');
        if (resultRaw) {
          let browseDidl = extractDidl(resultRaw);
          if (!browseDidl) browseDidl = extractDidl(decodeXmlEntities(resultRaw));
          if (browseDidl) {
            nextTrackName = browseDidl.title || null;
            nextArtistName = browseDidl.creator || null;
            if (browseDidl.albumArtURI) {
              const cleanUri = browseDidl.albumArtURI.replace(/&amp;/g, '&');
              rawNextAlbumArtUri = cleanUri;
              nextAlbumArtUri = cleanUri.startsWith('/')
                ? `http://${SONOS_IP}:1400${cleanUri}`
                : cleanUri;
            }
          }
        }
      } catch (err) {
        log.debug(`[SONOS] ContentDirectory browse fallback failed: ${err.message}`);
      }
    }
  }

  return { nextTrackName, nextArtistName, nextAlbumArtUri, rawNextAlbumArtUri };
}

// ============ Sonos UPnP Event Subscription (SSE) ============

let sonosEventClients = [];
let sonosSubscriptionSID = null;
let lastSonosEvent = null;
let sonosIdleDebounceTimer = null;
let pendingSonosIdleEvent = null;
let pendingSonosIdleMeta = null;
let sonosTransitionRefreshTimer = null;
let cachedGroupId = null;
let cachedGroupName = null;
let cachedRawAlbumArtUri = null;
let cachedRawNextAlbumArtUri = null;
let cachedCurrentPalette = [];
let cachedNextPalette = [];
let lastSpotifyKey = null;
let paletteExtractionInProgress = false;
let sonosSubscribeRetries = 0;
let sonosUpnpHandlerBusy = false;
let sonosUpnpHandlerPending = false;
const SONOS_IDLE_DEBOUNCE_MS = 2000;
const SONOS_TRANSITION_REFRESH_MS = 700;
const SONOS_TRANSITION_MAX_REFRESHES = 3;

function getSonosTrackKey(eventData) {
  return [
    eventData?.trackURI || '',
    eventData?.trackNumber ?? '',
    eventData?.trackName || '',
    eventData?.artistName || ''
  ].join('|');
}

function isSonosTransitionState(transportState) {
  return transportState === 'TRANSITIONING';
}

function isSonosIdleCandidateTransportState(transportState) {
  return !transportState || transportState === 'STOPPED' || transportState === 'NO_MEDIA_PRESENT';
}

function getSonosPlaybackState(transportState) {
  if (transportState === 'PLAYING') return 'PLAYBACK_STATE_PLAYING';
  if (transportState === 'PAUSED_PLAYBACK') return 'PLAYBACK_STATE_PAUSED';
  if (transportState === 'TRANSITIONING') {
    if (lastSonosEvent?.playbackState && lastSonosEvent.playbackState !== 'PLAYBACK_STATE_IDLE') {
      return lastSonosEvent.playbackState;
    }
    return 'PLAYBACK_STATE_PLAYING';
  }
  if (transportState === 'STOPPED') {
    return 'PLAYBACK_STATE_IDLE';
  }
  return 'PLAYBACK_STATE_IDLE';
}

function classifySonosIdleReason(transportState, eventData) {
  if (transportState === 'TRANSITIONING') return 'transition';
  const previousTrackKey = getSonosTrackKey(lastSonosEvent);
  const currentTrackKey = getSonosTrackKey(eventData);
  if (transportState === 'STOPPED' && previousTrackKey && currentTrackKey && previousTrackKey !== currentTrackKey) {
    return 'transition';
  }
  return 'stop-button';
}

function clearSonosTransitionRefresh() {
  if (sonosTransitionRefreshTimer) {
    clearTimeout(sonosTransitionRefreshTimer);
    sonosTransitionRefreshTimer = null;
  }
}

function cancelPendingSonosIdle(reason) {
  const hadPending = Boolean(sonosIdleDebounceTimer || pendingSonosIdleEvent);
  if (sonosIdleDebounceTimer) { clearTimeout(sonosIdleDebounceTimer); sonosIdleDebounceTimer = null; }
  pendingSonosIdleEvent = null;
  pendingSonosIdleMeta = null;
  if (hadPending) log.info(`✅ [SONOS] Suppressed pending IDLE (${reason})`);
}

// ============ Cloud Push to Brew Monitor TV ============

function loadCloudConfig() {
  const cfg = loadSonosConfig();
  return {
    enabled: cfg.cloudPushEnabled ?? (!!process.env.CLOUD_PUSH_URL),
    url: cfg.cloudPushUrl || process.env.CLOUD_PUSH_URL || '',
    positionUrl: cfg.cloudPushPositionUrl || process.env.CLOUD_PUSH_POSITION_URL || '',
    secret: cfg.cloudPushSecret || process.env.CLOUD_PUSH_SECRET || 'Fasanvagen',
    intervalMs: cfg.cloudPushIntervalMs || parseInt(process.env.CLOUD_PUSH_INTERVAL_MS || '3000'),
    albumArt: cfg.cloudPushAlbumArt !== false,   // [ALBUMART-UPLOAD] skicka omslaget som base64
  };
}

let cloudConfig = loadCloudConfig();
let lastCloudPush = 0;
let lastCloudPositionPush = 0;
let cloudPushPending = false;
let lastCloudPushData = null;
let cloudPushStatus = { lastPushAt: null, lastPushType: null, statusCode: null, ok: null, error: null, responseBody: null };

// ── State push (full payload) ──
// Skickas bara på state changes: track-byten, play/pause, volym/mute,
// palette-uppdateringar, audio settings. Aldrig från position-tick.
function cloudPushState(eventData) {
  if (!cloudConfig.enabled || !cloudConfig.url || !cloudConfig.secret) return;

  const payload = {
    trackName: eventData.trackName || null,
    artistName: eventData.artistName || null,
    albumName: eventData.albumName || null,
    albumArtUri: cachedRawAlbumArtUri ? (cachedRawAlbumArtUri.startsWith('/') ? `http://${SONOS_IP}:1400${cachedRawAlbumArtUri}` : cachedRawAlbumArtUri) : null,
    playbackState: eventData.playbackState || null,
    positionMillis: eventData.positionMillis ?? null,
    durationMillis: eventData.durationMillis ?? null,
    pushedAt: Date.now(),
    nextTrackName: eventData.nextTrackName || null,
    nextArtistName: eventData.nextArtistName || null,
    nextAlbumArtUri: cachedRawNextAlbumArtUri ? (cachedRawNextAlbumArtUri.startsWith('/') ? `http://${SONOS_IP}:1400${cachedRawNextAlbumArtUri}` : cachedRawNextAlbumArtUri) : null,
    volume: eventData.volume ?? null,
    mute: eventData.mute ?? null,
    bass: eventData.bass ?? null,
    treble: eventData.treble ?? null,
    loudness: eventData.loudness ?? null,
    crossfade: eventData.crossfade ?? null,
    mediaType: eventData.mediaType || null,
    trackNumber: eventData.trackNumber ?? null,
    trackURI: eventData.trackURI || null,
    nrTracks: eventData.nrTracks ?? null,
    currentURI: eventData.currentURI || null,
    nextAVTransportURI: eventData.nextAVTransportURI || null,
    playMedium: eventData.playMedium || null,
    streamContent: eventData.streamContent || null,
    radioShowMd: eventData.radioShowMd || null,
    originalTrackNumber: eventData.originalTrackNumber ?? null,
    protocolInfo: eventData.protocolInfo || null,
    groupId: eventData.groupId || null,
    groupName: eventData.groupName || null,
    currentPalette: eventData.currentPalette || cachedCurrentPalette || [],
    nextPalette: eventData.nextPalette || cachedNextPalette || [],
    // [ALBUMART-UPLOAD] molnet kan inte nå högtalarens LAN-URL — bilden följer med
    albumArtBase64: albumArtForPush(cachedRawAlbumArtUri, 'art'),
    nextAlbumArtBase64: albumArtForPush(cachedRawNextAlbumArtUri, 'next'),
    source: eventData.source || null,
  };

  // State pushes har ingen rate-limit — de sker sällan ändå.
  doCloudPush(cloudConfig.url, payload, 'state', { artUri: cachedRawAlbumArtUri, nextUri: cachedRawNextAlbumArtUri });   // [ALBUMART-UPLOAD]
}

// ── Position push (minimal payload) ──
// Skickas på position-ticks (typiskt var sekund). Bara position-data,
// inget annat. Rate-limited av cloudConfig.intervalMs.
function cloudPushPosition(positionData) {
  if (!cloudConfig.enabled || !cloudConfig.positionUrl || !cloudConfig.secret) return;

  const payload = {
    positionMillis: positionData.positionMillis ?? null,
    durationMillis: positionData.durationMillis ?? null,
    playbackState: positionData.playbackState || null,
    pushedAt: Date.now(),
  };

  const now = Date.now();
  if (now - lastCloudPositionPush < cloudConfig.intervalMs) {
    // Rate-limited: kasta — nästa tick (~sekund senare) skickar färskare data ändå.
    return;
  }
  lastCloudPositionPush = now;
  doCloudPush(cloudConfig.positionUrl, payload, 'position');
}

// ── Generisk push-funktion ──
// Keep-alive mot molnet: positionspushen går var 3:e sekund, och utan agent blev
// varje push en ny TLS-handskakning (mätt 2026-09-20: största kvarvarande CPU-posten).
const cloudAgentHttps = new https.Agent({ keepAlive: true, maxSockets: 2, keepAliveMsecs: 15000 });
const cloudAgentHttp = new http.Agent({ keepAlive: true, maxSockets: 2, keepAliveMsecs: 15000 });

function doCloudPush(url, payload, label, meta = null) {
  const body = JSON.stringify(payload);
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const deviceId = (sonosConfig && sonosConfig.sonosUuid) || 'default';
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bridge-secret': cloudConfig.secret,
      'x-device-id': deviceId,
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 10000,
    agent: isHttps ? cloudAgentHttps : cloudAgentHttp,
  };
  const lib = isHttps ? https : http;
  const req = lib.request(options, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      const isOk = res.statusCode >= 200 && res.statusCode < 300;
      cloudPushStatus = {
        lastPushAt: new Date().toISOString(),
        lastPushType: label,
        statusCode: res.statusCode,
        ok: isOk,
        error: isOk ? null : data.substring(0, 80),
        responseBody: data.substring(0, 80),
      };
      if (label === 'state') albumArtOnCloudReply(payload, meta, isOk ? data : null);   // [ALBUMART-UPLOAD]
      if (isOk) {
        log.debug(`☁️ [CLOUD-${label}] Push OK (${res.statusCode})`);
        if (payload.albumArtBase64 || payload.nextAlbumArtBase64) log.info(`🖼️ [ALBUMART] push ${label}/${payload.source} OK (${res.statusCode}) ${data.substring(0, 120)}`);   // [ALBUMART-UPLOAD]
      } else {
        log.warn(`☁️ [CLOUD-${label}] Push failed (${res.statusCode}): ${data.substring(0, 200)}`);
      }
    });
  });
  req.on('error', (err) => {
    cloudPushStatus = { lastPushAt: new Date().toISOString(), lastPushType: label, statusCode: null, ok: false, error: err.message, responseBody: null };
    log.error(`☁️ [CLOUD-${label}] Push error: ${err.message}`);
    if (label === 'state') albumArtOnCloudReply(payload, meta, null);   // [ALBUMART-UPLOAD]
  });
  req.on('timeout', () => {
    req.destroy();
    cloudPushStatus = { lastPushAt: new Date().toISOString(), lastPushType: label, statusCode: null, ok: false, error: 'Timeout', responseBody: null };
    log.warn(`☁️ [CLOUD-${label}] Push timeout`);
    if (label === 'state') albumArtOnCloudReply(payload, meta, null);   // [ALBUMART-UPLOAD]
  });
  req.write(body);
  req.end();
}

if (cloudConfig.enabled) {
  if (cloudConfig.url) log.info(`☁️ [CLOUD] State push → ${cloudConfig.url}`);
  if (cloudConfig.positionUrl) log.info(`☁️ [CLOUD] Position push → ${cloudConfig.positionUrl}`);
  if (!cloudConfig.url && !cloudConfig.positionUrl) log.info(`☁️ [CLOUD] Push enabled but no URLs configured`);
} else {
  log.info(`☁️ [CLOUD] Push disabled`);
}

function emitSonosEvent(eventData) {
  lastSonosEvent = eventData;
  broadcastSSE(eventData);
  cloudPushState(eventData);
}

function schedulePendingSonosIdle(eventData, meta) {
  pendingSonosIdleEvent = eventData;
  pendingSonosIdleMeta = meta;
  if (sonosIdleDebounceTimer) clearTimeout(sonosIdleDebounceTimer);
  sonosIdleDebounceTimer = setTimeout(() => {
    const idleEvent = pendingSonosIdleEvent;
    pendingSonosIdleEvent = null;
    pendingSonosIdleMeta = null;
    sonosIdleDebounceTimer = null;
    clearSonosTransitionRefresh();
    if (!idleEvent) return;
    const emittedIdleEvent = { ...idleEvent, playbackState: 'PLAYBACK_STATE_IDLE', timestamp: Date.now() };
    log.warn(`⚠️ [SONOS] Emitting IDLE after ${SONOS_IDLE_DEBOUNCE_MS}ms debounce`);
    emitSonosEvent(emittedIdleEvent);
  }, SONOS_IDLE_DEBOUNCE_MS);
}

// scheduleSonosTransitionRefresh (pollning 3×700 ms under TRANSITIONING) är borta:
// Sonos skickar ett nytt event när läget sätter sig.

// Fetch zone group info
async function fetchZoneGroupInfo() {
  try {
    const xml = await soapRequest(SOAP_GET_ZONE_GROUP, 'GetZoneGroupState', '/ZoneGroupTopology/Control', 'ZoneGroupTopology');
    const stateRaw = extractTag(xml, 'ZoneGroupState');
    if (!stateRaw) return { groupId: null, groupName: null };
    const state = decodeXmlEntities(stateRaw);
    const groupRegex = /<ZoneGroup\s[^>]*Coordinator="([^"]*)"[^>]*ID="([^"]*)"[^>]*>([\s\S]*?)<\/ZoneGroup>/g;
    let match;
    while ((match = groupRegex.exec(state)) !== null) {
      if (match[3].includes(SONOS_IP)) {
        cachedGroupId = `${match[1]}:${match[2]}`;
        const nameMatch = match[3].match(/ZoneName="([^"]*)"/);
        cachedGroupName = nameMatch ? nameMatch[1] : null;
        return { groupId: cachedGroupId, groupName: cachedGroupName };
      }
    }
    return { groupId: cachedGroupId, groupName: cachedGroupName };
  } catch (err) {
    return { groupId: cachedGroupId, groupName: cachedGroupName };
  }
}

function getNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// Re-resolve the coordinator IP for the saved room when subscription
// keeps failing — covers the case where the speaker got a new DHCP lease
// or the room's coordinator role moved to a different speaker.
let lastReresolveAt = 0;
async function reresolveCoordinator() {
  if (Date.now() - lastReresolveAt < 30000) return;
  lastReresolveAt = Date.now();
  if (!sonosConfig.sonosName && !sonosConfig.sonosUuid) return;
  log.info(`🔍 [SSDP] Re-resolving coordinator for "${sonosConfig.sonosName || sonosConfig.sonosUuid}"...`);
  try {
    const { rooms, devices } = await discoverRooms(4000);
    const list = rooms.length ? rooms : devices;
    sonosConfig.knownDevices = list;
    let match = sonosConfig.sonosName ? rooms.find(r => r.name === sonosConfig.sonosName) : null;
    if (!match && sonosConfig.sonosUuid) {
      match = rooms.find(r => r.uuid === sonosConfig.sonosUuid)
           || devices.find(d => d.uuid === sonosConfig.sonosUuid);
    }
    if (match && match.ip && match.ip !== SONOS_IP) {
      log.info(`🔄 [SSDP] Coordinator moved: ${SONOS_IP} → ${match.ip} (${match.name})`);
      SONOS_IP = match.ip;
      sonosConfig.sonosIp = match.ip;
      sonosConfig.sonosName = match.name || sonosConfig.sonosName;
      sonosConfig.sonosUuid = match.uuid || sonosConfig.sonosUuid;
    }
    saveSonosConfig(sonosConfig);
  } catch (e) {
    log.warn(`⚠️ [SSDP] Re-resolve failed: ${e.message}`);
  }
}


// ============ Event-först: Sonos pushar, vi räknar (2026-09-20) ============
//
// Sonos skickar UPnP-NOTIFY med HELA AVTransport-tillståndet (transportläge, låt,
// nästa låt, kö-URI, crossfade — allt utom positionen) och hela RenderingControl-
// tillståndet (volym, mute, bas, diskant, loudness) så fort något ändras, plus ett
// fullt event direkt efter SUBSCRIBE (uppmätt 2026-09-20: SEQ 0 efter 0,1 s).
//
// Gamla motorn kastade kroppen (räknade bara bytes) och gjorde 9 SOAP-anrop per
// event, 9 var 2:a sekund för statuscachen och 4 varje sekund för positionen:
// ~290 anrop/min mot högtalaren, ny TCP-anslutning varje gång.
//
// Nu: eventen parsas och blir sanningen. Positionen förankras med ETT
// GetPositionInfo vid play/paus/låtbyte och räknas lokalt däremellan, med
// omkalibrering var 30:e sekund under uppspelning. Skyddsnät: full SOAP-synk
// var 5:e minut och om inget event kommit 5 s efter prenumeration.

const POSITION_RESYNC_MS = 30 * 1000;
const SANITY_SYNC_MS = 5 * 60 * 1000;
const SUBSCRIBE_TIMEOUT_S = 300;
const SUBSCRIBE_RENEW_MS = 240 * 1000;
const NOTIFY_MAX_BYTES = 512 * 1024;

// Tillstånd från eventen
const avt = {
  transportState: null, transportStatus: null, playMode: null, crossfade: null,
  nrTracks: null, trackNumber: null, trackURI: null,
  trackDurationMs: null, trackDurationStr: null, didl: null,
  nextTrackURI: null, nextDidl: null,
  currentURI: null, nextAVTransportURI: null, nextAVTransportURIMetaData: null, playMedium: null,
  currentSpeed: null, updatedAt: 0, seq: null
};
const rc = { volume: null, mute: null, bass: null, treble: null, loudness: null, updatedAt: 0 };
// Positionsankare: relMs gällde vid anchorAt. Under PLAYING = relMs + förfluten tid.
const pos = { relMs: null, absTime: null, anchorAt: 0, driftMs: 0, anchors: 0 };
let lastStateChangeAt = 0;
let anchorInFlight = null;
let resyncTimer = null;
let sanityTimer = null;
let nextTrackCache = { key: null, value: null };
const eventStats = { avt: 0, rc: 0, soap: 0, anchors: 0, fullSyncs: 0 };

// Korrekt EN-nivås avkodning: &amp; SIST, annars blir &amp;quot; → " (dubbelavkodat).
function decodeXmlOnce(str) {
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// <e:propertyset><e:property><LastChange>&lt;Event ...&gt;</LastChange> → { Namn: val }
// Värden lämnas som de står i attributet (DIDL är fortfarande escapat en nivå,
// precis som i SOAP-svaren, så extractDidl/parseTime fungerar oförändrat).
function parseLastChange(body) {
  const m = body.match(/<LastChange>([\s\S]*?)<\/LastChange>/);
  if (!m) return null;
  const ev = decodeXmlOnce(m[1]);
  const vars = {};
  const re = /<([\w:]+)((?:\s+[\w:]+="[^"]*")*)\s*\/?>/g;
  let mm;
  while ((mm = re.exec(ev)) !== null) {
    const name = mm[1];
    if (name === 'Event' || name === 'InstanceID') continue;
    const attrs = mm[2] || '';
    const val = /\sval="([^"]*)"/.exec(attrs);
    if (!val) continue;
    const ch = /\schannel="([^"]*)"/.exec(attrs);
    if (ch && ch[1] !== 'Master') continue;
    vars[name] = val[1];
  }
  return vars;
}

function trackKeyOf(state) {
  return `${state.trackURI || ''}|${state.trackNumber ?? ''}|${state.didl?.title || ''}|${state.didl?.creator || ''}`;
}

function currentPositionMs() {
  if (pos.relMs === null) return null;
  // Radio/TV-strömmar saknar låtlängd och Sonos rapporterar ingen riktig position
  // för dem — då räknar vi inte upp (gav sågtand 0→30 s och "drift −5 699 s").
  if (avt.transportState !== 'PLAYING' || !(avt.trackDurationMs > 0)) return pos.relMs;
  return Math.min(pos.relMs + (Date.now() - pos.anchorAt), avt.trackDurationMs);
}

// ETT GetPositionInfo — sätter ankaret. Fyller också luckor (låt-URI, DIDL) om
// eventet saknade dem.
function anchorPosition(why) {
  if (anchorInFlight) return anchorInFlight;
  anchorInFlight = (async () => {
    try {
      const xml = await soapRequest(SOAP_GET_POSITION, 'GetPositionInfo');
      const relMs = parseTime(extractTag(xml, 'RelTime'));
      const durMs = parseTime(extractTag(xml, 'TrackDuration'));
      const at = Date.now();
      if (relMs !== null) {
        const predicted = currentPositionMs();
        if (why === 'omkalibrering' && predicted !== null && pos.anchorAt) pos.driftMs = relMs - predicted;   // bara mätbart mellan två ankare på samma låt
        pos.relMs = relMs;
        pos.anchorAt = at;
        pos.absTime = extractTag(xml, 'AbsTime');
        pos.anchors++;
        eventStats.anchors++;
        if (durMs !== null) { avt.trackDurationMs = durMs; avt.trackDurationStr = extractTag(xml, 'TrackDuration'); }
        if (!avt.trackURI) avt.trackURI = extractTag(xml, 'TrackURI');
        if (avt.trackNumber == null) { const t = extractTag(xml, 'Track'); if (t) avt.trackNumber = parseInt(t, 10); }
        if (!avt.didl) { const d = extractDidl(xml); if (d) avt.didl = d; }
        if (debugLogging) log.info(`[POS] förankrad (${why}): ${relMs} ms, drift ${pos.driftMs} ms`);
      }
    } catch (e) {
      log.debug(`[POS] förankring misslyckades (${why}): ${e.message}`);
    } finally {
      anchorInFlight = null;
    }
  })();
  return anchorInFlight;
}

function scheduleResync() {
  if (resyncTimer) clearTimeout(resyncTimer);
  resyncTimer = setTimeout(async () => {
    resyncTimer = null;
    if (avt.transportState === 'PLAYING') {
      await anchorPosition('omkalibrering');
      const ad = Math.abs(pos.driftMs);
      if (ad > 30000) log.info(`↔️ [POS] positionen hoppade ${Math.round(pos.driftMs / 1000)} s (seek eller missat event) — omförankrad`);
      else if (ad > 1500) log.warn(`⚠️ [POS] drift ${pos.driftMs} ms vid omkalibrering`);
    }
    scheduleResync();
  }, POSITION_RESYNC_MS);
}

function applyRcVars(vars) {
  let changed = false;
  const setInt = (k, name) => { if (name in vars) { const v = parseInt(vars[name], 10); if (!isNaN(v) && rc[k] !== v) { rc[k] = v; changed = true; } } };
  const setBool = (k, name) => { if (name in vars) { const v = vars[name] === '1'; if (rc[k] !== v) { rc[k] = v; changed = true; } } };
  setInt('volume', 'Volume'); setBool('mute', 'Mute'); setInt('bass', 'Bass'); setInt('treble', 'Treble'); setBool('loudness', 'Loudness');
  if (changed) { rc.updatedAt = Date.now(); lastStateChangeAt = rc.updatedAt; }
  return changed;
}

function applyAvtVars(vars) {
  const prevState = avt.transportState;
  const prevTrackKey = trackKeyOf(avt);
  const prevUri = avt.currentURI;
  const frozen = currentPositionMs();           // före mutation: var vi stod vid pausen

  const setStr = (k, name) => { if (name in vars) avt[k] = vars[name] || null; };
  setStr('transportState', 'TransportState');
  setStr('transportStatus', 'TransportStatus');
  setStr('playMode', 'CurrentPlayMode');
  if ('CurrentCrossfadeMode' in vars) avt.crossfade = vars.CurrentCrossfadeMode === '1';
  if ('NumberOfTracks' in vars) { const n = parseInt(vars.NumberOfTracks, 10); avt.nrTracks = isNaN(n) ? null : n; }
  if ('CurrentTrack' in vars) { const n = parseInt(vars.CurrentTrack, 10); avt.trackNumber = isNaN(n) ? null : n; }
  setStr('trackURI', 'CurrentTrackURI');
  if ('CurrentTrackDuration' in vars) { avt.trackDurationStr = vars.CurrentTrackDuration || null; avt.trackDurationMs = parseTime(vars.CurrentTrackDuration); }
  if ('CurrentTrackMetaData' in vars) avt.didl = vars.CurrentTrackMetaData ? (extractDidl(vars.CurrentTrackMetaData) || null) : null;
  setStr('nextTrackURI', 'r:NextTrackURI');
  if ('r:NextTrackMetaData' in vars) avt.nextDidl = vars['r:NextTrackMetaData'] ? (extractDidl(vars['r:NextTrackMetaData']) || null) : null;
  setStr('currentURI', 'AVTransportURI');
  setStr('nextAVTransportURI', 'NextAVTransportURI');
  setStr('nextAVTransportURIMetaData', 'NextAVTransportURIMetaData');
  setStr('playMedium', 'PlaybackStorageMedium');
  setStr('currentSpeed', 'TransportPlaySpeed');
  avt.updatedAt = Date.now();
  lastStateChangeAt = avt.updatedAt;

  const trackChanged = trackKeyOf(avt) !== prevTrackKey;
  const stateChanged = avt.transportState !== prevState;
  if (trackChanged) {
    pos.relMs = 0; pos.anchorAt = Date.now();
    nextTrackCache = { key: null, value: null };
  } else if (stateChanged && prevState === 'PLAYING' && frozen !== null) {
    pos.relMs = frozen; pos.anchorAt = Date.now();   // frys där vi stod
  }
  return { trackChanged, stateChanged, uriChanged: avt.currentURI !== prevUri };
}

// Nästa låt: från eventet (r:NextTrackMetaData). Saknas den (radio, kö-slut)
// görs Browse-uppslaget EN gång per låt, inte var 2:a sekund som förut.
async function resolveNextFromState() {
  if (avt.nextDidl) {
    const d = avt.nextDidl;
    let rawNextAlbumArtUri = null, nextAlbumArtUri = null;
    if (d.albumArtURI) {
      rawNextAlbumArtUri = d.albumArtURI.replace(/&amp;/g, '&');
      nextAlbumArtUri = rawNextAlbumArtUri.startsWith('/') ? `http://${SONOS_IP}:1400${rawNextAlbumArtUri}` : rawNextAlbumArtUri;
    }
    return { nextTrackName: d.title || null, nextArtistName: d.creator || null, nextAlbumArtUri, rawNextAlbumArtUri };
  }
  const key = `${avt.currentURI}|${avt.trackNumber}|${avt.nrTracks}|${avt.nextAVTransportURIMetaData ? 1 : 0}`;
  if (nextTrackCache.key === key) return nextTrackCache.value;
  const value = await resolveNextTrack(avt.nextAVTransportURIMetaData, avt.trackNumber, avt.nrTracks);
  nextTrackCache = { key, value };
  return value;
}

function albumArtUrlFromDidl(didl) {
  if (!didl || !didl.albumArtURI) return null;
  const clean = didl.albumArtURI.replace(/&amp;/g, '&');
  return clean.startsWith('/') ? `http://${SONOS_IP}:1400${clean}` : clean;
}

// Full SOAP-synk (9 anrop) — skyddsnät och ?fresh=1. Skriver in i samma tillstånd
// som eventen så att allt nedströms är oförändrat.
async function fullSyncFromSoap(source) {
  eventStats.fullSyncs++;
  const [posXml, transXml, mediaXml, volXml, muteXml, bassXml, trebleXml, loudnessXml, crossfadeXml] = await Promise.all([
    soapRequest(SOAP_GET_POSITION, 'GetPositionInfo'),
    soapRequest(SOAP_GET_TRANSPORT, 'GetTransportInfo'),
    soapRequest(SOAP_GET_MEDIA, 'GetMediaInfo'),
    soapRequest(SOAP_GET_VOLUME, 'GetVolume', RC_PATH, RC_SERVICE).catch(() => null),
    soapRequest(SOAP_GET_MUTE, 'GetMute', RC_PATH, RC_SERVICE).catch(() => null),
    soapRequest(SOAP_GET_BASS, 'GetBass', RC_PATH, RC_SERVICE).catch(() => null),
    soapRequest(SOAP_GET_TREBLE, 'GetTreble', RC_PATH, RC_SERVICE).catch(() => null),
    soapRequest(SOAP_GET_LOUDNESS, 'GetLoudness', RC_PATH, RC_SERVICE).catch(() => null),
    soapRequest(SOAP_GET_CROSSFADE, 'GetCrossfadeMode').catch(() => null)
  ]);
  const vars = {};
  const put = (name, xml, tag) => { if (!xml) return; const v = extractTag(xml, tag); if (v !== null) vars[name] = v; };
  put('TransportState', transXml, 'CurrentTransportState');
  put('TransportStatus', transXml, 'CurrentTransportStatus');
  put('TransportPlaySpeed', transXml, 'CurrentSpeed');
  put('NumberOfTracks', mediaXml, 'NrTracks');
  put('AVTransportURI', mediaXml, 'CurrentURI');
  put('NextAVTransportURI', mediaXml, 'NextAVTransportURI');
  put('NextAVTransportURIMetaData', mediaXml, 'NextAVTransportURIMetaData');
  put('PlaybackStorageMedium', mediaXml, 'PlayMedium');
  put('CurrentTrack', posXml, 'Track');
  put('CurrentTrackURI', posXml, 'TrackURI');
  put('CurrentTrackDuration', posXml, 'TrackDuration');
  put('CurrentTrackMetaData', posXml, 'TrackMetaData');
  if (crossfadeXml) { const cf = extractTag(crossfadeXml, 'CrossfadeMode'); if (cf !== null) vars.CurrentCrossfadeMode = cf; }
  if (debugLogging) {
    log.info(`[RAW] posXml (first 500): ${posXml?.substring(0, 500)}`);
    log.info(`[RAW] mediaXml (first 500): ${mediaXml?.substring(0, 500)}`);
  }
  // Positionen från samma svar blir ankaret
  applyAvtVars(vars);
  const relMs = parseTime(extractTag(posXml, 'RelTime'));
  if (relMs !== null) { pos.relMs = relMs; pos.anchorAt = Date.now(); pos.absTime = extractTag(posXml, 'AbsTime'); pos.anchors++; }
  const rcVars = {};
  const putRc = (name, xml, tag) => { if (!xml) return; const v = extractTag(xml, tag); if (v !== null) rcVars[name] = v; };
  putRc('Volume', volXml, 'CurrentVolume'); putRc('Mute', muteXml, 'CurrentMute');
  putRc('Bass', bassXml, 'CurrentBass'); putRc('Treble', trebleXml, 'CurrentTreble'); putRc('Loudness', loudnessXml, 'CurrentLoudness');
  applyRcVars(rcVars);
  await composeAndEmit(source, { trackChanged: true, stateChanged: true, uriChanged: true });
}

// Bakåtkompatibel ingång (anropas av config-byte m.m.): full synk, koalescerad.
async function handleSonosUPnPEvent({ source = 'full-sync' } = {}) {
  if (sonosUpnpHandlerBusy) { sonosUpnpHandlerPending = true; return; }
  sonosUpnpHandlerBusy = true;
  try {
    await fullSyncFromSoap(source);
  } catch (err) {
    log.error(`❌ [SONOS] Full synk misslyckades (${source}): ${err.message}`);
  } finally {
    sonosUpnpHandlerBusy = false;
    if (sonosUpnpHandlerPending) { sonosUpnpHandlerPending = false; setImmediate(() => handleSonosUPnPEvent({ source: 'coalesced' })); }
  }
}

function composeEventData(source, next) {
  const didl = avt.didl;
  return {
    ok: true,
    source,
    playbackState: getSonosPlaybackState(avt.transportState),
    positionMillis: currentPositionMs(),
    durationMillis: avt.trackDurationMs,
    trackName: didl ? didl.title : null,
    artistName: didl ? didl.creator : null,
    albumName: didl ? didl.album : null,
    albumArtUri: albumArtUrlFromDidl(didl),
    nextTrackName: next.nextTrackName,
    nextArtistName: next.nextArtistName,
    nextAlbumArtUri: next.nextAlbumArtUri,
    volume: rc.volume,
    mute: rc.mute,
    bass: rc.bass,
    treble: rc.treble,
    loudness: rc.loudness,
    mediaType: didl?.upnpClass?.includes('audioBroadcast') ? 'radio' : 'track',
    trackNumber: avt.trackNumber,
    trackURI: avt.trackURI,
    absTime: pos.absTime,
    currentSpeed: avt.currentSpeed,
    currentTransportStatus: avt.transportStatus,
    crossfade: avt.crossfade,
    nrTracks: avt.nrTracks,
    currentURI: avt.currentURI,
    nextAVTransportURI: avt.nextAVTransportURI,
    playMedium: avt.playMedium,
    streamContent: didl ? didl.streamContent : null,
    radioShowMd: didl ? didl.radioShowMd : null,
    originalTrackNumber: didl?.originalTrackNumber ? parseInt(didl.originalTrackNumber, 10) : null,
    protocolInfo: didl ? didl.protocolInfo : null,
    groupId: cachedGroupId,
    groupName: cachedGroupName,
    currentPalette: cachedCurrentPalette,
    nextPalette: cachedNextPalette,
    timestamp: Date.now()
  };
}

// Allt som tidigare hände efter de nio SOAP-anropen: omslag, palett, Spotify,
// zon, idle-debounce och utsändning. Oförändrad logik, ny datakälla.
async function composeAndEmit(source, { trackChanged = false, stateChanged = false, uriChanged = false } = {}) {
  try {
    const next = await resolveNextFromState();
    const didl = avt.didl;

    const previousRawAlbumArtUri = cachedRawAlbumArtUri;
    cachedRawAlbumArtUri = (didl?.albumArtURI || cachedRawAlbumArtUri || '').replace(/&amp;/g, '&');
    cachedRawNextAlbumArtUri = (next.rawNextAlbumArtUri || cachedRawNextAlbumArtUri || '').replace(/&amp;/g, '&');

    // Extract palette on album art change (new track)
    if (cachedRawAlbumArtUri && cachedRawAlbumArtUri !== previousRawAlbumArtUri) {
      pushAlbumArtWhenReady(cachedRawAlbumArtUri, false);   // [ALBUMART-UPLOAD]
      if (cachedRawNextAlbumArtUri && cachedRawNextAlbumArtUri === cachedRawAlbumArtUri && cachedNextPalette.length > 0) {
        cachedCurrentPalette = cachedNextPalette;
        try { if (cachedCurrentPalette[0]) pushHueHistory(cachedCurrentPalette[0]); } catch {}
        log.info('🎨 [PALETTE] Promoted pre-fetched next → current');
      } else {
        cachedCurrentPalette = [];
      }
      cachedNextPalette = [];

      if (!paletteExtractionInProgress) {
        const targetUri = cachedRawAlbumArtUri;
        paletteExtractionInProgress = true;
        extractPalette(targetUri, SONOS_IP, log)
          .then(palette => {
            paletteExtractionInProgress = false;
            if (targetUri !== cachedRawAlbumArtUri) {
              log.info('🎨 [PALETTE] Discarded stale extraction (track changed)');
              return;
            }
            cachedCurrentPalette = palette;
            try { if (palette && palette[0]) pushHueHistory(palette[0]); } catch {}
            if (lastSonosEvent) {
              lastSonosEvent.currentPalette = palette;
              const prevSource = lastSonosEvent.source;
              lastSonosEvent.source = 'palette-update';
              broadcastSSE(lastSonosEvent);
              cloudPushState(lastSonosEvent);
              lastSonosEvent.source = prevSource;
            }
          })
          .catch(() => { paletteExtractionInProgress = false; });
      }
    }

    // Pre-fetch palette for next track (bara när nästa omslag är nytt)
    if (cachedRawNextAlbumArtUri && cachedRawNextAlbumArtUri !== cachedRawAlbumArtUri && cachedRawNextAlbumArtUri !== lastPrefetchedNextArtUri) {
      lastPrefetchedNextArtUri = cachedRawNextAlbumArtUri;
      pushAlbumArtWhenReady(cachedRawNextAlbumArtUri, true);   // [ALBUMART-UPLOAD]
      const targetNext = cachedRawNextAlbumArtUri;
      extractPalette(targetNext, SONOS_IP, log)
        .then(palette => {
          if (!palette || palette.length === 0) {                 // misslyckad hämtning (timeout) → nytt försök om 5 s, max 2
            nextPaletteRetries = (lastPrefetchedNextArtUri === targetNext) ? nextPaletteRetries + 1 : 1;
            if (nextPaletteRetries <= 2) setTimeout(() => { if (cachedRawNextAlbumArtUri === targetNext) { lastPrefetchedNextArtUri = null; composeAndEmit('next-palette-retry'); } }, 5000);
            return;
          }
          if (targetNext !== cachedRawNextAlbumArtUri) return;
          cachedNextPalette = palette;
          log.info('🎨 [PALETTE] Next track palette pre-cached');
          if (lastSonosEvent) {
            lastSonosEvent.nextPalette = palette;
            const prevSource = lastSonosEvent.source;
            lastSonosEvent.source = 'next-palette-update';
            broadcastSSE(lastSonosEvent);
            cloudPushState(lastSonosEvent);
            lastSonosEvent.source = prevSource;
          }
        })
        .catch(() => {});
    }

    if (uriChanged || !cachedGroupId) fetchZoneGroupInfo().catch(() => {});

    // Spotify audio-features on track change (non-blocking)
    const spTrackName = didl ? didl.title : null;
    const spArtistName = didl ? didl.creator : null;
    if (spTrackName && spArtistName) {
      const spKey = `${spArtistName}::${spTrackName}`;
      if (spKey !== lastSpotifyKey) {
        lastSpotifyKey = spKey;
        spotify.onTrackChange(spArtistName, spTrackName).catch(e => log.warn(`spotify.onTrackChange failed: ${e.message}`));
      }
    }

    const eventData = composeEventData(source, next);
    const transportState = avt.transportState;

    if ((source === 'sanity' || source === 'next-palette-retry') && lastSonosEvent && !stateDiffersFromLastEvent(eventData)) {
      log.debug('[SONOS] sanity: oförändrat — ingen utsändning');
      return;
    }

    if (transportState === 'PLAYING' || transportState === 'PAUSED_PLAYBACK') {
      cancelPendingSonosIdle(`received ${transportState}`);
      emitSonosEvent(eventData);
      return;
    }

    if (isSonosTransitionState(transportState) || isSonosIdleCandidateTransportState(transportState)) {
      // TRANSITIONING/STOPPED mellan låtar: nästa event (PLAYING) kommer av sig
      // självt — debouncen skyddar mot att IDLE hinner sändas emellan.
      const idleReason = classifySonosIdleReason(transportState, eventData);
      schedulePendingSonosIdle(eventData, { reason: idleReason, transportState });
      return;
    }

    cancelPendingSonosIdle(`received ${transportState || 'UNKNOWN'}`);
    emitSonosEvent(eventData);
  } catch (err) {
    log.error(`❌ [SONOS] Event handler error: ${err.message}`);
  }
}
let lastPrefetchedNextArtUri = null;
let nextPaletteRetries = 0;

function stateDiffersFromLastEvent(eventData) {
  const e = lastSonosEvent;
  return e.playbackState !== eventData.playbackState
    || e.trackURI !== eventData.trackURI
    || e.trackNumber !== eventData.trackNumber
    || e.trackName !== eventData.trackName
    || e.volume !== eventData.volume
    || e.mute !== eventData.mute
    || e.nextTrackName !== eventData.nextTrackName;
}

// NOTIFY-kroppar → tillstånd
let avtEventChain = Promise.resolve();
function onAvtNotify(body, seq) {
  eventStats.avt++;
  const vars = parseLastChange(body);
  if (!vars) { log.warn('⚠️ [SONOS] AVTransport-event utan LastChange — full synk'); handleSonosUPnPEvent({ source: 'notify-unparsed' }); return; }
  avt.seq = seq;
  // Serialisera: ett event i taget, i ordning
  avtEventChain = avtEventChain.then(async () => {
    const change = applyAvtVars(vars);
    if (debugLogging) log.info(`[EVENT] AVT seq=${seq} state=${avt.transportState} track=${avt.trackNumber}/${avt.nrTracks} "${avt.didl?.title || ''}" changed=${JSON.stringify(change)}`);
    if (change.trackChanged || change.stateChanged || pos.anchorAt === 0) {
      await anchorPosition(change.trackChanged ? 'låtbyte' : (change.stateChanged ? avt.transportState : 'första'));
    }
    await composeAndEmit('upnp-event', change);
  }).catch((e) => log.error(`❌ [SONOS] AVT-event: ${e.message}`));
}

function onRcNotify(body) {
  eventStats.rc++;
  const vars = parseLastChange(body);
  if (!vars) return;
  const changed = applyRcVars(vars);
  if (debugLogging) log.info(`[EVENT] RC volume=${rc.volume} mute=${rc.mute} bass=${rc.bass} treble=${rc.treble} loudness=${rc.loudness} changed=${changed}`);
  if (!changed || avt.updatedAt === 0) return;
  avtEventChain = avtEventChain.then(() => composeAndEmit('rc-event')).catch(() => {});
}

// ============ UPnP-prenumerationer (AVTransport + RenderingControl) ============

const subs = {
  avt: { label: 'AVTransport', path: '/MediaRenderer/AVTransport/Event', callback: '/api/upnp-callback', sid: null, renewTimer: null, retries: 0 },
  rc:  { label: 'RenderingControl', path: '/MediaRenderer/RenderingControl/Event', callback: '/api/upnp-callback-rc', sid: null, renewTimer: null, retries: 0 }
};

function subscribeService(key) {
  const sub = subs[key];
  const networkIP = getNetworkIP();
  const req = http.request({
    hostname: SONOS_IP, port: 1400, path: sub.path, method: 'SUBSCRIBE', timeout: 5000,
    headers: { 'CALLBACK': `<http://${networkIP}:${PORT}${sub.callback}>`, 'NT': 'upnp:event', 'TIMEOUT': `Second-${SUBSCRIBE_TIMEOUT_S}` }
  }, (res) => {
    res.resume();
    const sid = res.headers['sid'];
    if (sid) {
      sub.sid = sid;
      sub.retries = 0;
      if (key === 'avt') { sonosSubscriptionSID = sid; sonosSubscribeRetries = 0; }
      log.info(`📡 [SONOS] Prenumererar på ${sub.label}, SID ${sid}`);
      clearTimeout(sub.renewTimer);
      sub.renewTimer = setTimeout(() => renewService(key), SUBSCRIBE_RENEW_MS);
    } else {
      log.warn(`⚠️ [SONOS] SUBSCRIBE ${sub.label} utan SID (HTTP ${res.statusCode})`);
      scheduleSubscribeRetry(key, 'inget SID');
    }
  });
  req.on('error', (err) => scheduleSubscribeRetry(key, err.message));
  req.on('timeout', () => { req.destroy(); scheduleSubscribeRetry(key, 'timeout'); });
  req.end();
}

function scheduleSubscribeRetry(key, why) {
  const sub = subs[key];
  const retryMs = Math.min(5000 * Math.pow(2, Math.min(sub.retries++, 5)), 120000);
  if (key === 'avt') { sonosSubscriptionSID = null; sonosSubscribeRetries = sub.retries; }
  log.error(`❌ [SONOS] SUBSCRIBE ${sub.label} misslyckades (${why}) — försöker om ${Math.round(retryMs / 1000)} s`);
  if (sub.retries >= 2) reresolveCoordinator().catch(() => {});
  setTimeout(() => subscribeService(key), retryMs);
}

function renewService(key) {
  const sub = subs[key];
  if (!sub.sid) { subscribeService(key); return; }
  const req = http.request({
    hostname: SONOS_IP, port: 1400, path: sub.path, method: 'SUBSCRIBE', timeout: 5000,
    headers: { 'SID': sub.sid, 'TIMEOUT': `Second-${SUBSCRIBE_TIMEOUT_S}` }
  }, (res) => {
    res.resume();
    if (res.statusCode === 200) {
      log.debug(`🔄 [SONOS] ${sub.label}-prenumerationen förnyad`);
      clearTimeout(sub.renewTimer);
      sub.renewTimer = setTimeout(() => renewService(key), SUBSCRIBE_RENEW_MS);
    } else {
      log.warn(`⚠️ [SONOS] Förnyelse av ${sub.label} gav ${res.statusCode} — prenumererar om`);
      sub.sid = null;
      if (key === 'avt') sonosSubscriptionSID = null;
      subscribeService(key);
    }
  });
  req.on('error', () => { sub.sid = null; if (key === 'avt') sonosSubscriptionSID = null; setTimeout(() => subscribeService(key), 5000); });
  req.on('timeout', () => { req.destroy(); sub.sid = null; if (key === 'avt') sonosSubscriptionSID = null; setTimeout(() => subscribeService(key), 5000); });
  req.end();
}

function unsubscribeService(key, hostIp) {
  const sub = subs[key];
  clearTimeout(sub.renewTimer); sub.renewTimer = null;
  if (!sub.sid) return;
  try {
    const req = http.request({ hostname: hostIp || SONOS_IP, port: 1400, path: sub.path, method: 'UNSUBSCRIBE', headers: { 'SID': sub.sid }, timeout: 2000 });
    req.on('error', () => {}); req.on('timeout', () => req.destroy()); req.end();
  } catch (e) {}
  sub.sid = null;
  if (key === 'avt') sonosSubscriptionSID = null;
}

function subscribeSonosEvents() {
  subscribeService('avt');
  subscribeService('rc');
  // Skyddsnät: kommer inget event på 5 s (t.ex. gammal firmware) → full synk
  setTimeout(() => { if (avt.updatedAt === 0) { log.warn('⚠️ [SONOS] Inget event 5 s efter prenumeration — full synk'); handleSonosUPnPEvent({ source: 'no-event' }); } }, 5000);
}

function renewSonosSubscription() { renewService('avt'); renewService('rc'); }

function startEventEngine() {
  scheduleResync();
  if (sanityTimer) clearInterval(sanityTimer);
  sanityTimer = setInterval(() => handleSonosUPnPEvent({ source: 'sanity' }), SANITY_SYNC_MS);
  sanityTimer.unref?.();
}

// ============ Positionstick — räknad, inte hämtad ============

let positionBroadcastTimer = null;
let cachedMediaType = 'track';

// Reusable tick payload — mutated in place each second to avoid allocations
const tickData = {
  ok: true, source: 'position-tick',
  positionMillis: null, durationMillis: null, volume: null, mute: null, mediaType: 'track',
  bass: null, treble: null, loudness: null, crossfade: null,
  trackName: null, artistName: null, albumName: null,
  playbackState: 'PLAYBACK_STATE_IDLE', groupId: null, groupName: null
};

function fillTick() {
  tickData.positionMillis = currentPositionMs();
  tickData.durationMillis = avt.trackDurationMs;
  tickData.volume = rc.volume;
  tickData.mute = rc.mute;
  tickData.mediaType = avt.didl?.upnpClass?.includes('audioBroadcast') ? 'radio' : 'track';
  cachedMediaType = tickData.mediaType;
  tickData.bass = rc.bass;
  tickData.treble = rc.treble;
  tickData.loudness = rc.loudness;
  tickData.crossfade = avt.crossfade;
  tickData.trackName = avt.didl?.title || lastSonosEvent?.trackName || null;
  tickData.artistName = avt.didl?.creator || lastSonosEvent?.artistName || null;
  tickData.albumName = avt.didl?.album || lastSonosEvent?.albumName || null;
  tickData.playbackState = lastSonosEvent?.playbackState || getSonosPlaybackState(avt.transportState);
  tickData.groupId = cachedGroupId;
  tickData.groupName = cachedGroupName;
  return tickData;
}

function startPositionBroadcast() {
  if (positionBroadcastTimer) return;
  positionBroadcastTimer = setInterval(() => {
    const cloudActive = cloudConfig.enabled && cloudConfig.positionUrl && cloudConfig.secret;
    if (sonosEventClients.length === 0 && !cloudActive) return;
    if (avt.updatedAt === 0) return;
    fillTick();
    if (sonosEventClients.length > 0) broadcastSSE(tickData);
    if (cloudActive) cloudPushPosition(tickData);
  }, process.env.POSITION_INTERVAL_MS ? parseInt(process.env.POSITION_INTERVAL_MS) : 1000);
}

function stopPositionBroadcast() {
  if (positionBroadcastTimer) { clearInterval(positionBroadcastTimer); positionBroadcastTimer = null; }
}

// ============ Status för konsumenter (lotus m.fl.) ============
//
// Gamla statuscachen (9 SOAP var 2:a sekund) är borta. Svaret byggs ur
// eventtillståndet + beräknad position: ~0 ms, alltid färskt, inga anrop.
function buildStatusPayload() {
  const data = composeEventData('local-upnp', {
    nextTrackName: lastSonosEvent?.nextTrackName ?? null,
    nextArtistName: lastSonosEvent?.nextArtistName ?? null,
    nextAlbumArtUri: lastSonosEvent?.nextAlbumArtUri ?? null
  });
  if (lastSonosEvent?.playbackState) data.playbackState = lastSonosEvent.playbackState;
  delete data.timestamp;
  return {
    ...data,
    currentPalette: cachedCurrentPalette || [],
    nextPalette: cachedNextPalette || [],
    cached: true,
    cacheAgeMs: lastStateChangeAt ? Date.now() - lastStateChangeAt : null,
    positionAnchorAgeMs: pos.anchorAt ? Date.now() - pos.anchorAt : null
  };
}

function refreshStatusCacheSoon() { /* händelsestyrt — inget att göra */ }

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sonosEventClients = sonosEventClients.filter(client => {
    try { client.write(msg); return true; } catch (e) { return false; }
  });
}

function resetEventState() {
  for (const k of Object.keys(avt)) avt[k] = (k === 'updatedAt') ? 0 : null;
  for (const k of Object.keys(rc)) rc[k] = (k === 'updatedAt') ? 0 : null;
  pos.relMs = null; pos.absTime = null; pos.anchorAt = 0; pos.driftMs = 0;
  nextTrackCache = { key: null, value: null };
  lastPrefetchedNextArtUri = null;
}

// Re-subscribe with new IP
function switchSonosIP(newIp, name, uuid) {
  log.info(`🔄 [SONOS] Switching from ${SONOS_IP} to ${newIp} (${name || 'unknown'})`);
  const oldIp = SONOS_IP;
  unsubscribeService('avt', oldIp);
  unsubscribeService('rc', oldIp);
  subs.avt.retries = 0; subs.rc.retries = 0;
  sonosSubscribeRetries = 0;
  lastSonosEvent = null;
  cachedGroupId = null;
  cachedGroupName = null;
  resetEventState();

  SONOS_IP = newIp;
  sonosConfig = { ...sonosConfig, sonosIp: newIp, sonosName: name || null, sonosUuid: uuid || null };
  saveSonosConfig(sonosConfig);

  subscribeSonosEvents();
}

// ============ HTTP Server ============

const MAX_BODY_SIZE = 10 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block'
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Body too large')); return; }
      body += chunk;
    });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...SECURITY_HEADERS });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => res.setHeader(key, value));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  
  // API Routes — all under /api/
  if (pathname.startsWith('/api/')) {
    try {
      // GET /api/version (Pi Control Center obligatorisk)
      if (req.method === 'GET' && pathname === '/api/version') {
        sendJson(res, {
          name: 'sonos-buddy',
          version: VERSION,
          commit: GIT_COMMIT,
          commitShort: GIT_COMMIT_SHORT,
          branch: GIT_BRANCH
        });
        return;
      }

      // GET /api/health (Pi Control Center obligatorisk)
      if (req.method === 'GET' && pathname === '/api/health') {
        const mem = process.memoryUsage();
        const rssMB = Math.round(mem.rss / 1024 / 1024);
        let status = 'ok';
        if (rssMB > 100) status = 'degraded';
        if (!sonosSubscriptionSID) status = 'degraded';
        const events = { ...eventStats, rcSubscribed: !!subs.rc.sid, lastEventAt: lastStateChangeAt ? new Date(lastStateChangeAt).toISOString() : null, positionAnchors: pos.anchors, positionDriftMs: pos.driftMs };
        sendJson(res, {
          status,
          service: 'sonos-buddy-engine',
          version: VERSION,
          uptime: Math.floor(process.uptime()),
          memory: {
            rss: rssMB,
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotal: Math.round(mem.heapTotal / 1024 / 1024)
          },
          timestamp: new Date().toISOString(),
          sonosIp: SONOS_IP,
          subscribed: !!sonosSubscriptionSID,
          events,
          sseClients: sonosEventClients.length,
        });
        return;
      }

      // GET /api/discover — returns one entry per room (coordinator only)
      if (req.method === 'GET' && pathname === '/api/discover') {
        log.info('🔍 [SSDP] Starting network scan...');
        try {
          const { rooms, devices } = await discoverRooms(5000);
          const list = rooms.length ? rooms : devices;
          log.info(`🔍 [SSDP] Found ${devices.length} device(s), ${rooms.length} room(s)`);
          sonosConfig.knownDevices = list;
          saveSonosConfig(sonosConfig);
          sendJson(res, { ok: true, devices: list, currentUuid: sonosConfig.sonosUuid, currentIp: SONOS_IP });
        } catch (err) {
          sendJson(res, { ok: true, devices: sonosConfig.knownDevices || [], currentUuid: sonosConfig.sonosUuid, currentIp: SONOS_IP, cached: true });
        }
        return;
      }
      
      // GET /api/config
      if (req.method === 'GET' && pathname === '/api/config') {
        sendJson(res, { ok: true, ...sonosConfig, currentIp: SONOS_IP, knownDevices: sonosConfig.knownDevices || [] });
        return;
      }
      
      // PUT /api/config
      if (req.method === 'PUT' && pathname === '/api/config') {
        const body = await parseBody(req);
        if (!body.sonosIp) { sendJson(res, { ok: false, error: 'Missing sonosIp' }, 400); return; }
        switchSonosIP(body.sonosIp, body.sonosName || null, body.sonosUuid || null);
        sendJson(res, { ok: true, ...sonosConfig });
        return;
      }
      
      // GET /api/debug
      if (req.method === 'GET' && pathname === '/api/debug') {
        sendJson(res, { ok: true, enabled: debugLogging });
        return;
      }

      // PUT /api/debug
      if (req.method === 'PUT' && pathname === '/api/debug') {
        const body = await parseBody(req);
        debugLogging = !!body.enabled;
        sonosConfig.debugLogging = debugLogging;
        saveSonosConfig(sonosConfig);
        log.info(`[DEBUG] Raw debug logging ${debugLogging ? 'ENABLED' : 'DISABLED'} via UI`);
        sendJson(res, { ok: true, enabled: debugLogging });
        return;
      }

      // GET /api/palette/history
      if (req.method === 'GET' && pathname === '/api/palette/history') {
        const hues = getHueHistory();
        sendJson(res, { ok: true, hues, size: hues.length });
        return;
      }

      // DELETE /api/palette/history
      if (req.method === 'DELETE' && pathname === '/api/palette/history') {
        clearHueHistory();
        sendJson(res, { ok: true });
        return;
      }

      // GET /api/spotify/status
      if (req.method === 'GET' && pathname === '/api/spotify/status') {
        sendJson(res, { ok: true, ...spotify.getSpotifyStatus() });
        return;
      }

      // GET /api/spotify/current
      if (req.method === 'GET' && pathname === '/api/spotify/current') {
        const cur = spotify.getCurrentFeatures();
        if (!cur) { sendJson(res, { artist: null, track: null, features: null, updatedAt: null }); return; }
        sendJson(res, cur);
        return;
      }

      // POST /api/spotify/credentials
      if (req.method === 'POST' && pathname === '/api/spotify/credentials') {
        const body = await parseBody(req);
        if (!body.clientId || !body.clientSecret) {
          sendJson(res, { ok: false, error: 'missing_fields' }, 400);
          return;
        }
        const result = await spotify.setSpotifyCredentials(body.clientId, body.clientSecret);
        log.info(`🎧 [SPOTIFY] Credentials ${result.ok ? 'saved' : 'rejected'}${result.ok ? '' : ` (${result.error})`}`);
        sendJson(res, result, result.ok ? 200 : 400);
        return;
      }

      // DELETE /api/spotify/credentials
      if (req.method === 'DELETE' && pathname === '/api/spotify/credentials') {
        spotify.clearSpotifyCredentials();
        log.info(`🎧 [SPOTIFY] Credentials cleared`);
        sendJson(res, { ok: true });
        return;
      }

      // GET /api/cloud-config
      if (req.method === 'GET' && pathname === '/api/cloud-config') {
        sendJson(res, {
          ok: true,
          enabled: cloudConfig.enabled,
          url: cloudConfig.url,
          positionUrl: cloudConfig.positionUrl || '',
          secret: cloudConfig.secret ? '••••••••' : '',
          intervalMs: cloudConfig.intervalMs,
          hasSecret: !!cloudConfig.secret,
          pushStatus: cloudPushStatus,
        });
        return;
      }

      // PUT /api/cloud-config
      if (req.method === 'PUT' && pathname === '/api/cloud-config') {
        const body = await parseBody(req);
        const cfg = loadSonosConfig();
        if (typeof body.enabled === 'boolean') cfg.cloudPushEnabled = body.enabled;
        if (typeof body.url === 'string') cfg.cloudPushUrl = body.url.trim();
        if (typeof body.positionUrl === 'string') cfg.cloudPushPositionUrl = body.positionUrl.trim();
        if (typeof body.secret === 'string' && body.secret !== '••••••••' && body.secret.trim() !== '') cfg.cloudPushSecret = body.secret;
        if (typeof body.intervalMs === 'number' && body.intervalMs >= 100) cfg.cloudPushIntervalMs = body.intervalMs;
        const saved = saveSonosConfig(cfg, { includeSettings: true, includeState: false });
        if (!saved.ok) {
          log.error(`☁️ [CLOUD] Failed to persist config to ${SETTINGS_FILE}: ${saved.settingsError || 'unknown error'}`);
          sendJson(res, { ok: false, error: `Could not write settings to ${SETTINGS_FILE}${saved.settingsError ? `: ${saved.settingsError}` : ''}. Check write permissions for PCC_CONFIG_DIR.` }, 500);
          return;
        }
        // Re-read to verify on-disk state actually matches what we wrote
        const verify = readJson(SETTINGS_FILE) || {};
        cloudConfig = loadCloudConfig();
        log.info(`☁️ [CLOUD] Config updated: enabled=${cloudConfig.enabled}, url=${cloudConfig.url ? '✓' : '✗'}, positionUrl=${cloudConfig.positionUrl ? '✓' : '✗'}, secret=${cloudConfig.secret ? '✓' : '✗'}, file=${SETTINGS_FILE}`);
        log.info(`☁️ [CLOUD] On-disk verify: enabled=${verify.cloudPushEnabled}, url=${verify.cloudPushUrl ? '✓' : '✗'}, positionUrl=${verify.cloudPushPositionUrl ? '✓' : '✗'}, secret=${verify.cloudPushSecret ? '✓' : '✗'}`);
        sendJson(res, {
          ok: true,
          enabled: cloudConfig.enabled,
          url: cloudConfig.url,
          positionUrl: cloudConfig.positionUrl || '',
          hasSecret: !!cloudConfig.secret,
          intervalMs: cloudConfig.intervalMs,
          settingsFile: SETTINGS_FILE,
        });
        return;
      }
      
      // GET /api/status (alias: /api/sonos — bakåtkompatibel)
      if (req.method === 'GET' && (pathname === '/api/status' || pathname === '/api/sonos')) {
        // Svaret byggs ur eventtillståndet + beräknad position: inga SOAP-anrop,
        // ~0 ms, alltid färskt. ?fresh=1 tvingar en full SOAP-synk först.
        const wantFresh = url.searchParams && url.searchParams.get('fresh') === '1';
        if (wantFresh || avt.updatedAt === 0) {
          await handleSonosUPnPEvent({ source: wantFresh ? 'api-fresh' : 'api-first' });
        }
        if (avt.updatedAt === 0) {
          sendJson(res, { ok: false, error: 'Inget tillstånd från högtalaren ännu' }, 503);
          return;
        }
        sendJson(res, buildStatusPayload());
        return;
      }

      // GET /api/getaa* – proxy album art from Sonos
      if (req.method === 'GET' && pathname.startsWith('/api/getaa')) {
        const sonosPath = pathname.replace('/api', '') + (url.search || '');
        const sonosUrl = `http://${SONOS_IP}:1400${sonosPath}`;
        try {
          const artReq = http.get(sonosUrl, { timeout: 5000 }, (artRes) => {
            res.writeHead(artRes.statusCode, {
              'Content-Type': artRes.headers['content-type'] || 'image/jpeg',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=300',
              ...SECURITY_HEADERS
            });
            artRes.pipe(res);
          });
          artReq.on('timeout', () => { artReq.destroy(); res.writeHead(502, SECURITY_HEADERS); res.end('Art fetch timeout'); });
          artReq.on('error', () => { res.writeHead(502, SECURITY_HEADERS); res.end('Art fetch error'); });
        } catch (err) { res.writeHead(502, SECURITY_HEADERS); res.end('Art fetch error'); }
        return;
      }
      
      // GET /api/art?url=...
      if (req.method === 'GET' && pathname === '/api/art') {
        const artUrl = url.searchParams.get('url');
        if (!artUrl) { sendJson(res, { error: 'Missing url parameter' }, 400); return; }
        try {
          const mod = artUrl.startsWith('https') ? require('https') : http;
          const artReq = mod.get(artUrl, { timeout: 3000 }, (artRes) => {
            res.writeHead(artRes.statusCode, {
              'Content-Type': artRes.headers['content-type'] || 'image/jpeg',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=300',
              ...SECURITY_HEADERS
            });
            artRes.pipe(res);
          });
          artReq.on('timeout', () => { artReq.destroy(); res.writeHead(502, SECURITY_HEADERS); res.end('Art fetch timeout'); });
          artReq.on('error', () => { res.writeHead(502, SECURITY_HEADERS); res.end('Art fetch error'); });
        } catch (err) { res.writeHead(502, SECURITY_HEADERS); res.end('Art fetch error'); }
        return;
      }
      
      // GET /api/events – SSE stream
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          ...SECURITY_HEADERS
        });
        if (lastSonosEvent) res.write(`data: ${JSON.stringify(lastSonosEvent)}\n\n`);
        sonosEventClients.push(res);
        log.info(`📡 [SONOS] SSE client connected (total: ${sonosEventClients.length})`);
        req.on('close', () => {
          sonosEventClients = sonosEventClients.filter(c => c !== res);
          log.info(`📡 [SONOS] SSE client disconnected (total: ${sonosEventClients.length})`);
        });
        const keepAlive = setInterval(() => { try { res.write(':keepalive\n\n'); } catch(e) { clearInterval(keepAlive); } }, 15000);
        req.on('close', () => clearInterval(keepAlive));
        return;
      }
      
      // NOTIFY /api/upnp-callback (AVTransport) och /api/upnp-callback-rc (RenderingControl)
      // Kroppen ÄR tillståndet — parsas, inga SOAP-anrop.
      if (req.method === 'NOTIFY' && (pathname === '/api/upnp-callback' || pathname === '/api/upnp-callback-rc')) {
        const chunks = [];
        let bytes = 0;
        let tooBig = false;
        req.on('data', chunk => { bytes += chunk.length; if (bytes > NOTIFY_MAX_BYTES) { tooBig = true; return; } chunks.push(chunk); });
        req.on('end', () => {
          res.writeHead(200);
          res.end();
          if (tooBig) { log.warn(`⚠️ [SONOS] NOTIFY ${bytes} B — för stor, ignorerad`); return; }
          const body = Buffer.concat(chunks).toString('utf8');
          if (pathname === '/api/upnp-callback') {
            log.info(`📡 [SONOS] AVTransport-event (${bytes} B, SEQ ${req.headers.seq ?? '?'})`);
            onAvtNotify(body, req.headers.seq ?? null);
          } else {
            log.debug(`📡 [SONOS] RenderingControl-event (${bytes} B)`);
            onRcNotify(body);
          }
        });
        return;
      }
      
      // GET /api/logs
      if (req.method === 'GET' && pathname === '/api/logs') {
        sendJson(res, { ok: true, logs: logBuffer });
        return;
      }
      
      sendJson(res, { error: 'Not Found' }, 404);
    } catch (error) {
      log.error(`API error on ${req.method} ${pathname}: ${error.message}`);
      log.error(`Stack: ${error.stack}`);
      sendJson(res, { ok: false, error: error.message, stack: error.stack, route: `${req.method} ${pathname}` }, 500);
    }
    return;
  }
  
  // No static file serving — engine is API-only
  sendJson(res, { error: 'Not Found', hint: 'Engine is API-only. UI is served separately.' }, 404);
});

// ============ Main ============

async function main() {
  log.info(`🔊 Sonos Buddy Engine v${VERSION} starting on port ${PORT}...`);
  log.info(`🔊 Configured: ${sonosConfig.sonosName || 'unnamed'} (UUID: ${sonosConfig.sonosUuid || 'none'}, IP: ${SONOS_IP})`);
  
  // Auto-scan to resolve saved room/UUID → current coordinator IP
  // (handles DHCP changes AND speaker swaps within a room)
  if (sonosConfig.sonosUuid || sonosConfig.sonosName) {
    log.info(`🔍 [SSDP] Auto-scanning to resolve "${sonosConfig.sonosName || '?'}" (UUID ${sonosConfig.sonosUuid || 'none'})...`);
    try {
      const { rooms, devices } = await discoverRooms(5000);
      const list = rooms.length ? rooms : devices;
      sonosConfig.knownDevices = list;

      // 1. Prefer match by room name (coordinator may have changed UUID e.g. replaced speaker)
      // 2. Fall back to UUID match against rooms (coordinator's UUID)
      // 3. Fall back to UUID match against any SSDP device
      let match = null;
      if (sonosConfig.sonosName) {
        match = rooms.find(r => r.name === sonosConfig.sonosName);
      }
      if (!match && sonosConfig.sonosUuid) {
        match = rooms.find(r => r.uuid === sonosConfig.sonosUuid)
             || devices.find(d => d.uuid === sonosConfig.sonosUuid);
      }

      if (match && match.ip) {
        if (match.ip !== SONOS_IP) {
          log.info(`🔄 [SSDP] Coordinator IP for "${match.name}": ${SONOS_IP} → ${match.ip}`);
          SONOS_IP = match.ip;
          sonosConfig.sonosIp = match.ip;
        } else {
          log.info(`✅ [SSDP] Coordinator confirmed at ${match.ip}`);
        }
        sonosConfig.sonosName = match.name || sonosConfig.sonosName;
        sonosConfig.sonosUuid = match.uuid || sonosConfig.sonosUuid;
      } else {
        log.warn(`⚠️ [SSDP] "${sonosConfig.sonosName || sonosConfig.sonosUuid}" not found on network, using saved IP ${SONOS_IP}`);
      }
      saveSonosConfig(sonosConfig);
    } catch (err) {
      log.warn(`⚠️ [SSDP] Auto-scan failed: ${err.message}, using saved IP ${SONOS_IP}`);
    }
  }
  
  server.on('error', (err) => log.error(`❌ HTTP server error: ${err.message}`));
  
  const networkIP = getNetworkIP();
  server.listen(PORT, '0.0.0.0', () => {
    log.info(`🚀 Engine running on:`);
    log.info(`   Local:   http://localhost:${PORT}`);
    log.info(`   Network: http://${networkIP}:${PORT}`);
    log.info(`   UI port: ${UI_PORT}`);
  });
  
  // Start Sonos UPnP event subscription
  log.info(`📡 [SONOS] Starting UPnP event subscription to ${SONOS_IP}...`);
  subscribeSonosEvents();
  startPositionBroadcast();
  startEventEngine();
  log.info(`📡 [SONOS] Position broadcast started`);

  // Spotify audio-features (client-credentials, optional)
  try { spotify.init(log); log.info(`🎧 [SPOTIFY] Module initialized (${spotify.getSpotifyStatus().configured ? 'configured' : 'not configured'})`); } catch (e) { log.warn(`[SPOTIFY] init failed: ${e.message}`); }

  // Periodic GC to keep RSS low on Pi Zero 2 W (512MB total RAM).
  // V8 holds onto old-space memory unless explicitly nudged; without this
  // RSS slowly creeps up from ~35MB to 90MB+ even though heapUsed is small.
  if (typeof global.gc === 'function') {
    setInterval(() => {
      try { global.gc(); } catch {}
    }, 60000).unref();
    log.info(`🧹 [GC] Periodic GC enabled (every 60s)`);
  } else {
    log.warn(`⚠️ [GC] --expose-gc not enabled, skipping periodic GC`);
  }
  
  // Graceful shutdown (SIGTERM for systemd, SIGINT for dev)
  function shutdown(signal) {
    log.info(`👋 Received ${signal}, shutting down gracefully...`);
    stopPositionBroadcast();
    // Close SSE connections
    sonosEventClients.forEach(client => { try { client.end(); } catch (e) {} });
    sonosEventClients = [];
    // Unsubscribe from Sonos events (båda tjänsterna)
    unsubscribeService('avt');
    unsubscribeService('rc');
    if (resyncTimer) clearTimeout(resyncTimer);
    if (sanityTimer) clearInterval(sanityTimer);
    server.close(() => {
      log.info('✅ Server closed');
      process.exit(0);
    });
    // Force exit after 5s if graceful shutdown stalls
    setTimeout(() => process.exit(0), 5000);
  }
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  
  process.on('uncaughtException', (err) => {
    log.error(`❌ Uncaught exception: ${err.message}`);
    log.error(err.stack || '');
  });
  
  process.on('unhandledRejection', (reason) => {
    log.error(`❌ Unhandled rejection: ${reason}`);
  });
}

main().catch((error) => {
  log.error('Fatal error:', error.message);
  process.exit(1);
});
