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
  createSession, destroySession, destroyAllUserSessions,
  requireAuth, sessionCookieOptions, SESSION_DAYS, rateLimit,
} = require('../lib/auth');
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
    // Optional onboarding photo: only an uploaded image is accepted.
    const photoUrl = typeof req.body.photoUrl === 'string' && req.body.photoUrl.startsWith('/uploads/public/')
      ? cleanStr(req.body.photoUrl, 500)
      : null;
    await db.run(
      `INSERT INTO users (id, display_name, username, age, country, city, about, language, photo_url, suspended, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10)`,
      [
        id, displayName, username, age, req.body.country, cleanStr(req.body.city, 120),
        cleanStr(req.body.about || '', 500), req.body.language || 'en', photoUrl, now,
      ]
    );
    const user = await db.get('SELECT * FROM users WHERE id = $1', [id]);
    const session = await createSession(id);
    res.cookie('sp_session', session.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60 * 1000));
    await logAudit('user', id, 'user_onboarded', 'user', id, { country: req.body.country });
    res.status(201).json({ user: publicUser(user), sessionExpiresAt: session.expiresAt });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — restore the session (returning user lands straight in).
router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/logout — end this device's session.
router.post('/logout', async (req, res, next) => {
  try {
    await destroySession(req.cookies?.sp_session);
    res.clearCookie('sp_session', { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout-all — revoke every session for this profile.
router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await destroyAllUserSessions(req.user.id);
    res.clearCookie('sp_session', { path: '/' });
    await logAudit('user', req.user.id, 'user_logout_all', 'user', req.user.id, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.publicUser = publicUser;
