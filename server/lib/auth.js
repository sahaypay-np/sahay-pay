// Sahay Pay — user sessions, admin PIN, rate limiting.
// Sessions: opaque random tokens, SHA-256 hash stored server-side, delivered
// in an httpOnly cookie (sp_session, 30 days, sliding renewal).
// Admin PIN: scrypt hash in settings. FAIL-CLOSED when unset: no PIN is
// accepted until the owner sets one via the one-time setup flow. Admin session
// cookie sp_admin lasts 24h.
// Rate limiting: simple in-memory buckets (per IP + route key).

'use strict';

const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('./audit');

const SESSION_DAYS = 30;
const ADMIN_SESSION_HOURS = 24;
const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000; // renew when < 7 days left

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function isProd() {
  return process.env.NODE_ENV === 'production';
}

function sessionCookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isProd(),
    maxAge: maxAgeMs,
  };
}

async function createSession(userId) {
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.run(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashToken(token), userId, now.toISOString(), expires.toISOString(), now.toISOString()]
  );
  return { token, expiresAt: expires.toISOString() };
}

async function lookupSession(token) {
  if (!token) return null;
  const row = await db.get(
    `SELECT s.*, u.id AS user_id, u.display_name, u.username, u.age, u.country,
            u.city, u.about, u.language, u.photo_url, u.prefs_json, u.suspended, u.created_at AS user_created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)]
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.run('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    return null;
  }
  return row;
}

// Sliding renewal: if the session expires within 7 days, extend it to a full
// 30 days from now and re-issue the cookie.
async function maybeRenewSession(req, res, sessionRow) {
  const expiresMs = new Date(sessionRow.expires_at).getTime();
  if (expiresMs - Date.now() > RENEW_WITHIN_MS) return;
  const newExpires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.run(
    'UPDATE sessions SET expires_at = $1, last_seen_at = $2 WHERE token_hash = $3',
    [newExpires.toISOString(), nowIso(), hashToken(req.cookies?.sp_session || '')]
  );
  if (req.cookies?.sp_session) {
    res.cookie('sp_session', req.cookies.sp_session, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60 * 1000));
  }
}

async function destroySession(token) {
  if (!token) return;
  await db.run('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

async function destroyAllUserSessions(userId) {
  await db.run('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

// Middleware: attach req.user when a valid session cookie is present.
// Does NOT reject when absent (use requireAuth for that).
async function attachUser(req, res, next) {
  try {
    const token = req.cookies?.sp_session;
    if (!token) return next();
    const row = await lookupSession(token);
    if (!row) {
      res.clearCookie('sp_session', { path: '/' });
      return next();
    }
    let prefs = { notifyPrefs: { posts: true, gifts: true, brands: true }, showTotals: true, anonDefault: false };
    try {
      const p = JSON.parse(row.prefs_json || '{}');
      prefs = {
        notifyPrefs: p.notifyPrefs || prefs.notifyPrefs,
        showTotals: p.showTotals !== false,
        anonDefault: p.anonDefault === true,
      };
    } catch { /* keep defaults */ }
    req.user = {
      id: row.user_id,
      displayName: row.display_name,
      username: row.username,
      age: row.age,
      country: row.country,
      city: row.city,
      about: row.about,
      language: row.language,
      photoUrl: row.photo_url,
      suspended: row.suspended === 1,
      prefs,
      createdAt: row.user_created_at,
    };
    req.sessionRow = row;
    await maybeRenewSession(req, res, row);
    // Touch last_seen (cheap, best-effort).
    db.run('UPDATE sessions SET last_seen_at = $1 WHERE token_hash = $2', [nowIso(), hashToken(token)]).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please create a profile to continue.' } });
  }
  next();
}

// Write routes also require a non-suspended account.
function requireActive(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please create a profile to continue.' } });
  }
  if (req.user.suspended) {
    return res.status(403).json({ error: { code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended. Contact support via the Help Centre.' } });
  }
  next();
}

// ---- Admin PIN (scrypt, fail-closed when unset) ----

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  if (hash.length !== expected.length) return false;
  return crypto.timingSafeEqual(hash, expected);
}

async function isPinSet() {
  const v = await db.getSetting('admin_pin_hash');
  return Boolean(v);
}

// Setup is only possible while no PIN exists. Returns {ok} or {ok:false, error}.
async function setupPin(pin) {
  if (await isPinSet()) return { ok: false, error: 'An admin PIN is already set. Use change-pin instead.' };
  if (typeof pin !== 'string' || pin.length < 6 || pin.length > 64) {
    return { ok: false, error: 'PIN must be 6–64 characters.' };
  }
  await db.setSetting('admin_pin_hash', hashPin(pin));
  await logAudit('admin', 'owner', 'admin_pin_set', 'settings', 'admin_pin_hash', {});
  return { ok: true };
}

async function verifyAdminPin(pin) {
  const stored = await db.getSetting('admin_pin_hash');
  if (!stored) return false; // fail-closed: no PIN set -> no PIN accepted
  if (typeof pin !== 'string' || !pin) return false;
  return verifyPin(pin, stored);
}

async function changePin(oldPin, newPin) {
  const stored = await db.getSetting('admin_pin_hash');
  if (!stored) return { ok: false, error: 'No admin PIN is set yet. Use setup-pin first.' };
  if (!verifyPin(oldPin, stored)) return { ok: false, error: 'Current PIN is incorrect.' };
  if (typeof newPin !== 'string' || newPin.length < 6 || newPin.length > 64) {
    return { ok: false, error: 'New PIN must be 6–64 characters.' };
  }
  await db.setSetting('admin_pin_hash', hashPin(newPin));
  await logAudit('admin', 'owner', 'admin_pin_changed', 'settings', 'admin_pin_hash', {});
  return { ok: true };
}

async function createAdminSession() {
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + ADMIN_SESSION_HOURS * 60 * 60 * 1000);
  await db.run(
    'INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), now.toISOString(), expires.toISOString()]
  );
  return { token, expiresAt: expires.toISOString() };
}

async function lookupAdminSession(token) {
  if (!token) return null;
  const row = await db.get('SELECT * FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.run('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
    return null;
  }
  return row;
}

async function destroyAdminSession(token) {
  if (!token) return;
  await db.run('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
}

async function requireAdmin(req, res, next) {
  try {
    const token = req.cookies?.sp_admin;
    const row = await lookupAdminSession(token);
    if (!row) {
      return res.status(401).json({ error: { code: 'ADMIN_UNAUTHENTICATED', message: 'Admin login required.' } });
    }
    req.admin = { actor: 'owner' };
    next();
  } catch (err) {
    next(err);
  }
}

// ---- In-memory rate limiting ----
// Buckets keyed by (routeKey + IP). Simple fixed-window counters; good enough
// for a single-instance free-tier deploy. Returns true when the request is
// allowed, false when the bucket is exhausted.
const buckets = new Map();

function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

function rateLimit(routeKey, limit, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${routeKey}:${ip}`;
    if (!checkRateLimit(key, limit, windowMs)) {
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests — please wait a little and try again.' },
      });
    }
    next();
  };
}

// Periodic cleanup of expired buckets (unref'd so it never keeps the process alive).
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  SESSION_DAYS,
  ADMIN_SESSION_HOURS,
  hashToken,
  randomToken,
  sessionCookieOptions,
  createSession,
  lookupSession,
  destroySession,
  destroyAllUserSessions,
  attachUser,
  requireAuth,
  requireActive,
  isPinSet,
  setupPin,
  verifyAdminPin,
  changePin,
  createAdminSession,
  lookupAdminSession,
  destroyAdminSession,
  requireAdmin,
  rateLimit,
  checkRateLimit,
};
