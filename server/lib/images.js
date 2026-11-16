// Sahay Pay — image hashing for duplicate detection (Phase 2 §4).
// (a) SHA-256 of the file bytes — exact-duplicate detection (items 324/325).
// (b) Average hash (aHash, 64-bit) — near-duplicate / similarity detection
//     (item 338). Computed for PNG images only: Node has no image decoder,
//     so PNG is decoded by hand (zlib inflate + unfilter, bit depth 8,
//     non-interlaced). JPEG/WebP return null — exact-hash matching still
//     applies to them. The aHash is cheap (one 8x8 downscale) and runs
//     synchronously at upload time, so serverless cost is negligible.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

// --- Minimal PNG decoder (bit depth 8, non-interlaced) ---
// Returns { width, height, gray: Buffer } (grayscale, one byte per pixel)
// or null when the PNG is unsupported (other bit depths, interlaced,
// truncated). Palette images are resolved through the PLTE chunk.

function parsePng(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  const idatParts = [];
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) return null;
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
  // Cap the decoded size: a 50MP image would allocate ~200MB raw.
  if (width * height > 16 * 1024 * 1024) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) return null;
  if (colorType === 3 && !palette) return null;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idatParts));
  } catch {
    return null;
  }
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) return null;
  // Unfilter (PNG filters 0–4).
  const out = Buffer.alloc(stride * height);
  let prevRow = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const row = Buffer.from(raw.subarray(rowStart, rowStart + stride));
    const bpp = channels;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prevRow[x];
      const c = x >= bpp ? prevRow[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 0xff;
      }
      row[x] = v;
    }
    row.copy(out, y * stride);
    prevRow = row;
  }
  // Convert to grayscale.
  const gray = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    if (colorType === 0) gray[i] = out[o];
    else if (colorType === 2 || colorType === 6) {
      gray[i] = Math.round(0.299 * out[o] + 0.587 * out[o + 1] + 0.114 * out[o + 2]);
    } else if (colorType === 4) gray[i] = out[o];
    else if (colorType === 3) {
      const pi = out[o] * 3;
      if (pi + 2 < palette.length) {
        gray[i] = Math.round(0.299 * palette[pi] + 0.587 * palette[pi + 1] + 0.114 * palette[pi + 2]);
      }
    }
  }
  return { width, height, gray };
}

// 64-bit average hash as 16 hex chars, or null for unsupported images.
function averageHash(filePath) {
  const img = parsePng(filePath);
  if (!img) return null;
  const { width, height, gray } = img;
  // Downscale to 8x8 by averaging each block.
  const small = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const x0 = Math.floor((x * width) / 8);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / 8));
      const y0 = Math.floor((y * height) / 8);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / 8));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          sum += gray[yy * width + xx];
          n++;
        }
      }
      small.push(n ? sum / n : 0);
    }
  }
  const avg = small.reduce((a, b) => a + b, 0) / 64;
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (small[i] >= avg) hash |= 1n << BigInt(63 - i);
  }
  return hash.toString(16).padStart(16, '0');
}

// Hamming distance between two 16-hex-char aHashes (0–64).
function hammingDistance(a, b) {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

// Near-duplicate threshold: ≤5 bits differ out of 64.
const AHASH_THRESHOLD = 5;

module.exports = { sha256File, averageHash, hammingDistance, AHASH_THRESHOLD };
