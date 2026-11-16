// Sahay Pay — profile routes.
// GET/PATCH /api/profile/me, GET /api/profile/:username (public),
// POST /api/profile/delete.
// Photo changes go through owner review (Section 3) before becoming public.
// Phase 2 §5: the public profile carries impact stats, tiers, achievements,
// streaks, thank-you wall, gift history, follower counts and privacy
// toggles (items 431/432/462/469–471/490/499).

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, destroyAllUserSessions } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { createReviewPacket } = require('../lib/notify');
const { tierForCount, userGiftStats, listAchievements, maybeAwardHelperOfMonth } = require('../lib/achievements');

const router = express.Router();

function parsePrefs(row) {
  try {
    const p = JSON.parse(row?.prefs_json || '{}');
    return {
      notifyPrefs: p.notifyPrefs || { posts: true, gifts: true, brands: true },
      showTotals: p.showTotals !== false,
      anonDefault: p.anonDefault === true,
      hideGiftHistory: p.hideGiftHistory === true,
      hideLiveAsks: p.hideLiveAsks === true,
      hideFollowers: p.hideFollowers === true,
      hideFromSupporterWall: p.hideFromSupporterWall === true,
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
    coverUrl: u.cover_url || null,
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
      // Bio is 300 chars (item 464).
      const about = cleanStr(body.about, 300);
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

    let coverPacket = null;
    if (body.coverUrl !== undefined && body.coverUrl !== null) {
      // Cover image (item 466): same review flow as the avatar.
      if (body.coverUrl === '') {
        params.push(null);
        updates.push(`cover_url = $${params.length}`);
      } else {
        const coverUrl = cleanStr(body.coverUrl, 500);
        if (!coverUrl.startsWith('/uploads/public/')) {
          return res.status(400).json({ error: { code: 'VALIDATION', message: 'Cover image must be an uploaded image.' } });
        }
        coverPacket = await createReviewPacket('cover', req.user.id, {
          kind: 'cover',
          userId: req.user.id,
          displayName: req.user.displayName,
          username: req.user.username,
          coverUrl,
        });
      }
    }

    if (updates.length) {
      params.push(req.user.id);
      await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
      await logAudit('user', req.user.id, 'profile_updated', 'user', req.user.id, { fields: updates.map((u) => u.split(' = ')[0]) });
    }

    // Notification + privacy preferences live in prefs_json (merged, not replaced).
    const prefKeys = ['notifyPrefs', 'showTotals', 'anonDefault', 'hideGiftHistory', 'hideLiveAsks', 'hideFollowers', 'hideFromSupporterWall'];
    if (prefKeys.some((k) => body[k] !== undefined)) {
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
      for (const k of ['showTotals', 'anonDefault', 'hideGiftHistory', 'hideLiveAsks', 'hideFollowers', 'hideFromSupporterWall']) {
        if (body[k] !== undefined) prefs[k] = body[k] === true;
      }
      await db.run('UPDATE users SET prefs_json = $1 WHERE id = $2', [JSON.stringify(prefs), req.user.id]);
    }

    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.user.id]);
    res.json({
      user: publicUser(user),
      photoPendingReview: Boolean(photoPacket),
      photoPacketId: photoPacket ? photoPacket.id : null,
      coverPendingReview: Boolean(coverPacket),
      coverPacketId: coverPacket ? coverPacket.id : null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/export — download my data as JSON (items 183/273/429).
// Profile, bills, gifts (given + received), notifications, verifications,
// thank-yous, follows, achievements (item 494).
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
    const thanks = await db.query(
      `SELECT id, gift_id, bill_id, giver_id, receiver_id, body, status, created_at
       FROM thanks WHERE giver_id = $1 OR receiver_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    const following = await db.query(
      `SELECT f.followee_id, u.display_name, u.username, f.created_at
       FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = $1 ORDER BY f.created_at DESC`,
      [userId]
    );
    const followers = await db.query(
      `SELECT f.follower_id, u.display_name, u.username, f.created_at
       FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = $1 ORDER BY f.created_at DESC`,
      [userId]
    );
    const achievements = await db.query(
      `SELECT key, awarded_at FROM achievements WHERE user_id = $1 ORDER BY awarded_at ASC`,
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
      thanks: thanks.rows,
      following: following.rows,
      followers: followers.rows,
      achievements: achievements.rows,
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
    const viewerId = req.user?.id || null;
    const isSelf = viewerId === user.id;
    const prefs = parsePrefs(user);
    // Blocked either way: the profile is hidden (item 449).
    if (viewerId && !isSelf) {
      const blocked = await db.get(
        `SELECT id FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [viewerId, user.id]
      );
      if (blocked) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    }
    // Live badges only (expired badges don't count, item 306).
    const badges = await db.query(
      `SELECT type FROM verifications WHERE user_id = $1 AND status = 'approved'
       AND (expires_at IS NULL OR expires_at > $2)`,
      [user.id, nowIso()]
    );
    const liveAsks = await db.query(
      `SELECT id, title, category, amount_minor, covered_minor, currency, photo_url, created_at
       FROM bills WHERE user_id = $1 AND status = 'approved' ORDER BY created_at DESC LIMIT 20`,
      [user.id]
    );
    const totals = await db.get(
      `SELECT
         (SELECT COALESCE(SUM(amount_minor), 0) FROM gifts g WHERE g.supporter_id = $1 AND g.status = 'confirmed') AS given,
         (SELECT COALESCE(SUM(g.amount_minor), 0) FROM gifts g JOIN bills b ON b.id = g.bill_id WHERE b.user_id = $2 AND g.status = 'confirmed') AS received,
         (SELECT COUNT(*) FROM bills WHERE user_id = $3 AND status IN ('approved','completed')) AS bills_posted,
         (SELECT COUNT(*) FROM bills WHERE user_id = $4 AND status = 'completed') AS bills_completed,
         (SELECT COUNT(DISTINCT bill_id) FROM gifts WHERE supporter_id = $5 AND status = 'confirmed') AS bills_helped,
         (SELECT COUNT(DISTINCT b.user_id) FROM gifts g JOIN bills b ON b.id = g.bill_id WHERE g.supporter_id = $6 AND g.status = 'confirmed') AS people_helped`,
      [user.id, user.id, user.id, user.id, user.id, user.id]
    );
    const stats = await userGiftStats(user.id);
    const tier = tierForCount(stats.gifts);
    const achievements = await listAchievements(user.id);
    // Helper-of-the-month badge (item 500): awarded lazily on read.
    try { await maybeAwardHelperOfMonth(user.id); } catch { /* best-effort */ }
    // Gift history (item 469): confirmed gifts, date + category + amount
    // band — never exact recipient details. Hidden when the pref is set.
    let giftHistory = [];
    if (!prefs.hideGiftHistory || isSelf) {
      const hist = await db.query(
        `SELECT g.confirmed_at, g.amount_minor, g.currency, b.category
         FROM gifts g JOIN bills b ON b.id = g.bill_id
         WHERE g.supporter_id = $1 AND g.status = 'confirmed'
         ORDER BY g.confirmed_at DESC LIMIT 50`,
        [user.id]
      );
      giftHistory = hist.rows.map((r) => ({
        confirmedAt: r.confirmed_at,
        category: r.category,
        currency: r.currency,
        // Amount band, not the exact amount.
        amountBand: r.amount_minor <= 500000 ? 'small' : r.amount_minor <= 2500000 ? 'medium' : 'large',
      }));
    }
    // Thank-you wall (item 423): approved thank-yous received.
    const wall = await db.query(
      `SELECT t.id, t.body, t.video_url, t.created_at, b.title AS bill_title,
              u.display_name AS receiver_name, u.username AS receiver_username,
              (SELECT COUNT(*) FROM thank_reactions r WHERE r.thank_id = t.id) AS reactions
       FROM thanks t JOIN bills b ON b.id = t.bill_id JOIN users u ON u.id = t.receiver_id
       WHERE t.giver_id = $1 AND t.status = 'approved' ORDER BY t.created_at DESC LIMIT 20`,
      [user.id]
    );
    // Thank-you rate (item 490): share of confirmed gifts received that
    // the receiver thanked.
    const thankRate = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM gifts g JOIN bills b ON b.id = g.bill_id WHERE b.user_id = $1 AND g.status = 'confirmed') AS received_gifts,
         (SELECT COUNT(*) FROM thanks t WHERE t.receiver_id = $2 AND t.status = 'approved') AS thanked`,
      [user.id, user.id]
    );
    const completedAsks = await db.get(
      `SELECT COUNT(*) AS c FROM bills WHERE user_id = $1 AND status = 'completed'`,
      [user.id]
    );
    // Helper impact summary (item 299): confirmed-gift count, bills helped,
    // giving streaks, split by currency. Only confirmed gifts count.
    const impactRows = await db.query(
      `SELECT currency, amount_minor, confirmed_at, bill_id
       FROM gifts WHERE supporter_id = $1 AND status = 'confirmed' ORDER BY confirmed_at ASC`,
      [user.id]
    );
    const byCurrency = {};
    const billsHelped = new Set();
    const daySet = new Set();
    for (const r of impactRows.rows) {
      const cur = r.currency || 'NPR';
      if (!byCurrency[cur]) byCurrency[cur] = { count: 0, totalMinor: 0 };
      byCurrency[cur].count++;
      byCurrency[cur].totalMinor += r.amount_minor;
      billsHelped.add(r.bill_id);
      if (r.confirmed_at) daySet.add(r.confirmed_at.slice(0, 10));
    }
    // Streaks over UTC calendar days with at least one confirmed gift.
    const days = [...daySet].sort();
    let longestStreak = 0;
    let run = 0;
    let prev = null;
    for (const d of days) {
      const ms = new Date(`${d}T00:00:00Z`).getTime();
      run = prev !== null && ms - prev === 86400000 ? run + 1 : 1;
      prev = ms;
      longestStreak = Math.max(longestStreak, run);
    }
    let currentStreak = 0;
    if (days.length) {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      let cursor = daySet.has(today) ? today : daySet.has(yesterday) ? yesterday : null;
      while (cursor && daySet.has(cursor)) {
        currentStreak++;
        cursor = new Date(new Date(`${cursor}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
      }
    }
    const receivedGifts = Number(thankRate?.received_gifts || 0);
    const thanked = Number(thankRate?.thanked || 0);
    // Follower counts + viewer follow state (items 443/444/448).
    const followCounts = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM follows WHERE followee_id = $1) AS followers,
         (SELECT COUNT(*) FROM follows WHERE follower_id = $2) AS following`,
      [user.id, user.id]
    );
    let following = false;
    let blockedByViewer = false;
    if (viewerId && !isSelf) {
      following = Boolean(await db.get(
        'SELECT id FROM follows WHERE follower_id = $1 AND followee_id = $2', [viewerId, user.id]
      ));
      blockedByViewer = Boolean(await db.get(
        'SELECT id FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [viewerId, user.id]
      ));
    }
    // Response time (item 397): median confirm latency on received gifts.
    const latencies = await db.query(
      `SELECT g.created_at, g.confirmed_at FROM gifts g JOIN bills b ON b.id = g.bill_id
       WHERE b.user_id = $1 AND g.status = 'confirmed' AND g.confirmed_at IS NOT NULL
       ORDER BY g.confirmed_at DESC LIMIT 50`,
      [user.id]
    );
    const hours = latencies.rows
      .map((r) => (new Date(r.confirmed_at).getTime() - new Date(r.created_at).getTime()) / 3600000)
      .filter((h) => Number.isFinite(h) && h >= 0)
      .sort((a, b) => a - b);
    const responseTimeHours = hours.length ? Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10 : null;
    res.json({
      user: {
        displayName: user.display_name,
        username: user.username,
        country: user.country,
        city: user.city,
        about: user.about,
        photoUrl: user.photo_url,
        coverUrl: user.cover_url || null,
        memberSince: user.created_at,
        // Verified-helper indicator (item 394): confirmed-gift history.
        verifiedHelper: stats.gifts > 0,
      },
      badges: badges.rows.map((r) => r.type),
      liveAsks: (prefs.hideLiveAsks && !isSelf) ? [] : liveAsks.rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, amountMinor: r.amount_minor,
        coveredMinor: r.covered_minor, currency: r.currency, photoUrl: r.photo_url, createdAt: r.created_at,
      })),
      totals: {
        givenMinor: Number(totals?.given || 0), receivedMinor: Number(totals?.received || 0),
        billsPosted: Number(totals?.bills_posted || 0),
        billsCompleted: Number(totals?.bills_completed || 0),
        billsHelped: Number(totals?.bills_helped || 0),
        peopleHelped: Number(totals?.people_helped || 0),
      },
      completedAsks: Number(completedAsks?.c || 0),
      impact: {
        confirmedGifts: impactRows.rows.length,
        billsHelped: billsHelped.size,
        byCurrency,
        currentStreakDays: currentStreak,
        longestStreakDays: longestStreak,
      },
      tier: { ...tier, gifts: stats.gifts },
      streak: { weeks: stats.streakWeeks, freezeUsed: stats.freezeUsed },
      achievements,
      giftHistory,
      thankYouWall: wall.rows.map((r) => ({
        id: r.id, body: r.body, videoUrl: r.video_url, createdAt: r.created_at,
        billTitle: r.bill_title, receiverName: r.receiver_name, receiverUsername: r.receiver_username,
        reactions: Number(r.reactions || 0),
      })),
      thankYouRate: receivedGifts > 0 ? Math.round((thanked / receivedGifts) * 100) : null,
      bestWeekMinor: stats.bestWeekMinor,
      bestWeek: stats.bestWeek || null,
      responseTimeHours,
      followers: prefs.hideFollowers && !isSelf ? null : Number(followCounts?.followers || 0),
      followingCount: prefs.hideFollowers && !isSelf ? null : Number(followCounts?.following || 0),
      isFollowing: following,
      isBlockedByViewer: blockedByViewer,
      showTotals: prefs.showTotals,
      hideGiftHistory: prefs.hideGiftHistory,
      hideLiveAsks: prefs.hideLiveAsks,
    });
  } catch (err) {
    next(err);
  }
});

// Delete account: revokes all sessions and deletes the user row (cascades to
// their bills, gifts, notifications, sessions). Anonymised gift counts are
// kept for the leaderboards (item 495) — totals only, no identity.
router.post('/delete', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    // Keep anonymised counts (item 495) before the cascade deletes gifts.
    const anon = await db.query(
      `SELECT currency, COALESCE(SUM(amount_minor), 0) AS total, COUNT(*) AS gifts,
              COUNT(DISTINCT bill_id) AS bills_helped
       FROM gifts WHERE supporter_id = $1 AND status = 'confirmed' GROUP BY currency`,
      [userId]
    );
    for (const r of anon.rows) {
      await db.run(
        `INSERT INTO anon_stats (id, currency, total_minor, gifts, bills_helped, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [crypto.randomUUID(), r.currency, Number(r.total), Number(r.gifts), Number(r.bills_helped), nowIso()]
      );
    }
    await destroyAllUserSessions(userId);
    await db.run('DELETE FROM users WHERE id = $1', [userId]);
    await logAudit('user', userId, 'user_deleted', 'user', userId, { anonKept: anon.rows.length });
    res.clearCookie('sp_session', { path: '/' });
    res.json({ ok: true, message: 'Your account and its data have been deleted.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
