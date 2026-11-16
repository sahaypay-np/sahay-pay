// Sahay Pay — notifications routes (in-app only; there are no email
// addresses in this product, so there are no email notifications).
// GET /api/notifications, POST /api/notifications/:id/read,
// POST /api/notifications/read-all.

'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../lib/auth');
const { runGiftMaintenanceSafe } = require('../lib/gift-maintenance');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    // Lazy reminders + 7-day gift expiry + pledge reminders (243/244/267):
    // evaluated when the user opens their notifications, so notices exist
    // by the time the list is read.
    await runGiftMaintenanceSafe(req.user.id);
    const { rows } = await db.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    const unread = await db.get(
      `SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1 AND is_read = 0`,
      [req.user.id]
    );
    res.json({
      notifications: rows.map((r) => ({
        id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link,
        isRead: r.is_read === 1, createdAt: r.created_at,
      })),
      unreadCount: Number(unread?.c || 0),
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
