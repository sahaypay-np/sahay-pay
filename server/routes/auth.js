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
const { flagSignal } = require('../lib/fraud');
const { generateReferralCode, checkReferralVelocity } = require('../lib/referrals');

const router = express.Router();

// Small edit-distance helper (item 339): compares display names against
// suspended accounts. Same algorithm family as the feed's typo tolerance.
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let up = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, up + (a[i - 1] === b[j - 1] ? 0 : 1));
      up = tmp;
    }
  }
  return prev[b.length];
}

async function recordSignin(userId, userAgent) {
  // Sign-in history (item 386): timestamp + device only. No IP is stored
  // — location from IP would need a Privacy Policy change and is not
  // collected by design.
  try {
    await db.run(
      `INSERT INTO signin_history (id, user_id, user_agent, created_at) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), userId, String(userAgent || '').slice(0, 500), nowIso()]
    );
  } catch { /* history is advisory */ }
}

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
    // Item 673: referral link — the landing page stores ?ref=CODE and passes
    // it here. The code resolves to an existing user, so a new account can
    // never be its own referrer (self-referral is structurally impossible).
    const refCode = cleanStr(req.body.ref || req.body.referralCode || '', 20).toUpperCase();
    let referredBy = null;
    if (refCode) {
      const referrer = await db.get('SELECT id, prefs_json FROM users WHERE referral_code = $1', [refCode]);
      let optedOut = false;
      try { optedOut = JSON.parse(referrer?.prefs_json || '{}').referralOptOut === true; } catch { /* no */ }
      if (referrer && !optedOut) {
        referredBy = referrer.id;
        // Item 678: referral-velocity flag (5+ signups via one code in 24h
        // -> audit flag for admin review; no device identification).
        await checkReferralVelocity(referrer.id);
      }
    }
    const referralCode = await generateReferralCode();
    await db.run(
      `INSERT INTO users (id, display_name, username, age, country, city, about, language, photo_url,
        recovery_code_hash, recovery_code_lookup,
        terms_accepted_version, terms_accepted_at, privacy_accepted_version, privacy_accepted_at,
        ua_hash, suspended, referral_code, referred_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 0, $17, $18, $19)`,
      [
        id, displayName, username, age, req.body.country, cleanStr(req.body.city, 120),
        cleanStr(req.body.about || '', 500), req.body.language || 'en', photoUrl,
        hashSecret(recoveryCode.replace(/-/g, '')),
        recoveryLookupKey(recoveryCode),
        TERMS_VERSION, now, PRIVACY_VERSION, now,
        fp,
        referralCode, referredBy,
        now,
      ]
    );
    const user = await db.get('SELECT * FROM users WHERE id = $1', [id]);
    const session = await createSession(id, req.headers['user-agent']);
    res.cookie('sp_session', session.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60 * 1000, req));
    await logAudit('user', id, 'user_onboarded', 'user', id, { country: req.body.country });
    // Item 923: the 18+ age-gate pass is an audit-logged event (timestamped).
    await logAudit('user', id, 'age_gate_passed', 'user', id, { age });
    await recordSignin(id, req.headers['user-agent']);
    // Name-similarity check (item 339): flag (never block) when the new
    // display name closely matches a suspended account.
    try {
      const suspended = await db.query(
        `SELECT display_name FROM users WHERE suspended = 1 AND id != $1 LIMIT 200`,
        [id]
      );
      const mine = normName(displayName);
      for (const s of suspended.rows) {
        if (mine.length >= 4 && editDistance(mine, normName(s.display_name)) <= 2) {
          await flagSignal({
            userId: id, signal: 'name_similar_suspended',
            detail: `Display name closely matches a suspended account.`, severity: 'medium',
          });
          break;
        }
      }
    } catch { /* best-effort */ }
    // One-account signals (item 383): same user-agent + created within
    // 10 minutes of another account. No fingerprinting (P1-269) — only
    // the user-agent string the browser already sends, plus timing.
    // Flags for manual review; never blocks onboarding.
    try {
      const ua = String(req.headers['user-agent'] || '').slice(0, 500);
      if (ua) {
        const twin = await db.get(
          `SELECT u.id FROM users u JOIN sessions s ON s.user_id = u.id
           WHERE u.id != $1 AND s.user_agent = $2 AND u.created_at >= $3 LIMIT 1`,
          [id, ua, new Date(Date.now() - 10 * 60 * 1000).toISOString()]
        );
        if (twin) {
          await flagSignal({
            userId: id, signal: 'one_account_signals',
            detail: 'Created within 10 minutes of another account from the same device pattern.',
            severity: 'low',
          });
        }
      }
    } catch { /* best-effort */ }
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
      // Lazy expiry: a timed suspension ends on its own (item 384).
      if (user.suspended_until && new Date(user.suspended_until).getTime() <= Date.now()) {
        await db.run(
          `UPDATE users SET suspended = 0, suspended_reason = '', suspended_until = NULL, suspended_at = NULL WHERE id = $1`,
          [user.id]
        );
      } else {
        // Suspension notice (item 385): reason + how to appeal.
        return res.status(403).json({
          error: {
            code: 'ACCOUNT_SUSPENDED',
            message: 'This account is suspended. Contact support via the Help Centre.',
            suspendedReason: user.suspended_reason || '',
            suspendedUntil: user.suspended_until || null,
            canAppeal: true,
          },
        });
      }
    }
    const session = await createSession(user.id, req.headers['user-agent']);
    res.cookie('sp_session', session.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60 * 1000, req));
    await logAudit('user', user.id, 'user_recovered', 'user', user.id, {});
    await recordSignin(user.id, req.headers['user-agent']);
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

// GET /api/auth/signin-history — own sign-in history (item 386).
router.get('/signin-history', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, user_agent, created_at FROM signin_history
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({
      history: rows.map((r) => ({ id: r.id, userAgent: r.user_agent, createdAt: r.created_at })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/appeal — appeal a suspension (item 384).
// A suspended user who logged out cannot recover (recover rejects
// suspended accounts), so the appeal accepts either a live session OR
// the recovery code as proof of identity.
router.post('/appeal', rateLimit('appeal', 5, 60 * 60 * 1000), async (req, res, next) => {
  try {
    let user = null;
    if (req.user) {
      user = await db.get('SELECT * FROM users WHERE id = $1', [req.user.id]);
    } else if (req.body?.code) {
      user = await findUserByRecoveryCode(req.body.code);
    }
    if (!user) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in or enter your recovery code to appeal.' } });
    }
    if (user.suspended !== 1) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Your account is not suspended.' } });
    }
    const body = cleanStr(req.body?.body || '', 2000);
    if (body.length < 10) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please explain your appeal (10+ characters).' } });
    }
    const existing = await db.get(
      `SELECT id FROM appeals WHERE target_type = 'user' AND target_id = $1 AND status = 'open'`,
      [user.id]
    );
    if (existing) {
      return res.status(409).json({ error: { code: 'ALREADY_SUBMITTED', message: 'You already have an open appeal.' } });
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO appeals (id, user_id, target_type, target_id, body, status, reviewer_note, created_at, decided_at)
       VALUES ($1, $2, 'user', $3, $4, 'open', '', $5, NULL)`,
      [id, user.id, user.id, body, nowIso()]
    );
    await logAudit('user', user.id, 'appeal_filed', 'user', user.id, { appealId: id });
    res.status(201).json({ ok: true, appealId: id });
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
