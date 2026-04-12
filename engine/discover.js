// SSDP Discovery module for Sonos speakers
const dgram = require('dgram');
const http = require('http');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SONOS_SEARCH_TARGET = 'urn:schemas-upnp-org:device:ZonePlayer:1';

const M_SEARCH = [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
  'MAN: "ssdp:discover"',
  'MX: 3',
  `ST: ${SONOS_SEARCH_TARGET}`,
  '', ''
].join('\r\n');

/**
 * Fetch device description XML from a Sonos speaker and parse name/model/uuid
 */
function fetchDeviceDescription(ip, port = 1400) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${ip}:${port}/xml/device_description.xml`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const extract = (tag) => {
          const m = data.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
          return m ? m[1].trim() : null;
        };
        resolve({
          ip,
          port,
          name: extract('roomName') || extract('friendlyName') || 'Unknown',
          model: extract('modelName') || 'Unknown',
          modelNumber: extract('modelNumber') || null,
          uuid: extract('UDN')?.replace('uuid:', '') || null,
          softwareVersion: extract('softwareVersion') || null
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Discover Sonos speakers on the local network via SSDP M-SEARCH
 * @param {number} timeoutMs - How long to wait for responses (default 5000ms)
 * @returns {Promise<Array>} Array of { ip, name, model, uuid, ... }
 */
function discoverSonos(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const found = new Map(); // ip -> true
    const results = [];
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const timer = setTimeout(() => {
      try { socket.close(); } catch (e) {}
    }, timeoutMs);

    socket.on('message', (msg) => {
      const text = msg.toString();
      // Extract LOCATION header
      const locMatch = text.match(/LOCATION:\s*(http:\/\/([^:/]+):?(\d+)?[^\s]*)/i);
      if (!locMatch) return;
      const ip = locMatch[2];
      const port = locMatch[3] ? parseInt(locMatch[3], 10) : 1400;
      if (found.has(ip)) return;
      found.set(ip, true);

      // Fetch device description in background
      fetchDeviceDescription(ip, port)
        .then(info => results.push(info))
        .catch(() => results.push({ ip, port, name: 'Unknown', model: 'Unknown', uuid: null }));
    });

    socket.on('close', () => {
      clearTimeout(timer);
      // Give a small delay for pending device description fetches
      setTimeout(() => resolve(results), 500);
    });

    socket.on('error', (err) => {
      console.error('SSDP socket error:', err.message);
      clearTimeout(timer);
      try { socket.close(); } catch (e) {}
      resolve(results);
    });

    socket.bind(() => {
      socket.addMembership(SSDP_ADDRESS);
      const buf = Buffer.from(M_SEARCH);
      // Send M-SEARCH twice for reliability
      socket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDRESS);
      setTimeout(() => {
        try { socket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDRESS); } catch (e) {}
      }, 500);
    });
  });
}

module.exports = { discoverSonos, fetchDeviceDescription };
