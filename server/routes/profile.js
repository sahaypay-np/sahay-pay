// Sahay Pay — profile routes.
// GET/PATCH /api/profile/me, GET /api/profile/:username (public),
// POST /api/profile/delete.
// Photo changes go through owner review (Section 3) before becoming public.

'use strict';

const express = require('express');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, destroyAllUserSessions } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { createReviewPacket } = require('../lib/notify');

const router = express.Router();

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

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// PATCH own profile. Display name / about / city / language change at once.
// Username change allowed when available. Photo change goes to owner review.
router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.notifyPrefs !== undefined && (typeof body.notifyPrefs !== 'object' || Array.isArray(body.notifyPrefs))) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'notifyPrefs must be an object.' } });
    }
    const updates = [];
    const params = [];

    if (body.displayName !== undefined) {
      const name = cleanStr(body.displayName, 60);
      if (name.length < 2) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Display name must be 2–60 characters.' } });
      params.push(name); updates.push(`display_name = $${params.length}`);
    }
    if (body.about !== undefined) {
      const about = cleanStr(body.about, 500);
      params.push(about); updates.push(`about = $${params.length}`);
    }
    if (body.city !== undefined) {
      const city = cleanStr(body.city, 120);
      if (city.length < 2) return res.status(400).json({ error: { code: 'VALIDATION', message: 'City must be 2+ characters.' } });
      params.push(city); updates.push(`city = $${params.length}`);
    }
    if (body.language !== undefined) {
      if (!['en', 'ne', 'hi'].includes(body.language)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Language must be English, Nepali or Hindi.' } });
      }
      params.push(body.language); updates.push(`language = $${params.length}`);
    }
    // Country can change (NP <-> IN): it only drives the currency and the
    // payout methods offered for NEW bills — existing bills keep theirs.
    if (body.country !== undefined) {
      if (!['NP', 'IN'].includes(body.country)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Country must be Nepal or India.' } });
      }
      params.push(body.country); updates.push(`country = $${params.length}`);
    }
    if (body.username !== undefined) {
      const username = cleanStr(body.username, 30).toLowerCase();
      if (!/^[a-z0-9][a-z0-9._]{1,29}$/.test(username)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Username must be 2–30 characters: letters, numbers, dots and underscores.' } });
      }
      const taken = await db.get('SELECT id FROM users WHERE username = $1 AND id != $2', [username, req.user.id]);
      if (taken) return res.status(409).json({ error: { code: 'USERNAME_TAKEN', message: 'That username is taken.' } });
      params.push(username); updates.push(`username = $${params.length}`);
    }

    let photoPacket = null;
    if (body.photoUrl !== undefined && body.photoUrl !== null) {
      const photoUrl = cleanStr(body.photoUrl, 500);
      if (!photoUrl.startsWith('/uploads/public/')) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Profile photo must be an uploaded image.' } });
      }
      // Photo changes go through owner review before becoming public.
      photoPacket = await createReviewPacket('photo', req.user.id, {
        kind: 'photo',
        userId: req.user.id,
        displayName: req.user.displayName,
        username: req.user.username,
        photoUrl,
      });
    }

    if (updates.length) {
      params.push(req.user.id);
      await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
      await logAudit('user', req.user.id, 'profile_updated', 'user', req.user.id, { fields: updates.map((u) => u.split(' = ')[0]) });
    }

    // Notification + privacy preferences live in prefs_json (merged, not replaced).
    if (body.notifyPrefs !== undefined || body.showTotals !== undefined || body.anonDefault !== undefined) {
      const current = await db.get('SELECT prefs_json FROM users WHERE id = $1', [req.user.id]);
      let prefs = {};
      try { prefs = JSON.parse(current?.prefs_json || '{}'); } catch { prefs = {}; }
      if (body.notifyPrefs !== undefined) {
        prefs.notifyPrefs = {
          posts: body.notifyPrefs.posts !== false,
          gifts: body.notifyPrefs.gifts !== false,
          brands: body.notifyPrefs.brands !== false,
        };
      }
      if (body.showTotals !== undefined) prefs.showTotals = body.showTotals === true;
      if (body.anonDefault !== undefined) prefs.anonDefault = body.anonDefault === true;
      await db.run('UPDATE users SET prefs_json = $1 WHERE id = $2', [JSON.stringify(prefs), req.user.id]);
    }

    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.user.id]);
    res.json({
      user: publicUser(user),
      photoPendingReview: Boolean(photoPacket),
      photoPacketId: photoPacket ? photoPacket.id : null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/export — download my data as JSON (items 183/273/429).
// Profile, bills, gifts (given + received), notifications, verifications.
// Payout accounts are NEVER included — only the masked hints. Must stay
// above the /:username route or "export" would match as a username.
router.get('/export', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await db.get('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    const bills = await db.query(
      `SELECT b.id, b.request_code, b.title, b.category, b.company, b.amount_minor, b.currency,
              b.covered_minor, b.due_date, b.story, b.details, b.charity, b.anonymous, b.status,
              b.city, b.country, b.photo_url, b.support_photo_url, b.pay_direct, b.biller_name,
              b.biller_ref, b.biller_destination, b.views, b.created_at, b.updated_at
       FROM bills b WHERE b.user_id = $1 ORDER BY b.created_at DESC`,
      [userId]
    );
    const billIds = bills.rows.map((b) => b.id);
    let payoutHints = [];
    if (billIds.length) {
      const ph = billIds.map((_, i) => `$${i + 1}`).join(',');
      const hints = await db.query(
        `SELECT bill_id, method, holder_name, account_hint FROM payout_methods WHERE bill_id IN (${ph})`,
        billIds
      );
      payoutHints = hints.rows;
    }
    const giftsGiven = await db.query(
      `SELECT id, bill_id, amount_minor, currency, fee_minor, tip_minor, status, reference, created_at, confirmed_at
       FROM gifts WHERE supporter_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    const giftsReceived = await db.query(
      `SELECT g.id, g.bill_id, g.supporter_id, g.amount_minor, g.currency, g.fee_minor, g.tip_minor,
              g.status, g.reference, g.created_at, g.confirmed_at
       FROM gifts g JOIN bills b ON b.id = g.bill_id WHERE b.user_id = $1 ORDER BY g.created_at DESC`,
      [userId]
    );
    const notifications = await db.query(
      `SELECT id, kind, title, body, link, is_read, created_at FROM notifications
       WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    const verifications = await db.query(
      `SELECT id, bill_id, type, status, reviewer_note, created_at, decided_at
       FROM verifications WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    res.set('Content-Disposition', 'attachment; filename="sahay-pay-my-data.json"');
    res.json({
      exportedAt: nowIso(),
      app: 'Sahay Pay',
      profile: publicUser(user),
      bills: bills.rows,
      payoutHints,
      giftsGiven: giftsGiven.rows,
      giftsReceived: giftsReceived.rows,
      notifications: notifications.rows,
      verifications: verifications.rows,
    });
  } catch (err) {
    next(err);
  }
});

// Public profile by username. Never shows payout accounts or private data.
router.get('/:username', async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE username = $1', [req.params.username]);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    const badges = await db.query(
      `SELECT type, status FROM verifications WHERE user_id = $1 AND status = 'approved'`,
      [user.id]
    );
    const liveAsks = await db.query(
      `SELECT id, title, category, amount_minor, covered_minor, currency, photo_url, created_at
       FROM bills WHERE user_id = $1 AND status = 'approved' ORDER BY created_at DESC LIMIT 20`,
      [user.id]
    );
    const totals = await db.get(
      `SELECT
         (SELECT COALESCE(SUM(amount_minor), 0) FROM gifts g WHERE g.supporter_id = $1 AND g.status = 'confirmed') AS given,
         (SELECT COALESCE(SUM(g.amount_minor), 0) FROM gifts g JOIN bills b ON b.id = g.bill_id WHERE b.user_id = $2 AND g.status = 'confirmed') AS received`,
      [user.id, user.id]
    );
    res.json({
      user: {
        displayName: user.display_name,
        username: user.username,
        country: user.country,
        city: user.city,
        about: user.about,
        photoUrl: user.photo_url,
        memberSince: user.created_at,
      },
      badges: badges.rows.map((r) => r.type),
      liveAsks: liveAsks.rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, amountMinor: r.amount_minor,
        coveredMinor: r.covered_minor, currency: r.currency, photoUrl: r.photo_url, createdAt: r.created_at,
      })),
      totals: { givenMinor: Number(totals?.given || 0), receivedMinor: Number(totals?.received || 0) },
    });
  } catch (err) {
    next(err);
  }
});

// Delete account: revokes all sessions and deletes the user row (cascades to
// their bills, gifts, notifications, sessions). Anonymous bill statistics
// are NOT kept in this build — deletion is full deletion.
router.post('/delete', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    await destroyAllUserSessions(userId);
    await db.run('DELETE FROM users WHERE id = $1', [userId]);
    await logAudit('user', userId, 'user_deleted', 'user', userId, {});
    res.clearCookie('sp_session', { path: '/' });
    res.json({ ok: true, message: 'Your account and its data have been deleted.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
