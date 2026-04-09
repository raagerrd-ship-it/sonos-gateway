require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { discoverSonos } = require('./discover');

// Version
const VERSION = '1.0.0';

// Git commit hash — resolved once at startup
const { execSync } = require('child_process');
let GIT_COMMIT = 'unknown';
let GIT_COMMIT_SHORT = 'unknown';
let GIT_BRANCH = 'unknown';
try {
  GIT_COMMIT = execSync('git rev-parse HEAD', { cwd: __dirname, timeout: 3000 }).toString().trim();
  GIT_COMMIT_SHORT = GIT_COMMIT.substring(0, 7);
  GIT_BRANCH = execSync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname, timeout: 3000 }).toString().trim();
} catch (e) {
  // Not a git repo or git not available
}

// Configuration
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '3002');

// Load persisted config or fall back to env
function loadSonosConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    sonosIp: process.env.SONOS_IP || '192.168.1.175',
    sonosName: null,
    sonosUuid: null,
    knownDevices: []
  };
}

function saveSonosConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return true;
  } catch (e) {
    log.error(`Config save failed: ${e.message}`);
    return false;
  }
}

let sonosConfig = loadSonosConfig();
let SONOS_IP = sonosConfig.sonosIp;

// ============ Logging ============

const LOG_BUFFER_SIZE = 50;
let logBuffer = [];

function addToLogBuffer(level, msg, args) {
  logBuffer.push({
    timestamp: new Date().toISOString(),
    level,
    message: msg,
    args: args.length > 0 ? args : undefined
  });
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

const log = {
  info: (msg, ...args) => { console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, ...args); addToLogBuffer('info', msg, args); },
  warn: (msg, ...args) => { console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, ...args); addToLogBuffer('warn', msg, args); },
  error: (msg, ...args) => { console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, ...args); addToLogBuffer('error', msg, args); },
  debug: (msg, ...args) => {
    if (process.env.DEBUG) console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`, ...args);
    addToLogBuffer('debug', msg, args);
  }
};

// ============ Sonos UPnP Helpers ============

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

  if (nextMeta) {
    let nextDidl = extractDidl(nextMeta);
    if (!nextDidl) nextDidl = extractDidl(decodeXmlEntities(nextMeta));
    if (nextDidl) {
      nextTrackName = nextDidl.title || null;
      nextArtistName = nextDidl.creator || null;
      if (nextDidl.albumArtURI) {
        rawNextAlbumArtUri = nextDidl.albumArtURI;
        nextAlbumArtUri = nextDidl.albumArtURI.startsWith('/')
          ? `/api/sonos${nextDidl.albumArtURI}`
          : `/api/sonos/art?url=${encodeURIComponent(nextDidl.albumArtURI)}`;
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
              rawNextAlbumArtUri = browseDidl.albumArtURI;
              nextAlbumArtUri = browseDidl.albumArtURI.startsWith('/')
                ? `/api/sonos${browseDidl.albumArtURI}`
                : `/api/sonos/art?url=${encodeURIComponent(browseDidl.albumArtURI)}`;
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
let sonosSubscriptionRenewTimer = null;
let lastSonosEvent = null;
let sonosIdleDebounceTimer = null;
let pendingSonosIdleEvent = null;
let pendingSonosIdleMeta = null;
let sonosTransitionRefreshTimer = null;
let cachedGroupId = null;
let cachedGroupName = null;
let cachedRawAlbumArtUri = null;
let cachedRawNextAlbumArtUri = null;
let sonosSubscribeRetries = 0;
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
    if (lastSonosEvent?.playbackState && lastSonosEvent.playbackState !== 'PLAYBACK_STATE_IDLE') {
      return lastSonosEvent.playbackState;
    }
    return 'PLAYBACK_STATE_PAUSED';
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

// Cloud push config — persisted in config.json, overridden by env vars on first boot
function loadCloudConfig() {
  const cfg = loadSonosConfig();
  return {
    enabled: cfg.cloudPushEnabled ?? (!!process.env.CLOUD_PUSH_URL),
    url: cfg.cloudPushUrl || process.env.CLOUD_PUSH_URL || '',
    secret: cfg.cloudPushSecret || process.env.CLOUD_PUSH_SECRET || '',
    intervalMs: cfg.cloudPushIntervalMs || parseInt(process.env.CLOUD_PUSH_INTERVAL_MS || '1000'),
  };
}

let cloudConfig = loadCloudConfig();
let lastCloudPush = 0;
let cloudPushPending = false;
let lastCloudPushData = null;

function cloudPush(eventData) {
  if (!cloudConfig.enabled || !cloudConfig.url || !cloudConfig.secret) return;

  // Build payload with raw album art URIs (not local proxy paths)
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
  };

  // Throttle: don't push more often than CLOUD_PUSH_INTERVAL_MS
  const now = Date.now();
  if (now - lastCloudPush < CLOUD_PUSH_INTERVAL_MS) {
    lastCloudPushData = payload;
    if (!cloudPushPending) {
      cloudPushPending = true;
      setTimeout(() => {
        cloudPushPending = false;
        if (lastCloudPushData) {
          const p = lastCloudPushData;
          lastCloudPushData = null;
          doCloudPush(p);
        }
      }, CLOUD_PUSH_INTERVAL_MS - (now - lastCloudPush));
    }
    return;
  }
  lastCloudPushData = null;
  doCloudPush(payload);
}

function doCloudPush(payload) {
  lastCloudPush = Date.now();
  const body = JSON.stringify(payload);
  const url = new URL(CLOUD_PUSH_URL);
  const isHttps = url.protocol === 'https:';
  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bridge-secret': CLOUD_PUSH_SECRET,
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 10000,
  };
  const lib = isHttps ? https : http;
  const req = lib.request(options, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        log.debug(`☁️ [CLOUD] Push OK (${res.statusCode}) ${data.substring(0, 100)}`);
      } else {
        log.warn(`☁️ [CLOUD] Push failed (${res.statusCode}): ${data.substring(0, 200)}`);
      }
    });
  });
  req.on('error', (err) => log.error(`☁️ [CLOUD] Push error: ${err.message}`));
  req.on('timeout', () => { req.destroy(); log.warn('☁️ [CLOUD] Push timeout'); });
  req.write(body);
  req.end();
}

if (CLOUD_PUSH_URL) {
  log.info(`☁️ [CLOUD] Push enabled → ${CLOUD_PUSH_URL}`);
} else {
  log.info(`☁️ [CLOUD] Push disabled (no CLOUD_PUSH_URL)`);
}

function emitSonosEvent(eventData) {
  lastSonosEvent = eventData;
  broadcastSSE(eventData);
  cloudPush(eventData);
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

function scheduleSonosTransitionRefresh(refreshCount) {
  if (refreshCount > SONOS_TRANSITION_MAX_REFRESHES) return;
  clearSonosTransitionRefresh();
  sonosTransitionRefreshTimer = setTimeout(() => {
    sonosTransitionRefreshTimer = null;
    handleSonosUPnPEvent({ source: 'transition-refresh', refreshCount });
  }, SONOS_TRANSITION_REFRESH_MS);
}

// Fetch zone group info
async function fetchZoneGroupInfo() {
  try {
    const body = `<u:GetZoneGroupState xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1"></u:GetZoneGroupState>`;
    const xml = await soapRequest(body, 'GetZoneGroupState', '/ZoneGroupTopology/Control', 'ZoneGroupTopology');
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

// Subscribe to Sonos AVTransport events
function subscribeSonosEvents() {
  const networkIP = getNetworkIP();
  const callbackUrl = `<http://${networkIP}:${PORT}/api/sonos/upnp-callback>`;
  
  const options = {
    hostname: SONOS_IP,
    port: 1400,
    path: '/MediaRenderer/AVTransport/Event',
    method: 'SUBSCRIBE',
    headers: {
      'CALLBACK': callbackUrl,
      'NT': 'upnp:event',
      'TIMEOUT': 'Second-300'
    },
    timeout: 5000
  };
  
  const req = http.request(options, (res) => {
    const sid = res.headers['sid'];
    if (sid) {
      sonosSubscriptionSID = sid;
      sonosSubscribeRetries = 0;
      log.info(`📡 [SONOS] Subscribed to AVTransport events, SID: ${sid}`);
      clearTimeout(sonosSubscriptionRenewTimer);
      sonosSubscriptionRenewTimer = setTimeout(() => renewSonosSubscription(), 240000);
      log.info(`📡 [SONOS] Fetching full state after (re)subscribe...`);
      handleSonosUPnPEvent({ source: 'resubscribe' });
    } else {
      log.warn('⚠️ [SONOS] Subscribe response missing SID');
    }
  });
  
  req.on('error', (err) => {
    log.error(`❌ [SONOS] Subscribe error: ${err.message}`);
    const retryMs = Math.min(5000 * Math.pow(2, Math.min(sonosSubscribeRetries++, 5)), 120000);
    log.info(`🔄 [SONOS] Retrying subscribe in ${Math.round(retryMs / 1000)}s...`);
    setTimeout(() => subscribeSonosEvents(), retryMs);
  });
  
  req.on('timeout', () => {
    req.destroy();
    log.error('❌ [SONOS] Subscribe timeout');
    const retryMs = Math.min(5000 * Math.pow(2, Math.min(sonosSubscribeRetries++, 5)), 120000);
    setTimeout(() => subscribeSonosEvents(), retryMs);
  });
  
  req.end();
}

function renewSonosSubscription() {
  if (!sonosSubscriptionSID) { subscribeSonosEvents(); return; }
  
  const options = {
    hostname: SONOS_IP,
    port: 1400,
    path: '/MediaRenderer/AVTransport/Event',
    method: 'SUBSCRIBE',
    headers: { 'SID': sonosSubscriptionSID, 'TIMEOUT': 'Second-300' },
    timeout: 5000
  };
  
  const req = http.request(options, (res) => {
    if (res.statusCode === 200) {
      log.info(`🔄 [SONOS] Subscription renewed`);
      clearTimeout(sonosSubscriptionRenewTimer);
      sonosSubscriptionRenewTimer = setTimeout(() => renewSonosSubscription(), 240000);
    } else {
      log.warn(`⚠️ [SONOS] Renewal failed (${res.statusCode}), re-subscribing...`);
      sonosSubscriptionSID = null;
      subscribeSonosEvents();
    }
  });
  
  req.on('error', () => { sonosSubscriptionSID = null; setTimeout(() => subscribeSonosEvents(), 5000); });
  req.on('timeout', () => { req.destroy(); sonosSubscriptionSID = null; setTimeout(() => subscribeSonosEvents(), 5000); });
  req.end();
}

// Full status fetch and broadcast
async function handleSonosUPnPEvent({ source = 'upnp-event', refreshCount = 0 } = {}) {
  try {
    const posBody = `<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo>`;
    const transBody = `<u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo>`;
    const mediaBody = `<u:GetMediaInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetMediaInfo>`;
    const volBody = `<u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume>`;
    const muteBody = `<u:GetMute xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetMute>`;
    const bassBody = `<u:GetBass xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID></u:GetBass>`;
    const trebleBody = `<u:GetTreble xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID></u:GetTreble>`;
    const loudnessBody = `<u:GetLoudness xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetLoudness>`;
    const crossfadeBody = `<u:GetCrossfadeMode xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetCrossfadeMode>`;
    
    const [posXml, transXml, mediaXml, volXml, muteXml, bassXml, trebleXml, loudnessXml, crossfadeXml] = await Promise.all([
      soapRequest(posBody, 'GetPositionInfo'),
      soapRequest(transBody, 'GetTransportInfo'),
      soapRequest(mediaBody, 'GetMediaInfo'),
      soapRequest(volBody, 'GetVolume', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null),
      soapRequest(muteBody, 'GetMute', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null),
      soapRequest(bassBody, 'GetBass', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null),
      soapRequest(trebleBody, 'GetTreble', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null),
      soapRequest(loudnessBody, 'GetLoudness', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null),
      soapRequest(crossfadeBody, 'GetCrossfadeMode').catch(() => null)
    ]);
    
    const parseIntTag = (xml, tag) => { if (!xml) return null; const v = extractTag(xml, tag); return v !== null ? parseInt(v, 10) : null; };
    const parseBoolTag = (xml, tag) => { if (!xml) return null; const v = extractTag(xml, tag); return v !== null ? v === '1' : null; };
    
    const volume = parseIntTag(volXml, 'CurrentVolume');
    const mute = parseBoolTag(muteXml, 'CurrentMute');
    const bass = parseIntTag(bassXml, 'CurrentBass');
    const treble = parseIntTag(trebleXml, 'CurrentTreble');
    const loudness = parseBoolTag(loudnessXml, 'CurrentLoudness');
    let crossfade = null;
    if (crossfadeXml) { const cfStr = extractTag(crossfadeXml, 'CrossfadeMode'); if (cfStr !== null) crossfade = cfStr === '1'; }
    
    const relTime = extractTag(posXml, 'RelTime');
    const trackDuration = extractTag(posXml, 'TrackDuration');
    const trackNumber = extractTag(posXml, 'Track');
    const trackURI = extractTag(posXml, 'TrackURI');
    const absTime = extractTag(posXml, 'AbsTime');
    const didl = extractDidl(posXml);
    const transportState = extractTag(transXml, 'CurrentTransportState');
    const currentTransportStatus = extractTag(transXml, 'CurrentTransportStatus');
    const currentSpeed = extractTag(transXml, 'CurrentSpeed');
    
    const playbackState = getSonosPlaybackState(transportState);
    let albumArtUri = null;
    if (didl && didl.albumArtURI) {
      albumArtUri = didl.albumArtURI.startsWith('/')
        ? `/api/sonos${didl.albumArtURI}`
        : `/api/sonos/art?url=${encodeURIComponent(didl.albumArtURI)}`;
    }
    
    const nrTracks = extractTag(mediaXml, 'NrTracks');
    const currentURI = extractTag(mediaXml, 'CurrentURI');
    const nextAVTransportURI = extractTag(mediaXml, 'NextAVTransportURI');
    const playMedium = extractTag(mediaXml, 'PlayMedium');
    const nextMeta = extractTag(mediaXml, 'NextAVTransportURIMetaData');
    const { nextTrackName, nextArtistName, nextAlbumArtUri, rawNextAlbumArtUri } = await resolveNextTrack(nextMeta, trackNumber, nrTracks);
    
    cachedRawAlbumArtUri = didl?.albumArtURI || cachedRawAlbumArtUri;
    cachedRawNextAlbumArtUri = rawNextAlbumArtUri || cachedRawNextAlbumArtUri;
    fetchZoneGroupInfo().catch(() => {});
    
    const mediaType = didl?.upnpClass?.includes('audioBroadcast') ? 'radio' : 'track';
    cachedMediaType = mediaType;
    cachedBass = bass;
    cachedTreble = treble;
    cachedLoudness = loudness;
    cachedCrossfade = crossfade;
    
    const eventData = {
      ok: true,
      source,
      playbackState,
      positionMillis: parseTime(relTime),
      durationMillis: parseTime(trackDuration),
      trackName: didl ? didl.title : null,
      artistName: didl ? didl.creator : null,
      albumName: didl ? didl.album : null,
      albumArtUri,
      nextTrackName,
      nextArtistName,
      nextAlbumArtUri,
      volume,
      mute,
      bass,
      treble,
      loudness,
      mediaType,
      trackNumber: trackNumber ? parseInt(trackNumber, 10) : null,
      trackURI,
      absTime,
      currentSpeed,
      currentTransportStatus,
      crossfade,
      nrTracks: nrTracks ? parseInt(nrTracks, 10) : null,
      currentURI,
      nextAVTransportURI,
      playMedium,
      streamContent: didl ? didl.streamContent : null,
      radioShowMd: didl ? didl.radioShowMd : null,
      originalTrackNumber: didl?.originalTrackNumber ? parseInt(didl.originalTrackNumber, 10) : null,
      protocolInfo: didl ? didl.protocolInfo : null,
      groupId: cachedGroupId,
      groupName: cachedGroupName,
      timestamp: Date.now()
    };

    if (transportState === 'PLAYING' || transportState === 'PAUSED_PLAYBACK') {
      cancelPendingSonosIdle(`received ${transportState}`);
      clearSonosTransitionRefresh();
      emitSonosEvent(eventData);
      return;
    }

    if (isSonosTransitionState(transportState) || isSonosIdleCandidateTransportState(transportState)) {
      const idleReason = classifySonosIdleReason(transportState, eventData);
      schedulePendingSonosIdle(eventData, { reason: idleReason, transportState });
      if (idleReason === 'transition' && refreshCount < SONOS_TRANSITION_MAX_REFRESHES) {
        scheduleSonosTransitionRefresh(refreshCount + 1);
      }
      return;
    }

    cancelPendingSonosIdle(`received ${transportState || 'UNKNOWN'}`);
    clearSonosTransitionRefresh();
    emitSonosEvent(eventData);
  } catch (err) {
    log.error(`❌ [SONOS] Event handler error: ${err.message}`);
  }
}

// Position broadcast (250ms)
let positionBroadcastTimer = null;
let cachedMediaType = 'track';
let cachedBass = null;
let cachedTreble = null;
let cachedLoudness = null;
let cachedCrossfade = null;

function startPositionBroadcast() {
  if (positionBroadcastTimer) return;
  positionBroadcastTimer = setInterval(async () => {
    if (sonosEventClients.length === 0) return;
    try {
      const posBody = `<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo>`;
      const volBody = `<u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume>`;
      const muteBody = `<u:GetMute xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetMute>`;
      const [posXml, volXml, muteXml] = await Promise.all([
        soapRequest(posBody, 'GetPositionInfo'),
        soapRequest(volBody, 'GetVolume', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null),
        soapRequest(muteBody, 'GetMute', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null)
      ]);
      let volume = null;
      if (volXml) { const v = extractTag(volXml, 'CurrentVolume'); if (v !== null) volume = parseInt(v, 10); }
      let mute = null;
      if (muteXml) { const v = extractTag(muteXml, 'CurrentMute'); if (v !== null) mute = v === '1'; }
      const relTime = extractTag(posXml, 'RelTime');
      const trackDuration = extractTag(posXml, 'TrackDuration');
      const tickData = {
        ok: true,
        source: 'position-tick',
        positionMillis: parseTime(relTime),
        durationMillis: parseTime(trackDuration),
        volume,
        mute,
        mediaType: cachedMediaType,
        bass: cachedBass,
        treble: cachedTreble,
        loudness: cachedLoudness,
        crossfade: cachedCrossfade,
        // Include last known track info for cloud push
        trackName: lastSonosEvent?.trackName || null,
        artistName: lastSonosEvent?.artistName || null,
        albumName: lastSonosEvent?.albumName || null,
        playbackState: lastSonosEvent?.playbackState || 'PLAYBACK_STATE_PLAYING',
        groupId: cachedGroupId,
        groupName: cachedGroupName,
      };
      broadcastSSE(tickData);
      cloudPush(tickData);
    } catch { /* ignore */ }
  }, process.env.POSITION_INTERVAL_MS ? parseInt(process.env.POSITION_INTERVAL_MS) : 1000);
}

function stopPositionBroadcast() {
  if (positionBroadcastTimer) { clearInterval(positionBroadcastTimer); positionBroadcastTimer = null; }
}

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sonosEventClients = sonosEventClients.filter(client => {
    try { client.write(msg); return true; } catch (e) { return false; }
  });
}

// Re-subscribe with new IP
function switchSonosIP(newIp, name, uuid) {
  log.info(`🔄 [SONOS] Switching from ${SONOS_IP} to ${newIp} (${name || 'unknown'})`);
  
  // Cancel current subscription
  if (sonosSubscriptionSID) {
    // Try to unsubscribe (best effort)
    try {
      const req = http.request({
        hostname: SONOS_IP, port: 1400,
        path: '/MediaRenderer/AVTransport/Event',
        method: 'UNSUBSCRIBE',
        headers: { 'SID': sonosSubscriptionSID },
        timeout: 2000
      });
      req.on('error', () => {});
      req.end();
    } catch (e) {}
    sonosSubscriptionSID = null;
  }
  
  clearTimeout(sonosSubscriptionRenewTimer);
  sonosSubscriptionRenewTimer = null;
  sonosSubscribeRetries = 0;
  lastSonosEvent = null;
  cachedGroupId = null;
  cachedGroupName = null;
  
  // Update
  SONOS_IP = newIp;
  sonosConfig = { ...sonosConfig, sonosIp: newIp, sonosName: name || null, sonosUuid: uuid || null };
  saveSonosConfig(sonosConfig);
  
  // Re-subscribe
  subscribeSonosEvents();
}

// ============ HTTP Server ============

const MAX_BODY_SIZE = 10 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.png', '.jpg', '.ico', '.svg']);
const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block'
};

function serveStatic(filePath, res) {
  const ext = path.extname(filePath);
  if (!ALLOWED_EXTENSIONS.has(ext)) { res.writeHead(403, SECURITY_HEADERS); res.end('Forbidden'); return; }
  const normalizedPath = path.normalize(filePath);
  if (!normalizedPath.startsWith(PUBLIC_DIR)) { res.writeHead(403, SECURITY_HEADERS); res.end('Forbidden'); return; }
  const contentType = MIME_TYPES[ext] || 'text/plain';
  fs.readFile(normalizedPath, (err, data) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); res.end('Not Found'); }
    else { res.writeHead(200, { 'Content-Type': contentType, ...SECURITY_HEADERS }); res.end(data); }
  });
}

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
  
  // API Routes
  if (pathname.startsWith('/api/')) {
    try {
      // GET /api/sonos/discover
      if (req.method === 'GET' && pathname === '/api/sonos/discover') {
        log.info('🔍 [SSDP] Starting network scan...');
        try {
          const devices = await discoverSonos(5000);
          log.info(`🔍 [SSDP] Found ${devices.length} Sonos device(s)`);
          // Persist discovered devices
          sonosConfig.knownDevices = devices;
          saveSonosConfig(sonosConfig);
          sendJson(res, { ok: true, devices, currentUuid: sonosConfig.sonosUuid, currentIp: SONOS_IP });
        } catch (err) {
          // Return cached devices on error
          sendJson(res, { ok: true, devices: sonosConfig.knownDevices || [], currentUuid: sonosConfig.sonosUuid, currentIp: SONOS_IP, cached: true });
        }
        return;
      }
      
      // GET /api/sonos/config
      if (req.method === 'GET' && pathname === '/api/sonos/config') {
        sendJson(res, { ok: true, ...sonosConfig, currentIp: SONOS_IP, knownDevices: sonosConfig.knownDevices || [] });
        return;
      }
      
      // PUT /api/sonos/config
      if (req.method === 'PUT' && pathname === '/api/sonos/config') {
        const body = await parseBody(req);
        if (!body.sonosIp) { sendJson(res, { ok: false, error: 'Missing sonosIp' }, 400); return; }
        switchSonosIP(body.sonosIp, body.sonosName || null, body.sonosUuid || null);
        sendJson(res, { ok: true, ...sonosConfig });
        return;
      }
      
      // GET /api/sonos/version
      if (req.method === 'GET' && pathname === '/api/sonos/version') {
        sendJson(res, {
          name: 'sonos-buddy',
          version: VERSION,
          commit: GIT_COMMIT,
          commitShort: GIT_COMMIT_SHORT,
          branch: GIT_BRANCH
        });
        return;
      }

      // POST /api/sonos/update — git pull + signal restart
      if (req.method === 'POST' && pathname === '/api/sonos/update') {
        const { execSync } = require('child_process');
        const repoDir = path.resolve(__dirname, '..');
        try {
          const pullResult = execSync('git pull', { cwd: repoDir, timeout: 15000, encoding: 'utf8' });
          const isUpToDate = pullResult.includes('Already up to date') || pullResult.includes('Already up-to-date');
          if (isUpToDate) {
            sendJson(res, { ok: true, updated: false, message: 'Redan uppdaterad' });
            return;
          }
          // Install deps if package.json changed
          try { execSync('npm install --production', { cwd: path.join(repoDir, 'bridge'), timeout: 30000, encoding: 'utf8' }); } catch (e) {}
          sendJson(res, { ok: true, updated: true, message: 'Uppdaterad! Startar om...', output: pullResult.trim() });
          // Restart after response is sent
          setTimeout(() => { process.exit(0); }, 500);
        } catch (e) {
          sendJson(res, { ok: false, error: e.message }, 500);
        }
        return;
      }
      
      // GET /api/sonos/status
      if (req.method === 'GET' && pathname === '/api/sonos/status') {
        try {
          const posBody = `<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo>`;
          const transBody = `<u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo>`;
          const mediaBody = `<u:GetMediaInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetMediaInfo>`;
          const volBody = `<u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume>`;
          const muteBody = `<u:GetMute xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetMute>`;
          const bassBody = `<u:GetBass xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID></u:GetBass>`;
          const trebleBody = `<u:GetTreble xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID></u:GetTreble>`;
          const loudnessBody = `<u:GetLoudness xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetLoudness>`;
          const crossfadeBody = `<u:GetCrossfadeMode xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetCrossfadeMode>`;
          
          const [posXml, transXml, mediaXml, volXml, muteXml, bassXml, trebleXml, loudnessXml, crossfadeXml] = await Promise.all([
            soapRequest(posBody, 'GetPositionInfo'),
            soapRequest(transBody, 'GetTransportInfo'),
            soapRequest(mediaBody, 'GetMediaInfo'),
            soapRequest(volBody, 'GetVolume', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null),
            soapRequest(muteBody, 'GetMute', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null),
            soapRequest(bassBody, 'GetBass', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null),
            soapRequest(trebleBody, 'GetTreble', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null),
            soapRequest(loudnessBody, 'GetLoudness', '/MediaRenderer/RenderingControl/Control', 'RenderingControl').catch(() => null),
            soapRequest(crossfadeBody, 'GetCrossfadeMode').catch(() => null)
          ]);
          
          const parseIntTag = (xml, tag) => { if (!xml) return null; const v = extractTag(xml, tag); return v !== null ? parseInt(v, 10) : null; };
          const parseBoolTag = (xml, tag) => { if (!xml) return null; const v = extractTag(xml, tag); return v !== null ? v === '1' : null; };
          
          const volume = parseIntTag(volXml, 'CurrentVolume');
          const mute = parseBoolTag(muteXml, 'CurrentMute');
          const bass = parseIntTag(bassXml, 'CurrentBass');
          const treble = parseIntTag(trebleXml, 'CurrentTreble');
          const loudness = parseBoolTag(loudnessXml, 'CurrentLoudness');
          let crossfade = null;
          if (crossfadeXml) { const cf = extractTag(crossfadeXml, 'CrossfadeMode'); if (cf !== null) crossfade = cf === '1'; }
          
          const relTime = extractTag(posXml, 'RelTime');
          const trackDuration = extractTag(posXml, 'TrackDuration');
          const trackNumber = extractTag(posXml, 'Track');
          const trackURI = extractTag(posXml, 'TrackURI');
          const absTime = extractTag(posXml, 'AbsTime');
          const didl = extractDidl(posXml);
          const transportState = extractTag(transXml, 'CurrentTransportState');
          const currentTransportStatus = extractTag(transXml, 'CurrentTransportStatus');
          const currentSpeed = extractTag(transXml, 'CurrentSpeed');
          let playbackState = 'PLAYBACK_STATE_IDLE';
          if (transportState === 'PLAYING') playbackState = 'PLAYBACK_STATE_PLAYING';
          else if (transportState === 'PAUSED_PLAYBACK') playbackState = 'PLAYBACK_STATE_PAUSED';
          else if (transportState === 'TRANSITIONING') playbackState = 'PLAYBACK_STATE_PLAYING';
          else if (transportState === 'STOPPED') playbackState = 'PLAYBACK_STATE_PAUSED';
          
          let albumArtUri = null;
          if (didl && didl.albumArtURI) {
            albumArtUri = didl.albumArtURI.startsWith('/')
              ? `/api/sonos${didl.albumArtURI}`
              : `/api/sonos/art?url=${encodeURIComponent(didl.albumArtURI)}`;
          }
          
          const nrTracks = extractTag(mediaXml, 'NrTracks');
          const currentURI = extractTag(mediaXml, 'CurrentURI');
          const nextAVTransportURI = extractTag(mediaXml, 'NextAVTransportURI');
          const playMedium = extractTag(mediaXml, 'PlayMedium');
          const nextMeta = extractTag(mediaXml, 'NextAVTransportURIMetaData');
          const { nextTrackName, nextArtistName, nextAlbumArtUri } = await resolveNextTrack(nextMeta, trackNumber, nrTracks);
          const mediaType = didl?.upnpClass?.includes('audioBroadcast') ? 'radio' : 'track';
          
          sendJson(res, {
            ok: true,
            source: 'local-upnp',
            playbackState,
            positionMillis: parseTime(relTime),
            durationMillis: parseTime(trackDuration),
            trackName: didl ? didl.title : null,
            artistName: didl ? didl.creator : null,
            albumName: didl ? didl.album : null,
            albumArtUri,
            nextTrackName,
            nextArtistName,
            nextAlbumArtUri,
            volume, mute, bass, treble, loudness,
            mediaType,
            trackNumber: trackNumber ? parseInt(trackNumber, 10) : null,
            trackURI, absTime, currentSpeed, currentTransportStatus, crossfade,
            nrTracks: nrTracks ? parseInt(nrTracks, 10) : null,
            currentURI, nextAVTransportURI, playMedium,
            streamContent: didl ? didl.streamContent : null,
            radioShowMd: didl ? didl.radioShowMd : null,
            originalTrackNumber: didl?.originalTrackNumber ? parseInt(didl.originalTrackNumber, 10) : null,
            protocolInfo: didl ? didl.protocolInfo : null
          });
        } catch (err) {
          log.error(`❌ Sonos status error: ${err.message}`);
          sendJson(res, { ok: false, error: err.message }, 502);
        }
        return;
      }
      
      // GET /api/sonos/getaa* – proxy album art from Sonos
      if (req.method === 'GET' && pathname.startsWith('/api/sonos/getaa')) {
        const sonosPath = pathname.replace('/api/sonos', '') + (url.search || '');
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
      
      // GET /api/sonos/art?url=...
      if (req.method === 'GET' && pathname === '/api/sonos/art') {
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
      
      // GET /api/sonos/events – SSE stream
      if (req.method === 'GET' && pathname === '/api/sonos/events') {
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
      
      // NOTIFY /api/sonos/upnp-callback
      if (req.method === 'NOTIFY' && pathname === '/api/sonos/upnp-callback') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          log.info(`📡 [SONOS] UPnP event received (${body.length} bytes)`);
          res.writeHead(200);
          res.end();
          handleSonosUPnPEvent();
        });
        return;
      }
      
      // GET /api/sonos/logs
      if (req.method === 'GET' && pathname === '/api/sonos/logs') {
        sendJson(res, { ok: true, logs: logBuffer });
        return;
      }
      
      
      sendJson(res, { error: 'Not Found' }, 404);
    } catch (error) {
      log.error('API error:', error.message);
      sendJson(res, { error: error.message }, 500);
    }
    return;
  }
  
  // Static file serving
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  serveStatic(filePath, res);
});

// ============ Main ============

async function main() {
  log.info(`🔊 Sonos Proxy v${VERSION} starting...`);
  log.info(`🔊 Configured: ${sonosConfig.sonosName || 'unnamed'} (UUID: ${sonosConfig.sonosUuid || 'none'}, IP: ${SONOS_IP})`);
  
  // Auto-scan to resolve UUID → current IP (handles DHCP changes)
  if (sonosConfig.sonosUuid) {
    log.info(`🔍 [SSDP] Auto-scanning to verify UUID ${sonosConfig.sonosUuid}...`);
    try {
      const devices = await discoverSonos(5000);
      sonosConfig.knownDevices = devices;
      saveSonosConfig(sonosConfig);
      const match = devices.find(d => d.uuid === sonosConfig.sonosUuid);
      if (match && match.ip !== SONOS_IP) {
        log.info(`🔄 [SSDP] IP changed: ${SONOS_IP} → ${match.ip} for "${match.name}"`);
        SONOS_IP = match.ip;
        sonosConfig.sonosIp = match.ip;
        sonosConfig.sonosName = match.name || sonosConfig.sonosName;
        saveSonosConfig(sonosConfig);
      } else if (match) {
        log.info(`✅ [SSDP] UUID confirmed at ${match.ip}`);
      } else {
        log.warn(`⚠️ [SSDP] UUID ${sonosConfig.sonosUuid} not found on network, using saved IP ${SONOS_IP}`);
      }
    } catch (err) {
      log.warn(`⚠️ [SSDP] Auto-scan failed: ${err.message}, using saved IP ${SONOS_IP}`);
    }
  }
  
  server.on('error', (err) => log.error(`❌ HTTP server error: ${err.message}`));
  
  const networkIP = getNetworkIP();
  server.listen(PORT, '0.0.0.0', () => {
    log.info(`🚀 Server running on:`);
    log.info(`   Local:   http://localhost:${PORT}`);
    log.info(`   Network: http://${networkIP}:${PORT}`);
  });
  
  // Start Sonos UPnP event subscription
  log.info(`📡 [SONOS] Starting UPnP event subscription to ${SONOS_IP}...`);
  subscribeSonosEvents();
  startPositionBroadcast();
  log.info(`📡 [SONOS] Position broadcast started (250ms interval)`);
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    log.info('👋 Shutting down...');
    stopPositionBroadcast();
    server.close();
    process.exit(0);
  });
  
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
