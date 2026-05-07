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

module.exports = { discoverSonos, fetchDeviceDescription };
