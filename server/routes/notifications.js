// Sahay Pay — notifications routes (in-app only; there are no email
// addresses in this product, so there are no email notifications).
// GET /api/notifications (cursor pagination + kind filter),
// GET /api/notifications/:id (detail view), DELETE /api/notifications/:id,
// POST /api/notifications/:id/read, POST /api/notifications/read-all.
// Only notifications whose deliver_at has passed are listed or counted
// (quiet-hours holds, item 617 — lazy delivery on next visit).

'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../lib/auth');
const { nowIso } = require('../lib/audit');
const { createNotification } = require('../lib/notify');

const router = express.Router();

// Filter tabs (item 604): All / Gifts / Bills / Account.
const KIND_GROUPS = {
  gifts: [
    'gift_started', 'gift_details_shown', 'gift_reported_sent', 'gift_confirmed',
    'gift_not_received', 'gift_progress', 'first_gift', 'gift_fully_funded',
    'milestone_giver', 'milestone_helper', 'thank_you_received', 'confirm_reminder',
  ],
  bills: [
    'post_approved', 'post_rejected', 'changes_requested', 'bill_paused',
    'bill_removed', 'bill_restored', 'poster_warned', 'deadline_reminder',
  ],
  account: [
    'verification_approved', 'verification_decided', 'complaint_resolved',
    'appeal_decided', 'report_decided', 'user_notice', 'digest_weekly',
    'digest_monthly', 'referral_milestone', 'referral_friend', 'message_received',
    'announcement', 'broadcast', 'payout_edited', 'verification_reminder',
    'thank_you_reminder', 'auction_outbid', 'auction_paused', 'auction_removed',
    'auction_restored',
  ],
};

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id })).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const obj = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof obj.createdAt === 'string' && typeof obj.id === 'string') return obj;
  } catch { /* fall through */ }
  return null;
}

function publicNotification(r) {
  return {
    id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link,
    isRead: r.is_read === 1, createdAt: r.created_at,
  };
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const group = KIND_GROUPS[req.query.kind] || null;
    const cursor = req.query.cursor ? decodeCursor(req.query.cursor) : null;
    const params = [req.user.id, nowIso()];
    let where = `user_id = $1 AND (deliver_at IS NULL OR deliver_at <= $2)`;
    if (group) {
      const ph = group.map((k) => { params.push(k); return `$${params.length}`; }).join(',');
      where += ` AND kind IN (${ph})`;
    }
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      where += ` AND (created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id < $${params.length}))`;
    }
    const { rows } = await db.query(
      `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`,
      [...params, limit + 1]
    );
    const page = rows.slice(0, limit);
    const unread = await db.get(
      `SELECT COUNT(*) AS c FROM notifications
       WHERE user_id = $1 AND is_read = 0 AND (deliver_at IS NULL OR deliver_at <= $2)`,
      [req.user.id, nowIso()]
    );
    res.json({
      notifications: page.map(publicNotification),
      unreadCount: Number(unread?.c || 0),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    await db.run(
      `UPDATE notifications SET is_read = 1 WHERE user_id = $1 AND (deliver_at IS NULL OR deliver_at <= $2)`,
      [req.user.id, nowIso()]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/reminders — items 659/661/664: lazy reminders,
// computed on read (no scheduler exists). The My Bills screen calls this
// once per session; each reminder is deduplicated by kind+link so it is
// only created once per bill/gift. Returns the reminders so the UI can
// show them inline as well as in the notification list.
router.post('/reminders', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const now = Date.now();
    const reminders = [];
    async function maybeRemind(kind, title, body, link) {
      const existing = await db.get(
        `SELECT id FROM notifications WHERE user_id = $1 AND kind = $2 AND link = $3
         AND created_at >= $4 LIMIT 1`,
        [userId, kind, link, new Date(now - 7 * 24 * 3600000).toISOString()]
      );
      if (existing) {
        reminders.push({ kind, title, body, link, created: false });
        return;
      }
      const id = await createNotification(userId, kind, title, body, link);
      reminders.push({ kind, title, body, link, created: Boolean(id) });
    }
    // 659: own approved bill, expiring within 7 days, under half funded.
    const { rows: expiring } = await db.query(
      `SELECT * FROM bills WHERE user_id = $1 AND status = 'approved'
       AND expires_at IS NOT NULL AND expires_at > $2 AND expires_at < $3`,
      [userId, nowIso(), new Date(now + 7 * 24 * 3600000).toISOString()]
    );
    for (const b of expiring) {
      const pct = Number(b.amount_minor) > 0 ? (Number(b.covered_minor) / Number(b.amount_minor)) * 100 : 100;
      if (pct < 50) {
        await maybeRemind(
          'deadline_reminder',
          'Your bill ends soon',
          `"${b.title}" ends soon and is under half funded — share it while there is still time.`,
          `#/bill/${b.id}`
        );
      }
    }
    // 661: a gift on my bill was reported sent 24h+ ago and I have not
    // confirmed it yet.
    const { rows: unconfirmed } = await db.query(
      `SELECT g.*, b.title AS bill_title FROM gifts g JOIN bills b ON b.id = g.bill_id
       WHERE b.user_id = $1 AND g.status = 'donor_reported_sent' AND g.created_at < $2`,
      [userId, new Date(now - 24 * 3600000).toISOString()]
    );
    for (const g of unconfirmed) {
      await maybeRemind(
        'confirm_reminder',
        'Did the money arrive?',
        `Someone says they sent help for "${g.bill_title}" — please confirm so the helper gets thanked.`,
        `#/mybills`
      );
    }
    // 664: my bill is fully funded — say thank you.
    const { rows: funded } = await db.query(
      `SELECT * FROM bills WHERE user_id = $1 AND status = 'completed'
       AND completed_at >= $2 ORDER BY completed_at DESC LIMIT 5`,
      [userId, new Date(now - 30 * 24 * 3600000).toISOString()]
    );
    for (const b of funded) {
      await maybeRemind(
        'thank_you_reminder',
        'Say thank you',
        `"${b.title}" is fully funded — say thank you to your helpers.`,
        `#/bill/${b.id}`
      );
    }
    res.json({ ok: true, reminders });
  } catch (err) {
    next(err);
  }
});

// Item 606: notification detail view.
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const note = await db.get('SELECT * FROM notifications WHERE id = $1', [req.params.id]);
    if (!note || note.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification not found.' } });
    }
    res.json({ notification: publicNotification(note) });
  } catch (err) {
    next(err);
  }
});

// Item 603: per-notification delete (dismiss).
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const note = await db.get('SELECT * FROM notifications WHERE id = $1', [req.params.id]);
    if (!note || note.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification not found.' } });
    }
    await db.run('DELETE FROM notifications WHERE id = $1', [note.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const note = await db.get('SELECT * FROM notifications WHERE id = $1', [req.params.id]);
    if (!note || note.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification not found.' } });
    }
    await db.run('UPDATE notifications SET is_read = 1 WHERE id = $1', [note.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
