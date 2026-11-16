// Sahay Pay — referral programme routes (Phase 2 §7, items 671–680).
// GET /api/referrals/me, GET /api/referrals/leaders,
// GET /api/referrals/landing/:code (public landing data),
// POST /api/referrals/opt-out | /opt-in.

'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const {
  ensureReferralCode, activeReferralCount, totalReferralCount, badgesFor,
} = require('../lib/referrals');

const router = express.Router();

function referralLink(req, code) {
  const origin = `${req.protocol}://${req.get('host')}`;
  return `${origin}/#/r/${code}`;
}

// GET /api/referrals/me — my code, link, counts, badges (671/675/676).
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const code = await ensureReferralCode(req.user.id);
    const user = await db.get('SELECT prefs_json FROM users WHERE id = $1', [req.user.id]);
    let optedOut = false;
    try { optedOut = JSON.parse(user?.prefs_json || '{}').referralOptOut === true; } catch { /* no */ }
    const active = await activeReferralCount(req.user.id);
    const total = await totalReferralCount(req.user.id);
    res.json({
      code,
      link: referralLink(req, code),
      activeReferrals: active,
      totalReferrals: total,
      badges: badgesFor(active),
      nextBadge: [1, 5, 10].find((b) => active < b) || null,
      optedOut,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/referrals/leaders — top referrers by active friends (675).
router.get('/leaders', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.display_name, u.username, u.photo_url,
              (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.id AND (
                 EXISTS (SELECT 1 FROM bills b WHERE b.user_id = r.id AND b.status != 'draft')
                 OR EXISTS (SELECT 1 FROM gifts g WHERE g.supporter_id = r.id)
               )) AS active_count
       FROM users u
       WHERE EXISTS (SELECT 1 FROM users r WHERE r.referred_by = u.id)
       ORDER BY active_count DESC, u.created_at ASC LIMIT 20`
    );
    res.json({
      leaders: rows.map((r, i) => ({
        rank: i + 1,
        displayName: r.display_name,
        username: r.username,
        photoUrl: r.photo_url,
        activeReferrals: Number(r.active_count),
        badges: badgesFor(Number(r.active_count)),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/referrals/landing/:code — public landing page data (672):
// the referrer's first name only (no other personal data).
router.get('/landing/:code', async (req, res, next) => {
  try {
    const code = cleanStr(req.params.code, 16).toUpperCase();
    const user = await db.get('SELECT display_name, prefs_json FROM users WHERE referral_code = $1', [code]);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Referral link not found.' } });
    let optedOut = false;
    try { optedOut = JSON.parse(user?.prefs_json || '{}').referralOptOut === true; } catch { /* no */ }
    if (optedOut) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Referral link not found.' } });
    }
    res.json({ referrerFirstName: String(user.display_name || '').split(' ')[0] || 'A friend', code });
  } catch (err) {
    next(err);
  }
});

async function setOptOut(req, res, optedOut) {
  const user = await db.get('SELECT prefs_json FROM users WHERE id = $1', [req.user.id]);
  let prefs = {};
  try { prefs = JSON.parse(user?.prefs_json || '{}'); } catch { prefs = {}; }
  prefs.referralOptOut = optedOut;
  await db.run('UPDATE users SET prefs_json = $1 WHERE id = $2', [JSON.stringify(prefs), req.user.id]);
  res.json({ ok: true, optedOut });
}

// POST /api/referrals/opt-out | /opt-in (680).
router.post('/opt-out', requireAuth, (req, res, next) => setOptOut(req, res, true).catch(next));
router.post('/opt-in', requireAuth, (req, res, next) => setOptOut(req, res, false).catch(next));

module.exports = router;
