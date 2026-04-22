/**
 * Palette extraction module for LED lighting.
 * Pure-JS implementation (no sharp/libvips) — saves ~30-40MB RSS on Pi Zero 2 W.
 *
 * Decodes JPEG (jpeg-js) or PNG (pngjs), nearest-neighbor downsamples to 20x20,
 * then runs median-cut quantization. Sonos album art is almost always JPEG.
 */

const http = require('http');
const https = require('https');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

// LRU cache — small footprint suits constrained RAM
const CACHE_MAX = 8;
const paletteCache = new Map();

function cacheGet(key) {
  if (!paletteCache.has(key)) return undefined;
  const val = paletteCache.get(key);
  paletteCache.delete(key);
  paletteCache.set(key, val);
  return val;
}

function cacheSet(key, val) {
  if (paletteCache.has(key)) paletteCache.delete(key);
  paletteCache.set(key, val);
  if (paletteCache.size > CACHE_MAX) {
    const oldest = paletteCache.keys().next().value;
    paletteCache.delete(oldest);
  }
}

// Download image with timeout + size cap (prevent runaway memory if Sonos serves something huge)
const MAX_IMAGE_BYTES = 512 * 1024; // 512KB — album art is typically 30-150KB
function downloadImage(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > MAX_IMAGE_BYTES) {
          req.destroy();
          reject(new Error(`Image too large (>${MAX_IMAGE_BYTES} bytes)`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
    req.on('error', reject);
  });
}

// Detect format from magic bytes
function detectFormat(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  return null;
}

// Decode image to { data: Uint8Array RGBA, width, height }
function decodeImage(buf) {
  const fmt = detectFormat(buf);
  if (fmt === 'jpeg') {
    // useTArray=true returns Uint8Array (avoids extra Buffer alloc)
    // maxMemoryUsageInMB caps decoder workspace
    return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 32, formatAsRGBA: true });
  }
  if (fmt === 'png') {
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height };
  }
  throw new Error(`Unsupported image format (magic: ${buf.slice(0, 4).toString('hex')})`);
}

// Nearest-neighbor downsample to TARGET x TARGET, returning RGB pixel array
const TARGET = 20;
function downsampleToPixels(decoded) {
  const { data, width, height } = decoded;
  const pixels = [];
  for (let ty = 0; ty < TARGET; ty++) {
    const sy = Math.floor((ty + 0.5) * height / TARGET);
    for (let tx = 0; tx < TARGET; tx++) {
      const sx = Math.floor((tx + 0.5) * width / TARGET);
      const i = (sy * width + sx) * 4; // RGBA
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  return pixels;
}

// RGB to HSL
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

// HSL to RGB
function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255)
  ];
}

// Median-cut quantization
function medianCut(pixels, depth) {
  if (depth === 0 || pixels.length === 0) {
    if (pixels.length === 0) return [[0, 0, 0]];
    let rSum = 0, gSum = 0, bSum = 0;
    for (const [r, g, b] of pixels) { rSum += r; gSum += g; bSum += b; }
    const n = pixels.length;
    return [[Math.round(rSum / n), Math.round(gSum / n), Math.round(bSum / n)]];
  }

  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (const [r, g, b] of pixels) {
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
  }

  const rRange = rMax - rMin, gRange = gMax - gMin, bRange = bMax - bMin;
  let sortIdx;
  if (rRange >= gRange && rRange >= bRange) sortIdx = 0;
  else if (gRange >= rRange && gRange >= bRange) sortIdx = 1;
  else sortIdx = 2;

  pixels.sort((a, b) => a[sortIdx] - b[sortIdx]);
  const mid = Math.floor(pixels.length / 2);

  return [
    ...medianCut(pixels.slice(0, mid), depth - 1),
    ...medianCut(pixels.slice(mid), depth - 1)
  ];
}

/**
 * Extract 4 dominant LED-optimized colors from a decoded image.
 */
function extractPaletteFromPixels(pixels) {
  // Pre-filter: keep saturated pixels regardless of darkness — we lift L later
  const filtered = pixels.filter(([r, g, b]) => {
    const [, s, l] = rgbToHsl(r, g, b);
    return s >= 0.22 && l >= 0.05 && l <= 0.95;
  });

  let source = filtered;
  if (source.length < 16) {
    source = pixels.filter(([r, g, b]) => {
      const [, s] = rgbToHsl(r, g, b);
      return s >= 0.10;
    });
  }
  if (source.length < 16) source = pixels;

  const rawColors = medianCut([...source], 4); // 16 buckets

  const optimized = rawColors
    .map(([r, g, b]) => {
      let [h, s, l] = rgbToHsl(r, g, b);
      if (s < 0.18) return null;
      s = Math.min(1, 0.45 + s * 0.75);
      l = 0.5 + l * 0.15;
      l = Math.max(0.5, Math.min(0.65, l));
      const rgb = hslToRgb(h, s, l);
      return { rgb, h, s, l };
    })
    .filter(Boolean);

  optimized.sort((a, b) => {
    const va = a.s * (1 - Math.abs(a.l - 0.5) * 1.2);
    const vb = b.s * (1 - Math.abs(b.l - 0.5) * 1.2);
    return vb - va;
  });

  const distinct = [];
  for (const c of optimized) {
    const tooClose = distinct.some(d => {
      let dh = Math.abs(d.h - c.h);
      if (dh > 0.5) dh = 1 - dh;
      return dh < 0.05;
    });
    if (!tooClose) distinct.push(c);
    if (distinct.length >= 4) break;
  }

  const result = distinct.map(c => c.rgb);

  while (result.length < 4) {
    if (optimized.length > result.length) {
      result.push(optimized[result.length].rgb);
    } else {
      result.push([255, 80, 80]);
    }
  }

  return result.slice(0, 4);
}

/**
 * Extract palette for a given albumArtURI.
 */
async function extractPalette(albumArtUri, sonosIp, logger) {
  if (!albumArtUri) return [];

  const cached = cacheGet(albumArtUri);
  if (cached) {
    logger.info(`🎨 [PALETTE] Cache hit for ${albumArtUri.substring(0, 60)}`);
    return cached;
  }

  try {
    const fullUrl = albumArtUri.startsWith('/')
      ? `http://${sonosIp}:1400${albumArtUri}`
      : albumArtUri;

    logger.info(`🎨 [PALETTE] Extracting from ${fullUrl.substring(0, 80)}...`);
    let imageBuffer = await downloadImage(fullUrl, 3000);
    let decoded = decodeImage(imageBuffer);
    imageBuffer = null; // release encoded buffer ASAP
    const pixels = downsampleToPixels(decoded);
    decoded = null; // release full RGBA buffer ASAP
    const palette = extractPaletteFromPixels(pixels);
    cacheSet(albumArtUri, palette);
    logger.info(`🎨 [PALETTE] Extracted: ${JSON.stringify(palette)}`);
    return palette;
  } catch (err) {
    logger.warn(`🎨 [PALETTE] Extraction failed: ${err.message}`);
    return [];
  }
}

module.exports = { extractPalette };
