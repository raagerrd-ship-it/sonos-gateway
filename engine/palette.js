/**
 * Palette extraction module for LED lighting.
 * Downloads album art, scales to ~30x30, extracts 4 dominant colors
 * using median-cut quantization, optimized for LED output.
 */

const http = require('http');
const https = require('https');
const sharp = require('sharp');

// LRU cache (max 20 entries)
const CACHE_MAX = 20;
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

  // Pre-filter: remove very dark/light pixels before quantization
  const filtered = pixels.filter(([r, g, b]) => {
    const [, s, l] = rgbToHsl(r, g, b);
    return s >= 0.10 && l >= 0.08 && l <= 0.92;
  });

  // Use filtered if enough pixels, otherwise fall back to all
  const source = filtered.length >= 16 ? filtered : pixels;

  // Median-cut to get 8 colors, then pick best 4
  const rawColors = medianCut([...source], 3); // 2^3 = 8 buckets

  // LED-optimize: boost saturation, filter bad colors
  const optimized = rawColors
    .map(([r, g, b]) => {
      let [h, s, l] = rgbToHsl(r, g, b);
      // Filter: skip low-saturation or extreme lightness
      if (s < 0.15 || l < 0.08 || l > 0.92) return null;
      // Boost saturation for LED vibrancy
      s = Math.min(1, s * 1.3);
      // Clamp lightness to useful LED range
      l = Math.max(0.15, Math.min(0.85, l));
      return hslToRgb(h, s, l);
    })
    .filter(Boolean);

  // If we have fewer than 4, fill with what we have or fallback
  while (optimized.length < 4) {
    if (rawColors.length > optimized.length) {
      // Add unfiltered colors
      const [r, g, b] = rawColors[optimized.length];
      let [h, s, l] = rgbToHsl(r, g, b);
      s = Math.min(1, s * 1.3);
      l = Math.max(0.15, Math.min(0.85, l));
      optimized.push(hslToRgb(h, s, l));
    } else {
      optimized.push([128, 128, 128]); // neutral fallback
    }
  }

  return optimized.slice(0, 4);
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
