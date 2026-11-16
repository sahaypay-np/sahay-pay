// Sahay Pay — user sessions, admin PIN, rate limiting, CSRF, recovery codes.
// Sessions: opaque random tokens, SHA-256 hash stored server-side, delivered
// in an httpOnly cookie (sp_session, 30 days, sliding renewal).
// Admin PIN: scrypt hash in settings. FAIL-CLOSED when unset: no PIN is
// accepted until the owner sets one via the one-time setup flow. Admin session
// cookie sp_admin lasts 24h absolute with a 30-minute IDLE timeout.
// Rate limiting: DB-backed buckets (rate_limits table) so limits survive
// serverless cold starts; 429s carry a Retry-After header and repeat
// offenders get progressively longer windows.
// CSRF: synchronizer tokens stored per session (sessions.csrf_token /
// admin_sessions.csrf_token); the frontend sends X-CSRF-Token on every
// state-changing request. Requests with no session (login/onboard) are
// exempt from CSRF but still pass the Origin/Referer check.
// Recovery codes: 16 chars (4x4, unambiguous alphabet), shown ONCE at
// onboarding; only a scrypt hash (+ a SHA-256 lookup key) is stored.

'use strict';

const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('./audit');
const { consentIsCurrent } = require('./policy');
const { browserFamily, deviceClass, deviceLabel, familyHash } = require('./device');

const SESSION_DAYS = 30;
const SESSION_ABSOLUTE_DAYS = 90; // item 819: no session lives past 90 days, however active
const MAX_SESSIONS_PER_USER = 3; // item 811: oldest revoked automatically
const ADMIN_SESSION_HOURS = 24;
const ADMIN_IDLE_MINUTES = 30;
const ADMIN_ELEVATED_MINUTES = 10; // item 808: PIN re-auth elevation window
const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000; // renew when < 7 days left

// Item 788: security settings (admin-configurable, stored in settings).
// Defaults match the current behaviour; the admin console can change them.
const DEFAULT_SECURITY_SETTINGS = {
  pinMinLength: 6,
  adminIdleMinutes: 30,
  lockoutAttempts: 5,
  lockoutMinutes: 15,
};

async function getSecuritySettings() {
  const stored = await db.getSettingJson('security_settings', null);
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_SECURITY_SETTINGS };
  const out = { ...DEFAULT_SECURITY_SETTINGS };
  if (Number.isInteger(stored.pinMinLength) && stored.pinMinLength >= 4 && stored.pinMinLength <= 32) {
    out.pinMinLength = stored.pinMinLength;
  }
  if (Number.isInteger(stored.adminIdleMinutes) && stored.adminIdleMinutes >= 5 && stored.adminIdleMinutes <= 480) {
    out.adminIdleMinutes = stored.adminIdleMinutes;
  }
  if (Number.isInteger(stored.lockoutAttempts) && stored.lockoutAttempts >= 3 && stored.lockoutAttempts <= 20) {
    out.lockoutAttempts = stored.lockoutAttempts;
  }
  if (Number.isInteger(stored.lockoutMinutes) && stored.lockoutMinutes >= 5 && stored.lockoutMinutes <= 1440) {
    out.lockoutMinutes = stored.lockoutMinutes;
  }
  return out;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function isProd() {
  return process.env.NODE_ENV === 'production';
}

// Secure flag: set in production OR whenever the request arrived over HTTPS.
// NODE_ENV is not guaranteed in the Netlify function runtime, so the
// per-request scheme (trust proxy is on, index.js:21) is the reliable signal:
// live traffic is always HTTPS, local dev over plain HTTP keeps working.
function sessionCookieOptions(maxAgeMs, req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isProd() || !!(req && req.secure),
    maxAge: maxAgeMs,
  };
}

// Constant-time string compare (CSRF tokens, recovery codes).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

async function createSession(userId, userAgent) {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  // Item 811: cap concurrent sessions at 3 — revoke the oldest first so
  // this new session never pushes the account over the cap.
  const { rows: existing } = await db.query(
    'SELECT token_hash FROM sessions WHERE user_id = $1 ORDER BY last_seen_at DESC',
    [userId]
  );
  for (const old of existing.slice(MAX_SESSIONS_PER_USER - 1)) {
    await db.run('DELETE FROM sessions WHERE token_hash = $1', [old.token_hash]);
  }
  await db.run(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, csrf_token, user_agent, ua_family_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      hashToken(token), userId, now.toISOString(), expires.toISOString(),
      now.toISOString(), csrfToken, String(userAgent || '').slice(0, 500),
      familyHash(userAgent),
    ]
  );
  return { token, csrfToken, expiresAt: expires.toISOString() };
}

// Item 802: rotate the session token on a sensitive action (payout reveal,
// recovery-code regeneration, account deletion). The CSRF token is carried
// over so in-flight forms keep working; the OLD session token stops working
// immediately. Returns the new token + cookie options, or null.
async function rotateSession(req, res) {
  const oldToken = req.cookies?.sp_session;
  if (!oldToken || !req.sessionRow) return null;
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const row = req.sessionRow;
  await db.run('DELETE FROM sessions WHERE token_hash = $1', [hashToken(oldToken)]);
  await db.run(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, csrf_token, user_agent, ua_family_hash, trusted_note, reauthed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      hashToken(token), row.user_id, row.created_at, expires.toISOString(),
      now.toISOString(), row.csrf_token, row.user_agent, row.ua_family_hash,
      row.trusted_note || null, row.reauthed_at || null,
    ]
  );
  // Keep the absolute 90-day cap (item 819): rotation must not extend it.
  await db.run(
    'UPDATE sessions SET expires_at = $1 WHERE token_hash = $2 AND expires_at > $1',
    [new Date(Date.parse(row.created_at) + SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000).toISOString(), hashToken(token)]
  );
  res.cookie('sp_session', token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60 * 1000, req));
  req.sessionRow = { ...row, token_hash: hashToken(token) };
  return { token, csrfToken: row.csrf_token };
}

// Item 802 (admin side): rotate the admin session token on PIN change.
async function rotateAdminSession(req, res) {
  const oldToken = req.cookies?.sp_admin;
  if (!oldToken) return null;
  const row = await db.get('SELECT * FROM admin_sessions WHERE token_hash = $1', [hashToken(oldToken)]);
  if (!row) return null;
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + ADMIN_SESSION_HOURS * 60 * 60 * 1000);
  await db.run('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(oldToken)]);
  await db.run(
    'INSERT INTO admin_sessions (token_hash, created_at, expires_at, csrf_token, last_seen_at) VALUES ($1, $2, $3, $4, $5)',
    [hashToken(token), now.toISOString(), expires.toISOString(), row.csrf_token, now.toISOString()]
  );
  res.cookie('sp_admin', token, sessionCookieOptions(ADMIN_SESSION_HOURS * 60 * 60 * 1000, req));
  return { token, csrfToken: row.csrf_token };
}

async function lookupSession(token) {
  if (!token) return null;
  const row = await db.get(
    `SELECT s.*, u.id AS user_id, u.display_name, u.username, u.age, u.country,
            u.city, u.about, u.language, u.photo_url, u.prefs_json, u.suspended,
            u.suspended_until, u.banned,
            u.terms_accepted_version, u.privacy_accepted_version,
            u.terms_accepted_at, u.privacy_accepted_at,
            u.created_at AS user_created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)]
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.run('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    return null;
  }
  // Item 819: absolute 90-day lifetime from creation — sliding renewal
  // (below) can never push a session past this.
  if (row.created_at && Date.parse(row.created_at) + SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000 <= Date.now()) {
    await db.run('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    return null;
  }
  // Lazy suspension expiry (Phase 2 item 384): a timed suspension ends on
  // its own the first time the account is used after the end date.
  if (row.suspended === 1 && row.suspended_until && row.banned !== 1 && new Date(row.suspended_until).getTime() <= Date.now()) {
    await db.run(
      `UPDATE users SET suspended = 0, suspended_reason = '', suspended_until = NULL, suspended_at = NULL WHERE id = $1`,
      [row.user_id]
    );
    row.suspended = 0;
  }
  return row;
}

// Sliding renewal: if the session expires within 7 days, extend it to a full
// 30 days from now and re-issue the cookie — never past the 90-day absolute cap.
async function maybeRenewSession(req, res, sessionRow) {
  const expiresMs = new Date(sessionRow.expires_at).getTime();
  if (expiresMs - Date.now() > RENEW_WITHIN_MS) return;
  const absoluteCap = Date.parse(sessionRow.created_at) + SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000;
  const newExpires = new Date(Math.min(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000, absoluteCap));
  await db.run(
    'UPDATE sessions SET expires_at = $1, last_seen_at = $2 WHERE token_hash = $3',
    [newExpires.toISOString(), nowIso(), hashToken(req.cookies?.sp_session || '')]
  );
  if (req.cookies?.sp_session) {
    res.cookie('sp_session', req.cookies.sp_session, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60 * 1000, req));
  }
}

async function destroySession(token) {
  if (!token) return;
  await db.run('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

async function destroyAllUserSessions(userId) {
  await db.run('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

// Item 821: revoke every session EXCEPT the current one.
async function destroyOtherUserSessions(userId, currentToken) {
  if (!currentToken) return 0;
  const result = await db.run(
    'DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2',
    [userId, hashToken(currentToken)]
  );
  return result.changes || 0;
}

// Active sessions for the Settings list. The id is the first 12 hex chars
// of the token hash — enough to identify a row for revoke, useless for
// forging a session (the token itself is never exposed).
// Items 801/805: device class + browser derived from the stored user-agent
// (no IP is ever stored, so no location is shown).
async function listUserSessions(userId, currentToken) {
  const { rows } = await db.query(
    `SELECT token_hash, created_at, expires_at, last_seen_at, user_agent, trusted_note
     FROM sessions WHERE user_id = $1 ORDER BY last_seen_at DESC`,
    [userId]
  );
  const currentHash = currentToken ? hashToken(currentToken) : '';
  return rows.map((r) => ({
    id: String(r.token_hash).slice(0, 12),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastSeenAt: r.last_seen_at,
    userAgent: r.user_agent || null,
    deviceClass: deviceClass(r.user_agent),
    browser: browserFamily(r.user_agent),
    deviceLabel: deviceLabel(r.user_agent),
    trustedNote: r.trusted_note || null,
    current: r.token_hash === currentHash,
  }));
}

// Revoke one session by its 12-char id prefix. Returns true if a row was deleted.
async function destroyUserSessionById(userId, idPrefix) {
  if (!/^[0-9a-f]{12}$/.test(String(idPrefix || ''))) return false;
  const result = await db.run(
    'DELETE FROM sessions WHERE user_id = $1 AND token_hash LIKE $2',
    [userId, `${idPrefix}%`]
  );
  return (result.changes || 0) > 0;
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
    // Items 806/810/818 — token binding: the session token is bound to the
    // browser family that created it. A token presented from a DIFFERENT
    // browser family is treated as stolen: the session is destroyed, the
    // event is audit-logged, and the request continues logged-out (the
    // X-Session-Suspicious header lets the frontend explain why and point
    // at recovery — item 810's "force re-onboarding"). Sessions created
    // before this feature get their family hash lazily. A missing UA on
    // either side skips the check (no signal, not a mismatch).
    const currentUa = req.headers['user-agent'] || '';
    if (row.ua_family_hash && currentUa) {
      if (!safeEqual(row.ua_family_hash, familyHash(currentUa))) {
        await db.run('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
        await logAudit('user', row.user_id, 'session_fingerprint_changed', 'user', row.user_id, {
          fromFamily: row.ua_family_hash.slice(0, 8),
        });
        res.clearCookie('sp_session', { path: '/' });
        res.set('X-Session-Suspicious', '1');
        return next();
      }
    } else if (!row.ua_family_hash && currentUa) {
      db.run('UPDATE sessions SET ua_family_hash = $1 WHERE token_hash = $2', [
        familyHash(currentUa), hashToken(token),
      ]).catch(() => {});
    }
    let prefs = { notifyPrefs: { posts: true, gifts: true, brands: true }, showTotals: true, anonDefault: false };
    try {
      const p = JSON.parse(row.prefs_json || '{}');
      prefs = {
        notifyPrefs: p.notifyPrefs || prefs.notifyPrefs,
        showTotals: p.showTotals !== false,
        anonDefault: p.anonDefault === true,
        // Phase 2 §7 notification preferences (612–618, 655, 680).
        notifyTypes: p.notifyTypes || {},
        pauseUntil: p.pauseUntil || null,
        quietHours: p.quietHours || null,
        tzOffsetMinutes: Number.isInteger(p.tzOffsetMinutes) ? p.tzOffsetMinutes : null,
        notifyLang: p.notifyLang || null,
        digestOptOut: p.digestOptOut === true,
        referralOptOut: p.referralOptOut === true,
        soundEnabled: p.soundEnabled === true,
      };
    } catch { /* keep defaults */ }
    // Item 727: temporary suspension auto-restores on expiry, checked
    // lazily on auth (no scheduler exists). Banned accounts never restore.
    let suspended = row.suspended === 1;
    if (suspended && row.suspended_until && row.banned !== 1 && Date.parse(row.suspended_until) <= Date.now()) {
      try {
        await db.run(
          `UPDATE users SET suspended = 0, suspended_until = NULL, suspended_reason = '', suspended_at = NULL
           WHERE id = $1`,
          [row.user_id]
        );
        await logAudit('system', 'auto-restore', 'user_auto_restored', 'user', row.user_id, {
          suspendedUntil: row.suspended_until,
        });
        suspended = false;
      } catch { /* keep suspended on failure — fail closed */ }
    }
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
      suspended,
      prefs,
      createdAt: row.user_created_at,
      consentCurrent: consentIsCurrent(row),
      termsAcceptedVersion: row.terms_accepted_version || null,
      privacyAcceptedVersion: row.privacy_accepted_version || null,
      termsAcceptedAt: row.terms_accepted_at || null,
      privacyAcceptedAt: row.privacy_accepted_at || null,
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

// ---- Scrypt secret hashing (admin PIN + recovery codes) ----

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifySecret(secret, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  let hash;
  try {
    hash = crypto.scryptSync(secret, Buffer.from(saltHex, 'hex'), 64);
  } catch {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  if (hash.length !== expected.length) return false;
  return crypto.timingSafeEqual(hash, expected);
}

// ---- Admin PIN (scrypt, fail-closed when unset) ----

function hashPin(pin) {
  return hashSecret(pin);
}

function verifyPin(pin, stored) {
  return verifySecret(pin, stored);
}

async function isPinSet() {
  const v = await db.getSetting('admin_pin_hash');
  return Boolean(v);
}

// Setup is only possible while no PIN exists. Returns {ok} or {ok:false, error}.
async function setupPin(pin) {
  if (await isPinSet()) return { ok: false, error: 'An admin PIN is already set. Use change-pin instead.' };
  const { pinMinLength } = await getSecuritySettings();
  if (typeof pin !== 'string' || pin.length < pinMinLength || pin.length > 64) {
    return { ok: false, error: `PIN must be ${pinMinLength}–64 characters.` };
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
  const { pinMinLength } = await getSecuritySettings();
  if (typeof newPin !== 'string' || newPin.length < pinMinLength || newPin.length > 64) {
    return { ok: false, error: `New PIN must be ${pinMinLength}–64 characters.` };
  }
  await db.setSetting('admin_pin_hash', hashPin(newPin));
  await logAudit('admin', 'owner', 'admin_pin_changed', 'settings', 'admin_pin_hash', {});
  return { ok: true };
}

async function createAdminSession(adminUserId = null, userAgent = '') {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + ADMIN_SESSION_HOURS * 60 * 60 * 1000);
  await db.run(
    'INSERT INTO admin_sessions (token_hash, admin_user_id, user_agent, created_at, expires_at, csrf_token, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [hashToken(token), adminUserId, String(userAgent || '').slice(0, 500), now.toISOString(), expires.toISOString(), csrfToken, now.toISOString()]
  );
  return { token, csrfToken, expiresAt: expires.toISOString() };
}

// Enforces BOTH the 24h absolute expiry and the idle timeout (checklist
// item 239; idle minutes come from the security settings, item 788).
// Any successful lookup counts as activity.
async function lookupAdminSession(token) {
  if (!token) return null;
  const row = await db.get('SELECT * FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.run('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
    return null;
  }
  const { adminIdleMinutes } = await getSecuritySettings();
  if (row.last_seen_at) {
    const idleMs = Date.now() - Date.parse(row.last_seen_at);
    if (idleMs > adminIdleMinutes * 60 * 1000) {
      await db.run('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
      return null;
    }
  }
  // Touch last_seen (best-effort, awaited so the idle clock is exact).
  await db.run(
    'UPDATE admin_sessions SET last_seen_at = $1 WHERE token_hash = $2',
    [nowIso(), hashToken(token)]
  ).catch(() => {});
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
    // Items 771/772: per-admin accounts with roles. A session with no
    // admin_user_id is the owner's shared-PIN session (role 'owner').
    // Anything else resolves its role from admin_users.
    let role = 'owner';
    let displayName = 'Owner';
    let adminUserId = null;
    if (row.admin_user_id) {
      const adminUser = await db.get('SELECT * FROM admin_users WHERE id = $1', [row.admin_user_id]);
      if (!adminUser) {
        return res.status(401).json({ error: { code: 'ADMIN_UNAUTHENTICATED', message: 'Admin account no longer exists.' } });
      }
      role = adminUser.role;
      displayName = adminUser.display_name;
      adminUserId = adminUser.id;
    }
    req.admin = { actor: adminUserId || 'owner', role, displayName, adminUserId };
    req.adminSessionRow = row;
    next();
  } catch (err) {
    next(err);
  }
}

// ---- Admin PIN re-auth / elevation (item 808) ----
// Sensitive admin actions (fee changes, bill approval decisions) require
// the owner PIN to have been re-entered within the last 10 minutes.
// The elevation flag lives on the admin session row (elevated_until).

async function elevateAdminSession(token) {
  if (!token) return false;
  const until = new Date(Date.now() + ADMIN_ELEVATED_MINUTES * 60 * 1000).toISOString();
  const result = await db.run(
    'UPDATE admin_sessions SET elevated_until = $1 WHERE token_hash = $2',
    [until, hashToken(token)]
  );
  return (result.changes || 0) > 0;
}

async function isAdminElevated(token) {
  if (!token) return false;
  const row = await db.get('SELECT elevated_until FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
  if (!row || !row.elevated_until) return false;
  return Date.parse(row.elevated_until) > Date.now();
}

async function requireElevated(req, res, next) {
  try {
    const token = req.cookies?.sp_admin;
    if (!(await isAdminElevated(token))) {
      return res.status(403).json({
        error: { code: 'ELEVATION_REQUIRED', message: 'Please re-enter the owner PIN to do this.' },
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Require one of the given admin roles (owner > moderator > viewer).
// Use after requireAdmin.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.admin || !roles.includes(req.admin.role)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Your admin role does not allow this action.' } });
    }
    next();
  };
}

// Viewers are read-only (item 772): block every non-GET admin request
// for them, wherever this middleware is mounted.
function blockViewerWrites(req, res, next) {
  if (req.admin?.role === 'viewer' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Viewer accounts are read-only.' } });
  }
  next();
}

// ---- Per-admin accounts (items 771–773) ----
// The owner's shared PIN (settings.admin_pin_hash) remains the owner
// account. Additional admins have individual PINs in admin_users and are
// created by redeeming a one-time invite code the owner generates in-app
// (no email exists in this product, so the owner passes the code on
// himself — item 773's swap).

const ADMIN_ROLES = ['owner', 'moderator', 'viewer'];

async function listAdminUsers() {
  const { rows } = await db.query(
    `SELECT id, display_name, role, failed_attempts, locked_until, created_at, last_login_at
     FROM admin_users ORDER BY created_at ASC`
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    role: r.role,
    lockedUntil: r.locked_until,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  }));
}

async function getAdminUser(id) {
  const row = await db.get('SELECT * FROM admin_users WHERE id = $1', [id]);
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

async function createAdminUser(displayName, role, pin) {
  if (!ADMIN_ROLES.includes(role)) return { ok: false, error: 'Role must be owner, moderator or viewer.' };
  const name = String(displayName || '').trim();
  if (name.length < 2 || name.length > 60) return { ok: false, error: 'Display name must be 2–60 characters.' };
  const { pinMinLength } = await getSecuritySettings();
  if (typeof pin !== 'string' || pin.length < pinMinLength || pin.length > 64) {
    return { ok: false, error: `PIN must be ${pinMinLength}–64 characters.` };
  }
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO admin_users (id, display_name, role, pin_hash, failed_attempts, locked_until, created_at, last_login_at)
     VALUES ($1, $2, $3, $4, 0, NULL, $5, NULL)`,
    [id, name, role, hashPin(pin), nowIso()]
  );
  await logAudit('admin', 'owner', 'admin_user_created', 'admin', id, { role, displayName: name });
  return { ok: true, adminUser: { id, displayName: name, role } };
}

// Verify a per-admin PIN, enforcing the per-account lockout (item 777:
// lockoutAttempts wrong attempts -> lockoutMinutes lock).
async function verifyAdminUserPin(adminId, pin) {
  const row = await db.get('SELECT * FROM admin_users WHERE id = $1', [adminId]);
  if (!row) return { ok: false, error: 'Admin account not found.' };
  const { lockoutAttempts, lockoutMinutes } = await getSecuritySettings();
  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    return { ok: false, locked: true, lockedUntil: row.locked_until, error: 'This admin account is locked. Try again later.' };
  }
  if (typeof pin === 'string' && pin && verifyPin(pin, row.pin_hash)) {
    await db.run(
      'UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = $1 WHERE id = $2',
      [nowIso(), row.id]
    );
    return { ok: true, adminUser: row };
  }
  const failed = (Number(row.failed_attempts) || 0) + 1;
  const lockedUntil = failed >= lockoutAttempts
    ? new Date(Date.now() + lockoutMinutes * 60 * 1000).toISOString()
    : null;
  await db.run(
    'UPDATE admin_users SET failed_attempts = $1, locked_until = $2 WHERE id = $3',
    [failed, lockedUntil, row.id]
  );
  if (lockedUntil) {
    await logAudit('admin', row.id, 'admin_account_locked', 'admin', row.id, { failedAttempts: failed });
  }
  return {
    ok: false,
    locked: Boolean(lockedUntil),
    lockedUntil,
    remaining: Math.max(0, lockoutAttempts - failed),
    error: 'Incorrect PIN.',
  };
}

// One-time invite code: 16 chars from the recovery-code alphabet (shown
// once to the owner; only the SHA-256 hash is stored).
function generateInviteCode() {
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (let i = 0; i < 16; i++) raw += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

async function createAdminInvite(role, createdBy = 'owner') {
  if (!['moderator', 'viewer'].includes(role)) {
    return { ok: false, error: 'Invites can only create moderator or viewer accounts.' };
  }
  const code = generateInviteCode();
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO admin_invites (id, code_hash, role, created_by, created_at, used_at, used_by)
     VALUES ($1, $2, $3, $4, $5, NULL, NULL)`,
    [id, crypto.createHash('sha256').update(code.replace(/-/g, '')).digest('hex'), role, createdBy, nowIso()]
  );
  await logAudit('admin', createdBy, 'admin_invite_created', 'admin', id, { role });
  return { ok: true, invite: { id, code, role } };
}

async function redeemAdminInvite(code, displayName, pin) {
  const normalised = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalised.length !== 16) return { ok: false, error: 'That invite code does not look right.' };
  const codeHash = crypto.createHash('sha256').update(normalised).digest('hex');
  const invite = await db.get('SELECT * FROM admin_invites WHERE code_hash = $1', [codeHash]);
  if (!invite) return { ok: false, error: 'Invite code not found.' };
  if (invite.used_at) return { ok: false, error: 'This invite code has already been used.' };
  const created = await createAdminUser(displayName, invite.role, pin);
  if (!created.ok) return created;
  await db.run(
    'UPDATE admin_invites SET used_at = $1, used_by = $2 WHERE id = $3',
    [nowIso(), created.adminUser.id, invite.id]
  );
  return { ok: true, adminUser: created.adminUser };
}

async function deleteAdminUser(id) {
  const row = await db.get('SELECT * FROM admin_users WHERE id = $1', [id]);
  if (!row) return { ok: false, error: 'Admin account not found.' };
  await db.run('DELETE FROM admin_users WHERE id = $1', [id]);
  await db.run('DELETE FROM admin_sessions WHERE admin_user_id = $1', [id]);
  await logAudit('admin', 'owner', 'admin_user_deleted', 'admin', id, { role: row.role });
  return { ok: true };
}

// ---- Account recovery codes ----
// Alphabet excludes 0/O, 1/I/L so a code read back over the phone is
// unambiguous. 16 chars from 32 symbols = 80 bits of entropy.
// Storage: scrypt hash (verification) + SHA-256 of the normalised code
// (lookup key — scrypt's random salt makes it unsearchable on its own).
// The plain code is NEVER stored or logged; it is shown once at onboarding.

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generateRecoveryCode() {
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (let i = 0; i < 16; i++) raw += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function recoveryLookupKey(code) {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

// Find the user for a recovery code (lookup key, then scrypt verify).
// Returns the user row or null. Never throws on a bad code.
async function findUserByRecoveryCode(code) {
  const normalised = normalizeRecoveryCode(code);
  if (normalised.length !== 16) return null;
  const user = await db.get('SELECT * FROM users WHERE recovery_code_lookup = $1', [recoveryLookupKey(code)]);
  if (!user || !user.recovery_code_hash) return null;
  if (!verifySecret(normalised, user.recovery_code_hash)) return null;
  return user;
}

// ---- Origin / Referer verification (checklist item 130) ----
// State-changing API requests from a browser must come from this site.
// A missing Origin AND Referer is allowed (curl, tests, non-browser
// clients); a PRESENT one that doesn't match this host is rejected.
// Note: no Origin check existed before this change — SameSite=Lax was the
// only cross-site defence.
function verifyOrigin(req, res, next) {
  if (!req.path.startsWith('/api')) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const host = req.get('host');
  const sameHost = (value) => {
    try {
      return new URL(value).host === host;
    } catch {
      return false;
    }
  };
  const origin = req.headers.origin;
  if (origin) {
    if (!sameHost(origin)) {
      return res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: 'Cross-site requests are not allowed.' } });
    }
    return next();
  }
  const referer = req.headers.referer;
  if (referer && !sameHost(referer)) {
    return res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: 'Cross-site requests are not allowed.' } });
  }
  next();
}

// ---- CSRF synchronizer tokens (checklist item 129) ----
// The token is stored server-side on the session row and sent by the
// frontend as X-CSRF-Token. Sessions created before this feature get a
// token lazily on first use. Requests with no session at all (onboard,
// login, setup-pin) are exempt — there is nothing to forge against — and
// the bridge route authenticates with its own secret header.

async function getOrCreateCsrfToken(table, token) {
  const row = await db.get(`SELECT csrf_token FROM ${table} WHERE token_hash = $1`, [hashToken(token)]);
  if (!row) return null;
  if (row.csrf_token) return row.csrf_token;
  const fresh = randomToken(24);
  await db.run(`UPDATE ${table} SET csrf_token = $1 WHERE token_hash = $2`, [fresh, hashToken(token)]);
  return fresh;
}

function csrfDenied(res) {
  return res.status(403).json({
    error: { code: 'CSRF_INVALID', message: 'Security token missing or expired. Please reload and try again.' },
  });
}

async function verifyCsrf(req, res, next) {
  try {
    if (!req.path.startsWith('/api')) return next();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.path.startsWith('/api/bridge')) return next();
    const presented = req.headers['x-csrf-token'];
    // Admin paths authenticate with the admin session.
    if (req.path.startsWith('/api/admin')) {
      const adminToken = req.cookies?.sp_admin;
      if (adminToken) {
        const row = await lookupAdminSession(adminToken);
        if (row) {
          const expected = row.csrf_token || (await getOrCreateCsrfToken('admin_sessions', adminToken));
          if (!safeEqual(presented, expected)) return csrfDenied(res);
        }
        // Invalid admin cookie: fall through — requireAdmin returns 401.
      }
      return next();
    }
    const sessionToken = req.cookies?.sp_session;
    if (sessionToken && req.user && req.sessionRow) {
      const expected = req.sessionRow.csrf_token || (await getOrCreateCsrfToken('sessions', sessionToken));
      if (!safeEqual(presented, expected)) return csrfDenied(res);
    }
    // No user session: nothing to forge against (login/onboard) — allowed.
    next();
  } catch (err) {
    next(err);
  }
}

// ---- DB-backed rate limiting (checklist items 70 + 170) ----
// Fixed-window buckets in the rate_limits table, keyed by (route + IP),
// so limits survive serverless cold starts. On exhaustion the window is
// pushed out progressively (30s per extra hit, up to +5 min) and every
// 429 carries a Retry-After header with the reset window in seconds.

async function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const row = await db.get('SELECT * FROM rate_limits WHERE key = $1', [key]);
  if (!row || Date.parse(row.reset_at) <= now) {
    await db.run(
      `INSERT INTO rate_limits (key, count, reset_at, violations) VALUES ($1, 1, $2, 0)
       ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at, violations = 0`,
      [key, new Date(now + windowMs).toISOString()]
    );
    // Opportunistic cleanup of expired buckets (table stays tiny).
    db.run('DELETE FROM rate_limits WHERE reset_at < $1', [new Date(now).toISOString()]).catch(() => {});
    return { allowed: true, retryAfterSec: 0 };
  }
  if (row.count < limit) {
    await db.run('UPDATE rate_limits SET count = count + 1 WHERE key = $1', [key]);
    return { allowed: true, retryAfterSec: 0 };
  }
  const violations = (Number(row.violations) || 0) + 1;
  const extraMs = Math.min(violations, 10) * 30 * 1000;
  const newReset = new Date(Math.max(Date.parse(row.reset_at), now) + extraMs);
  await db.run('UPDATE rate_limits SET violations = $1, reset_at = $2 WHERE key = $3', [
    violations,
    newReset.toISOString(),
    key,
  ]);
  return {
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil((newReset.getTime() - now) / 1000)),
  };
}

function rateLimit(routeKey, limit, windowMs) {
  return async (req, res, next) => {
    try {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const result = await checkRateLimit(`${routeKey}:${ip}`, limit, windowMs);
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfterSec));
        return res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'Too many requests — please wait a little and try again.' },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Item 843: per-ACCOUNT rate limit (not per-IP) — the key is the signed-in
// user id, so one account cannot hammer an endpoint from many IPs.
function rateLimitAccount(routeKey, limit, windowMs) {
  return async (req, res, next) => {
    try {
      if (!req.user) return next(); // requireAuth/requireActive answers first
      const result = await checkRateLimit(`${routeKey}:user:${req.user.id}`, limit, windowMs);
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfterSec));
        return res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'Too many requests — please wait a little and try again.' },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  SESSION_DAYS,
  SESSION_ABSOLUTE_DAYS,
  MAX_SESSIONS_PER_USER,
  ADMIN_SESSION_HOURS,
  ADMIN_IDLE_MINUTES,
  ADMIN_ELEVATED_MINUTES,
  hashToken,
  randomToken,
  sessionCookieOptions,
  createSession,
  rotateSession,
  rotateAdminSession,
  lookupSession,
  destroySession,
  destroyAllUserSessions,
  destroyOtherUserSessions,
  listUserSessions,
  destroyUserSessionById,
  attachUser,
  requireAuth,
  requireActive,
  hashSecret,
  verifySecret,
  isPinSet,
  setupPin,
  verifyAdminPin,
  changePin,
  createAdminSession,
  lookupAdminSession,
  destroyAdminSession,
  requireAdmin,
  elevateAdminSession,
  isAdminElevated,
  requireElevated,
  requireRole,
  blockViewerWrites,
  listAdminUsers,
  getAdminUser,
  createAdminUser,
  verifyAdminUserPin,
  createAdminInvite,
  redeemAdminInvite,
  deleteAdminUser,
  getSecuritySettings,
  DEFAULT_SECURITY_SETTINGS,
  generateRecoveryCode,
  normalizeRecoveryCode,
  recoveryLookupKey,
  findUserByRecoveryCode,
  verifyOrigin,
  verifyCsrf,
  getOrCreateCsrfToken,
  rateLimit,
  rateLimitAccount,
  checkRateLimit,
};
