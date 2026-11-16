// Sahay Pay — auth routes. NO email, NO Google, NO password, NO OTP.
// A profile is created by answering simple questions only. Age < 18 is a
// hard block: 403 AGE_BLOCK and NO user row is created.
// Sessions last 30 days (sliding renewal), cookie sp_session.

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { nowIso, logAudit } = require('../lib/audit');
const {
  createSession, destroySession, destroyAllUserSessions, destroyOtherUserSessions,
  listUserSessions, destroyUserSessionById, rotateSession, hashToken,
  requireAuth, sessionCookieOptions, SESSION_DAYS, rateLimit, checkRateLimit,
  generateRecoveryCode, hashSecret, recoveryLookupKey, findUserByRecoveryCode,
  getOrCreateCsrfToken,
} = require('../lib/auth');
const { uaHash } = require('../lib/device');
const { TERMS_VERSION, PRIVACY_VERSION, consentIsCurrent } = require('../lib/policy');
const { validateOnboarding, cleanStr } = require('../lib/validate');

const router = express.Router();

function slugifyName(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'user';
  return slug;
}

async function generateUsername(displayName) {
  const base = slugifyName(displayName);
  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = crypto.randomBytes(2).toString('hex');
    const candidate = `${base}${suffix}`;
    const existing = await db.get('SELECT id FROM users WHERE username = $1', [candidate]);
    if (!existing) return candidate;
  }
  return `${base}${crypto.randomUUID().slice(0, 8)}`;
}

function parsePrefs(row) {
  try {
    const p = JSON.parse(row?.prefs_json || '{}');
    return {
      notifyPrefs: p.notifyPrefs || { posts: true, gifts: true, brands: true },
      showTotals: p.showTotals !== false,
      anonDefault: p.anonDefault === true,
    };
  } catch {
    return { notifyPrefs: { posts: true, gifts: true, brands: true }, showTotals: true, anonDefault: false };
  }
}

function publicUser(u) {
  return {
    id: u.id,
    displayName: u.display_name,
    username: u.username,
    age: u.age,
    country: u.country,
    city: u.city,
    about: u.about,
    language: u.language,
    photoUrl: u.photo_url,
    suspended: u.suspended === 1,
    prefs: parsePrefs(u),
    createdAt: u.created_at,
    // Versioned consent (items 402/492): false until the user has accepted
    // the CURRENT Terms + Privacy versions; the app shows re-acceptance then.
    consentCurrent: consentIsCurrent(u),
    termsAcceptedVersion: u.terms_accepted_version || null,
    privacyAcceptedVersion: u.privacy_accepted_version || null,
    termsAcceptedAt: u.terms_accepted_at || null,
    privacyAcceptedAt: u.privacy_accepted_at || null,
  };
}

// POST /api/auth/onboard — create a profile from simple questions.
router.post('/onboard', rateLimit('onboard', 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const validationError = validateOnboarding(req.body || {});
    if (validationError) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: validationError } });
    }
    const age = Number(req.body.age);
    // 18+ HARD BLOCK — no profile row, no partial data kept.
    if (age < 18) {
      return res.status(403).json({
        error: {
          code: 'AGE_BLOCK',
          message: 'Sahay Pay is for adults only (18+). You can\'t create a profile yet.',
        },
      });
    }

    const displayName = cleanStr(req.body.displayName, 60);
    const username = await generateUsername(displayName);
    const id = crypto.randomUUID();
    const now = nowIso();
    // Item 855: per-device account cap — one browser user-agent (coarse UA
    // hash; no IP is stored) may create at most 5 accounts a day.
    const fp = uaHash(req.headers['user-agent']);
    const recentSameDevice = await db.get(
      `SELECT COUNT(*) AS c FROM users WHERE ua_hash = $1 AND created_at >= $2`,
      [fp, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
    );
    if (Number(recentSameDevice?.c || 0) >= 5) {
      return res.status(429).json({
        error: { code: 'DEVICE_LIMIT', message: 'Too many accounts were created from this device today. Please try again tomorrow.' },
      });
    }
    // Optional onboarding photo: only an uploaded image is accepted.
    const photoUrl = typeof req.body.photoUrl === 'string' && req.body.photoUrl.startsWith('/uploads/public/')
      ? cleanStr(req.body.photoUrl, 500)
      : null;
    // One-time recovery code: generated here, shown ONCE in the response,
    // and NEVER stored or logged in plain text — only a scrypt hash (for
    // verification) and a SHA-256 lookup key reach the database.
    const recoveryCode = generateRecoveryCode();
    await db.run(
      `INSERT INTO users (id, display_name, username, age, country, city, about, language, photo_url,
        recovery_code_hash, recovery_code_lookup,
        terms_accepted_version, terms_accepted_at, privacy_accepted_version, privacy_accepted_at,
        ua_hash, suspended, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 0, $17)`,
      [
        id, displayName, username, age, req.body.country, cleanStr(req.body.city, 120),
        cleanStr(req.body.about || '', 500), req.body.language || 'en', photoUrl,
        hashSecret(recoveryCode.replace(/-/g, '')),
        recoveryLookupKey(recoveryCode),
        TERMS_VERSION, now, PRIVACY_VERSION, now,
        fp,
        now,
      ]
    );
    const user = await db.get('SELECT * FROM users WHERE id = $1', [id]);
    const session = await createSession(id, req.headers['user-agent']);
    res.cookie('sp_session', session.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60 * 1000, req));
    await logAudit('user', id, 'user_onboarded', 'user', id, { country: req.body.country });
    // Item 923: the 18+ age-gate pass is an audit-logged event (timestamped).
    await logAudit('user', id, 'age_gate_passed', 'user', id, { age });
    res.status(201).json({
      user: publicUser(user),
      sessionExpiresAt: session.expiresAt,
      csrfToken: session.csrfToken,
      // Shown ONCE — the frontend displays it on the success screen and
      // never asks for it again.
      recoveryCode,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — who is signed in (null when logged out). Deliberately
// 200 for logged-out visitors: the app calls this on every load, and a 401
// would log a console error for every first-time visitor.
// When signed in, also returns the CSRF token for this session.
router.get('/me', async (req, res) => {
  if (!req.user || !req.sessionRow) return res.json({ user: null });
  const csrfToken =
    req.sessionRow.csrf_token || (await getOrCreateCsrfToken('sessions', req.cookies?.sp_session));
  res.json({ user: req.user, csrfToken });
});

// GET /api/auth/csrf — (re-)fetch this session's CSRF token.
router.get('/csrf', requireAuth, async (req, res, next) => {
  try {
    const csrfToken =
      req.sessionRow?.csrf_token || (await getOrCreateCsrfToken('sessions', req.cookies?.sp_session));
    res.json({ csrfToken });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/recover {code} — returning-user path. No email, no phone,
// no password: the one-time recovery code from onboarding restores the
// session. Rate-limited like a login; failures are deliberately generic.
router.post('/recover', rateLimit('recover', 5, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const user = await findUserByRecoveryCode(req.body?.code);
    if (!user) {
      return res.status(401).json({
        error: { code: 'INVALID_CODE', message: 'That recovery code was not recognised. Check it and try again.' },
      });
    }
    if (user.suspended === 1) {
      return res.status(403).json({
        error: { code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended. Contact support via the Help Centre.' },
      });
    }
    const session = await createSession(user.id, req.headers['user-agent']);
    res.cookie('sp_session', session.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60 * 1000, req));
    await logAudit('user', user.id, 'user_recovered', 'user', user.id, {});
    res.json({
      user: publicUser(user),
      sessionExpiresAt: session.expiresAt,
      csrfToken: session.csrfToken,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/re-consent {termsAccepted, privacyAccepted} — accept the
// CURRENT Terms + Privacy versions (shown in-app when the version bumps).
router.post('/re-consent', requireAuth, async (req, res, next) => {
  try {
    if (req.body?.termsAccepted !== true || req.body?.privacyAccepted !== true) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Please agree to both the Terms and the Privacy Policy.' },
      });
    }
    const now = nowIso();
    await db.run(
      `UPDATE users SET terms_accepted_version = $1, terms_accepted_at = $2,
       privacy_accepted_version = $3, privacy_accepted_at = $4 WHERE id = $5`,
      [TERMS_VERSION, now, PRIVACY_VERSION, now, req.user.id]
    );
    await logAudit('user', req.user.id, 'consent_accepted', 'user', req.user.id, {
      termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION,
    });
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.user.id]);
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/sessions — active sessions for this profile (item 112).
router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    const sessions = await listUserSessions(req.user.id, req.cookies?.sp_session);
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auth/sessions/:id — revoke one session (12-char id prefix).
router.delete('/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    const revoked = await destroyUserSessionById(req.user.id, req.params.id);
    if (!revoked) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found.' } });
    }
    await logAudit('user', req.user.id, 'session_revoked', 'user', req.user.id, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout — end this device's session.
router.post('/logout', async (req, res, next) => {
  try {
    // Item 814: plain logout is audit-logged (login events already were).
    if (req.user) await logAudit('user', req.user.id, 'user_logout', 'user', req.user.id, {});
    await destroySession(req.cookies?.sp_session);
    res.clearCookie('sp_session', { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout-all — revoke every session for this profile.
// Item 813: rate-limited per account (3/hour) so a stolen token cannot
// lock the owner out repeatedly.
router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    const result = await checkRateLimit(`logout-all:user:${req.user.id}`, 3, 60 * 60 * 1000);
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfterSec));
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'You logged out of all devices too often — please wait a little and try again.' },
      });
    }
    await destroyAllUserSessions(req.user.id);
    res.clearCookie('sp_session', { path: '/' });
    await logAudit('user', req.user.id, 'user_logout_all', 'user', req.user.id, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout-others — item 821: revoke every session EXCEPT
// this one (the "someone else is in my account" button).
router.post('/logout-others', requireAuth, async (req, res, next) => {
  try {
    const revoked = await destroyOtherUserSessions(req.user.id, req.cookies?.sp_session);
    await logAudit('user', req.user.id, 'user_logout_others', 'user', req.user.id, { revoked });
    res.json({ ok: true, revoked });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/auth/sessions/:id/note — item 816: a "trusted device" note the
// owner can set per session ("My phone", "Shared tablet — do not trust").
router.patch('/sessions/:id/note', requireAuth, async (req, res, next) => {
  try {
    const note = cleanStr(req.body?.note || '', 60);
    const idPrefix = String(req.params.id || '');
    if (!/^[0-9a-f]{12}$/.test(idPrefix)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found.' } });
    }
    const result = await db.run(
      'UPDATE sessions SET trusted_note = $1 WHERE user_id = $2 AND token_hash LIKE $3',
      [note || null, req.user.id, `${idPrefix}%`]
    );
    if ((result.changes || 0) === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found.' } });
    }
    res.json({ ok: true, note: note || null });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/recovery-code/regenerate — item 823: issue a fresh
// recovery code (shown once, like onboarding) and invalidate the old one.
// The session token is rotated too (item 802).
router.post('/recovery-code/regenerate', requireAuth, async (req, res, next) => {
  try {
    const recoveryCode = generateRecoveryCode();
    await db.run(
      'UPDATE users SET recovery_code_hash = $1, recovery_code_lookup = $2 WHERE id = $3',
      [hashSecret(recoveryCode.replace(/-/g, '')), recoveryLookupKey(recoveryCode), req.user.id]
    );
    await rotateSession(req, res);
    await logAudit('user', req.user.id, 'recovery_code_regenerated', 'user', req.user.id, {});
    res.json({ recoveryCode });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/confirm-identity {code} — item 839 support: re-prove who
// you are with your recovery code. Marks this session freshly authenticated
// for 15 minutes, which sensitive edits (payout details) require.
router.post('/confirm-identity', requireAuth, async (req, res, next) => {
  try {
    const user = await findUserByRecoveryCode(req.body?.code);
    if (!user || user.id !== req.user.id) {
      return res.status(401).json({
        error: { code: 'INVALID_CODE', message: 'That recovery code was not recognised. Check it and try again.' },
      });
    }
    await db.run(
      'UPDATE sessions SET reauthed_at = $1 WHERE token_hash = $2',
      [nowIso(), hashToken(req.cookies?.sp_session || '')]
    );
    await logAudit('user', req.user.id, 'identity_reconfirmed', 'user', req.user.id, {});
    res.json({ ok: true, freshUntilMinutes: 15 });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/security-activity — item 825: the user's own security
// timeline (logins, payout reveals, PIN-adjacent events) from the audit log.
router.get('/security-activity', requireAuth, async (req, res, next) => {
  try {
    const ACTIONS = [
      'user_onboarded', 'user_recovered', 'user_logout', 'user_logout_all',
      'user_logout_others', 'session_revoked', 'session_fingerprint_changed',
      'payout_revealed', 'payout_reveal_blocked', 'payout_reveal_anomaly',
      'recovery_code_regenerated', 'identity_reconfirmed', 'consent_accepted',
      'bill_payout_changed', 'profile_updated', 'age_gate_passed',
    ];
    const ph = ACTIONS.map((_, i) => `$${i + 2}`).join(',');
    const { rows } = await db.query(
      `SELECT action, target_type, target_id, meta_json, created_at FROM audit_logs
       WHERE actor_type = 'user' AND actor_id = $1 AND action IN (${ph})
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id, ...ACTIONS]
    );
    res.json({
      events: rows.map((r) => ({
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/delete-by-recovery {code, confirm:"DELETE"} — item 916:
// "delete my data" for users who lost access (logged out, no session).
// Verified by the recovery code; same full deletion as /profile/delete.
router.post('/delete-by-recovery', rateLimit('delete-by-recovery', 5, 60 * 60 * 1000), async (req, res, next) => {
  try {
    if (req.body?.confirm !== 'DELETE') {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Type DELETE to confirm permanent deletion.' },
      });
    }
    const user = await findUserByRecoveryCode(req.body?.code);
    if (!user) {
      return res.status(401).json({
        error: { code: 'INVALID_CODE', message: 'That recovery code was not recognised. Check it and try again.' },
      });
    }
    const userId = user.id;
    await destroyAllUserSessions(userId);
    await db.run('DELETE FROM users WHERE id = $1', [userId]);
    await logAudit('user', userId, 'user_deleted', 'user', userId, { via: 'recovery_code' });
    res.json({ ok: true, message: 'Your account and its data have been deleted.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.publicUser = publicUser;
