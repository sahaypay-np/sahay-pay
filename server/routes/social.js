// Sahay Pay — social routes (Phase 2 §5).
// Follows (443–448), server-side blocks (449), thank-yous (423–430),
// receiver stories (482–484), followed-users activity feed (447),
// achievement definitions (417).
// Thank-yous and stories go through owner review before anything is public.

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive, rateLimit } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { createReviewPacket, createNotification } = require('../lib/notify');
const { ACHIEVEMENT_DEFS, listAchievements, awardAchievements } = require('../lib/achievements');

const router = express.Router();

// --- Follows (items 443–448) ---

async function userByUsername(username) {
  return db.get('SELECT * FROM users WHERE username = $1', [username]);
}

// POST /api/social/follow/:username
router.post('/follow/:username', requireActive, async (req, res, next) => {
  try {
    const target = await userByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    if (target.id === req.user.id) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'You cannot follow yourself.' } });
    }
    // Blocks prevent follows (item 449).
    const blocked = await db.get(
      `SELECT id FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [req.user.id, target.id]
    );
    if (blocked) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot follow this person.' } });
    }
    const existing = await db.get(
      'SELECT id FROM follows WHERE follower_id = $1 AND followee_id = $2', [req.user.id, target.id]
    );
    if (existing) return res.json({ ok: true, following: true });
    await db.run(
      `INSERT INTO follows (id, follower_id, followee_id, created_at) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), req.user.id, target.id, nowIso()]
    );
    await createNotification(
      target.id, 'new_follower', 'You have a new follower',
      `${req.user.displayName} started following you.`, `#/profile/${req.user.username}`
    );
    await logAudit('user', req.user.id, 'user_followed', 'user', target.id, {});
    res.status(201).json({ ok: true, following: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/social/follow/:username
router.delete('/follow/:username', requireActive, async (req, res, next) => {
  try {
    const target = await userByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    await db.run('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [req.user.id, target.id]);
    res.json({ ok: true, following: false });
  } catch (err) {
    next(err);
  }
});

// GET /api/social/:username/followers|following — signed-in users only (444),
// hidden when the owner set the pref (448).
router.get('/:username/followers', requireAuth, async (req, res, next) => {
  try {
    const target = await userByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    let prefs = {};
    try { prefs = JSON.parse(target.prefs_json || '{}'); } catch { prefs = {}; }
    if (prefs.hideFollowers && target.id !== req.user.id) {
      return res.json({ followers: [], hidden: true });
    }
    const { rows } = await db.query(
      `SELECT u.id, u.display_name, u.username, u.photo_url, f.created_at
       FROM follows f JOIN users u ON u.id = f.follower_id
       WHERE f.followee_id = $1 ORDER BY f.created_at DESC LIMIT 100`,
      [target.id]
    );
    res.json({
      followers: rows.map((r) => ({
        id: r.id, displayName: r.display_name, username: r.username, photoUrl: r.photo_url, followedAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:username/following', requireAuth, async (req, res, next) => {
  try {
    const target = await userByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    let prefs = {};
    try { prefs = JSON.parse(target.prefs_json || '{}'); } catch { prefs = {}; }
    if (prefs.hideFollowers && target.id !== req.user.id) {
      return res.json({ following: [], hidden: true });
    }
    const { rows } = await db.query(
      `SELECT u.id, u.display_name, u.username, u.photo_url, f.created_at
       FROM follows f JOIN users u ON u.id = f.followee_id
       WHERE f.follower_id = $1 ORDER BY f.created_at DESC LIMIT 100`,
      [target.id]
    );
    res.json({
      following: rows.map((r) => ({
        id: r.id, displayName: r.display_name, username: r.username, photoUrl: r.photo_url, followedAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/social/activity — followed users' public actions (447):
// confirmed gifts given + bills fully paid, newest first.
router.get('/activity', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT g.id, g.amount_minor, g.currency, g.confirmed_at, g.bill_id,
              b.title AS bill_title, b.status AS bill_status,
              u.display_name, u.username, u.photo_url
       FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
       WHERE g.status = 'confirmed' AND g.anonymous = 0
         AND g.supporter_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
       ORDER BY g.confirmed_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({
      activity: rows.map((r) => ({
        id: r.id, kind: r.bill_status === 'completed' ? 'bill_fully_paid' : 'gift_given',
        amountMinor: r.amount_minor, currency: r.currency, confirmedAt: r.confirmed_at,
        billId: r.bill_id, billTitle: r.bill_title,
        actorName: r.display_name, actorUsername: r.username, actorPhoto: r.photo_url,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// --- Server-side blocks (item 449) ---

router.post('/block/:username', requireActive, async (req, res, next) => {
  try {
    const target = await userByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    if (target.id === req.user.id) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'You cannot block yourself.' } });
    }
    const existing = await db.get(
      'SELECT id FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.user.id, target.id]
    );
    if (!existing) {
      await db.run(
        `INSERT INTO user_blocks (id, blocker_id, blocked_id, created_at) VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), req.user.id, target.id, nowIso()]
      );
      // Blocking removes follows both ways.
      await db.run(
        `DELETE FROM follows WHERE (follower_id = $1 AND followee_id = $2) OR (follower_id = $2 AND followee_id = $1)`,
        [req.user.id, target.id]
      );
      await logAudit('user', req.user.id, 'user_blocked', 'user', target.id, {});
    }
    res.status(201).json({ ok: true, blocked: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/block/:username', requireActive, async (req, res, next) => {
  try {
    const target = await userByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    await db.run('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.user.id, target.id]);
    res.json({ ok: true, blocked: false });
  } catch (err) {
    next(err);
  }
});

router.get('/blocks', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.display_name, u.username, u.photo_url, b.created_at
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = $1 ORDER BY b.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({
      blocked: rows.map((r) => ({
        id: r.id, displayName: r.display_name, username: r.username, photoUrl: r.photo_url, blockedAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// --- Thank-yous (items 423–430) ---

// POST /api/social/thanks {giftId, body, videoUrl?, videoDurationSec?}
// Written (424) or video (425, ≤60s) thank-you from the bill page per
// confirmed gift. Goes to owner review (427) before any public display.
router.post('/thanks', requireActive, rateLimit('thank-you', 20, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const giftId = cleanStr(req.body?.giftId, 64);
    const body = cleanStr(req.body?.body || '', 1000);
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [giftId]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the person who posted the bill can thank a giver.' } });
    }
    if (gift.status !== 'confirmed') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Only a confirmed gift can be thanked.' } });
    }
    // Video thank-you (items 425/426): ≤60s, uploaded video file only.
    // Uploads are ephemeral on serverless (P1-926) and capped at 5MB, so
    // a video thank-you is a short clip uploaded through the normal flow.
    const videoUrl = req.body?.videoUrl ? cleanStr(req.body.videoUrl, 500) : null;
    const videoDurationSec = req.body?.videoDurationSec ? Math.floor(Number(req.body.videoDurationSec)) : null;
    if (videoUrl) {
      if (!videoUrl.startsWith('/uploads/public/')) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Video must be an uploaded file.' } });
      }
      if (videoDurationSec !== null && (videoDurationSec < 1 || videoDurationSec > 60)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Video thank-yous must be 60 seconds or shorter.' } });
      }
    }
    if (!body && !videoUrl) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Write a thank-you or attach a video.' } });
    }
    const existing = await db.get(
      `SELECT id FROM thanks WHERE gift_id = $1 AND status IN ('pending_review', 'approved')`,
      [gift.id]
    );
    if (existing) {
      return res.status(409).json({ error: { code: 'ALREADY_SUBMITTED', message: 'You already thanked this giver.' } });
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO thanks (id, gift_id, bill_id, giver_id, receiver_id, body, video_url, video_duration_sec, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_review', $9)`,
      [id, gift.id, bill.id, gift.supporter_id, req.user.id, body, videoUrl, videoDurationSec, nowIso()]
    );
    const packet = await createReviewPacket('thank', id, {
      kind: 'thank',
      thankId: id,
      giftId: gift.id,
      billId: bill.id,
      billTitle: bill.title,
      body,
      videoUrl,
      receiver: { displayName: req.user.displayName, username: req.user.username },
    });
    await logAudit('user', req.user.id, 'thank_you_submitted', 'thank', id, { giftId: gift.id });
    res.status(201).json({ ok: true, thankId: id, reviewPacketId: packet.id });
  } catch (err) {
    next(err);
  }
});

// GET /api/social/thanks/feed — public thank-you feed (item 429).
router.get('/thanks/feed', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT t.id, t.body, t.video_url, t.created_at, b.id AS bill_id, b.title AS bill_title,
              g.display_name AS giver_name, g.username AS giver_username,
              r.display_name AS receiver_name, r.username AS receiver_username,
              (SELECT COUNT(*) FROM thank_reactions tr WHERE tr.thank_id = t.id) AS reactions
       FROM thanks t JOIN bills b ON b.id = t.bill_id
       JOIN users g ON g.id = t.giver_id JOIN users r ON r.id = t.receiver_id
       WHERE t.status = 'approved' ORDER BY t.created_at DESC LIMIT 50`
    );
    res.json({
      thanks: rows.map((x) => ({
        id: x.id, body: x.body, videoUrl: x.video_url, createdAt: x.created_at,
        billId: x.bill_id, billTitle: x.bill_title,
        giverName: x.giver_name, giverUsername: x.giver_username,
        receiverName: x.receiver_name, receiverUsername: x.receiver_username,
        reactions: Number(x.reactions || 0),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/social/thanks/:id/react {kind: heart|clap|legend} (item 430).
router.post('/thanks/:id/react', requireActive, async (req, res, next) => {
  try {
    const kind = req.body?.kind;
    if (!['heart', 'clap', 'legend'].includes(kind)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Reaction must be heart, clap or legend.' } });
    }
    const thank = await db.get('SELECT * FROM thanks WHERE id = $1 AND status = $2', [req.params.id, 'approved']);
    if (!thank) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Thank-you not found.' } });
    const existing = await db.get(
      'SELECT id, kind FROM thank_reactions WHERE thank_id = $1 AND user_id = $2',
      [thank.id, req.user.id]
    );
    if (existing) {
      if (existing.kind === kind) {
        // Tap again to remove.
        await db.run('DELETE FROM thank_reactions WHERE id = $1', [existing.id]);
        return res.json({ ok: true, reacted: false });
      }
      await db.run('UPDATE thank_reactions SET kind = $1 WHERE id = $2', [kind, existing.id]);
    } else {
      await db.run(
        `INSERT INTO thank_reactions (id, thank_id, user_id, kind, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), thank.id, req.user.id, kind, nowIso()]
      );
    }
    const counts = await db.query(
      `SELECT kind, COUNT(*) AS c FROM thank_reactions WHERE thank_id = $1 GROUP BY kind`,
      [thank.id]
    );
    res.json({
      ok: true, reacted: true, kind,
      counts: Object.fromEntries(counts.rows.map((r) => [r.kind, Number(r.c)])),
    });
  } catch (err) {
    next(err);
  }
});

// --- Receiver stories (items 482–484) ---

// POST /api/social/stories {billId, body} — post-completion update composer.
router.post('/stories', requireActive, rateLimit('story', 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const billId = cleanStr(req.body?.billId, 64);
    const body = cleanStr(req.body?.body || '', 2000);
    if (body.length < 10) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please write your update (10+ characters).' } });
    }
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [billId]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    if (bill.status !== 'completed') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Stories can only be posted on fully-paid bills.' } });
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO receiver_stories (id, bill_id, user_id, body, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending_review', $5)`,
      [id, bill.id, req.user.id, body, nowIso()]
    );
    const packet = await createReviewPacket('story', id, {
      kind: 'story',
      storyId: id,
      billId: bill.id,
      billTitle: bill.title,
      body,
      author: { displayName: req.user.displayName, username: req.user.username },
    });
    await logAudit('user', req.user.id, 'story_submitted', 'story', id, { billId: bill.id });
    res.status(201).json({ ok: true, storyId: id, reviewPacketId: packet.id });
  } catch (err) {
    next(err);
  }
});

// GET /api/social/stories/:billId — approved stories for one bill.
router.get('/stories/:billId', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.body, s.created_at, u.display_name, u.username
       FROM receiver_stories s JOIN users u ON u.id = s.user_id
       WHERE s.bill_id = $1 AND s.status = 'approved' ORDER BY s.created_at DESC LIMIT 20`,
      [req.params.billId]
    );
    res.json({
      stories: rows.map((r) => ({
        id: r.id, body: r.body, createdAt: r.created_at, authorName: r.display_name, authorUsername: r.username,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// --- Achievements (items 415–417, 486–489) ---

router.get('/achievements/definitions', async (req, res, next) => {
  try {
    const counts = await db.query(
      `SELECT key, COUNT(*) AS holders FROM achievements GROUP BY key`
    );
    const holders = Object.fromEntries(counts.rows.map((r) => [r.key, Number(r.c)]));
    res.json({
      achievements: ACHIEVEMENT_DEFS.map((d) => ({
        key: d.key, name: d.name, desc: d.desc, icon: d.icon, holders: holders[d.key] || 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/achievements/:username', async (req, res, next) => {
  try {
    const target = await userByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } });
    // Award any newly-earned badges lazily on read.
    try { await awardAchievements(target.id); } catch { /* best-effort */ }
    res.json({ achievements: await listAchievements(target.id) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
