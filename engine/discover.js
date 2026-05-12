// SSDP Discovery module for Sonos speakers
const dgram = require('dgram');
const http = require('http');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
// Sonos responds to several STs; ZonePlayer is the main one but ssdp:all catches more reliably
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:ZonePlayer:1',
  'urn:smartspeaker-audio:service:SpeakerGroup:1',
  'ssdp:all'
];

function buildMSearch(st, mx = 2) {
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${st}`,
    '', ''
  ].join('\r\n');
}

/**
 * Fetch device description XML with retry on failure
 */
function fetchDeviceDescription(ip, port = 1400, attempt = 1) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${ip}:${port}/xml/device_description.xml`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const extract = (tag) => {
          const m = data.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
          return m ? m[1].trim() : null;
        };
        const name = extract('roomName') || extract('friendlyName');
        if (!name && attempt < 2) {
          // Retry once if XML was incomplete
          setTimeout(() => fetchDeviceDescription(ip, port, attempt + 1).then(resolve, reject), 300);
          return;
        }
        resolve({
          ip,
          port,
          name: name || 'Unknown',
          model: extract('modelName') || 'Unknown',
          modelNumber: extract('modelNumber') || null,
          uuid: extract('UDN')?.replace('uuid:', '') || null,
          softwareVersion: extract('softwareVersion') || null
        });
      });
    });
    req.on('error', (err) => {
      if (attempt < 2) {
        setTimeout(() => fetchDeviceDescription(ip, port, attempt + 1).then(resolve, reject), 500);
      } else {
        reject(err);
      }
    });
    req.on('timeout', () => {
      req.destroy();
      if (attempt < 2) {
        setTimeout(() => fetchDeviceDescription(ip, port, attempt + 1).then(resolve, reject), 500);
      } else {
        reject(new Error('timeout'));
      }
    });
  });
}

/**
 * Discover Sonos speakers on the local network via SSDP M-SEARCH.
 * Sends multiple search bursts and waits for all device-description fetches
 * to complete before resolving, so names/UUIDs are populated reliably.
 */
function discoverSonos(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const found = new Map(); // ip -> port
    const fetchPromises = [];
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('message', (msg) => {
      const text = msg.toString();
      // Only consider Sonos devices (filter ssdp:all noise)
      if (!/sonos|ZonePlayer/i.test(text)) return;
      const locMatch = text.match(/LOCATION:\s*(http:\/\/([^:/]+):?(\d+)?[^\s]*)/i);
      if (!locMatch) return;
      const ip = locMatch[2];
      const port = locMatch[3] ? parseInt(locMatch[3], 10) : 1400;
      if (found.has(ip)) return;
      found.set(ip, port);

      fetchPromises.push(
        fetchDeviceDescription(ip, port).catch(() => ({
          ip, port, name: 'Unknown', model: 'Unknown', uuid: null
        }))
      );
    });

    socket.on('error', (err) => {
      console.error('SSDP socket error:', err.message);
    });

    socket.bind(() => {
      try { socket.addMembership(SSDP_ADDRESS); } catch (e) {}
      try { socket.setBroadcast(true); } catch (e) {}

      // Send multiple bursts across the listen window for reliability
      const sendBurst = () => {
        for (const st of SEARCH_TARGETS) {
          const buf = Buffer.from(buildMSearch(st));
          try { socket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDRESS); } catch (e) {}
        }
      };
      sendBurst();
      const burstInterval = setInterval(sendBurst, 1000);

      setTimeout(async () => {
        clearInterval(burstInterval);
        try { socket.close(); } catch (e) {}
        // Wait for all in-flight device descriptions to finish
        const results = await Promise.all(fetchPromises);
        // Filter out entries that still have no usable name AND no uuid (truly unreachable)
        const usable = results.filter(r => r.name !== 'Unknown' || r.uuid);
        resolve(usable);
      }, timeoutMs);
    });
  });
}

/**
 * Fetch ZoneGroupState from any speaker — every Sonos device knows the
 * full topology. Returns an array of rooms keyed by coordinator:
 *   [{ roomName, coordinatorUuid, coordinatorIp, members: [{uuid, ip, name}] }]
 */
function fetchZoneTopology(ip, port = 1400) {
  return new Promise((resolve, reject) => {
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetZoneGroupState xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1"></u:GetZoneGroupState></s:Body></s:Envelope>`;
    const req = http.request({
      hostname: ip, port, path: '/ZoneGroupTopology/Control', method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': '"urn:schemas-upnp-org:service:ZoneGroupTopology:1#GetZoneGroupState"',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 4000
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const stateMatch = data.match(/<ZoneGroupState>([\s\S]*?)<\/ZoneGroupState>/);
          if (!stateMatch) return resolve([]);
          const state = stateMatch[1]
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
          const groupRe = /<ZoneGroup\s+([^>]*)>([\s\S]*?)<\/ZoneGroup>/g;
          const rooms = [];
          let gm;
          while ((gm = groupRe.exec(state)) !== null) {
            const attrs = gm[1];
            const inner = gm[2];
            const coordAttr = attrs.match(/Coordinator="([^"]+)"/);
            if (!coordAttr) continue;
            const coordinatorUuid = coordAttr[1];
            const memberRe = /<ZoneGroupMember\s+([^/]*)\/?>/g;
            let mm;
            const members = [];
            let coordinator = null;
            while ((mm = memberRe.exec(inner)) !== null) {
              const a = mm[1];
              const uuid = (a.match(/UUID="([^"]+)"/) || [])[1];
              const name = (a.match(/ZoneName="([^"]+)"/) || [])[1];
              const loc = (a.match(/Location="([^"]+)"/) || [])[1];
              const invisible = /Invisible="1"/.test(a);
              const ipMatch = loc && loc.match(/^https?:\/\/([^:/]+)/);
              const memIp = ipMatch ? ipMatch[1] : null;
              const member = { uuid, name, ip: memIp, invisible };
              members.push(member);
              if (uuid === coordinatorUuid) coordinator = member;
            }
            if (!coordinator) continue;
            rooms.push({
              roomName: coordinator.name,
              coordinatorUuid,
              coordinatorIp: coordinator.ip,
              members
            });
          }
          resolve(rooms);
        } catch (e) { resolve([]); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('topology timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Full room discovery: SSDP scan, then fetch topology from any reachable
 * device. Returns one entry per ROOM (coordinator), filtering out
 * satellites/surrounds. Falls back to raw SSDP devices if topology fails.
 */
async function discoverRooms(timeoutMs = 5000) {
  const devices = await discoverSonos(timeoutMs);
  if (!devices.length) return { rooms: [], devices: [] };

  let rooms = [];
  for (const d of devices) {
    try {
      rooms = await fetchZoneTopology(d.ip);
      if (rooms.length) break;
    } catch {}
  }

  // Enrich rooms with model info from SSDP results
  const byUuid = new Map(devices.map(d => [d.uuid, d]));
  const enriched = rooms.map(r => {
    const dev = byUuid.get(r.coordinatorUuid);
    return {
      name: r.roomName,
      ip: r.coordinatorIp,
      uuid: r.coordinatorUuid,
      model: dev?.model || 'Sonos',
      memberCount: r.members.length,
      members: r.members
    };
  });

  return { rooms: enriched, devices };
}

module.exports = { discoverSonos, fetchDeviceDescription, fetchZoneTopology, discoverRooms };
