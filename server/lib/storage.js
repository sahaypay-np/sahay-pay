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
// Vercel serverless: the project filesystem is read-only at runtime; only
// /tmp is writable. Uploads there are ephemeral (lost between invocations)
// until object storage lands — same caveat as redeploys on other hosts.
const UPLOAD_BASE = process.env.VERCEL
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

function encryptAccount(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', PAYOUT_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptAccount(blob) {
  const buf = Buffer.from(String(blob), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', PAYOUT_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ---- Uploads (multer) ----

const PUBLIC_KINDS = new Set(['public_bill', 'support', 'avatar', 'qr']);
const PRIVATE_KINDS = new Set(['private_proof', 'id_doc']);
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const kind = req.body?.kind || 'public_bill';
    cb(null, PRIVATE_KINDS.has(kind) ? PRIVATE_DIR : PUBLIC_DIR);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'].includes(ext) ? ext : '.bin';
    cb(null, `${crypto.randomUUID()}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Only images (jpg/png/webp) and PDF files are allowed.'));
    }
    cb(null, true);
  },
});

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

module.exports = {
  upload,
  isPrivateKind,
  isKnownKind,
  publicUrlFor,
  privateRefFor,
  encryptAccount,
  decryptAccount,
  payoutKeySource: PAYOUT_KEY_SOURCE,
  PUBLIC_DIR,
  PRIVATE_DIR,
  MAX_FILE_BYTES,
};
