/**
 * Palette extraction module for LED lighting.
 * Downloads album art, scales to ~30x30, extracts 4 dominant colors
 * using median-cut quantization, optimized for LED output.
 */

const http = require('http');
const https = require('https');
const sharp = require('sharp');

// Memory: disable libvips internal pixel cache (~50MB) and limit threads.
// Critical on Pi Zero 2 W where every MB counts.
sharp.cache(false);
sharp.concurrency(1);
sharp.simd(true);

// LRU cache — small footprint suits constrained RAM
const CACHE_MAX = 8;
const paletteCache = new Map();

function cacheGet(key) {
  if (!paletteCache.has(key)) return undefined;
  const val = paletteCache.get(key);
  // Move to end (most recent)
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

// Download image with timeout
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
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
    req.on('error', reject);
  });
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
    // Average the bucket
    let rSum = 0, gSum = 0, bSum = 0;
    for (const [r, g, b] of pixels) { rSum += r; gSum += g; bSum += b; }
    const n = pixels.length;
    return [[Math.round(rSum / n), Math.round(gSum / n), Math.round(bSum / n)]];
  }

  // Find channel with greatest range
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
 * Extract 4 dominant LED-optimized colors from an image buffer.
 * @param {Buffer} imageBuffer - Raw image data
 * @returns {Promise<number[][]>} Array of 4 [r,g,b] arrays
 */
async function extractPaletteFromBuffer(imageBuffer) {
  // Scale down to ~30x30
  const { data, info } = await sharp(imageBuffer)
    .resize(30, 30, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Collect pixels
  const pixels = [];
  for (let i = 0; i < data.length; i += 3) {
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }

  // Pre-filter: keep saturated pixels regardless of darkness — we lift L later
  const filtered = pixels.filter(([r, g, b]) => {
    const [, s, l] = rgbToHsl(r, g, b);
    return s >= 0.22 && l >= 0.05 && l <= 0.95;
  });

  // Use filtered if enough pixels, otherwise relax filter, then fall back to all
  let source = filtered;
  if (source.length < 16) {
    source = pixels.filter(([r, g, b]) => {
      const [, s] = rgbToHsl(r, g, b);
      return s >= 0.10;
    });
  }
  if (source.length < 16) source = pixels;

  // Median-cut to get 16 colors so we have headroom to pick the most vibrant 4
  const rawColors = medianCut([...source], 4); // 2^4 = 16 buckets

  // LED-optimize: maximize saturation, LIFT lightness so LEDs glow bright.
  // Dark colors (deep red, navy, forest) are mapped to their light siblings
  // (bright red, sky blue, lime) by raising L while preserving hue.
  const optimized = rawColors
    .map(([r, g, b]) => {
      let [h, s, l] = rgbToHsl(r, g, b);
      // Skip near-grayscale only; we'll rescue dark colors by lifting L
      if (s < 0.18) return null;
      // Aggressively push saturation toward full
      s = Math.min(1, 0.45 + s * 0.75);
      // Lift lightness: dark inputs get pulled UP to LED-bright range.
      // Map any L in [0..1] to roughly [0.5..0.65] so output is always bright.
      l = 0.5 + l * 0.15;
      l = Math.max(0.5, Math.min(0.65, l));
      const rgb = hslToRgb(h, s, l);
      return { rgb, h, s, l };
    })
    .filter(Boolean);

  // Sort by vibrancy (saturation * mid-lightness weight) so best colors come first
  optimized.sort((a, b) => {
    const va = a.s * (1 - Math.abs(a.l - 0.5) * 1.2);
    const vb = b.s * (1 - Math.abs(b.l - 0.5) * 1.2);
    return vb - va;
  });

  // Deduplicate similar hues (keep distinct LED colors)
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

  // Fill if fewer than 4
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
 * Uses LRU cache. Builds full URL if URI starts with /.
 * @param {string} albumArtUri - Raw album art URI from Sonos
 * @param {string} sonosIp - Sonos speaker IP
 * @param {function} logger - Logging object with .warn(), .info()
 * @returns {Promise<number[][]>} Array of 4 [r,g,b] arrays, or [] on failure
 */
async function extractPalette(albumArtUri, sonosIp, logger) {
  if (!albumArtUri) return [];

  // Check cache
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
    const imageBuffer = await downloadImage(fullUrl, 3000);
    const palette = await extractPaletteFromBuffer(imageBuffer);
    cacheSet(albumArtUri, palette);
    logger.info(`🎨 [PALETTE] Extracted: ${JSON.stringify(palette)}`);
    return palette;
  } catch (err) {
    logger.warn(`🎨 [PALETTE] Extraction failed: ${err.message}`);
    return [];
  }
}

module.exports = { extractPalette };
