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

// LED-optimize one [r,g,b] → { rgb, h, s, l, count } (or null if too gray)
const HSL_SCRATCH = new Float32Array(3);
function ledOptimize(rgb, count) {
  rgbToHslInto(rgb[0], rgb[1], rgb[2], HSL_SCRATCH);
  let h = HSL_SCRATCH[0], s = HSL_SCRATCH[1], l = HSL_SCRATCH[2];
  if (s < 0.18) return null;
  s = Math.min(1, 0.45 + s * 0.75);
  l = 0.5 + l * 0.15;
  l = Math.max(0.5, Math.min(0.65, l));
  return { rgb: hslToRgb(h, s, l), h, s, l, count };
}

// Histogram-bucketing av hue (12 bucketar à 30°). Deterministiskt och
// matchar mänsklig perception bättre än median-cut för "dominant färg".
//
// Algoritm:
//   1. För varje pixel: konvertera RGB→HSL, skippa grå/svart/vitt
//   2. Lägg pixeln i hue-bucket (0-11), vikta med saturation så att
//      mättade färger dominerar över bleka
//   3. Sortera bucketar efter vikt → största bucket = mest dominant hue
//   4. För varje topp-bucket: ta medianpixeln som representant
//   5. LED-optimera (saturation/luminans-justering för LED-output)
//
// Pi Zero 2 W: ~3-5ms per 400-pixels bild (TARGET=20).
const HUE_BUCKETS = 12;
const HUE_DELTA_MIN = 1;          // Min antal bucketar mellan distinkta färger (12 = 30° hue)
const SAT_MIN = 0.15;             // Skippa pixlar under denna saturation (för grå)
const L_MIN = 0.08, L_MAX = 0.92; // Skippa nästan-svart och nästan-vitt

// Återanvändbar pre-allokerad scratch — undviker GC-tryck i hot path.
// Pi Zero 2 W har bara 512 MB RAM och PCC budgeterar tjänster strikt.
const BUCKET_WEIGHTS = new Float32Array(HUE_BUCKETS);
const BUCKET_COUNTS = new Uint16Array(HUE_BUCKETS);
// För varje bucket: lista över pixel-byte-offsets i `flat`. Pre-allokerad
// till TARGET_PIXELS per bucket worst-case (om alla pixlar hamnar i samma).
// 12 × 400 × 2 bytes = 9.6 KB total — försumbart.
const BUCKET_INDICES = Array.from({ length: HUE_BUCKETS }, () => new Uint16Array(TARGET_PIXELS));

/**
 * Extract dominant LED-optimized colors via hue histogram bucketing.
 * Returnerar alltid 4 färger (med fallback om bilden är monokrom).
 */
function extractPaletteFromFlat(flat) {
  // Reset scratch buffers
  BUCKET_WEIGHTS.fill(0);
  BUCKET_COUNTS.fill(0);

  // ── Sweep 1: bucketa pixlar per hue ──
  for (let k = 0, i = 0; k < TARGET_PIXELS; k++, i += 3) {
    rgbToHslInto(flat[i], flat[i + 1], flat[i + 2], HSL_SCRATCH);
    const h = HSL_SCRATCH[0], s = HSL_SCRATCH[1], l = HSL_SCRATCH[2];

    // Filter: skippa grått, svart, vitt
    if (s < SAT_MIN || l < L_MIN || l > L_MAX) continue;

    // Hue 0..1 → bucket 0..11. Math.min skyddar mot h===1.0 edge case.
    let bucket = (h * HUE_BUCKETS) | 0;
    if (bucket >= HUE_BUCKETS) bucket = HUE_BUCKETS - 1;

    // Vikta med saturation: mättnadsröd > blekrosa även om count är samma
    BUCKET_WEIGHTS[bucket] += s;
    const cnt = BUCKET_COUNTS[bucket];
    if (cnt < TARGET_PIXELS) {
      BUCKET_INDICES[bucket][cnt] = i;
      BUCKET_COUNTS[bucket] = cnt + 1;
    }
  }

  // ── Rangordna bucketar efter total vikt ──
  // Bara 12 bucketar — insertion sort räcker, ingen anledning till .sort()-overhead.
  const ranking = [];
  for (let b = 0; b < HUE_BUCKETS; b++) {
    if (BUCKET_WEIGHTS[b] > 0) ranking.push(b);
  }
  ranking.sort((a, b) => BUCKET_WEIGHTS[b] - BUCKET_WEIGHTS[a]);

  // ── Plocka representativ färg per topp-bucket ──
  const result = [];
  const usedBuckets = [];

  for (let r = 0; r < ranking.length && result.length < 4; r++) {
    const bucket = ranking[r];

    // Skippa bucketar för nära redan vald (i hue-cirkel-avstånd)
    let tooClose = false;
    for (let u = 0; u < usedBuckets.length; u++) {
      let delta = Math.abs(usedBuckets[u] - bucket);
      if (delta > HUE_BUCKETS / 2) delta = HUE_BUCKETS - delta;
      if (delta < HUE_DELTA_MIN) { tooClose = true; break; }
    }
    if (tooClose) continue;

    // Median-pixel som representant: sortera bucket-pixlarna efter
    // RGB-summa (luminans-proxy) och ta mitten. Det undviker outliers.
    const count = BUCKET_COUNTS[bucket];
    const indices = BUCKET_INDICES[bucket];
    // Bygg en liten array med (rgbSum, byteOffset)-par. count är typiskt
    // 5-100 så sort-overhead är försumbar (vi gör detta max 4 ggr per bild).
    const sums = new Array(count);
    for (let k = 0; k < count; k++) {
      const i = indices[k];
      sums[k] = { i, sum: flat[i] + flat[i + 1] + flat[i + 2] };
    }
    sums.sort((a, b) => a.sum - b.sum);
    const midI = sums[count >> 1].i;
    const rgb = [flat[midI], flat[midI + 1], flat[midI + 2]];

    const optimized = ledOptimize(rgb, BUCKET_WEIGHTS[bucket]);
    if (optimized) {
      result.push(optimized.rgb);
      usedBuckets.push(bucket);
    }
  }

  // ── Fallback om vi har <4 färger ──
  // Händer för t.ex. svartvita foton, monokroma omslag, eller bilder med
  // bara en stark hue. Komplettera med relaxerade krav innan vi ger upp.
  if (result.length < 4) {
    for (let r = 0; r < ranking.length && result.length < 4; r++) {
      const bucket = ranking[r];
      if (usedBuckets.indexOf(bucket) !== -1) continue;

      const count = BUCKET_COUNTS[bucket];
      const indices = BUCKET_INDICES[bucket];
      const midI = indices[count >> 1];
      // Hoppa över ledOptimize-filtret (s<0.18) — vi behöver fylla på.
      result.push([flat[midI], flat[midI + 1], flat[midI + 2]]);
      usedBuckets.push(bucket);
    }
  }

  // Sista fallback: om bilden är helt grå
  while (result.length < 4) result.push([255, 80, 80]);

  return result;
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
