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

// ─── sRGB → Lab konvertering ──────────────────────────────────────────────
//
// Lab är designat så att Euclidean distance ≈ perceptuell färgskillnad.
// Det gör k-means-kluster perceptuellt sammanhängande, vilket median-cut
// och histogram-baserade approaches inte ger.

const SRGB_GAMMA_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  SRGB_GAMMA_LUT[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// D65 white point
const XYZ_REF_X = 0.95047, XYZ_REF_Y = 1.0, XYZ_REF_Z = 1.08883;
const LAB_EPSILON = 0.008856;
const LAB_KAPPA = 7.787;

function rgbToLab(r, g, b, out) {
  const lr = SRGB_GAMMA_LUT[r];
  const lg = SRGB_GAMMA_LUT[g];
  const lb = SRGB_GAMMA_LUT[b];

  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / XYZ_REF_X;
  const y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750) / XYZ_REF_Y;
  const z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) / XYZ_REF_Z;

  const fx = x > LAB_EPSILON ? Math.cbrt(x) : LAB_KAPPA * x + 16 / 116;
  const fy = y > LAB_EPSILON ? Math.cbrt(y) : LAB_KAPPA * y + 16 / 116;
  const fz = z > LAB_EPSILON ? Math.cbrt(z) : LAB_KAPPA * z + 16 / 116;

  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
}

function labToRgb(L, a, b, out) {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;

  const fx3 = fx * fx * fx;
  const fy3 = fy * fy * fy;
  const fz3 = fz * fz * fz;

  const x = (fx3 > LAB_EPSILON ? fx3 : (fx - 16 / 116) / LAB_KAPPA) * XYZ_REF_X;
  const y = (fy3 > LAB_EPSILON ? fy3 : (fy - 16 / 116) / LAB_KAPPA) * XYZ_REF_Y;
  const z = (fz3 > LAB_EPSILON ? fz3 : (fz - 16 / 116) / LAB_KAPPA) * XYZ_REF_Z;

  let lr = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
  let lg = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
  let lb = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

  const sR = lr <= 0.0031308 ? 12.92 * lr : 1.055 * Math.pow(lr, 1 / 2.4) - 0.055;
  const sG = lg <= 0.0031308 ? 12.92 * lg : 1.055 * Math.pow(lg, 1 / 2.4) - 0.055;
  const sB = lb <= 0.0031308 ? 12.92 * lb : 1.055 * Math.pow(lb, 1 / 2.4) - 0.055;

  out[0] = sR < 0 ? 0 : sR > 1 ? 255 : (sR * 255 + 0.5) | 0;
  out[1] = sG < 0 ? 0 : sG > 1 ? 255 : (sG * 255 + 0.5) | 0;
  out[2] = sB < 0 ? 0 : sB > 1 ? 255 : (sB * 255 + 0.5) | 0;
}

// ─── K-means clustering ────────────────────────────────────────────────────
//
// Standardiserad k-means med deterministisk k-means++-init.
// Pre-allokerade scratch-buffrar, noll allokering i hot path.

const K = 4;
const KMEANS_MAX_ITER = 15;
const KMEANS_CONVERGENCE = 0.5;

const LAB_PIXELS = new Float32Array(TARGET_PIXELS * 3);
const CENTROIDS = new Float32Array(K * 3);
const CENTROIDS_PREV = new Float32Array(K * 3);
const ASSIGNMENT = new Uint8Array(TARGET_PIXELS);
const CLUSTER_SUMS = new Float32Array(K * 3);
const CLUSTER_COUNTS = new Uint32Array(K);
const KMEANS_DISTS = new Float32Array(TARGET_PIXELS);
const LAB_SCRATCH = new Float32Array(3);
const RGB_SCRATCH = new Uint8Array(3);

function kmeansInit(numPixels) {
  CENTROIDS[0] = LAB_PIXELS[0];
  CENTROIDS[1] = LAB_PIXELS[1];
  CENTROIDS[2] = LAB_PIXELS[2];

  for (let p = 0; p < numPixels; p++) KMEANS_DISTS[p] = Infinity;

  for (let c = 1; c < K; c++) {
    for (let p = 0; p < numPixels; p++) {
      const pi = p * 3;
      const dL = LAB_PIXELS[pi]     - CENTROIDS[(c - 1) * 3];
      const da = LAB_PIXELS[pi + 1] - CENTROIDS[(c - 1) * 3 + 1];
      const db = LAB_PIXELS[pi + 2] - CENTROIDS[(c - 1) * 3 + 2];
      const d = dL * dL + da * da + db * db;
      if (d < KMEANS_DISTS[p]) KMEANS_DISTS[p] = d;
    }

    let maxDist = 0, maxIdx = 0;
    for (let p = 0; p < numPixels; p++) {
      if (KMEANS_DISTS[p] > maxDist) { maxDist = KMEANS_DISTS[p]; maxIdx = p; }
    }

    const ci = c * 3;
    const pi = maxIdx * 3;
    CENTROIDS[ci]     = LAB_PIXELS[pi];
    CENTROIDS[ci + 1] = LAB_PIXELS[pi + 1];
    CENTROIDS[ci + 2] = LAB_PIXELS[pi + 2];
  }
}

function kmeansIterate(numPixels) {
  for (let iter = 0; iter < KMEANS_MAX_ITER; iter++) {
    CENTROIDS_PREV.set(CENTROIDS);

    for (let p = 0; p < numPixels; p++) {
      const pi = p * 3;
      const pL = LAB_PIXELS[pi], pa = LAB_PIXELS[pi + 1], pb = LAB_PIXELS[pi + 2];
      let bestC = 0, bestD = Infinity;
      for (let c = 0; c < K; c++) {
        const ci = c * 3;
        const dL = pL - CENTROIDS[ci];
        const da = pa - CENTROIDS[ci + 1];
        const db = pb - CENTROIDS[ci + 2];
        const d = dL * dL + da * da + db * db;
        if (d < bestD) { bestD = d; bestC = c; }
      }
      ASSIGNMENT[p] = bestC;
    }

    CLUSTER_SUMS.fill(0);
    CLUSTER_COUNTS.fill(0);
    for (let p = 0; p < numPixels; p++) {
      const c = ASSIGNMENT[p];
      const pi = p * 3, ci = c * 3;
      CLUSTER_SUMS[ci]     += LAB_PIXELS[pi];
      CLUSTER_SUMS[ci + 1] += LAB_PIXELS[pi + 1];
      CLUSTER_SUMS[ci + 2] += LAB_PIXELS[pi + 2];
      CLUSTER_COUNTS[c]++;
    }
    for (let c = 0; c < K; c++) {
      const cnt = CLUSTER_COUNTS[c];
      if (cnt > 0) {
        const ci = c * 3;
        CENTROIDS[ci]     = CLUSTER_SUMS[ci]     / cnt;
        CENTROIDS[ci + 1] = CLUSTER_SUMS[ci + 1] / cnt;
        CENTROIDS[ci + 2] = CLUSTER_SUMS[ci + 2] / cnt;
      }
    }

    let maxShift = 0;
    for (let c = 0; c < K; c++) {
      const ci = c * 3;
      const dL = CENTROIDS[ci]     - CENTROIDS_PREV[ci];
      const da = CENTROIDS[ci + 1] - CENTROIDS_PREV[ci + 1];
      const db = CENTROIDS[ci + 2] - CENTROIDS_PREV[ci + 2];
      const shift = Math.sqrt(dL * dL + da * da + db * db);
      if (shift > maxShift) maxShift = shift;
    }
    if (maxShift < KMEANS_CONVERGENCE) break;
  }
}

// ─── LED-optimering i Lab-rymd ─────────────────────────────────────────────

const CHROMA_MIN = 8;
const L_TARGET_MIN = 50;
const L_TARGET_MAX = 65;
const CHROMA_BOOST = 1.4;

function ledOptimizeLab(L, a, b) {
  const chroma = Math.sqrt(a * a + b * b);
  if (chroma < CHROMA_MIN) return null;

  const newA = a * CHROMA_BOOST;
  const newB = b * CHROMA_BOOST;

  let newL = L;
  if (newL < L_TARGET_MIN) newL = L_TARGET_MIN;
  else if (newL > L_TARGET_MAX) newL = L_TARGET_MAX;

  labToRgb(newL, newA, newB, RGB_SCRATCH);
  return [RGB_SCRATCH[0], RGB_SCRATCH[1], RGB_SCRATCH[2]];
}

// ─── Huvudfunktion ─────────────────────────────────────────────────────────

function extractPaletteFromFlat(flat) {
  // 1. RGB → Lab för alla pixlar
  for (let k = 0, pi = 0; k < TARGET_PIXELS; k++, pi += 3) {
    rgbToLab(flat[pi], flat[pi + 1], flat[pi + 2], LAB_SCRATCH);
    LAB_PIXELS[pi]     = LAB_SCRATCH[0];
    LAB_PIXELS[pi + 1] = LAB_SCRATCH[1];
    LAB_PIXELS[pi + 2] = LAB_SCRATCH[2];
  }

  // 2. K-means
  kmeansInit(TARGET_PIXELS);
  kmeansIterate(TARGET_PIXELS);

  // 3. Bygg cluster-info med score = pixel-count × chroma-vikt.
  // Mättade färger viktas högre — matchar mänsklig perception av "dominant".
  const clusters = [];
  for (let c = 0; c < K; c++) {
    const ci = c * 3;
    const L = CENTROIDS[ci], a = CENTROIDS[ci + 1], b = CENTROIDS[ci + 2];
    const chroma = Math.sqrt(a * a + b * b);
    clusters.push({
      L, a, b,
      count: CLUSTER_COUNTS[c],
      chroma,
      score: CLUSTER_COUNTS[c] * (1 + chroma / 50),
    });
  }

  // 4. Sortera efter dominans
  clusters.sort((x, y) => y.score - x.score);

  // 5. LED-optimera + filtrera grå
  const result = [];
  for (let c = 0; c < clusters.length && result.length < 4; c++) {
    const cl = clusters[c];
    const optimized = ledOptimizeLab(cl.L, cl.a, cl.b);
    if (optimized) result.push(optimized);
  }

  // 6. Fallback för bilder med få mättade färger
  if (result.length < 4) {
    for (let c = 0; c < clusters.length && result.length < 4; c++) {
      const cl = clusters[c];
      labToRgb(cl.L, cl.a, cl.b, RGB_SCRATCH);
      const rgb = [RGB_SCRATCH[0], RGB_SCRATCH[1], RGB_SCRATCH[2]];
      let isDup = false;
      for (let r = 0; r < result.length; r++) {
        if (result[r][0] === rgb[0] && result[r][1] === rgb[1] && result[r][2] === rgb[2]) {
          isDup = true;
          break;
        }
      }
      if (!isDup) result.push(rgb);
    }
  }

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
