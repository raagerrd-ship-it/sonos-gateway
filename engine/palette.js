/**
 * Palette extraction module for LED lighting.
 * Pure-JS implementation (no sharp/libvips) — saves ~30-40MB RSS on Pi Zero 2 W.
 *
 * Optimized for low CPU and heap pressure:
 *  - JPEG decoded as RGB (not RGBA) — 25% smaller pixel buffer
 *  - Downsample directly into flat Uint8Array (no per-pixel sub-arrays)
 *  - Median-cut operates on Uint32Array of byte-indices (in-place sort, no slicing)
 *  - HSL conversion uses shared scratch buffer in hot loops
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

// Download image with timeout + size cap
const MAX_IMAGE_BYTES = 512 * 1024;
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

function detectFormat(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  return null;
}

// Decode → { data, width, height, channels }. JPEG=3ch (RGB), PNG=4ch (RGBA).
function decodeImage(buf) {
  const fmt = detectFormat(buf);
  if (fmt === 'jpeg') {
    const decoded = jpeg.decode(buf, {
      useTArray: true,
      maxMemoryUsageInMB: 32,
      formatAsRGBA: false, // RGB only — 25% smaller buffer
    });
    return { data: decoded.data, width: decoded.width, height: decoded.height, channels: 3 };
  }
  if (fmt === 'png') {
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height, channels: 4 };
  }
  throw new Error(`Unsupported image format (magic: ${buf.slice(0, 4).toString('hex')})`);
}

// HSL conversion — writes into shared scratch (no allocation in hot loops)
function rgbToHslInto(r, g, b, out) {
  r /= 255; g /= 255; b /= 255;
  const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const l = (max + min) / 2;
  if (max === min) { out[0] = 0; out[1] = 0; out[2] = l; return; }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  out[0] = h; out[1] = s; out[2] = l;
}

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

// Nearest-neighbor downsample directly into a flat Uint8Array (3 bytes/pixel).
// Skips the [[r,g,b],...] intermediate array entirely.
const TARGET = 20;
const TARGET_PIXELS = TARGET * TARGET;
function downsampleFlat(decoded) {
  const { data, width, height, channels } = decoded;
  const out = new Uint8Array(TARGET_PIXELS * 3);
  let oi = 0;
  for (let ty = 0; ty < TARGET; ty++) {
    const sy = ((ty * 2 + 1) * height / (TARGET * 2)) | 0;
    const rowBase = sy * width * channels;
    for (let tx = 0; tx < TARGET; tx++) {
      const sx = ((tx * 2 + 1) * width / (TARGET * 2)) | 0;
      const i = rowBase + sx * channels;
      out[oi++] = data[i];
      out[oi++] = data[i + 1];
      out[oi++] = data[i + 2];
    }
  }
  return out;
}

// Median-cut on byte-indices into `flat` (each value is a multiple of 3).
// `indices` is a Uint32Array; we sort and slice with subarray (no copy).
function medianCutIdx(flat, indices, depth, results) {
  if (depth === 0 || indices.length === 0) {
    if (indices.length === 0) return;
    let rSum = 0, gSum = 0, bSum = 0;
    const n = indices.length;
    for (let k = 0; k < n; k++) {
      const i = indices[k];
      rSum += flat[i]; gSum += flat[i + 1]; bSum += flat[i + 2];
    }
    results.push([Math.round(rSum / n), Math.round(gSum / n), Math.round(bSum / n)]);
    return;
  }

  // Range scan
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  const n = indices.length;
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    const r = flat[i], g = flat[i + 1], b = flat[i + 2];
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
  }

  const rRange = rMax - rMin, gRange = gMax - gMin, bRange = bMax - bMin;
  let off;
  if (rRange >= gRange && rRange >= bRange) off = 0;
  else if (gRange >= bRange) off = 1;
  else off = 2;

  // In-place sort by chosen channel (typed-array sort — avoids closure allocations
  // in V8 hot path; comparator still needed since we sort indices, not values)
  indices.sort((a, b) => flat[a + off] - flat[b + off]);
  const mid = n >> 1;
  // subarray() = view, zero-copy
  medianCutIdx(flat, indices.subarray(0, mid), depth - 1, results);
  medianCutIdx(flat, indices.subarray(mid), depth - 1, results);
}

// LED-optimize one [r,g,b] → { rgb, h, s, l } (or null if too gray)
const HSL_SCRATCH = new Float32Array(3);
function ledOptimize(rgb) {
  rgbToHslInto(rgb[0], rgb[1], rgb[2], HSL_SCRATCH);
  let h = HSL_SCRATCH[0], s = HSL_SCRATCH[1], l = HSL_SCRATCH[2];
  if (s < 0.18) return null;
  s = Math.min(1, 0.45 + s * 0.75);
  l = 0.5 + l * 0.15;
  l = Math.max(0.5, Math.min(0.65, l));
  return { rgb: hslToRgb(h, s, l), h, s, l };
}

/**
 * Extract 4 dominant LED-optimized colors from the flat pixel buffer.
 */
function extractPaletteFromFlat(flat) {
  // Build filtered index array (Uint32Array — pre-sized, no growth alloc).
  // Pass 1: strict filter (saturated, mid-light pixels).
  const allIndices = new Uint32Array(TARGET_PIXELS);
  for (let i = 0; i < TARGET_PIXELS; i++) allIndices[i] = i * 3;

  let source;
  // Pass 1: s>=0.22, 0.05<=l<=0.95
  const strict = new Uint32Array(TARGET_PIXELS);
  let sn = 0;
  for (let k = 0; k < TARGET_PIXELS; k++) {
    const i = allIndices[k];
    rgbToHslInto(flat[i], flat[i + 1], flat[i + 2], HSL_SCRATCH);
    const s = HSL_SCRATCH[1], l = HSL_SCRATCH[2];
    if (s >= 0.22 && l >= 0.05 && l <= 0.95) strict[sn++] = i;
  }

  if (sn >= 16) {
    source = strict.subarray(0, sn);
  } else {
    // Pass 2: relax to s>=0.10
    const relaxed = new Uint32Array(TARGET_PIXELS);
    let rn = 0;
    for (let k = 0; k < TARGET_PIXELS; k++) {
      const i = allIndices[k];
      rgbToHslInto(flat[i], flat[i + 1], flat[i + 2], HSL_SCRATCH);
      if (HSL_SCRATCH[1] >= 0.10) relaxed[rn++] = i;
    }
    source = rn >= 16 ? relaxed.subarray(0, rn) : allIndices;
  }

  // Median-cut → up to 16 buckets. Copy needed because subarray sorts mutate parent.
  const workIndices = new Uint32Array(source);
  const rawColors = [];
  medianCutIdx(flat, workIndices, 4, rawColors);

  // LED optimize + sort by vibrancy
  const optimized = [];
  for (let k = 0; k < rawColors.length; k++) {
    const o = ledOptimize(rawColors[k]);
    if (o) optimized.push(o);
  }
  optimized.sort((a, b) => {
    const va = a.s * (1 - Math.abs(a.l - 0.5) * 1.2);
    const vb = b.s * (1 - Math.abs(b.l - 0.5) * 1.2);
    return vb - va;
  });

  // Deduplicate similar hues
  const distinct = [];
  for (let k = 0; k < optimized.length && distinct.length < 4; k++) {
    const c = optimized[k];
    let tooClose = false;
    for (let m = 0; m < distinct.length; m++) {
      let dh = Math.abs(distinct[m].h - c.h);
      if (dh > 0.5) dh = 1 - dh;
      if (dh < 0.05) { tooClose = true; break; }
    }
    if (!tooClose) distinct.push(c);
  }

  const result = distinct.map(c => c.rgb);
  while (result.length < 4) {
    if (optimized.length > result.length) result.push(optimized[result.length].rgb);
    else result.push([255, 80, 80]);
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
    const flat = downsampleFlat(decoded);
    decoded = null;     // release full RGB(A) buffer ASAP (~30-180KB freed)
    const palette = extractPaletteFromFlat(flat);
    cacheSet(albumArtUri, palette);
    logger.info(`🎨 [PALETTE] Extracted: ${JSON.stringify(palette)}`);
    return palette;
  } catch (err) {
    logger.warn(`🎨 [PALETTE] Extraction failed: ${err.message}`);
    return [];
  }
}

module.exports = { extractPalette };
