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
    'thank_you_reminder',
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
    await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
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
