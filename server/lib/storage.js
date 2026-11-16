// Sahay Pay — storage helpers.
// (a) Uploads: local disk now (uploads/public, uploads/private). multer config
//     lives here: 5MB cap, images (jpg/png/webp) + PDF only, random filenames.
//     Production path: swap the disk destination for S3-compatible object
//     storage (OBJECT_STORAGE_* env vars, see .env.example) — the route code
//     only needs the stored path, so the swap is localised here.
// (b) Payout-account encryption: AES-256-GCM. Key from PAYOUT_ENCRYPTION_KEY
//     (base64 or hex of 32 bytes), else SHA-256 of SESSION_SECRET, else an
//     ephemeral key generated at startup with a LOUD warning (payout accounts
//     then become unreadable after restart — never run production that way).

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');

const ROOT = path.join(__dirname, '..', '..');
// Serverless (Vercel / Netlify Functions): the project filesystem is
// read-only at runtime; only /tmp is writable. Uploads there are ephemeral
// (lost between invocations) until object storage lands — same caveat as
// redeploys on other hosts.
const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME
);
const UPLOAD_BASE = IS_SERVERLESS
  ? path.join(os.tmpdir(), 'sahay-pay-uploads')
  : path.join(ROOT, 'uploads');
const PUBLIC_DIR = path.join(UPLOAD_BASE, 'public');
const PRIVATE_DIR = path.join(UPLOAD_BASE, 'private');
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

// ---- Payout encryption ----

function resolveKey() {
  const raw = process.env.PAYOUT_ENCRYPTION_KEY;
  if (raw) {
    let buf = null;
    try {
      const b64 = Buffer.from(raw, 'base64');
      if (b64.length === 32) buf = b64;
    } catch { /* fall through */ }
    if (!buf) {
      try {
        const hex = Buffer.from(raw, 'hex');
        if (hex.length === 32) buf = hex;
      } catch { /* fall through */ }
    }
    if (!buf) {
      throw new Error('PAYOUT_ENCRYPTION_KEY must be base64 or hex of exactly 32 bytes.');
    }
    return { key: buf, source: 'PAYOUT_ENCRYPTION_KEY' };
  }
  if (process.env.SESSION_SECRET) {
    return {
      key: crypto.createHash('sha256').update(`sahay-pay-payout:${process.env.SESSION_SECRET}`).digest(),
      source: 'SESSION_SECRET (derived)',
    };
  }
  console.error(
    '[SECURITY WARNING] No PAYOUT_ENCRYPTION_KEY or SESSION_SECRET set. ' +
      'Using an EPHEMERAL payout-encryption key: payout accounts stored now will be ' +
      'UNREADABLE after restart. Set PAYOUT_ENCRYPTION_KEY before any real use.'
  );
  return { key: crypto.randomBytes(32), source: 'ephemeral (UNSAFE for production)' };
}

const { key: PAYOUT_KEY, source: PAYOUT_KEY_SOURCE } = resolveKey();

// ---- Key-per-field encryption (Phase 2 item 833) ----
// Each payout field type (the payout method: esewa, upi, bank_np, …) gets
// its own AES-256-GCM key, derived from the master key with HMAC-SHA-256
// over a fixed label. A compromised field key therefore exposes only one
// field type, never the whole payout table. New ciphertexts carry a "v2:"
// prefix; legacy blobs (no prefix, master key directly) still decrypt,
// so existing rows keep working until they are re-encrypted (see the
// rotation runbook + scripts/reencrypt-payouts.js).
function fieldKey(fieldType) {
  return crypto.createHmac('sha256', PAYOUT_KEY).update(`sahay-pay-field:${fieldType || 'account'}`).digest();
}

function encryptAccount(plaintext, fieldType) {
  const key = fieldKey(fieldType);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

function decryptAccount(blob, fieldType) {
  const raw = String(blob || '');
  // Legacy rows (no prefix) were encrypted with the master key directly.
  const key = raw.startsWith('v2:') ? fieldKey(fieldType) : PAYOUT_KEY;
  const b64 = raw.startsWith('v2:') ? raw.slice(3) : raw;
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// Re-encrypt one stored blob under a NEW master key (rotation support —
// item 888). The caller supplies the new master key; the old key is the
// one this process resolved at startup.
function reencryptAccount(blob, fieldType, newMasterKey) {
  const plaintext = decryptAccount(blob, fieldType);
  const key = crypto.createHmac('sha256', newMasterKey).update(`sahay-pay-field:${fieldType || 'account'}`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

// ---- Uploads (multer) ----

const PUBLIC_KINDS = new Set(['public_bill', 'support', 'avatar', 'qr', 'cover', 'thanks_video']);
const PRIVATE_KINDS = new Set(['private_proof', 'id_doc']);
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);
// Video MIME types — only for the thanks_video kind (see fileFilter).
const VIDEO_MIME = new Set(['video/mp4', 'video/webm']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const kind = req.body?.kind || 'public_bill';
    cb(null, PRIVATE_KINDS.has(kind) ? PRIVATE_DIR : PUBLIC_DIR);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.mp4', '.webm'].includes(ext) ? ext : '.bin';
    cb(null, `${crypto.randomUUID()}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter(req, file, cb) {
    // Video is only ever accepted for video thank-yous (items 425/426);
    // every other kind takes images/PDF only.
    const kind = req.body?.kind || 'public_bill';
    if (VIDEO_MIME.has(file.mimetype)) {
      if (kind === 'thanks_video') return cb(null, true);
      return cb(new Error('Video files are only accepted for video thank-yous.'));
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Only images (jpg/png/webp) and PDF files are allowed.'));
    }
    cb(null, true);
  },
});

// ---- Magic-byte sniffing (checklist item 135) ----
// The multer fileFilter only sees the client-claimed MIME type, which is
// trivially faked. After the file lands on disk, sniff its real signature
// and require it to match the declared MIME type.
// Returns 'jpeg' | 'png' | 'webp' | 'pdf' | 'mp4' | 'webm' | null.
function sniffFileType(filePath) {
  let head;
  try {
    const fd = fs.openSync(filePath, 'r');
    head = Buffer.alloc(12);
    const n = fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
    head = head.subarray(0, n);
  } catch {
    return null;
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) return 'png';
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) return 'webp';
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  // MP4: 'ftyp' box at offset 4. WebM: EBML header 1A 45 DF A3.
  if (head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  return null;
}

const MIME_TO_TYPE = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

// True when the file's real signature matches its declared MIME type.
function fileMatchesMime(filePath, mime) {
  const expected = MIME_TO_TYPE[mime];
  if (!expected) return false;
  return sniffFileType(filePath) === expected;
}

// ---- EXIF / metadata stripping (Phase 2 item 864) ----
// Pure-JS, no native module (sharp is ruled out by P1 142): JPEG APP1
// (EXIF) / APP13 (Photoshop) / COM segments are dropped, PNG text chunks
// (tEXt/iTXt/zTXt) and the eXIf chunk are dropped, WebP EXIF chunks are
// dropped. Any parse failure leaves the file untouched (fail safe — the
// upload still succeeds, the metadata just stays).
// Returns { stripped: boolean, hadMetadata: boolean }.

function stripJpegMetadata(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out = [buf.subarray(0, 2)];
  let i = 2;
  let stripped = false;
  let hadMetadata = false;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null; // not a marker — give up, keep file
    const marker = buf[i + 1];
    if (marker === 0xda) { // SOS: the rest is compressed scan data, copy verbatim
      out.push(buf.subarray(i));
      return { buf: Buffer.concat(out), stripped, hadMetadata };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const segment = buf.subarray(i, i + 2 + len);
    const isApp1 = marker === 0xe1;
    const isApp13 = marker === 0xed;
    const isCom = marker === 0xfe;
    if (isApp1 || isApp13 || isCom) {
      hadMetadata = true;
      stripped = true;
      // dropped
    } else {
      out.push(segment);
    }
    i += 2 + len;
  }
  return null; // never found SOS — malformed; keep the file as-is
}

function stripPngMetadata(buf) {
  if (buf.length < 8 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  const out = [buf.subarray(0, 8)];
  let i = 8;
  let stripped = false;
  let hadMetadata = false;
  const DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const total = 12 + len;
    if (i + total > buf.length) return null;
    if (DROP.has(type)) {
      hadMetadata = true;
      stripped = true;
    } else {
      out.push(buf.subarray(i, i + total));
    }
    i += total;
    if (type === 'IEND') break;
  }
  return { buf: Buffer.concat(out), stripped, hadMetadata };
}

function stripWebpMetadata(buf) {
  if (buf.length < 12 || buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WEBP') {
    return null;
  }
  const out = [buf.subarray(0, 12)];
  let i = 12;
  let stripped = false;
  let hadMetadata = false;
  let bodyLen = 4; // 'WEBP'
  while (i + 8 <= buf.length) {
    const type = buf.subarray(i, i + 4).toString('latin1');
    const size = buf.readUInt32LE(i + 4);
    const total = 8 + size + (size % 2);
    if (i + total > buf.length) return null;
    if (type === 'EXIF') {
      hadMetadata = true;
      stripped = true;
    } else {
      out.push(buf.subarray(i, i + total));
      bodyLen += total;
    }
    i += total;
  }
  if (!stripped) return { buf, stripped: false, hadMetadata };
  const result = Buffer.concat(out);
  result.writeUInt32LE(bodyLen, 4); // fix the RIFF size field
  return { buf: result, stripped, hadMetadata };
}

function stripImageMetadata(filePath, mime) {
  try {
    const buf = fs.readFileSync(filePath);
    let result = null;
    if (mime === 'image/jpeg') result = stripJpegMetadata(buf);
    else if (mime === 'image/png') result = stripPngMetadata(buf);
    else if (mime === 'image/webp') result = stripWebpMetadata(buf);
    else return { stripped: false, hadMetadata: false }; // PDFs: left as-is
    if (!result) return { stripped: false, hadMetadata: false };
    if (result.stripped) fs.writeFileSync(filePath, result.buf);
    return { stripped: result.stripped, hadMetadata: result.hadMetadata };
  } catch {
    return { stripped: false, hadMetadata: false };
  }
}

// ---- Photo-origin heuristic (Phase 2 item 856) ----
// Flags photos whose metadata suggests a web download / editor export
// rather than a photo taken on a device: a "Software" tag naming an image
// editor or download tool. A flag routes the bill to closer review — it
// never blocks an upload. Best-effort text scan of the metadata segments.
function inspectPhotoOrigin(filePath, mime) {
  try {
    const buf = fs.readFileSync(filePath);
    const text = buf.subarray(0, Math.min(buf.length, 128 * 1024)).toString('latin1');
    const softwareMatch = text.match(/Software[\x00\s]*([A-Za-z0-9 .\-_/]+)/i);
    const software = softwareMatch ? softwareMatch[1].trim().slice(0, 80) : null;
    const hasExif = mime === 'image/jpeg' ? text.includes('Exif') : text.includes('eXIf');
    const EDITOR_RE = /(photoshop|gimp|canva|pixlr|picsart|snapseed|lightroom|paint\.net|photopea|remove\.bg|download|screenshot)/i;
    const webDownloadSuspected = Boolean(software && EDITOR_RE.test(software));
    return { hasExif, software, webDownloadSuspected };
  } catch {
    return { hasExif: false, software: null, webDownloadSuspected: false };
  }
}

function deleteStoredFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

// Delete a private file by its stored reference (/api/uploads/private/<file>).
// Used when a verification document is deleted after review (checklist
// item 255). The basename is re-derived so a crafted ref cannot escape
// PRIVATE_DIR. Returns true if a file was removed.
function deletePrivateFile(docUrl) {
  if (typeof docUrl !== 'string' || !docUrl.startsWith('/api/uploads/private/')) return false;
  const filename = path.basename(docUrl);
  if (!filename || filename.includes('/') || filename.includes('\\')) return false;
  return deleteStoredFile(path.join(PRIVATE_DIR, filename));
}

function isPrivateKind(kind) {
  return PRIVATE_KINDS.has(kind);
}

function isKnownKind(kind) {
  return PUBLIC_KINDS.has(kind) || PRIVATE_KINDS.has(kind);
}

// Public URL path for a stored public file (served by express.static).
function publicUrlFor(filename) {
  return `/uploads/public/${filename}`;
}

function privateRefFor(filename) {
  return `/api/uploads/private/${filename}`;
}

// Resolve a stored upload reference (/uploads/public/<file> or
// /api/uploads/private/<file>) to its on-disk path, or null when the ref
// is not a well-formed upload reference. Used for server-side hashing
// (items 324/338): the hash is computed from the stored file, never
// trusted from the client.
function pathForUploadRef(ref) {
  if (typeof ref !== 'string') return null;
  let dir = null;
  let file = null;
  if (ref.startsWith('/uploads/public/')) {
    dir = PUBLIC_DIR;
    file = ref.slice('/uploads/public/'.length);
  } else if (ref.startsWith('/api/uploads/private/')) {
    dir = PRIVATE_DIR;
    file = ref.slice('/api/uploads/private/'.length);
  } else {
    return null;
  }
  if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) return null;
  const full = path.join(dir, file);
  return fs.existsSync(full) ? full : null;
}

module.exports = {
  upload,
  isPrivateKind,
  isKnownKind,
  publicUrlFor,
  privateRefFor,
  pathForUploadRef,
  encryptAccount,
  decryptAccount,
  reencryptAccount,
  fieldKey,
  sniffFileType,
  fileMatchesMime,
  stripImageMetadata,
  inspectPhotoOrigin,
  deleteStoredFile,
  deletePrivateFile,
  payoutKeySource: PAYOUT_KEY_SOURCE,
  PUBLIC_DIR,
  PRIVATE_DIR,
  MAX_FILE_BYTES,
};
